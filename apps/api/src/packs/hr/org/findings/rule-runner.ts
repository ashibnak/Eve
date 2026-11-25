import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import type { orgV1, platformV1 } from '@eve/contracts';
import { toCanonicalValue } from '../../../../platform/audit/canonical-json';
import { AuditService } from '../../../../platform/audit/audit.service';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import { runAs, withFlow } from '../../../../platform/context/request-context';
import { LONG_TX, type Tx, TxRunner } from '../../../../platform/context/tx-runner';
import { businessDateIn } from '../../../../platform/dates/dates';
import { RuleRuntime } from '../../../../platform/rules/rule-runtime';
import { AccessService } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { dateOf } from '../model/period';
import { OrgPermissions } from '../org.permissions';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';
import type { Violations } from '../rules/common';
import { ORG_RULES } from '../rules/index';
import { buildSnapshot } from '../rules/snapshot';
import { ruleRunView } from './finding-view';

/** The system actor of rule runs; audit rows of a nightly run carry it (source `workflow`). */
export const RULES_ACTOR: platformV1.Actor = { kind: 'system', id: 'org:rules' };

interface Seen {
  code: string;
  rule: { id: string; version: number };
  paramVersionId: string | null;
  paramsHash: string;
  severity: orgV1.Severity;
  subject: { type: 'company' | 'unit' | 'position' | 'person'; id: string };
  key: string;
  fingerprint: string;
  detail: Record<string, unknown>;
}

const fingerprintOf = (ruleId: string, s: Seen['subject'], key: string) =>
  `${ruleId}|${s.type}|${s.id}|${key}`;

/**
 * Runs the org rules over a company (spec §5, F5) and keeps the findings in step:
 * - a new case opens a finding; one already open is refreshed (last seen, evidence, rule version);
 * - an open finding no longer seen is resolved; if it comes back later it opens anew;
 * - an accepted exception holds for its rule and subject whatever the rule version or parameters
 *   (decision 2026-11-25); a run only refreshes when it was last seen.
 * Opening and resolving are audited (system actor `org:rules` for nightly runs).
 */
@Injectable()
export class OrgRuleRunner {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly runtime: RuleRuntime,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  /** "Run now" by the company's data owner (`org.finding.manage`), as of today. */
  async runNow(companyId: string): Promise<orgV1.RuleRunView> {
    await this.access.requireFor(OrgPermissions.manageFindings, companyId);
    return this.run(companyId, await this.today(), 'manual');
  }

  /** The nightly job: every company with org data, as of today, as the system. Returns runs made. */
  async runNightly(): Promise<number> {
    const today = await this.today();
    const companies = await this.db.afterOwnCheck().orgCompany.findMany({
      select: { companyId: true },
      orderBy: { companyId: 'asc' },
    });
    for (const { companyId } of companies) {
      await runAs(RULES_ACTOR, () =>
        withFlow({ source: 'workflow' }, () => this.run(companyId, today, 'nightly')),
      );
    }
    return companies.length;
  }

  /** Evaluates every nightly rule for one company and applies the finding lifecycle. */
  async run(
    companyId: string,
    asOf: platformV1.BusinessDate,
    trigger: 'nightly' | 'manual',
  ): Promise<orgV1.RuleRunView> {
    const startedAt = this.clock.now();
    const snapshot = await buildSnapshot(this.db.afterOwnCheck(), this.people, companyId, asOf);
    const rules: orgV1.RuleRunView['rules'] = [];
    const seen = new Map<string, Seen>();
    for (const rule of ORG_RULES.filter((r) => r.nightly)) {
      const record = await this.runtime.evaluate(
        { id: rule.template.id, version: rule.template.version },
        rule.input(snapshot),
        { asOf, companyId, knownAt: startedAt },
      );
      const { violations } = record.output as Violations;
      rules.push({
        code: rule.code,
        rule: record.rule,
        paramVersionId: record.paramVersionId,
        paramsHash: record.paramsHash,
        violations: violations.length,
      });
      for (const v of violations) {
        if (v.subject.type === 'change') continue;
        const subject = { type: v.subject.type, id: v.subject.id };
        const fingerprint = fingerprintOf(rule.template.id, subject, v.key);
        if (seen.has(fingerprint)) continue;
        seen.set(fingerprint, {
          code: rule.code,
          rule: record.rule,
          paramVersionId: record.paramVersionId,
          paramsHash: record.paramsHash,
          severity: rule.severity,
          subject,
          key: v.key,
          fingerprint,
          detail: v.detail,
        });
      }
    }
    return this.txRunner.run(
      (tx) => this.apply(tx, { companyId, asOf, trigger, startedAt, rules, seen }),
      LONG_TX,
    );
  }

  private async apply(
    tx: Tx,
    run: {
      companyId: string;
      asOf: platformV1.BusinessDate;
      trigger: 'nightly' | 'manual';
      startedAt: Date;
      rules: orgV1.RuleRunView['rules'];
      seen: Map<string, Seen>;
    },
  ): Promise<orgV1.RuleRunView> {
    const { companyId, seen } = run;
    // One run per company at a time; findings are compared against the committed state.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org_rules:${companyId}`}))`;
    const live = await tx.orgFinding.findMany({
      where: { companyId, status: { in: ['open', 'accepted'] } },
      select: { id: true, fingerprint: true, status: true, detail: true },
    });
    const liveByFingerprint = new Map(live.map((f) => [f.fingerprint, f]));
    const toOpen = [...seen.values()].filter((s) => !liveByFingerprint.has(s.fingerprint));
    const toResolve = live.filter((f) => f.status === 'open' && !seen.has(f.fingerprint));
    const stillOpen = live.filter((f) => f.status === 'open' && seen.has(f.fingerprint));
    const accepted = live.filter((f) => f.status === 'accepted' && seen.has(f.fingerprint));

    const runId = randomUUID();
    const now = this.clock.now();
    const created = await tx.orgRuleRun.create({
      data: {
        id: runId,
        companyId,
        asOf: dateOf(run.asOf),
        knownAt: run.startedAt,
        trigger: run.trigger,
        rules: run.rules,
        opened: toOpen.length,
        resolved: toResolve.length,
        stillOpen: stillOpen.length,
        accepted: accepted.length,
        startedAt: run.startedAt,
        finishedAt: now,
      },
    });
    const reason = `org rules run (${run.trigger}, as of ${run.asOf})`;

    const opened = toOpen.map((s) => ({
      id: randomUUID(),
      companyId,
      code: s.code,
      ruleId: s.rule.id,
      ruleVersion: s.rule.version,
      paramVersionId: s.paramVersionId,
      paramsHash: s.paramsHash,
      severity: s.severity,
      subjectType: s.subject.type,
      subjectId: s.subject.id,
      key: s.key,
      fingerprint: s.fingerprint,
      detail: toCanonicalValue(s.detail) as object,
      status: 'open',
      firstRunId: runId,
      lastRunId: runId,
      firstSeenAt: now,
      lastSeenAt: now,
    }));
    for (let i = 0; i < opened.length; i += 1000) {
      await tx.orgFinding.createMany({ data: opened.slice(i, i + 1000) });
    }
    for (const f of opened) {
      await this.audit.record(tx, {
        action: 'org.finding.open',
        entityType: 'org_finding',
        entityId: f.id,
        companyId,
        before: null,
        after: {
          code: f.code,
          rule: { id: f.ruleId, version: f.ruleVersion },
          paramVersionId: f.paramVersionId,
          severity: f.severity,
          subject: { type: f.subjectType, id: f.subjectId },
          key: f.key,
          detail: f.detail,
        },
        reason,
      });
    }

    for (let i = 0; i < toResolve.length; i += 1000) {
      await tx.orgFinding.updateMany({
        where: { id: { in: toResolve.slice(i, i + 1000).map((f) => f.id) }, status: 'open' },
        data: { status: 'resolved', resolvedAt: now, lastRunId: runId },
      });
    }
    for (const f of toResolve) {
      await this.audit.record(tx, {
        action: 'org.finding.resolve',
        entityType: 'org_finding',
        entityId: f.id,
        companyId,
        before: { status: 'open' },
        after: { status: 'resolved', resolvedAt: now.toISOString() },
        reason,
      });
    }

    // Still there: refresh when it was seen and with which rule version (bookkeeping, not audited).
    // Accepted ones keep their evidence; open ones take the latest.
    const refresh = [...stillOpen, ...accepted];
    const byRule = new Map<string, string[]>();
    for (const f of refresh) {
      const s = seen.get(f.fingerprint)!;
      const group = `${s.rule.id}@${s.rule.version}|${s.paramVersionId ?? ''}|${s.paramsHash}`;
      byRule.set(group, [...(byRule.get(group) ?? []), f.id]);
    }
    const fingerprintOfId = new Map(refresh.map((f) => [f.id, f.fingerprint]));
    for (const ids of byRule.values()) {
      const s = seen.get(fingerprintOfId.get(ids[0]!)!)!;
      for (let i = 0; i < ids.length; i += 1000) {
        await tx.orgFinding.updateMany({
          where: { id: { in: ids.slice(i, i + 1000) } },
          data: {
            ruleVersion: s.rule.version,
            paramVersionId: s.paramVersionId,
            paramsHash: s.paramsHash,
            lastRunId: runId,
            lastSeenAt: now,
          },
        });
      }
    }
    for (const f of stillOpen) {
      const detail = toCanonicalValue(seen.get(f.fingerprint)!.detail) as object;
      if (!isDeepStrictEqual(toCanonicalValue(f.detail), detail)) {
        await tx.orgFinding.update({ where: { id: f.id }, data: { detail } });
      }
    }
    return ruleRunView(created);
  }

  private async today(): Promise<platformV1.BusinessDate> {
    return businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }
}

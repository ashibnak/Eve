import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { toCanonicalValue } from '../audit/canonical-json';
import { Clock } from '../context/clock';
import { type Tx } from '../context/tx-runner';
import { PrismaService } from '../db/prisma.service';
import { type RuleTemplate, ruleKey } from './rule-template';

export interface ResolvedParams {
  /** The row used, or null when nothing is stored and the template defaults apply. */
  paramVersionId: string | null;
  params: unknown;
}

export interface ScheduleParams {
  template: RuleTemplate;
  /** null = customer-wide. */
  companyId: string | null;
  params: unknown;
  validFrom: platformV1.BusinessDate;
  approvalRequestId: string | null;
}

interface ParamRow {
  id: string;
  company_id: string | null;
  params: unknown;
  valid_from: Date;
  valid_to: Date | null;
  approval_request_id: string | null;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Customer parameters of rule templates, bitemporal (ADR-009). Values are never rewritten: a change
 * from date D supersedes every current row reaching past D and records (a) the old values ending at
 * D and (b) the new values from D. Lookups can ask "as known at" any moment.
 */
@Injectable()
export class ParamVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Company value, else customer value, else the template defaults; as of a day and a moment. */
  async resolve(
    template: RuleTemplate,
    companyId: string | null,
    asOf: platformV1.BusinessDate,
    knownAt: Date,
  ): Promise<ResolvedParams> {
    const rows = await this.prisma.$queryRaw<ParamRow[]>`
      SELECT id, company_id, params, valid_from, valid_to, approval_request_id
      FROM rules_param_version
      WHERE template_id = ${template.id}
        AND template_version = ${template.version}
        AND (company_id IS NULL OR company_id = ${companyId}::uuid)
        AND valid_from <= ${asOf}::date
        AND (valid_to IS NULL OR valid_to > ${asOf}::date)
        AND recorded_at <= ${knownAt}
        AND (superseded_at IS NULL OR superseded_at > ${knownAt})`;
    const row =
      rows.find((r) => companyId !== null && r.company_id === companyId) ??
      rows.find((r) => r.company_id === null);
    if (!row)
      return { paramVersionId: null, params: template.params.parse(template.defaultParams) };
    return { paramVersionId: row.id, params: template.params.parse(row.params) };
  }

  /** Records new values from `validFrom` on, inside the caller's (approval) transaction. */
  async schedule(tx: Tx, request: ScheduleParams): Promise<{ id: string }> {
    const { template, companyId, validFrom } = request;
    const params = toCanonicalValue(template.params.parse(request.params));
    const now = this.clock.now();
    const lockKey = `rules:${ruleKey(template)}:${companyId ?? 'customer'}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const affected = await tx.$queryRaw<ParamRow[]>`
      SELECT id, company_id, params, valid_from, valid_to, approval_request_id
      FROM rules_param_version
      WHERE template_id = ${template.id}
        AND template_version = ${template.version}
        AND company_id IS NOT DISTINCT FROM ${companyId}::uuid
        AND superseded_at IS NULL
        AND (valid_to IS NULL OR valid_to > ${validFrom}::date)
      FOR UPDATE`;

    for (const row of affected) {
      await tx.$executeRaw`UPDATE rules_param_version SET superseded_at = ${now} WHERE id = ${row.id}::uuid`;
      if (isoDay(row.valid_from) < validFrom) {
        // The part before the change stays as it was known.
        await tx.$executeRaw`
          INSERT INTO rules_param_version
            (template_id, template_version, company_id, params, valid_from, valid_to, recorded_at, approval_request_id)
          VALUES (${template.id}, ${template.version}, ${companyId}::uuid, ${JSON.stringify(row.params)}::jsonb,
                  ${isoDay(row.valid_from)}::date, ${validFrom}::date, ${now}, ${row.approval_request_id}::uuid)`;
      }
    }

    const [created] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO rules_param_version
        (template_id, template_version, company_id, params, valid_from, valid_to, recorded_at, approval_request_id)
      VALUES (${template.id}, ${template.version}, ${companyId}::uuid, ${JSON.stringify(params)}::jsonb,
              ${validFrom}::date, NULL, ${now}, ${request.approvalRequestId}::uuid)
      RETURNING id`;
    if (!created) throw new Error('Inserting the parameter version returned no row');
    return created;
  }
}

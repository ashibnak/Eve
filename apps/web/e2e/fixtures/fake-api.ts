import type { Page, Route } from '@playwright/test';
import { orgV1 } from '@eve/contracts';
import { buildCompany, type Company, uuid } from './company';

export const COMPANY_ID = uuid(1);
export type Persona = 'owner' | 'approver' | 'admin' | 'employee';

const USERS: Record<
  Persona,
  {
    id: string;
    username: string;
    roles: { role: string; scopeKind: string; companyId: string | null }[];
  }
> = {
  owner: {
    id: uuid(11),
    username: 'structure.expert',
    roles: [{ role: 'org_data_owner', scopeKind: 'company', companyId: COMPANY_ID }],
  },
  approver: {
    id: uuid(12),
    username: 'group.hr',
    roles: [{ role: 'org_change_approver', scopeKind: 'customer', companyId: null }],
  },
  admin: {
    id: uuid(13),
    username: 'sys.admin',
    roles: [{ role: 'system_admin', scopeKind: 'customer', companyId: null }],
  },
  employee: { id: uuid(14), username: 'employee', roles: [] },
};

interface Approval {
  id: string;
  type: string;
  companyId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'returned' | 'rejected';
  currentStep: number;
  chain: string[];
  requestedBy: string;
  createdAt: string;
  history: { action: string; step: number; actorId: string; note: string | null; at: string }[];
}

/**
 * A fake of the API the web app talks to, enough for the happy paths. Responses are parsed with
 * the contracts' schemas, so the fake cannot drift from what the real API returns.
 */
export class FakeApi {
  persona: Persona = 'owner';
  readonly company: Company;
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly findings: orgV1.FindingView[];
  readonly changeRequests: orgV1.ChangeRequestView[] = [];
  readonly approvals: Approval[] = [];
  profileSaved: unknown = null;
  importState: Record<string, unknown> | null = null;

  constructor(positions = 60) {
    this.company = buildCompany(COMPANY_ID, positions);
    const [p1, p2, p3] = this.company.structure.positions.slice(1, 4);
    const finding = (
      n: number,
      subject: string,
      code: string,
      severity: orgV1.Severity,
    ): orgV1.FindingView =>
      orgV1.FindingViewSchema.parse({
        id: uuid(500 + n),
        companyId: COMPANY_ID,
        code,
        rule: { id: `org.rule_${code.toLowerCase()}`, version: 1 },
        paramVersionId: null,
        severity,
        subject: { type: 'position', id: subject },
        key: code === 'R5' ? 'manager_outside_unit_line' : 'two_direct_lines',
        detail: {},
        status: 'open',
        firstSeenAt: '2026-11-20T00:00:00.000Z',
        lastSeenAt: '2026-11-22T00:00:00.000Z',
        resolvedAt: null,
        accepted: null,
      });
    this.findings = [
      finding(1, p1!.id, 'R2', 'blocking'),
      finding(2, p2!.id, 'R5', 'warning'),
      finding(3, p3!.id, 'R11', 'warning'),
    ];
  }

  get me() {
    return USERS[this.persona];
  }

  private workspace(): orgV1.CompanyWorkspace[] {
    const p = this.persona;
    return [
      orgV1.CompanyWorkspaceSchema.parse({
        companyId: COMPANY_ID,
        nameFa: 'شرکت آزمایشی',
        nameEn: null,
        codePrefix: 'TST',
        myPersonId: p === 'employee' ? uuid(900) : null,
        can: {
          readStructure: p === 'owner' || p === 'approver',
          manageFindings: p === 'owner',
          importStructure: p === 'owner',
          requestChange: p === 'owner',
          correct: p === 'owner',
          approveChange: p === 'approver',
          manageCompany: p === 'admin',
        },
      }),
    ];
  }

  private structure(asOf: string): orgV1.Structure {
    return asOf < '2026-11-01' ? this.company.earlier : this.company.structure;
  }

  private positionView(id: string, asOf: string): orgV1.PositionView | null {
    const p = this.structure(asOf).positions.find((x) => x.id === id);
    if (!p) return null;
    return orgV1.PositionViewSchema.parse({
      ...p,
      incumbentCount: undefined,
      incumbents:
        p.occupancy === 'filled'
          ? [
              {
                personId: uuid(2000 + Number.parseInt(p.code.slice(-5), 10)),
                kind: 'primary',
                timeShare: 1,
                active: true,
                personnelCode: '100001',
                name: { first: 'مریم', last: 'کریمی' },
              },
            ]
          : [],
    });
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/**', (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    let body: unknown = null;
    if (method !== 'GET') {
      try {
        body = request.postDataJSON();
      } catch {
        body = null; // a multipart upload
      }
    }
    this.calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    const q = url.searchParams;
    const asOf = q.get('asOf') ?? '2026-11-22';
    let m: RegExpMatchArray | null;

    if (path === '/auth/me') return json(this.me);
    if (path === '/auth/logout') return route.fulfill({ status: 204 });
    if (path === '/org/companies') return json(this.workspace());
    if ((m = path.match(/^\/org\/companies\/[^/]+\/structure$/))) return json(this.structure(asOf));
    if ((m = path.match(/^\/org\/companies\/[^/]+\/profile$/))) {
      if (method === 'POST') {
        this.profileSaved = body;
        return json({ ok: true }, 201);
      }
      return json({
        nameFa: 'شرکت آزمایشی',
        nameEn: null,
        codePrefix: 'TST',
        legalFields: { nationalId: '10380284790', ssoWorkshopCode: '1234567890' },
        levels: this.company.levels,
      });
    }
    if (path.match(/^\/org\/companies\/[^/]+\/unit-levels$/)) return json({ ok: true });
    if (path.match(/^\/org\/companies\/[^/]+\/rule-runs$/)) return json({}, 201);
    if (path === '/platform/companies')
      return json([{ id: COMPANY_ID, code: 'TST', jurisdictionCode: 'ir' }]);

    if (path === '/org/findings') {
      const status = q.get('status') ?? 'open';
      const subject = q.get('subjectId');
      return json(
        this.findings.filter((f) => f.status === status && (!subject || f.subject.id === subject)),
      );
    }
    if ((m = path.match(/^\/org\/findings\/([^/]+)\/(accept|reopen)$/))) {
      const f = this.findings.find((x) => x.id === m![1])!;
      f.status = m[2] === 'accept' ? 'accepted' : 'open';
      f.accepted =
        m[2] === 'accept'
          ? {
              by: this.me.id,
              at: '2026-11-22T08:00:00.000Z',
              reason: String((body as { reason: string }).reason),
            }
          : null;
      return json(f, 201);
    }

    if ((m = path.match(/^\/org\/positions\/([^/]+)\/history$/))) {
      const p = this.positionView(m[1]!, '2026-11-22');
      if (!p) return json({ error: 'not_found' }, 404);
      return json(
        orgV1.PositionHistorySchema.parse({
          positionId: p.id,
          code: p.code,
          versions: [
            {
              validFrom: '2020-01-01',
              validTo: null,
              legacyCode: p.legacyCode,
              title: p.title,
              unitId: p.unitId,
              unitName:
                this.company.structure.units.find((u) => u.id === p.unitId)?.name.fa ?? null,
              type: p.type,
              fte: p.fte,
              supervisory: p.supervisory,
              status: p.status,
              source: p.source,
            },
          ],
          lines: p.reportsToPositionId
            ? [
                {
                  kind: 'direct',
                  toPositionId: p.reportsToPositionId,
                  toCode: 'TST-P00001',
                  validFrom: '2020-01-01',
                  validTo: null,
                },
              ]
            : [],
          assignments: [],
        }),
      );
    }
    if ((m = path.match(/^\/org\/positions\/([^/]+)\/team$/))) return json([]);
    if ((m = path.match(/^\/org\/positions\/([^/]+)\/corrections$/))) {
      const p = this.company.structure.positions.find((x) => x.id === m![1])!;
      const changes = (body as { changes: { titleFa?: string } }).changes;
      if (changes.titleFa) p.title = { ...p.title, fa: changes.titleFa };
      return json({ corrected: true }, 201);
    }
    if ((m = path.match(/^\/org\/positions\/([^/]+)$/))) {
      const view = this.positionView(m[1]!, asOf);
      return view ? json(view) : json({ error: 'not_found' }, 404);
    }

    if ((m = path.match(/^\/org\/persons\/([^/]+)\/positions$/))) {
      return json([
        {
          positionId: this.company.structure.positions[5]!.id,
          kind: 'primary',
          timeShare: 1,
          validFrom: '2024-03-01',
        },
      ]);
    }
    if (path.match(/^\/org\/persons\/[^/]+\/manager$/)) {
      return json({
        manager: {
          personId: uuid(901),
          positionId: this.company.structure.positions[1]!.id,
          via: 'primary',
          levelsUp: 1,
        },
      });
    }
    if (path.match(/^\/org\/persons\/[^/]+\/approval-chain$/)) return json([]);
    if (path.match(/^\/org\/persons\/[^/]+\/informed$/)) return json([]);

    if (path === '/org/change-requests' && method === 'POST')
      return json(this.createChange(body as orgV1.ChangeRequestInput), 201);
    if (path === '/org/change-requests') return json(this.changeRequests);
    if ((m = path.match(/^\/org\/change-requests\/([^/]+)\/resubmit$/))) {
      const r = this.changeRequests.find((x) => x.id === m![1])!;
      const input = body as orgV1.ChangeRequestInput;
      Object.assign(r, {
        operations: input.operations,
        reason: input.reason,
        effectiveDate: input.effectiveDate,
      });
      const a = this.approvals.find((x) => x.id === r.approvalRequestId)!;
      Object.assign(a, { status: 'pending', currentStep: 0 });
      a.history.push({
        action: 'resubmit',
        step: 0,
        actorId: this.me.id,
        note: 'resubmitted',
        at: '2026-11-22T09:00:00.000Z',
      });
      return json(r, 201);
    }
    if ((m = path.match(/^\/org\/change-requests\/([^/]+)$/)))
      return json(this.changeRequests.find((x) => x.id === m![1]));

    if (path === '/platform/approvals/inbox') {
      return json(
        this.persona === 'approver' ? this.approvals.filter((a) => a.status === 'pending') : [],
      );
    }
    if (path === '/platform/approvals/mine')
      return json(this.approvals.filter((a) => a.requestedBy === this.me.id));
    if ((m = path.match(/^\/platform\/approvals\/([^/]+)\/(approve|reject|return)$/))) {
      const a = this.approvals.find((x) => x.id === m![1])!;
      const note = (body as { note?: string } | null)?.note ?? null;
      a.history.push({
        action: m[2]!,
        step: a.currentStep,
        actorId: this.me.id,
        note,
        at: '2026-11-22T10:00:00.000Z',
      });
      if (m[2] === 'approve') {
        a.status = 'approved';
        const r = this.changeRequests.find((x) => x.approvalRequestId === a.id);
        if (r) Object.assign(r, { status: 'applied', appliedAt: '2026-11-22T10:00:00.000Z' });
      } else {
        a.status = m[2] === 'return' ? 'returned' : 'rejected';
      }
      return json(a, 201);
    }
    if ((m = path.match(/^\/platform\/approvals\/([^/]+)$/)))
      return json(this.approvals.find((x) => x.id === m![1]));

    if (path === '/platform/imports' && method === 'POST') {
      this.importState = {
        id: uuid(700),
        status: 'uploaded',
        effectiveDate: '2026-11-22',
        mapping: {
          واحدها: {
            entity: 'unit',
            columns: { 'کد واحد': 'unitCode', 'نام واحد': 'nameFa', سطح: 'level' },
          },
          پست‌ها: {
            entity: 'position',
            columns: { 'کد پست': 'positionCode', 'عنوان پست': 'titleFa' },
          },
          انتساب‌ها: {
            entity: 'assignment',
            columns: { 'کد پرسنلی': 'personnelCode', 'کد پست': 'positionCode' },
          },
        },
        findings: null,
        counts: {},
        diff: null,
      };
      return json(this.importState, 201);
    }
    if ((m = path.match(/^\/platform\/imports\/[^/]+\/(mapping|validate|preview|commit)$/))) {
      const step = m[1];
      const s = this.importState!;
      if (step === 'mapping') s.status = 'mapped';
      if (step === 'validate')
        Object.assign(s, {
          status: 'validated',
          findings: [
            { severity: 'warning', code: 'org.rule.R6', message: 'R6: unit U3, no_supervisor' },
          ],
        });
      if (step === 'preview')
        Object.assign(s, {
          status: 'previewed',
          counts: { added: 120, changed: 0, removed: 0 },
          diff: [{ entity: 'position', key: 'proposed:U3|کارشناس پیشنهادی', kind: 'added' }],
        });
      if (step === 'commit') s.status = 'committed';
      return json(s);
    }

    return json({ error: 'not_mocked', path }, 404);
  }

  private createChange(input: orgV1.ChangeRequestInput): orgV1.ChangeRequestView {
    const n = this.changeRequests.length + 1;
    const approval: Approval = {
      id: uuid(800 + n),
      type: 'org.structure.change',
      companyId: input.companyId,
      payload: { changeRequestId: uuid(850 + n) },
      status: 'pending',
      currentStep: 0,
      chain: ['org_change_approver'],
      requestedBy: this.me.id,
      createdAt: '2026-11-22T08:30:00.000Z',
      history: [
        {
          action: 'submit',
          step: 0,
          actorId: this.me.id,
          note: null,
          at: '2026-11-22T08:30:00.000Z',
        },
      ],
    };
    this.approvals.push(approval);
    const request = orgV1.ChangeRequestViewSchema.parse({
      id: uuid(850 + n),
      companyId: input.companyId,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
      operations: input.operations,
      impact: {
        movedPeople: [
          {
            personId: uuid(3000),
            positionId: this.company.structure.positions[4]!.id,
            fromUnitId: this.company.structure.units[1]!.id,
            toUnit: 'new-unit:u1',
          },
        ],
        managerChanges: [{ personId: uuid(3000), from: uuid(3001), to: null }],
        ordersNeeded: 1,
        vacatedPositions: [],
        warnings: { opened: [], resolved: [] },
        gradeChanges: 'unknown_until_grading',
      },
      status: 'submitted',
      approvalRequestId: approval.id,
      requestedBy: this.me.id,
      createdAt: '2026-11-22T08:30:00.000Z',
      appliedAt: null,
    });
    this.changeRequests.push(request);
    return request;
  }
}

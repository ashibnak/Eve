# R1 Build Plan — Eve core + people-core + org (Module 1)

Version 1.0 · 2026-11-22 (1 Azar 1405)
Source docs: ADR 1.0, Roadmap Amendment 1.1 (release R1), Module 1 Spec 1.1.

R1 delivers: the minimum Eve core that `org` needs, a minimal `people` core (ADR-008), and Module 1 MVP (F1–F8, F16). Build only what a slice below asks for; later slices may extend a component, they never rewrite it.

Each slice = one or more small PRs. Do not start a slice before the previous one is merged. LLM is **not** used in R1 (column mapping is manual; chat questions F13 come in R2).

## S0 — Scaffold
- pnpm workspace: `apps/api` (NestJS), `apps/web` (React + Vite + Tailwind), `packages/contracts`, `packages/jurisdictions`.
- Docker Compose: api, postgres (with `btree_gist`, `pgvector`), caddy.
- Prisma + raw SQL migration folder; Vitest; Playwright; pino logging.
- CI (GitLab): lint, typecheck, test, `dependency-cruiser` boundary rules (platform ↛ packs; pack module ↛ other module internals; only `ports/adapters` may import another module's public service).
- Design-system tokens wired into Tailwind; Vazirmatn; RTL root; logical-CSS lint rule.
- **Done when:** empty app boots with one command; a deliberate boundary violation fails CI.
- **Status / decisions (S0, 2026-11-22):**
  - [x] Workspace: Node 24 LTS, pnpm 12.21 (via corepack), TypeScript 6.0 (typescript-eslint does not support TS 7 yet).
  - [x] Prisma 7.10 with driver adapter (`@prisma/adapter-pg` + `pg`, approved). Migrations hand-numbered `NNNN_name/`, applied only by `prisma migrate deploy`.
  - [x] DB roles: `eve_owner` runs migrations, `eve_app` is the runtime role (DML only) — lets S1 deny UPDATE/DELETE on audit. Created by `deploy/postgres/init/01-roles.sh` (shell, not `.sql`, to read passwords from env). pgvector is not a trusted extension, so the init script creates extensions as superuser.
  - [x] Boundaries: only `adapters/` may import another module, and only its `service/index.ts`; `ports/` are self-contained (product-owner confirmed). Proven by fixture tests in `tools/boundaries/`.
  - [x] UI text: `eslint-plugin-i18next` (`no-literal-string`, JSX) + fa/en key-sync check (`pnpm check:i18n`).
  - [x] Logical CSS: local ESLint rule `eve/no-physical-tailwind` for class names + `stylelint-use-logical` (stylelint pinned to 17.x for its peer range).
  - [x] Tokens: `apps/web/src/styles/tokens.css` is a verbatim copy of the design system; Tailwind v4 `@theme inline reference` maps them and clears default palette/radius/shadow. Hard shadows mirrored for `dir="ltr"`.
  - [x] Vazirmatn self-hosted via `@fontsource-variable/vazirmatn` (works offline).
  - [x] Registries: public npm / Docker Hub for now; switch via `.npmrc` and `IMAGE_REGISTRY`.

## S1 — Core foundations
- `auth`: local login + OTP (OTP delivery behind `Channel`, stubbed); OIDC hook left as interface only.
- Roles + scopes (customer | company | unit subtree) and the scope layer every repository uses. Unit subtree resolution is a port that `org` will implement later.
- `audit`: append-only, hash-chained table; DB grants forbid UPDATE/DELETE.
- `events`: envelope type in contracts, `outbox` table, publisher via `pg-boss`, idempotent consumer helper.
- `jobs`: pg-boss setup.
- `i18n` (fa, en keys), `Money`, date utils (UTC store, Jalali display), `jurisdiction` loader + `packages/jurisdictions/ir` skeleton (calendar, company legal-field schema).
- `config`: customer settings in DB.
- `usage`: ledger table + counters for requests and active users (LLM token fields present, unused in R1).
- **Done when:** a sample write produces one audit row and one outbox event atomically; scope test proves company A can't read company B.

## S2 — Rules engine + approvals
- Rule template registry: id, version, param schema (Zod), evaluate fn, test cases; immutable once published.
- Customer parameter sets: versioned, effective-dated, changed only via approval.
- Rule evaluation result records template id@version + param version (for decision records).
- `approvals`: state machine on PostgreSQL (pending → approved | rejected | returned), configurable approver role per request type, resumable after restart, pinned rule versions per running workflow.
- **Done when:** a dummy template v1 and v2 coexist; replay with v1 gives the old result; an approval survives an app restart.

## S3 — Connectors (file)
- Pipeline: upload → choose company + effective date → column mapping (saved per source) → structural validation → domain validation hook (module supplies rules) → diff preview → commit as one atomic change bundle with source = file.
- Canonical model types in contracts: person, unit, position, assignment (others later).
- Excel via ExcelJS.
- **Done when:** a test module can import a sheet, preview the diff and commit it with full audit.

## S4 — people core (`people`)
- Tables `people_person`: id, personnel code, names (fa required, en optional), company, hire date, employment status, contact channel id. Temporal where it changes (status).
- Public service: `get_person`, `find_by_personnel_code`, `list_active`; events `people.person.created|status_changed`.
- File import via S3 connector.
- **Ask before adding** any other personnel field (full Module 42 spec comes later).
- **Done when:** both pilot companies' people import cleanly; contract `people/v1` published.

## S5 — org data model + read services
- Tables per spec §3/§10 with exclusion constraints on validity ranges and R15 constraint.
- Read services + MCP tools: `get_position`, `get_person_position`, `get_manager` (primary → acting → upward), `get_approval_chain`, `get_informed`, `get_team`, `get_structure`, `diff_structure`; all accept `as_of`.
- Ports: `PeopleDirectoryPort` (adapter → people), `PayrollSnapshotPort` (null adapter in R1), `JobLookupPort` (null adapter in R1).
- Implement the core unit-subtree scope port.
- **Done when:** manager resolution tests (incl. vacant + acting) pass; reads < 300 ms on a 6,000-position fixture.

## S6 — org rules R1–R15 + findings
- Each rule as a template `org.<name>@1` with default params (spec §5); blocking rules run on every write, all rules nightly.
- Findings inbox data: open / resolved / accepted-exception with reason; no reopen of accepted exceptions.
- **Done when:** every rule has positive/negative tests; nightly job produces findings on the fixture.

## S7 — org import
- Three-sheet template (unit, position, assignment) through the S3 pipeline, using legacy codes for matching, system-generated codes, R1–R15 on the hypothetical result, proposed positions.
- **Done when:** spec acceptance "import a real company in one working day; second time < 1 hour with saved mapping" is demonstrable on anonymized data.

## S8 — Change requests, corrections, `apply_assignment`
- Data correction path (owner, reason, audit).
- Change request bundle: operations, impact analysis (moved people, vacated positions, orders needed), approval via S2, applied at effective date, events published at effective date.
- `apply_assignment` command (only callable with an action id + approval id; checks R3, R4, R15).
- Events per spec §7 with standard envelope.
- **Done when:** one change request goes request → approval → effective-date events; replaying the command with the same id produces no duplicate.

## S9 — Web UI
- Six pages per spec §9: chart (React Flow), positions table, position card, findings inbox, change request (before/after + ApprovalChain), import wizard. "As of" date picker on every page.
- Components from the design system; one red primary action per view; all strings from i18n.
- **Done when:** a 6,000-position chart opens < 2 s; Playwright happy paths pass.

## S10 — R1 acceptance
- Run Module 1 spec §11 checklist and Roadmap Amendment R1 criteria on anonymized pilot data.
- Record baseline timings (letters, certificates, leave, pay proposals) for later gates.
- Tag `v0.1.0`.

## Open items to raise with the product owner (not for the agent to decide)
- Exact personnel fields beyond S4 list.
- Approver role per change-request type for each pilot company.
- Which two companies are the R1 pilots.

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
- **Product-owner decisions (2026-11-22):** password + OTP as second factor for every user; minimal platform company registry `core_company` (org extends it in S5); platform registers only `system_admin` and `auditor`; `ir` company legal fields = national ID (11 digits, checksum) + social-security workshop code (exactly 10 digits); minimal login/OTP screen in S1b; usage months follow the customer's jurisdiction calendar.
- **S1a — audit, events, jobs, config (status / decisions):**
  - [x] Done-when 1: `ConfigService.set` writes the setting, one audit row and one `platform.config.changed` outbox event in one transaction; a failing publish rolls all back (integration test).
  - [x] Request context via `AsyncLocalStorage`; writes outside a context fail. `TxRunner` is the only unit of work; audit and outbox accept only its transaction.
  - [x] Audit chain: `hash = sha256(prev_hash \n canonical JSON)`, appends serialized by `pg_advisory_xact_lock`; `eve_app` has no UPDATE/DELETE/TRUNCATE and a trigger blocks changes for the owner too; `verifyChain()` pinpoints a tampered row.
  - [x] Envelope (contracts `platform/v1`): `effective_at` is a business date (`YYYY-MM-DD`); `company_id` is null only for customer-wide platform events.
  - [x] Relay publishes to pg-boss **inside the claiming transaction** (pg-boss `db` option), event name `<type>/v<version>`; consumers are idempotent via `events_inbox` in the handler's transaction.
  - [x] pg-boss 12.38.2 (12.39.0 was too new for pnpm's minimum release age) + `@opentelemetry/api` 1.10.0 (static import in pg-boss, approved); schema `pgboss` owned by `eve_app` (migration 0006, needs `GRANT eve_app TO eve_owner` in `roles.sql`).
  - [x] `platform.time_zone` setting has no default: reading it unset fails loudly; effective dates use it.
  - [x] Integration tests run against real Postgres (`pnpm db:dev:up`, port 15432 — 55432 is reserved by Hyper-V on Windows) in a fresh database per run, as `eve_app`; CI runs them with a Postgres service plus `pnpm db:check-drift` (schema.prisma vs. hand-written SQL).
  - [x] Fixed S0 CI failure on `main`: the gitignored Prisma client is now generated by the root `postinstall`.
  - [x] Fix after merge (CI on Linux): pg-boss defaults (1 job per fetch, 2 s poll) drained a backlog at ~30 events/min. Consumers now fetch batches of 20 with burst mode and per-job results (one failing event is retried alone). Events reach a consumer in write order: outbox `seq` (migration 0007), one relay transaction per event (pg-boss orders only by `created_on`), and each fetched batch sorted by `outbox_seq` (pg-boss returns batches unordered). Retries and multiple relay processes can still reorder; consumers must tolerate it.
- **S1b — auth, roles, scope, login screen (status / decisions):**
  - [x] Done-when 2: auditors scoped to company A and B each read only their own companies, settings and audit rows, through the scoped Prisma client and over HTTP; company B and customer-level reads are 403 for A (integration tests).
  - [x] Login = password, then a 6-digit one-time code through the user's `Channel` (stub in R1). Defaults per product owner: code 2 min / 5 tries, lock 15 min after 5 wrong passwords, session 30 min idle / 12 h absolute — all customer settings. Password minimum length 12 is an engineering default (not decided by the product owner).
  - [x] Session: opaque token in an httpOnly, Secure, SameSite=Strict cookie on `/api`; only its SHA-256 is stored; the token is rotated when the code is verified. Unknown user and wrong password give the same answer and timing; a locked account is revealed only to someone with the right password.
  - [x] Wrong-attempt counters increment atomically in SQL; failed attempts are committed (and audited) before the error, so limits cannot be bypassed by a rollback. All login activity is audited (actor `system:auth` before sign-in); password hashes never reach the audit log.
  - [x] Global guard denies by default; `@Public()` only for health, login and code. Request context opens in middleware (request id, caller `x-correlation-id`), the guard sets the actor.
  - [x] Roles registered in code: `system_admin` (customer scope; settings, users, companies; no audit log) and `auditor` (customer or company scope; read-only incl. audit). Grants are closed with `revoked_at`; the last system administrator cannot be revoked. Agents get exactly the scope of the user they act for.
  - [x] Scope layer: `AccessService` resolves a scope per permission; `scopedPrisma()` is read-only and adds the company filter to every registered model; rows without a company are customer-wide only. `UnitSubtreePort` with a deny-all adapter until org (S5). New boundary rule: pack code cannot import the raw `PrismaService`.
  - [x] First administrator via `node dist/cli/bootstrap.js` (password from `EVE_BOOTSTRAP_PASSWORD`). Login screen + signed-in shell with logout; Persian digits accepted in the code field.
  - [ ] Open: R1 has only the stub channel, so a real deployment cannot deliver codes until a real channel (Bale, R2) or another delivery path exists.
- **S1c — i18n, Money, dates, jurisdiction, usage (status / decisions):**
  - [x] `Money` in contracts (`{ amountMinor: bigint, currency }`, JSON amount as string); arithmetic in `platform/money`: no currency mixing, every rounding step takes an explicit mode (no default), exact `allocate`, exact parse/print. Currency table: IRR scale 0 (ADR-010), AED/EUR/USD 2; others must be added before use.
  - [x] `JurisdictionPack` contract; `ir` pack: Persian calendar (jalaali algorithm, verified against ICU for every day of 1300–1500 SH), default time zone `Asia/Tehran`, currency IRR, company legal fields = national ID (11 digits + check digit) and workshop code (exactly 10 digits). Packs are handed to the platform by the app wiring; company registration rejects jurisdictions the deployment does not ship.
  - [x] National-ID check digit: the standard algorithm, confirmed with two independently remembered real IDs. **Verify with the pilot companies' real IDs before go-live.**
  - [x] `platform.home_jurisdiction` setting (no default) chooses the calendar of reporting months; bootstrap CLI now requires `--jurisdiction` and defaults the time zone from the pack.
  - [x] Usage: per-day request counters per module and daily active users, days in the customer time zone (more precise than UTC days for a local-calendar month); monthly report for a month of the home-jurisdiction calendar (Jalali for `ir`), aggregates only, `system_admin` only. LLM ledger table with token fields, unused in R1. Counters are telemetry and are not audited.
  - [x] Server i18n catalogs (`apps/api/src/platform/i18n`, first message: the sign-in code); the CI key check covers web and API catalogs.
  - [ ] Not in S1: the signed monthly usage report (ADR-014) and quotas.

## S2 — Rules engine + approvals
- Rule template registry: id, version, param schema (Zod), evaluate fn, test cases; immutable once published.
- Customer parameter sets: versioned, effective-dated, changed only via approval.
- Rule evaluation result records template id@version + param version (for decision records).
- `approvals`: state machine on PostgreSQL (pending → approved | rejected | returned), configurable approver role per request type, resumable after restart, pinned rule versions per running workflow.
- **Done when:** a dummy template v1 and v2 coexist; replay with v1 gives the old result; an approval survives an app restart.
- **Product-owner decisions (2026-11-23):** ordered approval steps, each a role, configurable per customer (R1 default: one step); rule parameters proposed by `system_admin` and approved by a new `rule_approver` role; the requester never approves (four-eyes); parameter changes take effect today or later only; a returned request is edited and resubmitted from step 1 as a new revision; a running request keeps the chain and rule versions it was submitted with.
- **Status / decisions (S2):**
  - [x] Done-when 1: the sample template `v1` (`>`) and `v2` (`>=`) coexist; a v1 evaluation record replays to its old result after the parameters changed and v2 became the latest; altered records are detected (output mismatch, parameter hash).
  - [x] Done-when 2: a two-step request is submitted and approved once in one application instance, which shuts down; a fresh instance on the same database shows it in the next approver's inbox and completes it (change applied, one audit row per action, outbox events).
  - [x] Templates: id + version, Zod params/input/output, pure `evaluate`, fa/en description, at least two cases that must pass at registration. Published versions are frozen by committed golden files (`apps/api/rules-golden/`, written by `pnpm rules:golden`, never overwritten) and a CI test; editing v1's logic fails CI (verified).
  - [x] Parameters: bound to an exact template version, company value over customer value over defaults; bitemporal rows (`valid_from/valid_to`, `recorded_at/superseded_at`); a change from D supersedes and splits periods, never rewrites (the app role may only stamp `superseded_at`); an exclusion constraint forbids overlapping current periods; "as known at" lookups.
  - [x] Approvals: request types registered in code with their own `apply`, which runs in the final approval's transaction; chains are settings (`approvals.chain.<type>`, customer or company); every action locks the request row, so concurrent decisions cannot both win; actions are append-only; events `platform.approval.requested/decided/returned`.
  - [x] Engineering default to confirm: **one person approves at most one step of a revision**, even if they hold the roles of several steps.
  - [x] If a request waits past its effective date, final approval is refused (409) and nothing is applied; the approver returns it so the requester sets a new date.
  - [x] HTTP: `GET/POST /platform/rules…` (list, propose), `/platform/approvals` (inbox, mine, get, approve, reject, return, resubmit, cancel).

## S3 — Connectors (file)
- Pipeline: upload → choose company + effective date → column mapping (saved per source) → structural validation → domain validation hook (module supplies rules) → diff preview → commit as one atomic change bundle with source = file.
- Canonical model types in contracts: person, unit, position, assignment (others later).
- Excel via ExcelJS.
- **Done when:** a test module can import a sheet, preview the diff and commit it with full audit.
- **Product-owner decisions (2026-11-24):** each import target decides whether its commit needs approval (both paths built); committed import files are kept permanently as evidence, discarded/abandoned imports lose file and staged rows after 30 days; formats `.xlsx` and UTF-8 `.csv`.
- **Status / decisions (S3):**
  - [x] Done-when: a test-only `test.widget` target imports an Excel sheet: upload → mapping (auto-suggested from Persian header aliases) → validate → preview (3 added) → commit; one audit row per widget plus the import's own row, all with source `file` and the import id as action id; event `platform.import.committed`; the stored file matches its SHA-256. A second file from the same source is pre-mapped and previews added/changed/removed/unchanged.
  - [x] Pipeline is a PostgreSQL state machine (`connectors_import`): re-mapping invalidates validation and preview; commit needs a fresh preview, no row errors and no blocking findings; the diff is recomputed at commit and the commit is refused if data changed since the preview.
  - [x] Persian normalization for every cell: Arabic ي/ك → ی/ک, Persian/Arabic-Indic digits and separators, stray direction marks removed, ZWNJ kept inside words; dates as Excel cells, ISO, or Jalali text in the company's calendar; malformed values are row errors, not crashes. Duplicate keys in a file are row errors.
  - [x] Targets plug in fields, entity key, permission, domain checks, diff and commit; an approval-gated target gets request type `<target>.import.commit` whose `apply` commits atomically.
  - [x] Files: `FileStore` interface, local-disk adapter on volume `eve_files`, content-addressed by SHA-256; nightly retention job (pg-boss schedule) purges expired imports, never a file a committed import uses. Limits are settings: 20 MB and 50,000 rows by default.
  - [x] HR canonical model (person, unit, position, assignment) in `packages/contracts/src/hr/canonical/v1` (not the platform), fields only from spec §3 and the S4 list; open value lists (employment status, unit level, position type/status, assignment kind) stay strings until S4/S7.
  - [x] Found by the HTTP test and fixed: the file store could not be created by Nest (the app would not have started with S3 wired in).

## S4 — people core (`people`)
- Tables `people_person`: id, personnel code, names (fa required, en optional), company, hire date, employment status, contact channel id. Temporal where it changes (status).
- Public service: `get_person`, `find_by_personnel_code`, `list_active`; events `people.person.created|status_changed`.
- File import via S3 connector.
- **Ask before adding** any other personnel field (full Module 42 spec comes later).
- **Done when:** both pilot companies' people import cleanly; contract `people/v1` published.
- **Product-owner decisions (2026-11-24):** statuses `active | on_leave | suspended | terminated` (active + on_leave count as employed); personnel code unique per company; one person record per company in R1; people imports committed directly by the data owner; people missing from a re-import are reported, never changed; new role `people_data_owner` (company or customer scope; `system_admin` has no people access); effective-dated status history (past dates allowed); optional contact `bale | sms`.
- **Status / decisions (S4):**
  - [x] Done-when (with anonymized generated data, since the pilot files are not in the repository): two companies with 1,200 and 800 messy-but-realistic people rows (Arabic ي/ك, Persian digits, Jalali/Excel dates, Persian/English status words) import with no blocking finding; employed counts match; service output validates against the `people/v1` contract. **To do with you: run the same import on the two pilot companies' real files.**
  - [x] Contract `packages/contracts/src/people/v1`: statuses, `PersonView`, `PeopleReadService`, event payloads `people.person.created|status_changed@1`, field sensitivity labels (names and contact sensitive).
  - [x] Tables `people_person` (unique company + code) and `people_employment_status` (exclusion constraint against overlap; app may only close a period). A person's first status starts on the first import's effective date: earlier history is unknown and reported as no status.
  - [x] A status change before a later existing change is refused (correcting later history is out of R1 scope); an empty optional cell never clears a stored value (clearing is an explicit correction).
  - [x] One writer (`PeopleWriter`) for commands and imports: audit row per change, events through the outbox in the same transaction.
  - [x] Platform additions: `ScopedDb` (packs read only through the scope layer, never the raw client) and `registerScopedModel()`; transactions take a timeout (30 s default, 15 min for import commits and approval decisions — a 1,200-person import exceeded Prisma's 5 s default).
  - [x] The boundary check caught a platform test importing the people pack; the people HTTP test now lives in the pack.
  - [ ] Open: which roles besides `people_data_owner` may read people (org roles come in S5; the auditor has no people access yet).

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

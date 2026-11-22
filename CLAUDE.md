# CLAUDE.md — Eve / HR Ops

Version 1.0 · 2026-11-22 (1 Azar 1405)

Eve is an AI-assisted **decision platform**. HR Ops is its first domain pack. Every salary, grade or rule result comes from deterministic code; the LLM only understands, extracts, explains and drafts.

## Read before any work (in this order)

1. `docs/HR-Ops-ADR.md` — architecture decisions ADR-001..015. **Overrides** the architecture doc where they differ.
2. `docs/TechnologiesAndArchitecture.md` — stack and principles.
3. `docs/plan/R1-Build-Plan.md` — current release, slices, definition of done.
4. The spec of the module you are building, e.g. `docs/modules/HR-Ops-Module-01-Org-Structure-Spec.md`.
5. `docs/design-system/` — UI tokens and components (HR Ops Design System).
6. Roadmap (`docs/HR-Ops-Roadmap-and-Modules.md` + `docs/HR-Ops-Roadmap-Amendment-1.1.md`) only for context.

Docs are in Persian. Code, identifiers, commits and code comments are in English. UI text is never hard-coded: it lives in `apps/web/src/i18n/fa.json` (and `en.json` keys kept in sync).

## Non-negotiable rules

1. **One language, one app, one DB.** TypeScript everywhere, modular monolith (NestJS + React), PostgreSQL. No Redis, no message broker, no Kubernetes, no microservices, no agent framework, no rule DSL. Do not add a dependency or infra component without asking first.
2. **Platform knows no domain.** `apps/api/src/platform/**` must never import from `apps/api/src/packs/**` (ADR-001).
3. **Module boundaries.** A module owns its tables (prefix = module slug, e.g. `org_`). No module reads another module's tables. Cross-module access only through: (a) the provider's public service via a **port defined in the consumer** (`ports/` + `adapters/`, ADR-004), (b) a registered event, or (c) a registered command. Enforced by `dependency-cruiser` in CI.
4. **Contracts.** Each module's services, commands, events and MCP tools are declared in `packages/contracts/<slug>/v1/`. Within v1: additive changes only. Breaking change = v2 alongside v1 (ADR-003). Consumers keep contract tests in their own folder.
5. **Rules = template + parameters** (ADR-005). A rule template is code with its own id and version (`org.single_supervisor@1`). Published templates are immutable: fixing logic = new version, old one stays. Customer parameters are versioned rows with effective dates and go through approval.
6. **Time.** Business data has `valid_from`/`valid_to` with a DB exclusion constraint against overlap; nothing is deleted, only closed. Pay-related tables are bitemporal (`recorded_at`/`superseded_at`, ADR-009). Store UTC Gregorian; display per locale (Jalali for `fa`).
7. **Money** = `{ amountMinor: bigint, currency: ISO4217 }` via the platform `Money` type. Never a bare number for money.
8. **Single writer.** Only the owning module writes an entity. Data changes happen only inside a workflow/command after the required approval. Agents/LLM never write; they read and draft.
9. **Audit.** Every change goes to the append-only, hash-chained audit log with: actor, time, before, after, reason, source (manual | file | agent | workflow), request/action id. The app DB user cannot UPDATE/DELETE audit rows.
10. **Events.** Published only via the `outbox` table in the same transaction, using the standard envelope (`event_id, type, schema_version, occurred_at, effective_at, correlation_id, causation_id, actor, source, company_id`; ADR-006). Handlers are idempotent on `event_id`. No handler opens a decision (D1–D18) unless the decision graph names that event as its trigger.
11. **Scope.** Every business table has `company_id`; every query goes through the platform scope layer that applies the caller's role + scope (customer | company | unit subtree). Agents act with the requesting user's scope, never more.
12. **Localization seams** (ADR-010): country-specific things (calendar, legal fields, law, insurance/tax, document templates) come from `packages/jurisdictions/<code>` (`ir` first). Channels (Bale, web) implement the platform `Channel` interface. Web CSS uses logical properties only (`margin-inline-start`, never `margin-left`).
13. **Sensitive data** (names, national id, salary, performance) never goes to an external LLM. LLM calls go only through `platform/llm`, which enforces field sensitivity labels from contracts.
14. **Single-customer is a deployment fact, not a code assumption** (ADR-012): customer settings in DB, no per-customer globals in memory.

## Repository layout

```text
apps/api/src/platform/   auth config rules approvals audit decisions events jobs
                         connectors channels llm agent router usage i18n jurisdiction
apps/api/src/packs/hr/<slug>/   model/ service/ commands/ mcp/ events/ ports/ adapters/ tests/
apps/web/                React + Vite + Tailwind (tokens from design system)
packages/contracts/<slug>/v1/
packages/jurisdictions/ir/
deploy/                  docker compose, upgrade scripts
docs/                    specs, ADRs, plan, design-system
```

## How to work

- Work **one slice at a time** from `docs/plan/R1-Build-Plan.md`. Start each slice in plan mode: restate the slice, list files to touch, list open questions. Wait for approval before coding.
- **Ask, don't guess, on business/HR logic.** If the spec is silent or ambiguous on an HR rule, process or data meaning, stop and ask with your recommended option. Technical choices inside these rules you may decide; note them in the PR description.
- Tests first for rules, temporal logic and scope. Every rule template ships with positive and negative cases.
- Migrations are numbered, forward-only. Breaking schema change = 3 steps across releases (add → migrate data → drop).
- Commits: Conventional Commits (`feat(org): ...`). Small PRs, one slice or less.
- No placeholder logic for numbers ("TODO compute later" returning 0). If something can't be computed yet, fail loudly.

## Definition of done (every slice)

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm boundaries` all green.
- Contract tests pass for every consumer of a changed contract.
- New UI strings only in i18n files; screens follow the design system (2px navy frames, Vazirmatn, one red primary action per view).
- Audit + outbox behaviour covered by tests for every write path.
- Slice checklist in the build plan ticked, with notes on any decision taken.

## Do not build (unless the plan says so)

Multi-tenancy, microservices, Redis, Temporal, Keycloak, LangGraph or any agent framework, a customer-facing rule language, a separate file store, Grafana, multi-agent orchestration.

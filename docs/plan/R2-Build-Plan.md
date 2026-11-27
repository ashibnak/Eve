# R2 Build Plan — employee services

Version 0.1 (draft) · 2026-11-27 (6 Azar 1405)
Source docs: ADR 1.0, Roadmap 1.0 (modules 41, 44, 47, 50), Roadmap Amendment 1.1 (release R2), R1 Build Plan and `v0.1.0`.

R2 delivers what the amendment promises for month 4: **every employee of the two pilot companies gets letters, employment certificates and leave in Bale.** Modules: `front_door` (41, simple), `letters` (44, without the salary-deduction letter), `leave` (50) and `compliance_cal` (47), on top of the R1 core, `people` and `org`.

Each slice = one or more small PRs, started in plan mode, merged before the next one starts (as in R1). Platform slices (S11–S13) need no HR rules and can start now. A module slice starts only after its spec in `docs/modules/` is approved.

## Product-owner decisions (2026-11-27)
- **LLM: menu first, optional model.** Letter, certificate and leave work from Bale buttons with no model. The LLM gateway and an intent router are built (S13), and free-text intent detection runs only when a model endpoint is configured. R2's acceptance does not depend on the GPU server (ADR-013).
- **Bale identity:** the user shares their Bale contact; the mobile number is matched to the person's contact number in `people`, then confirmed with a one-time code sent through the bot. The link is stored once.
- **Specs:** drafted in Persian by the agent in the Module 1 format; every HR rule the docs do not settle is a marked question with a recommended default; HR approves each spec before its slice.
- **Certificates:** R2 issues employment certificates and introduction letters **without amounts**. Certificates with salary and the salary-deduction letter come in R3, with `payroll_link`.

## R2 acceptance (Roadmap Amendment 1.1) and where each is met

| Criterion | Measured by | Slices |
| --- | --- | --- |
| At least 60% of the two pilots' employees got a letter, certificate or leave through Bale | usage report: distinct employees with a completed request through the Bale channel ÷ employed people | S12, S15, S16, S17, S20 |
| HR response time to these requests is half the R1 baseline | usage report: median cycle time per request type vs `docs/acceptance/R1-baseline-measurement.md` | S15, S16, S20 (needs the baseline) |
| Fanap's leave regulation is in the rule engine as template + parameters, with test cases | rule templates `leave.*@1`, Fanap parameters approved, golden cases | S16 |

## S11 — Documents and file store (platform)
- `platform/documents`: versioned HTML templates rendered to PDF by Playwright + Chromium (the architecture doc's choice for orders and letters). An issued document records template id + version, an inputs hash, its number and its file.
- `platform/files`: storage interface on server disk (content hash, company scope, no deletion; S3-compatible later without code change). Not a separate file store.
- Default layouts in `packages/jurisdictions/ir` (Persian, RTL, Jalali dates); per-company letterhead and overrides as versioned config.
- **Dependency to approve at slice start:** `playwright-core` + Chromium in the api image (today Playwright is a web dev dependency only).
- **Done when:** a Persian RTL letter with Jalali dates renders to PDF in < 2 s; the same inputs and template version give the same bytes; issuing is audited and emits an event.
- **Product-owner decision (2026-11-27):** `playwright-core` 1.65.1 (the web e2e version) with its pinned `chromium-headless-shell`, and `@fontsource-variable/vazirmatn` 5.3.0, as api runtime dependencies.
- **Status / decisions (S11):**
  - [x] Done-when (`platform/documents/documents.int.test.ts`, real Chromium + PostgreSQL): a Persian document (sample template, `ir` layout, Jalali dates, Persian digits) renders warm in a median of 284 ms, worst 366 ms, first render 291 ms (development laptop); issuing writes the `doc_document` row, one audit row and one `platform.document.issued` outbox event in one transaction; the same inputs give byte-identical PDFs and the same file, different data or language give different bytes.
  - [x] Determinism: Chromium's PDF output differs between runs only in `/CreationDate` and `/ModDate` (spike); both are rewritten, at the same length, to the issue date. Byte identity holds for the same image (same Chromium build); across browser upgrades only the template fingerprint and the inputs hash are promised.
  - [x] Templates are code with id + version (like rule templates): `defineDocumentTemplate`, a fingerprint over body, CSS and data schema, golden files in `apps/api/documents-golden/` checked by `documents.golden.test.ts`; `pnpm documents:golden` writes missing ones and never overwrites. The platform ships only a test-only sample (`platform.sample_notice@1`); packs add theirs to `src/documents.catalog.ts`.
  - [x] Template language is our own and tiny (`render.ts`): escaped values only (no unescaped output), `#if`/`else`, `#each … as x`, `date` (jurisdiction calendar in `fa`, "27 November 2026" in `en`, no Intl so output cannot drift) and `digits`; a missing value throws, `null` prints nothing. No template-engine dependency.
  - [x] Chromium is locked down: JavaScript off, offline, every request aborted (a test with a remote image, stylesheet and CSS background makes zero requests), fonts inlined from the package's own CSS; one warm browser, at most 2 pages at a time, closed on shutdown.
  - [x] Layout: the frame (letterhead, number / date / attachment block, footer) belongs to the jurisdiction pack (`ir.letter@1`, contract `DocumentLayout`, optional field on `JurisdictionPack`, additive in v1); the issued record keeps the layout version too. Persian list counters in `fa`.
  - [x] Letterhead: setting `platform.documents.letterhead` (customer-wide or per company, no default: issuing without one fails). Logo upload `POST /platform/documents/letterhead-logo` (system admin; PNG or JPEG by magic bytes, ≤ 512 KB; SVG refused).
  - [x] Reading: `GET /platform/documents/:id/file` needs the new permission `platform.documents.read`, given to **auditor only** — not to the system administrator, who sees no business data (S1 decision; the S11 plan had said both). Owning modules use `contentAfterOwnCheck` after their own check.
  - [x] The file store moved from `connectors` to `platform/files` (`FilesModule`), unchanged; documents never delete. `doc_document` is insert-only (migration `0020_documents`).
  - [x] Deploy: the api image installs the pinned headless shell with its system libraries at build time (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`); CI's test job (GitHub and GitLab) installs the same; dev install line in `deploy/README.md`.
  - [ ] Open: on Windows a Vitest worker occasionally exits with a native fault (0xC0000409, the code of a native abort) while starting an integration file (seen in S10, S11 and S12, about 1 full run in 4, always in files that neither render documents nor use Bale, e.g. `audit-replay`, `changes`); a rerun passes. It happens while the worker is starting a file, which points at a native module (e.g. the SWC transformer) rather than our code. Not seen in CI (Linux). If it shows up in CI, run the int project with a single fork.

## S12 — Bale channel and identity (platform)
- Bale Bot API adapter behind `Channel` (ADR-010): long polling (outbound only, no inbound port on the customer server), inline keyboards, contact share, document send; retries through `pg-boss`.
- Linking: shared contact → match on the `people` contact number (through a port) → one-time code in the bot → stored channel link. An employee user is created on first link if none exists.
- Web login's one-time code can go through Bale (closes R1's "no real OTP channel").
- **Done when:** against a fake Bale server in tests, a new employee links and receives a message and a PDF; an unknown number is refused without revealing who exists; a lost update is retried, never sent twice.
- **External dependency:** Fanap IT — bot token, outbound access from the server to the Bale API.
- **Product-owner decisions (2026-11-27):** (1) **verified contact only** — the bot accepts a shared contact only when Bale says it is the sender's own number (contact `user_id` = sender, private chat); no extra one-time code, because a code sent back to the same chat adds no security (this replaces "shared phone + one-time code" in the R2 decisions above). (2) **Employed people only** — the number must match people employed today, at most one per company (several companies possible); a number matching nobody, a leaver, or two employed people of one company gets the same neutral "not found, contact HR".
- **Status / decisions (S12):**
  - [x] Done-when (`platform/channels/bale.int.test.ts`, fake Bale server on localhost + PostgreSQL, 9 tests): `/start` gets the share button; sharing one's own number creates the user (`bale-<chat>`, no usable password), the channel link and the people links in both companies the person works for, audited, and replies "linked"; messages then reach that chat; an existing login linked to the person is reused and its web login code now arrives in Bale; a forwarded contact gets "only your own number"; unknown, leaver and ambiguous numbers get the identical "not found"; after 5 failed attempts in 24 h a chat gets "too many"; a redelivered update has no second effect and polling resumes from the stored offset; a second poller cannot take the lock; a 429 is retried and delivered once; a 401 is not retried and its error never contains the token; text from linked users goes to the registered inbound handler (for S13).
  - [x] Architecture: the platform knows no people. `ChannelIdentities` is a port in `platform/channels/identity.ts`; `people` registers `PeopleChannelIdentity` (finds employed people by normalized number, links through its own writer, so it stays the single writer of `people_user_link`). Phone numbers are normalized with the jurisdiction's `phoneCountryCode` (contract field added in v1, `ir` = `98`).
  - [x] Polling: long polling (outbound HTTPS only), one poller per deployment by a PostgreSQL session advisory lock, offset in `channels_poll_state`, each update recorded in `channels_update` in the same transaction as its effect; replies after the commit (a crash can lose a reply, never repeat an effect).
  - [x] Sending: immediate, up to 3 attempts on network errors, 5xx and 429 (`retry_after` honoured). **Not queued in pg-boss**, unlike the slice text above: a queue would keep one-time codes at rest. Best effort, like `UserNotifier`; a retried send may rarely arrive twice. `Channel` gained an optional `sendDocument` (Bale and stub).
  - [x] Stored: chat ids (`channels_link`), processed update ids, the poll offset, and link attempts (chat, time, outcome) for the rate limit. No phone numbers, no message texts. Token and API URL from the environment (`EVE_BALE_BOT_TOKEN`, `EVE_BALE_API_URL`); no token, no Bale.
  - [x] Users: `UserService.createChannelUser` and `setContact` (internal, audited; the contact address itself is not written to the audit). Linking a user who already has a login (e.g. an HR expert) reuses it and moves their login codes to Bale.
  - [x] No new dependencies (native `fetch`, `FormData`, `Blob`).
  - [ ] Open: not yet run against the real Bale API (needs the bot token and outbound access from Fanap IT).
  - [ ] Open: a person who leaves keeps their Bale link; modules check employment on each request (decision 2026-11-27). Ending links when someone leaves can come with S17.
  - [ ] Open: messages are Persian only; users carry no language preference yet.

## S13 — Conversation, router and LLM gateway (platform)
- `platform/router`: conversation state per user and channel in PostgreSQL (resumable after restart); packs register intents (menu entry, handler) the way they register approval types — the platform knows no domain. Unknown text gets the menu.
- `platform/llm`: OpenAI-compatible client (endpoint and model in config); refuses fields labelled sensitive in contracts (CLAUDE.md rule 13); records tokens in `usage` and a call trace (prompt id + hash).
- Intent classifier used only when a model is configured, with a confidence threshold that falls back to the menu. Agent test set: about 20 Persian phrasings per intent, in the repo.
- **Done when:** with no model everything works by menu; with a fake model free text routes; a sensitive field never leaves the gateway (test).

## S14 — People additions (pack `people`)
- Fields that letters, leave and the calendar need, e.g. national ID and father's name (`ir` legal fields for a person), contract type, contract end, probation end, mobile number. Bulk update through the existing people import (S4).
- **Waits on:** the field list from specs 44, 50 and 47 (R1 open item "personnel fields beyond S4").

## S15 — Letters and certificates (pack `letters`, module 44) — waits on spec 44
- Request from Bale or web → the letter type's rule decides automatic or HR approval (approval type `letters.issue`) → number from the company's letter register → PDF (S11) → delivered in Bale and on the web.
- Data through ports only: person (`people`), current position and unit (`org`). No amounts in R2.
- Register for HR: every letter with number, type, template version, requester, approver and a verification code printed on the letter.

## S16 — Leave (pack `leave`, module 50) — waits on spec 50
- Leave types and entitlements as rule templates + parameters (ADR-005), e.g. `leave.annual_entitlement@1`, `leave.request_allowed@1`; Fanap's regulation = parameters, with positive and negative cases.
- Balance = append-only ledger with effective dates (accrual, use, carry-over, expiry). Opening balances by file import (connectors pipeline). Not pay data: one time axis (ADR-009).
- Request → line manager approval; the approver from `get_manager` through a port (acting supervisors included); the approver sees the balance and team overlap.
- Approved leave emits `leave.approved`; monthly export file for the payroll/attendance tool (attendance itself, module 48, is phase 2).
- **Waits on:** spec 50, incl. whether missions are in R2 and how opening balances are obtained.

## S17 — Front door (pack `front_door`, module 41 simple) — waits on spec 41
- One conversation in Bale and web chat: menu to letters and leave, "my balance", "status of my requests".
- Handoff to an HR expert with a summary (template; LLM-written only with a configured model and no sensitive data); HR referrals inbox; status messages until the request closes.
- Labour-law questions are referred to the expert until module 52 (R4), as the amendment says.

## S18 — Compliance calendar (pack `compliance_cal`, module 47) — waits on spec 47
- Deadline catalog: legal deadlines from `packages/jurisdictions/ir` (e.g. monthly insurance list, tax, the yearly wage decree) and internal ones per company, each with an owner.
- Per-person alerts: contract end and probation end (S14), to the manager and HR.
- Weekly task list for HR; reminders in Bale (`pg-boss` schedule).

## S19 — Web for R2
- Web chat (same router as Bale); "my requests" for employees.
- HR pages: letters register, leave admin (balances, imports, requests), referrals inbox, compliance week.
- Manager approvals through the existing ApprovalChain.
- The chart moves to its own code chunk (closes R1's "bundle > 500 kB").

## S20 — R2 acceptance
- `pnpm acceptance` gains the R2 criteria: Bale usage share and cycle times from the usage report, against the R1 baseline; leave rule cases.
- Pilot measurements stay "waiting" until real. Tag `v0.2.0`.

## Carried from R1
- [ ] The two pilot companies (names) and their anonymized files → `ACCEPTANCE_DIR=<folder> pnpm acceptance`.
- [ ] Baseline timings from the HR team — **needed before S20** can compare.
- [ ] May an employee see their manager's (and approval chain's) names? **Needed by S16 and S17:** the leave approver is the manager.

## Open questions (owner)
- Fanap IT: Bale bot token, outbound access to the Bale API, test accounts (S12).
- HR: answers to the marked questions in specs 44, 50, 41 and 47 (each spec lists them).
- Product owner: GPU server and model timing, which only decides when free-text routing is switched on (S13).
- Product owner: approve `playwright-core` + Chromium in the api image (S11).

## Spec status
| Module | Spec | Status |
| --- | --- | --- |
| 44 `letters` | `docs/modules/HR-Ops-Module-44-Letters-Spec.md` | draft 0.1, waiting for HR |
| 50 `leave` | to write | — |
| 41 `front_door` | to write | — |
| 47 `compliance_cal` | to write | — |

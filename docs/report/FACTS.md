# Facts behind the progress report

Every number in `HAVEN-Progress-Report.pdf` and where it comes from. Repository state:
`main` at `24aaa59` (19 October 2026), before the report's own commit. Commands are run
from the repository root.

## A. Counted from the repository

`python docs/report/scripts/facts.py` reproduces every row marked **(facts.py)**.

| Number in the report | Value | Source |
|---|---|---|
| Commits on main | 78; first `3ca4c08` 2026-10-01, last `24aaa59` 2026-10-19 | `git rev-list --count main`; `git log` **(facts.py)** |
| Lines of code | 52,229 total (`.ts .tsx .sql .mjs`, tracked, excluding `docs/report`); API src 16,633; API tests 12,029; app 11,918; shared 3,570; SQL 1,861 | `git ls-files` + line count **(facts.py)** |
| API endpoints | 86 unique method + path | route registrations in `apps/api/src` (non-test) **(facts.py)** |
| App screens | 43 route files, layouts excluded | `apps/mobile/app/**/*.tsx` **(facts.py)** |
| Migrations / tables | 20 / 25 tables in schema `haven` | `supabase/migrations` **(facts.py)** |
| Decisions | 25 (DEC-001..DEC-025) | `docs/DECISIONS.md` **(facts.py)** |
| Scheduled jobs | 11 (8 SQL functions + `media_purge`, `push_receipts`, `account_deletion`) | `apps/api/src/jobs/runner.ts` **(facts.py)** |
| Notification kinds | 20 | `N-…` kinds in `packages/shared/src`, `apps/api/src/notify` **(facts.py)** |
| Outbox worker | every 2 s, 50 rows per claim | `apps/api/src/notify/worker.ts` |
| Visit states / transitions | 8 / 19 | `VISIT_TRANSITIONS` in `apps/api/src/visits/stateMachine.ts` |
| Gate token | new step every 10 s; accepted −1…+2 steps (≤ 30 s); 80-bit MAC (first 10 bytes of HMAC-SHA256) | `apps/api/src/gate/token.ts` (`STEP_MS`) |
| Scan session | 10 minutes | `apps/api/src/gate/scanSessions.ts` |
| Geofence | haversine; GPS fix ≤ 60 s old; default radius 50 m | `apps/api/src/gate/geofence.ts`; `gates.radius_m default 50` in the init migration |
| Access / refresh tokens | 15 min (HS256, algorithm pinned) / 30 days, rotated, reuse detection | `apps/api/src/auth/jwt.ts`, `apps/api/src/auth/sessions.ts` |
| Photos | ≤ 3 MB, EXIF stripped, max 720 px, 120 s signed links | `apps/api/src/gate/media.ts`, `apps/api/src/media/routes.ts`, `media/signing.ts` |
| Append-only tables | gate_events, approvals, hostel_rules, audit_log | `forbid_mutation()` triggers in `supabase/migrations` |
| Audit trigger tables | visits, residents, role_assignments | `audit_row()` triggers in `supabase/migrations` |
| Storage buckets | 3: `gate-photos`, `visitor-photos`, `resident-docs` | `apps/api/src` media storage |
| Business-rule values (20:00, 22:00, 3 nights, ₹50, ₹150, 3 guests, 10 min, 15 min, 7 / 30 days, ₹400, 12:00, 30 min) | GH-8 rules version 1 | `GH8_RULES_CONFIG_V1` in `packages/shared/src/rules`; SDD §4.2 |
| Retention periods | 1 day, 1 day, 180 days, 365 days, on decision, 2 years | SDD §16.3 / §16.5; `job_retention()` (DEC-015) |
| Threats T1–T16 and residual risk | as in SDD | SDD §16.1 |
| Visit types, roles, flows F1–F11, BR-01..BR-20 | as in SDD | SDD §3, §4.1, §4.2, §6 |
| SDD length | 123 pages | `docs/HAVEN — Software Design Document v3.pdf` (page count) |
| Requirement totals 50 FR, 14 NFR, 20 BR, 24 E, 51 TC | item counts used by the QA review | `docs/FINAL-QA-REPORT.md`, Summary (TC-RULE-01..11 counted as 11) |

## B. From test runs (20 October 2026, Windows, local)

| Number | Value | Command |
|---|---|---|
| API tests | 52 files, 888 tests, all passed | `pnpm test -- --force` (no Turbo cache) |
| — of which unit | 22 files, 409 tests (incl. 270 state-machine cases) | files under `apps/api/src` (`*.test.ts`) in the same run |
| — of which integration/contract | 30 files, 479 tests | files under `apps/api/test` in the same run |
| Shared package | 13 files, 158 tests | same run |
| App (jest-expo) / UI package | 5 suites, 21 tests / 1 file, 1 test | same run |
| End-to-end | 31 passed (Chromium, incl. `qr-camera` and `late` projects) | `pnpm e2e` |
| Database (pgTAP) | 4 files, 35/35 (001: 15, 002: 8, 003: 5, 004: 7) | local pgTAP harness on embedded PostgreSQL with every migration (as in FINAL-QA-REPORT); CI uses `supabase test db` |
| Total "1,068 unit and integration" | 888 + 158 + 21 + 1 | sum of the rows above |

## C. From the audit reports

| Number | Value | Source |
|---|---|---|
| Requirement verdicts after remediation | 159 items: 142 PASS, 0 FAIL, 9 PARTIAL, 8 NOT TESTABLE; per category FR 47/0/3/0, NFR 2/0/5/7, BR 20/0/0/0, E 22/0/1/1, TC 51/0/0/0 | `docs/FINAL-QA-REPORT.md`, Summary |
| Verdicts at the audit (`b49b994`) | 116 / 6 / 29 / 8 | same |
| Critical defects | 5 (D-01..D-05), all fixed with regression tests | FINAL-QA-REPORT, Critical defects and Remediation |
| Security findings | SA-01..SA-33 (33) + SA-M1..M4 (4). HIGH 3/3 fixed; MEDIUM 11, 10 fixed (SA-12 scheduled); LOW 12, 9 fixed (14, 15, 16, 17, 19, 20, 21, 32, 33), SA-18 and SA-23 accepted, SA-22 false positive; INFO 7, 1 fixed (tests) | `docs/SECURITY-AUDIT.md`, Summary table |
| "17 of the first 20 security tests failed before the fixes" | 17 | SECURITY-AUDIT, "Proof the regression tests are real" |
| Audit date | 18 October 2026 | SECURITY-AUDIT header |

Note: SECURITY-AUDIT's "Final status" table says LOW "8 (+1 false positive)" fixed, but its
own Summary rows mark nine LOW findings fixed. The report uses the per-finding rows (9).

## D. Statements about what is and is not done

| Statement | Source |
|---|---|
| Rehearsed live on real Android phones, 19 Oct 2026 | the live rehearsal; `apps/api/test/server-time-header.integration.test.ts` and NEXT-PHASE.md refer to it |
| Not deployed; no real SMS, Google sign-in or Android build; not measured: performance, accessibility, other browsers | `docs/NEXT-PHASE.md`; FINAL-QA-REPORT "Remaining gaps" |
| DEC-013 accepted deviation (second scan) | `docs/DECISIONS.md` DEC-013 |
| Map preview (FR-56) and G-16 screenshots not built; F4 has no browser-level test | NEXT-PHASE.md "Also known"; FINAL-QA-REPORT |
| TanStack Query, React Hook Form, native Google sign-in library not used | no dependency in `apps/*/package.json`, `packages/*/package.json` |
| CI steps (lint, types, tests, build, prod start, pgTAP, Playwright, audit) | `.github/workflows/ci.yml` (not yet run on GitHub: the repository has not been pushed) |

## E. Screenshots and diagrams

- Screenshots: `node docs/report/scripts/capture-screenshots.mjs` on 20 October 2026. It
  resets and starts `pnpm demo` with the gate forced to the placeholder location
  12.9716, 77.5946 (radius 150 m), sets the demo clock to 13:00 IST and seeds the demo
  visits around that time (`DEMO_SEED_AT`). Seeded, fictitious people only; SDD test
  phone numbers; Chromium's fake camera and fake GPS.
- Two desktop screenshots are cropped (`scripts/build_report.py`, `prepare()`) above
  timestamps written by the database's own `now()` — the visit's "Approved" row and the
  rules' "Published" line — because they show the real time of the run, not the 13:00
  demo clock. In a real deployment both clocks agree (DEC-025).
- Diagrams: sources in `docs/report/diagrams/*.mmd` (Mermaid 11.4.1) and `*.dot`
  (Graphviz via `@viz-js/viz`), drawn from the code paths named in each file's header.

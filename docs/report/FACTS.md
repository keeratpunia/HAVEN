# Facts behind the progress report

Every number in `HAVEN-Progress-Report.pdf` and where it comes from. Repository counts
(section A) are taken at `24aaa59` (19 October 2026), the last commit before work on the
report began; later commits only add the report and the FR-23 fix (`caa7d50`). Commands are run
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

## B. From test runs (21 October 2026, Windows, local, after the FR-23 fix)

| Number | Value | Command |
|---|---|---|
| API tests | 52 files, 889 tests, all passed | `pnpm test -- --force` (no Turbo cache) |
| — of which unit | 22 files, 409 tests (incl. 270 state-machine cases) | files under `apps/api/src` (`*.test.ts`) in the same run |
| — of which integration/contract | 30 files, 480 tests (479 on 20 Oct + the FR-23 regression test) | files under `apps/api/test` in the same run |
| Shared package | 13 files, 158 tests | same run |
| App (jest-expo) / UI package | 5 suites, 21 tests / 1 file, 1 test | same run |
| End-to-end | 31 passed (Chromium, incl. `qr-camera` and `late` projects) | `pnpm e2e` |
| Database (pgTAP) | 4 files, 35/35 (001: 15, 002: 8, 003: 5, 004: 7) | local pgTAP harness on embedded PostgreSQL with every migration (as in FINAL-QA-REPORT); CI uses `supabase test db` |
| Total "1,069 unit and integration" | 889 + 158 + 21 + 1 | sum of the rows above |

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
| CI passed on GitHub, 19 Oct 2026, commit `24aaa59` (run 39300456508): every step succeeded; pgTAP `Files=4, Tests=35, Result: PASS`; Playwright steps skipped (they run only on pull requests) | `gh run list`, `gh run view 39300456508 --json jobs`, job log |
| Table 3.1 permissions | SDD §3.3 matrix, narrowed by DEC-014; checked against `apps/api/src/admin/policy.ts` (e.g. `admin.charges.waive: warden` only; super admin: visits read, residents verify/suspend, bans, rules, gates, audit, hostels, warden invites; no dashboard, emergency, approvals, reports, force check-out) |
| Table 10.1 (old Phases 1–4) | the old plan: `docs/report/previous-report.pdf` §8.2–8.5; status from Chapter 2's sources, `docs/NEXT-PHASE.md`; "Dark mode: not built" from `packages/ui/src/tokens.ts` (light theme only) |
| Table 7.3 hardware | SDD §2.5–2.6, §20 (hosting), NEXT-PHASE.md; the demo setup (`pnpm demo`) |
| End-to-end flow coverage (Chapter 9) | FINAL-QA-REPORT "Flow coverage", updated by its Remediation (F8 `gate-pairing.spec.ts`, F10 `late-flows.spec.ts`, F3 `gate-retry-and-walkin.spec.ts` FR-27 test) |
| PHOTO_REUSED shows "Something went wrong" | no `PHOTO_REUSED` key in `packages/shared/src/copy/en.ts`, so `copyFor` falls back to the generic text; seen during the screenshot capture |

## E. Screenshots and diagrams

- Screenshots: `node docs/report/scripts/capture-screenshots.mjs` on 20 October 2026. It
  resets and starts `pnpm demo` with the gate forced to the placeholder location
  12.9716, 77.5946 (radius 150 m), sets the demo clock to 13:00 IST and seeds the demo
  visits around that time (`DEMO_SEED_AT`). Seeded, fictitious people only; SDD test
  phone numbers; fake GPS. Chromium's fake camera plays a synthetic illustrated face per
  guest (`scripts/fake_faces.py`, flat shapes, not a photo of anyone) through
  `--use-file-for-fake-video-capture`; every frame differs slightly so the API's duplicate-photo
  check (PHOTO_REUSED) does not refuse it. Captured 21 October 2026.
- Figure 17: (a) the demo clock moved to 20:05 for a walk-in (BR-02); (b) a gate token 12
  steps (2 minutes) old; (c) GPS placed about 1 km from the gate, three attempts; (d) a guest
  banned by the warden in the same run, then refused at the gate.
- Figure 18 (gate display) is cropped to the QR, countdown bar and instruction; they are in
  `apps/mobile/app/gate/index.tsx`, covered by `test/gate-logic.test.ts` (countdown) and
  `e2e/tests/gate-pairing.spec.ts` (instruction text).
- Two desktop screenshots are cropped (`scripts/build_report.py`, `prepare()`) above
  timestamps written by the database's own `now()` — the visit's "Approved" row and the
  rules' "Published" line — because they show the real time of the run, not the 13:00
  demo clock. In a real deployment both clocks agree (DEC-025).
- Diagrams: sources in `docs/report/diagrams/*.mmd` (Mermaid 11.4.1) and `*.dot`
  (Graphviz via `@viz-js/viz`), drawn from the code paths named in each file's header.

## F. Plain-language version (27 October 2026)

The report is now written to be read on its own, without the design document or the
repository. Internal codes were replaced by plain words; the facts behind them are
unchanged. This table maps the report's wording back to the records above.

| Report wording | Source / code it replaces |
|---|---|
| "159 items: 50 features, 14 quality targets, 20 hostel rules, 24 unusual situations, 51 test scenarios" (Table 1.1, 9.2) | 50 FR, 14 NFR, 20 BR, 24 E, 51 TC (FINAL-QA-REPORT Summary) |
| "a detailed design document" (1.1, the only mention) and "Design document authoring" (Table 10.2, wording set by the team) | SDD v3 |
| Key decisions, 2.2: arriving early; demo sign-in; second scan for new walk-ins; office staff; background work; security review; deployment; privacy; small cases | DEC-006; DEC-011; DEC-013; DEC-014; DEC-015/016; DEC-018; DEC-019/021; DEC-020; DEC-022/023/025 |
| Table 2.1 reasons | SDD §2.3, §2.5, §2.7 (D2, D4–D8, D10, D11), §4, §16.3 |
| Table 3.1 super admin row ("the team kept … with the warden only") | DEC-014 items 3–5; `apps/api/src/admin/policy.ts` |
| Table 6.1 threats (in order) | T2, T3/T4, T5, T7, T10, T11, T13, T15, T1 (SDD §16.1) |
| Table 6.2 "Not fixed": web security settings; notification sign-up case; developer-only tools; false alarm | SA-12; SA-18; SA-23; SA-22 |
| "Photo handling" row in Table 6.2 | SA-M1..M4 |
| Table 6.3 "deleted automatically every night" | `job_retention()` at 03:00 |
| 5.4 "any other move is refused" | 409 `INVALID_TRANSITION`, `apps/api/src/visits/stateMachine.ts` |
| 5.5 "one-time random number", "safe to resend" | scan nonce (`X-Scan-Nonce`); `Idempotency-Key` |
| 5.7 "eight run inside the database and three in the server" | 8 SQL jobs (pg_cron on Supabase, otherwise the API's job runner) + `media_purge`, `push_receipts`, `account_deletion` |
| 9.1 "Journeys with end-to-end tests" | flows F1–F11, named in words with their Chapter 4 codes |
| 9.1 CI run on 19 October 2026 | run 39300456508, commit `24aaa59` (section D) |
| 11 "a photo refused as a duplicate … 'Something went wrong'" | `PHOTO_REUSED` has no guest wording (section D) |
| Diagram labels in plain words (Figures 5, 7, 8, 9, 10, 12) | same steps as before; e.g. "check sign-in pass" = JWT check, "permission check" = `authorize()`, "waiting for host" = `pending_host` |

Figure 11 (database tables) still shows the real table and column names, because it is a
picture of the database itself; the text around it explains what it shows.

Table 2.2 (Key Terms) is new; its values (10 s / 30 s code, 10-minute scan session, 50 m circle, 6-digit OTP) are from section A.

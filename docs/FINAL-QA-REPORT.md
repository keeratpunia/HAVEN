# HAVEN — Final QA report

**Role:** independent QA lead. TRACEABILITY.md and DECISIONS.md were not trusted;
each requirement was checked in code and tests at commit `b49b994`.

**Method:**
- Requirements were read from the SDD PDF (§4.2, §5, §17.1, §17.3, §19.2).
- Each implementation and its tests were located by reading code and searching by
  behaviour.
- Suspected defects were confirmed with throwaway probe tests against the real API
  and database (not committed).

**Date:** 2026-10-19.

**Verdicts:**
- **PASS:** the implementation meets the requirement as written and a test proves it.
- **PARTIAL:** implemented but incomplete, or untested.
- **FAIL:** missing or wrong.
- **NOT TESTABLE:** needs real devices, providers, infrastructure or people, as noted
  per row.

## Summary

| Category | Items | PASS | FAIL | PARTIAL | NOT TESTABLE |
|---|---|---|---|---|---|
| FR | 50 | 37 | 2 | 11 | 0 |
| NFR | 14 | 2 | 0 | 5 | 7 |
| BR | 20 | 19 | 1 | 0 | 0 |
| E | 24 | 11 | 2 | 10 | 1 |
| TC | 51 | 47 | 1 | 3 | 0 |
| **All** | **159** | **116** | **6** | **29** | **8** |

TC-RULE-01..11 is one row counted as 11 cases (the SDD's §19.2 groups them).

**Accepted deviations** (not marked FAIL):
- DEC-013: a first-time guest who signs up mid-scan scans the QR once more
  (FR-21, FR-25, §9.3/F2).
- DEC-016: N-DIGEST is a team-approved catalogue addition (FR-60), and the overstay
  SMS uses the §15.3 DLT text instead of §15.2.
- DEC-018: the test-OTP phones are allowed in staging per §9.5.
- DEC-006: TOO_EARLY uses the 30-minute rule over the SDD's contradictory worked
  example.

## Checks run during this audit

| Check | Result |
|---|---|
| `pnpm typecheck` | 4/4 packages pass |
| `pnpm lint` | 4/4 packages pass (0 warnings) |
| `pnpm format:check` | clean |
| API tests with coverage (`vitest --coverage`) | 845/845 pass; lines 89.4 %, branches 75.9 %, statements 87.0 % |
| `packages/shared` rules engine coverage | 152/152 pass; 100 % statements, branches, functions and lines |
| mobile jest / ui | 10/10, 1/1 |
| Playwright (Chromium, full suite, fresh DB) | 21/21 pass |
| `pnpm build` (API `tsc`, Expo `expo export`) | exit 0 |
| Expo web export | **succeeds**: `apps/mobile/dist` (entry bundle 2.8 MB, index 540 KB) |
| API production start (`node apps/api/dist/server.js`) | **fails**: `ERR_MODULE_NOT_FOUND` for `packages/shared/src/rules/index.js`. `@haven/shared` publishes only TypeScript sources (`main: ./src/index.ts`); everything else runs through `tsx`. |
| QA probe: day walk-in at 20:30 IST | accepted 201 → approved 200 → `inside` (**BR-02 defect**) |
| QA probe: quick drop-off walk-in at 22:30 IST | 422 WINDOW_INVALID (BR-03 holds) |
| pgTAP DB tests (`supabase/tests`) | **not run anywhere**: CI step commented out, embedded Postgres has no pgTAP |
| CI (`.github/workflows/ci.yml`) | would fail today at `pnpm audit --audit-level high` (2 accepted, unpatched dev-tooling advisories); Playwright and pgTAP steps are commented out |

## Flow coverage (SDD §6, Playwright)

| Flow | Coverage | Evidence / gap |
|---|---|---|
| F1 Pre-invite and check-in | **Full** | golden-path: claim → sign-in → profile → scan → photo → check-in → check-out |
| F2 Walk-in | **Full** | gate-retry-and-walkin (request) + resident-app (host approves, guest turns green; reject) |
| F3 Location unverified | **Partly** | guest reaches "Ask host to confirm" / awaiting confirmation; the host's confirm and the entry are API-tested only |
| F4 Host-assisted entry | **None** | fake camera can't present a QR to R-12; API-tested only |
| F5 Check-out | **Partly** | golden-path check-out; overnight step-out and unverified exit are API-tested only |
| F6 Overnight request | **Partly** | R-11 request, warden approval, office marks paid; sharing the invite after approval and the guest's stay are not e2e |
| F7 Resident onboarding | **Full** | resident-app R-01→R-04 and warden-office verification (different seeded residents) |
| F8 Gate pairing and location | **None** | D-01/D-02 pairing and W-09 Capture not in e2e |
| F9 Dispute | **Partly** | resident-app "Not my guest"; warden resolution is API-tested only |
| F10 Forgotten check-out | **None** | mark-left, overstay alerts and escalation are API-tested only |
| F11 Staff invite | **None** | invite creation API-tested; acceptance needs Google sign-in |

## Critical defects

Anything that breaks security, privacy, money or a core flow:

| ID | Defect | Impact | Evidence |
|---|---|---|---|
| D-01 | Walk-ins skip the entry rules: no AFTER_ENTRY_CUTOFF (20:00) for day/quick guests; F2 step 9's `evaluateEntry` is never run | Core-flow rule violation (BR-02, E-05): any walk-in between 20:00 and 22:00 is admitted | QA probe (201 → 200 → inside at 20:30 IST); `visits/service.ts` createWalkIn/approveWalkIn call only `evaluateCreate` |
| D-02 | Production API can't start | Nothing deploys: `node dist/server.js` crashes on `@haven/shared` TS sources | start check above |
| D-03 | Photos stored on local disk in production (`server.ts` → `LocalDiskMediaStorage`) | On Render the disk is ephemeral and per-instance: every check-in, profile and ID photo is lost on restart or deploy; §9.10 requires Supabase Storage private buckets | `apps/api/src/server.ts` |
| D-04 | SSE LISTEN uses `DATABASE_URL` (the transaction pooler per §11.7) | Live dashboard updates never arrive in production; falls back to 15 s polling (FR-50, NFR-04) | `app.ts` `new StreamHub(env.DATABASE_URL, …)`; `DATABASE_DIRECT_URL` exists but is unused |
| D-05 | Consent not recorded (`consent_version`/`consent_at` never written; no consent checkbox) and `PROFILE_INCOMPLETE` never enforced | DPDP §16.3 consent evidence missing; a guest can skip the 18+ confirmation by calling the API directly | `auth/routes.ts` PATCH /me; no `PROFILE_INCOMPLETE` anywhere |

**Other notable defects (not critical):**
- E-06: the gate lists only one approved visit.
- FR-23: check-in is offered for future-dated approved visits.
- E-10 / TC-FLOW-10: no Idempotency-Key replay on gate check-in, check-out and walk-in.
- FR-27: permission-denied doesn't offer the host-confirm path.
- E-03: no in-app-browser prompt.
- FR-08 and FR-22 are not built.
- pgTAP tests never run.
- CI is red on the audit gate.

## Recommended fixes (priority order)

| # | Fix | Size |
|---|---|---|
| 1 | D-01: run `evaluateEntry` for walk-ins at request (scan time) and at approval with `judgedAt = scan session created_at` (E-05); tests at 19:59 / 20:00 / 20:03-approval | S |
| 2 | D-02: build `@haven/shared` to JS (or bundle the API with tsup/esbuild) and add a CI step that starts `dist/server.js` and hits `/health` | S |
| 3 | D-05: consent checkbox on G-04 and R-03, store `consent_version`/`consent_at`; enforce `PROFILE_INCOMPLETE` on walk-in, check-in and claim | S |
| 4 | D-04: give the SSE hub `DATABASE_DIRECT_URL`; test that a pooled URL is rejected for LISTEN | S |
| 5 | D-03: `SupabaseMediaStorage` (private buckets, signed URLs per §9.10) behind the existing `MediaStorage` interface; refuse `LocalDisk` when `APP_ENV != local` | M |
| 6 | §9.12: `runIdempotent` on gate check-in, check-out and walk-in; TC-FLOW-10 test | S |
| 7 | E-06 / FR-23: return all of today's approved visits at this hostel and let the guest choose | S |
| 8 | CI: `pnpm audit --prod --audit-level high`; run pgTAP (supabase CLI) and Playwright in CI | M |
| 9 | FR-27: permission-denied → offer "Ask host to confirm" immediately | S |
| 10 | BR-03 copy: return AFTER_HARD_CUTOFF for walk-ins after 22:00 (fixed by #1) | S |
| 11 | E-03 in-app browser prompt; FR-22 guest scanner; FR-08 profile edit | M |
| 12 | Tests for untested-but-implemented items (FR-20, FR-30, FR-45, FR-56, E-04, E-14, E-17, E-20, E-23, E-24, TC-FLOW-02); F4/F8/F10 e2e | M |
| 13 | NFR evidence: Lighthouse + load test on staging, Safari/Samsung runs, axe audit | L |

## Requirements

### Functional (FR)

| ID | Requirement | Implementation | Test | Verdict | Notes |
|---|---|---|---|---|---|
| FR-01 | Guest sign-in by 6-digit SMS OTP, Indian mobiles | `api/src/auth/otp-service.ts` requestOtp/verifyOtp; `auth/phone.ts` | apps/api/test/otp-service, auth-routes; apps/mobile/e2e/tests/golden-path | PASS | Real SMS delivery needs MSG91 (console provider only). |
| FR-02 | First-time guest: name, gender, 18+, accept privacy notice, live profile selfie | `app/(guest)/profile.tsx`; `PATCH /me`, `POST /me/profile-photo` | apps/mobile/e2e/tests/golden-path | PARTIAL | No consent checkbox; `consent_version`/`consent_at` never stored (§16.3). Server never returns `PROFILE_INCOMPLETE` (§12.2), so an unfinished profile (incl. no 18+ confirmation) can still walk in / check in through the API. |
| FR-03 | Residents and staff sign in with Google | `auth/google-service.ts`, `auth/google.ts`; web `GoogleSignInButton.tsx` | apps/api/test/google-service (fake verifier) | PARTIAL | Server logic tested with a fake verifier. Native `@react-native-google-signin` not built. Real Google OAuth NOT TESTABLE here (needs client IDs). |
| FR-04 | Resident: phone OTP, room, live ID card + selfie, wait | `residents/routes.ts`, `(auth)/phone.tsx`, `onboarding.tsx`, `pending.tsx` | apps/api/test/resident-onboarding-visits; apps/mobile/e2e/tests/resident-app R-01→R-04 | PASS | Resident consent (R-03) not stored — see FR-02 note. |
| FR-05 | Warden approves/rejects resident; ID card deleted on decision | `admin/people-routes.ts` decide() | apps/api/test/staff-behaviour; apps/mobile/e2e/tests/warden-office | PASS |  |
| FR-06 | Office/warden invites by email, 48 h, email-bound | `admin/config-routes.ts` staff-invites; `google-service.ts` acceptance | apps/api/test/staff-behaviour (W-10), google-service | PASS | Acceptance in the app needs real Google sign-in (not testable here). |
| FR-07 | Deactivate staff / mark resident left; sessions end immediately | `admin/effects.ts` endAllSessions | apps/api/test/staff-behaviour FR-07, sessions | PASS |  |
| FR-08 | View/edit name, retake profile photo; resident photo changes logged | — | — | FAIL | Not built (priority S). PATCH /me edits name for users, but no retake/edit UI and no logged resident photo change. |
| FR-09 | Request account deletion (§16.6) | `account/routes.ts`, `account/deletion.ts`; `DeleteAccount.tsx` | apps/api/test/account-deletion; apps/mobile/e2e/tests/account-deletion | PASS |  |
| FR-10 | Verified host creates pre-invite | `visits/host-routes.ts` POST /visits, `host-actions.ts` | apps/api/test/resident-onboarding-visits, host-routes; apps/mobile/e2e/tests/resident-app | PASS |  |
| FR-11 | Share invite via share sheet | `components/SharePanel.tsx`; POST /visits/:id/invite-link | apps/mobile/e2e/tests/resident-app R-06→R-07 | PASS | Native share sheet not executed (Android). |
| FR-12 | Invite link requires OTP to the invited number | `auth/invites.ts` claimInvite | apps/api/test/invites, auth-routes (INVITE_PHONE_MISMATCH); apps/mobile/e2e/tests/golden-path | PASS |  |
| FR-13 | Host edits window or cancels until check-in | PATCH /visits/:id, POST /visits/:id/cancel | apps/api/test/resident-onboarding-visits | PASS |  |
| FR-14 | Overnight/guest-room request with quota + charge preview | POST /visits/preview, POST /visits (overnight) | apps/api/test/resident-onboarding-visits; apps/mobile/e2e/tests/resident-app R-11 | PASS |  |
| FR-15 | Warden approves/rejects; approval creates pending charge | `visits/service.ts` approveOvernight | apps/api/test/visits-service, resident-onboarding-visits; apps/mobile/e2e/tests/warden-office | PASS |  |
| FR-16 | Host sees all visits with status and charges | GET /me/hosted-visits, /visits/:id, /me/charges | apps/api/test/resident-onboarding-visits | PASS |  |
| FR-20 | Gate QR (https://<web>/g/<token>) every 10 s, countdown, hostel name, instruction | `app/gate/index.tsx`, `lib/gateToken.ts` | — (no test of the display page) | PARTIAL | Implemented as specified on reading; no automated test. |
| FR-21 | Scan opens guest app; location + token + GPS validated first | `gate/scanSessions.ts`, `(guest)/g/[token].tsx` | apps/api/test/gate-routes; apps/mobile/e2e/tests/golden-path, gate-errors | PASS | Accepted deviation DEC-013 (rescan after mid-scan sign-up). |
| FR-22 | In-app scanner on the guest home screen | `components/QrScanner.tsx` exists, used only by R-12 | — | FAIL | Not offered to guests (priority S). |
| FR-23 | Offer Check in (approved visit today) / Check out / Request entry | GET /scan-sessions/:id (`gate/routes.ts`) | apps/api/test/gate-routes; apps/mobile/e2e/tests/golden-path, gate-retry-and-walkin | PARTIAL | Approved visit is not limited to *today* (a future approved visit is offered Check in, then refused TOO_EARLY); only the first approved visit is offered (see E-06). |
| FR-24 | Live front-camera photo, never a file picker | `components/LiveCamera.tsx`, `gate/media.ts` | apps/api/test/media, gate-routes; Playwright fake camera | PASS | No file input anywhere in the app (grep). |
| FR-25 | Walk-in: room search (first name + initial), type, duration, live photo | GET /hostels/:id/rooms/:n/residents, POST /scan-sessions/:id/walk-in | apps/api/test/security SA-01, gate-routes; apps/mobile/e2e/tests/gate-retry-and-walkin | PASS | Accepted deviation DEC-013. See BR-02 for the cutoff defect on this path. |
| FR-26 | Live waiting screen turns green on approval without rescan | `(guest)/g/[token].tsx` waiting phase (3 s poll) | apps/mobile/e2e/tests/resident-app (approval turns guest green) | PASS |  |
| FR-27 | 3 GPS failures OR permission denied → ask host to confirm | `(guest)/g/[token].tsx`, awaiting_host_confirmation | apps/api/test/gate-routes; apps/mobile/e2e/tests/gate-retry-and-walkin | PARTIAL | 3-failure path works and is tested. Permission denied does NOT offer "Ask host to confirm" immediately — it is treated as one failed attempt. |
| FR-28 | Host-assisted entry/exit from the resident app | POST /scan-sessions/:id/host-assisted-entry\|exit; `(resident)/assist.tsx` | apps/api/test/gate-routes, resident-approvals-notifications | PARTIAL | API tested. R-12 UI has no e2e (fake camera cannot show a QR); native path never executed. |
| FR-29 | Heartbeat 60 s; warden sees status; alert after 5 min offline | `gate/devices.ts`, `job_gate_offline`, W-01/W-09 | apps/api/test/gate-routes, staff-behaviour, jobs-runner | PASS |  |
| FR-30 | Gate keeps screen awake and recovers after network loss | `app/gate/index.tsx` (wakeLock, heartbeat backoff) | — | PARTIAL | Implemented; no automated test. |
| FR-40 | Host push per walk-in with photos, name, type, duration; approve (adjust end) / reject | N-WALKIN; R-08 `walk-in/[id].tsx` | apps/api/test/resident-approvals-notifications; apps/mobile/e2e/tests/resident-app | PASS | Android push delivery not executed. |
| FR-41 | SMS if push unopened in 60 s | outbox + worker | apps/api/test/notification-worker (59 s/60 s) | PASS | Console SMS only. |
| FR-42 | Push per check-in with photo compare; Yes / Not my guest for 30 min | N-ARRIVED; R-09 | apps/api/test/resident-approvals-notifications; apps/mobile/e2e/tests/resident-app | PASS |  |
| FR-43 | Not my guest → disputed, warden push + SMS immediately | POST /visits/:id/dispute | apps/api/test/resident-approvals-notifications (TC-FLOW-06) | PASS |  |
| FR-44 | Host push on check-out and on overstay | N-LEFT, N-OVERSTAY-HOST | apps/api/test/jobs-runner, templates | PASS |  |
| FR-45 | Host marks "My guest has left" (logged, flagged to warden) | POST /visits/:id/mark-left; admin flag filter host_marked_left | apps/api/test/resident-approvals-notifications | PARTIAL | Host side tested; the warden-side flag/filter has no test. |
| FR-50 | Dashboard live counts/lists, updates within 5 s | GET /admin/dashboard; SSE `stream/` | apps/api/test/staff-behaviour (SSE); apps/mobile/e2e/tests/warden-office (≤ 8 s) | PARTIAL | Works locally. In the SDD deployment the SSE LISTEN connection uses DATABASE_URL (the transaction pooler, §11.7) where LISTEN does not work — live updates would silently fall back to 15 s polling (see D-04). |
| FR-51 | Emergency roll call, printable/exportable | GET /admin/emergency (JSON/CSV); W-03 | apps/api/test/staff-behaviour | PASS |  |
| FR-52 | Visit detail timeline with photos, GPS distance, notifications, flags | GET /admin/visits/:id; W-05 | apps/api/test/staff-behaviour, media (warden sees photo) | PASS |  |
| FR-53 | Force check-out with reason | POST /admin/visits/:id/force-checkout | apps/api/test/visits-service, staff-behaviour; apps/mobile/e2e/tests/warden-office | PASS |  |
| FR-54 | Ban guest (hostel/all, dated/permanent); suspend hosting until date | `admin/people-routes.ts` | apps/api/test/staff-behaviour; apps/mobile/e2e/tests/warden-office | PASS |  |
| FR-55 | Rules form; each save a new version | GET/PUT /admin/rules | apps/api/test/staff-behaviour | PASS |  |
| FR-56 | Pair/revoke devices; set gate location (avg of 5) | `admin/config-routes.ts`; W-09 `gates.tsx` | apps/api/test/staff-permissions | PARTIAL | Averaging untested; F8 step 4 map preview not built; pairing UI flow (D-01) not in e2e. |
| FR-57 | Search visits; CSV export | GET /admin/visits, /admin/reports/visits.csv | apps/api/test/staff-permissions, staff-behaviour | PASS |  |
| FR-58 | Audit log filtered by actor/entity/date | GET /admin/audit | apps/api/test/staff-behaviour | PASS |  |
| FR-59 | Office charges: confirm, mark paid w/ receipt; warden waive/fine | `admin/charges-routes.ts`; O-01 | apps/api/test/staff-behaviour; apps/mobile/e2e/tests/warden-office | PASS |  |
| FR-60 | Daily 08:00 digest to warden | `haven.job_daily_digest` | apps/api/test/jobs-runner (FR-60) | PASS | N-DIGEST text is a team-approved addition (DEC-016), not SDD §15.2 text. |
| FR-70 | Walk-ins expire after 10 min; guest and host told | `job_expire_walkins`; guest page expired state | apps/api/test/jobs-runner (BR-12), resident-approvals-notifications | PASS | Guest-side expired screen has no e2e. |
| FR-71 | Approved never-entered visits expire at window_end | `job_expire_approved` | apps/api/test/jobs-runner (FR-71) | PASS |  |
| FR-72 | Overstay detection every 5 min; host + guest; warden after 30 min | `job_flag_overstays` | apps/api/test/jobs-runner (BR-13/FR-72) | PASS |  |
| FR-73 | 22:00 night sweep of day/quick guests | `job_night_sweep` | apps/api/test/jobs-runner (TC-JOB-02) | PASS |  |
| FR-74 | Every state change and admin action in append-only audit log | `audit_row()` triggers; `admin/audit.ts` | apps/api/test/staff-behaviour (audit), retention (append-only) | PARTIAL | Implemented; the trigger/PII-stripping tests are pgTAP files (`supabase/tests`) that no runner executes (CI step commented out). |
| FR-75 | Personal data purged per §16.5 | `job_retention`, `jobs/media-purge.ts` | apps/api/test/retention | PASS |  |

### Non-functional (NFR)

| ID | Requirement | Implementation | Test | Verdict | Notes |
|---|---|---|---|---|---|
| NFR-01 | Scan + check-in p95 < 800 ms server; < 2 s on 4G | — | — | NOT TESTABLE | Needs the deployed stack (Supabase pooler, Render) and a 4G device; no load test exists. |
| NFR-02 | Gate landing interactive < 3 s on midrange Android/4G (Lighthouse) | — | — | NOT TESTABLE | Needs a real midrange Android on 4G. |
| NFR-03 | N-WALKIN/N-ARRIVED push within 10 s p95 | outbox worker (2 s loop) | — | NOT TESTABLE | Needs real Expo push to a device. |
| NFR-04 | Dashboard reflects any visit change within 5 s | SSE hub | apps/mobile/e2e/tests/warden-office (asserts ≤ 8 s) | PARTIAL | Not measured at 5 s; in the SDD deployment LISTEN runs over the transaction pooler and cannot receive notifications (D-04). |
| NFR-05 | 99.5 % availability 07:00–23:00 IST | — | — | NOT TESTABLE | Operational metric; needs the pilot. |
| NFR-06 | 50 scans/min/gate burst; 1,000 visits/day | — | — | NOT TESTABLE | No load test; needs a deployed environment. |
| NFR-07 | All §16.4 controls before real data | see SECURITY-AUDIT.md | apps/api/test/security, media | PARTIAL | Web CSP/HSTS (SA-12) scheduled for deployment; production cannot start yet (D-02); two-owner/MFA are process items. |
| NFR-08 | Retention enforced automatically | job_retention + media purge + JobRunner | apps/api/test/retention, jobs-runner | PASS |  |
| NFR-09 | Returning guest ≤ 30 s / ≤ 4 taps; first-time ≤ 3 min | — | — | NOT TESTABLE | Needs timed sessions with real users. |
| NFR-10 | Chrome 100+, Safari iOS 15+, Samsung Internet 18+; Android 9+ app | Expo web, RN | Playwright Chromium only | PARTIAL | Only Chromium is exercised; Safari/Samsung Internet untested; Android app never run. |
| NFR-11 | WCAG 2.1 AA guest web; text scales to 200 % | accessibility labels/roles throughout | — | PARTIAL | Labels and roles present (Playwright selects by them); no axe/automated audit, no 200 % text test. |
| NFR-12 | Rules engine 100 % branch; API services ≥ 70 % lines; no `any` | `packages/shared/src/rules`, eslint `no-explicit-any: error` | vitest --coverage (run in this audit) | PASS | Rules engine 100 % statements/branches/lines. API src 89.4 % lines, 75.9 % branches (845 tests). |
| NFR-13 | Request IDs; errors reach Sentry within 1 min | `lib/request-id.ts`, `lib/error-reporter.ts` | apps/api/test/app, security (SA-13) | PARTIAL | Request IDs tested. Sentry only verified with a fake reporter; the 1-minute delivery needs a real Sentry project. |
| NFR-14 | ≤ ₹1,500/month in pilot | — | — | NOT TESTABLE | Needs real billing. |

### Business rules (BR)

| ID | Requirement | Implementation | Test | Verdict | Notes |
|---|---|---|---|---|---|
| BR-01 | No admission without verified, non-suspended host approval | evaluateCreate/evaluateEntry; visits/service.ts | evaluate-create/entry tests; visits-service | PASS |  |
| BR-02 | Day and quick drop-off guests must check in before 20:00 | evaluateEntry AFTER_ENTRY_CUTOFF (pre-invite check-in, host-assisted) | evaluate-entry.test; resident-approvals (host-assisted 20:15) | FAIL | Walk-in path never runs evaluateEntry (request uses evaluateCreate, approval uses evaluateCreate). QA probe: a day walk-in requested at 20:30 IST was accepted (201), approved (200) and ended `inside`. (D-01) |
| BR-03 | No guest checks in at or after 22:00 | evaluateEntry AFTER_HARD_CUTOFF; walk-ins refused by WINDOW_INVALID | evaluate-entry.test; QA probe (quick drop-off 22:30 → 422) | PASS | Walk-ins after 22:00 are refused, but with WINDOW_INVALID, so the guest does not see §13.6 "The hostel is closed to guests". |
| BR-04 | Day windows within visiting_start..day_visit_latest_end, one date | evaluateCreate WINDOW_INVALID | evaluate-create.test; resident-onboarding-visits | PASS |  |
| BR-05 | Overnight max 3 nights/host/month (IST) | evaluateCreate QUOTA_EXCEEDED, nights.ts | evaluate-create, nights tests; resident-onboarding-visits | PASS |  |
| BR-06 | One overnight guest per host at a time | evaluateCreate OVERNIGHT_OVERLAP | evaluate-create (TC-RULE-15) | PASS |  |
| BR-07 | Opposite/undisclosed gender → visitors_room; no overnight | computeZone, TYPE_NOT_ALLOWED_FOR_GENDER | zone/evaluate-create tests; resident-onboarding-visits | PASS |  |
| BR-08 | ₹50/night, ₹150 guest room; pending charge on approval | visits/sideEffects.ts createPendingCharge | visits-service; warden-office e2e | PASS |  |
| BR-09 | Banned guests cannot be invited, request entry or check in | VISITOR_BANNED in create/entry; isVisitorBanned | evaluate tests; staff-behaviour; warden-office e2e | PASS |  |
| BR-10 | Suspended hosts cannot create/approve; future visits cancelled | HOST_SUSPENDED; admin/effects cancelFutureVisits | evaluate tests; staff-behaviour BR-10 | PASS |  |
| BR-11 | Max 3 day/quick guests inside per host | HOST_DAY_LIMIT (create deny, entry flag) | evaluate tests; resident-approvals BR-11 | PASS |  |
| BR-12 | Walk-in expires after 10 min | job_expire_walkins (inclusive) | jobs-runner BR-12 (9:59/10:00) | PASS |  |
| BR-13 | Overstay at window_end + 15 min | job_flag_overstays (inclusive) | jobs-runner BR-13 (14:59/15:00) | PASS |  |
| BR-14 | 22:00 list of day/quick guests to warden | job_night_sweep | jobs-runner TC-JOB-02 | PASS |  |
| BR-15 | One inside visit per visitor (DB constraint) | partial unique index + ALREADY_INSIDE | visits-concurrency | PASS |  |
| BR-16 | Pre-invites ≤ 7 days, overnight ≤ 30 days ahead | TOO_FAR_AHEAD | evaluate-create.test | PASS |  |
| BR-17 | Check-out never refused; failed GPS flagged | evaluateExit | evaluate-exit; visits-service | PASS |  |
| BR-18 | Manual fine minimum ₹400 | POST /admin/charges (fine) | staff-behaviour BR-18 | PASS |  |
| BR-19 | Overnight window visiting_start → overnight_checkout_time | host-actions.ts overnightWindow | evaluate-entry; visits-service | PASS |  |
| BR-20 | Arrive up to 30 min early | TOO_EARLY | evaluate-entry; visits-service | PASS | DEC-006 resolves the SDD worked-example contradiction in favour of 30 min. |

### Edge cases (E)

| ID | Requirement | Implementation | Test | Verdict | Notes |
|---|---|---|---|---|---|
| E-01 | Gate offline: QR still valid; warden alerted after 5 min | gate page local token generation; job_gate_offline | jobs-runner (offline alert) | PARTIAL | Offline QR generation not tested. |
| E-02 | Guest clock wrong — server decides | gate/token.ts verify with server clock | token tests (TC-TOK) | PASS |  |
| E-03 | Link opened in WhatsApp/IG/FB in-app browser → "Open in Chrome/Safari" | — | — | FAIL | No user-agent detection or prompt anywhere in the app. |
| E-04 | Three friends: one token works for all within 30 s | scan sessions per guest; token not single-use | — | PARTIAL | True by construction; no test. |
| E-05 | Walk-in 19:58 approved 20:03 → allowed (judged at scan session) | approveWalkIn (evaluateCreate only) | — | PARTIAL | "Allowed" holds only because no entry cutoff is applied to walk-ins at all (D-01); F2 step 9 evaluateEntry with the session time is not implemented; no test. |
| E-06 | Same guest invited by two hosts: gate lists both; one inside | GET /scan-sessions/:id | — | FAIL | Only the first approved visit is returned (`executeTakeFirst`); the guest cannot choose the second. |
| E-07 | Guest changed phone: host cancels and re-invites | cancel + create | apps/api/test/resident-onboarding-visits | PASS |  |
| E-08 | Host offline: walk-in expires; pre-invites still check in | job_expire_walkins; check-in independent of host | apps/api/test/jobs-runner, gate-routes | PASS |  |
| E-09 | Host not in hostel approves: allowed, visible in timeline | approve has no location requirement; approvals row | apps/api/test/resident-approvals-notifications | PASS |  |
| E-10 | Double tap / drop after commit: Idempotency-Key replays; one gate event | single-use scan session; runIdempotent on host actions and host-assisted only | apps/api/test/resident-approvals (host replay), gate-routes (2nd call SCAN_SESSION_EXPIRED) | PARTIAL | §9.12 requires Idempotency-Key replay on check-in, check-out and walk-in; those gate routes do not implement it (a retry gets SCAN_SESSION_EXPIRED, not the original response). One gate event is still guaranteed. |
| E-11 | Host suspended while guest inside | suspend + cancelFutureVisits | apps/api/test/staff-behaviour BR-10 | PASS |  |
| E-12 | Guest banned while inside | force-checkout + ban | apps/api/test/staff-behaviour; apps/mobile/e2e/tests/warden-office | PASS |  |
| E-13 | Rules changed during the day | RulesProvider latest version; visits keep rules_version | apps/api/test/staff-behaviour FR-55/E-13 | PASS |  |
| E-14 | Gate location not set → GATE_NOT_CONFIGURED; red banner | geofence/scanSessions; W-01/W-09 banner | — | PARTIAL | Implemented; no test. |
| E-15 | No mobile data → host-assisted entry | F4 host-assisted | apps/api/test/gate-routes | PARTIAL | Same as FR-28: UI path untested, native unexecuted. |
| E-16 | GPS inside geofence but guest in a nearby room | calibration + live photo (documented limitation) | — | NOT TESTABLE | Needs on-site GPS calibration (§19.4). |
| E-17 | Camera denied → G-16, no check-in without photo | LiveCamera onPermissionDenied | — | PARTIAL | Implemented; no test. |
| E-18 | Resident moves out: future visits cancelled, guests see cancelled | mark-left + cancelFutureVisits | apps/api/test/staff-behaviour FR-07 | PASS |  |
| E-19 | Overnight across two months: nights split for quota | nights.ts monthsTouched | nights/evaluate-create tests | PASS |  |
| E-20 | Roommates allowed; warden sees existing verified residents of the room | residents DTO roommates; W-04 | — | PARTIAL | Implemented; no test. |
| E-21 | "Not my guest" by mistake → warden resolves | POST /admin/visits/:id/resolve-dispute | apps/api/test/staff-permissions, staff-behaviour (audit) | PASS |  |
| E-22 | Never checks out: overstay → escalation → sweep → force check-out | jobs + force-checkout | apps/api/test/jobs-runner, staff-behaviour | PASS |  |
| E-23 | Two gate devices on one gate both valid | per-gate secret | — | PARTIAL | True by construction; no test. |
| E-24 | Approved guest at another hostel's gate → only Request entry | scan-session query scoped to gate hostel | — | PARTIAL | Implemented; no test. |

### Test cases (TC)

| ID | Requirement | Implementation | Test | Verdict | Notes |
|---|---|---|---|---|---|
| TC-RULE-01..11 | All §4.6 worked examples | packages/shared/src/rules | evaluate-create/entry, nights tests | PASS | Counted as 11 cases. |
| TC-RULE-12 | Undisclosed gender day invite → allow, visitors_room | evaluateCreate/zone | evaluate-create.test | PASS |  |
| TC-RULE-13 | Host pending creates invite → HOST_NOT_VERIFIED | evaluateCreate | evaluate-create.test; resident-onboarding-visits | PASS |  |
| TC-RULE-14 | Suspended until yesterday → allow | evaluateCreate | evaluate-create.test | PASS |  |
| TC-RULE-15 | Overnight overlap → OVERNIGHT_OVERLAP | evaluateCreate | evaluate-create.test | PASS |  |
| TC-RULE-16 | Exit after window + grace → LATE_EXIT flag | evaluateExit | evaluate-exit.test | PASS |  |
| TC-TOK-01 | Token valid at s, s+1, s+2 | gate/token.ts | token.test | PASS |  |
| TC-TOK-02 | s+3 → GATE_TOKEN_EXPIRED | gate/token.ts | token.test | PASS |  |
| TC-TOK-03 | s-1 valid; s-2 invalid | gate/token.ts | token.test | PASS |  |
| TC-TOK-04 | One MAC char changed → GATE_TOKEN_INVALID | gate/token.ts (timingSafeEqual, 80-bit MAC) | token.test | PASS |  |
| TC-TOK-05 | Old secret valid 120 s after rotation | gate/secret.ts | token/secret tests | PASS |  |
| TC-GEO-01 | 49 m, accuracy 20 → gps_ok | gate/geofence.ts | geofence.test | PASS |  |
| TC-GEO-02 | 51 m → outside_geofence | gate/geofence.ts | geofence.test | PASS |  |
| TC-GEO-03 | Accuracy 80 m → low_accuracy | gate/geofence.ts | geofence.test | PASS |  |
| TC-GEO-04 | Fix age 61 s → stale_fix | gate/geofence.ts | geofence.test | PASS |  |
| TC-GEO-05 | 4th location attempt → LOCATION_RETRY_LIMIT | scanSessions retry | gate-routes (retry limit) | PASS |  |
| TC-FLOW-01 | F1 end to end: inside, 1 gate event, 1 N-ARRIVED | gate + visits | gate-routes; golden-path e2e | PASS |  |
| TC-FLOW-02 | Walk-in approved: inside, entry time = approval time, session consumed | approveWalkIn | resident-approvals (inside, 1 gate event) | PARTIAL | Entry-time and session-consumed assertions missing. |
| TC-FLOW-03 | Walk-in, no answer 10 min → expired, host notified | job_expire_walkins | jobs-runner BR-12; resident-approvals | PASS |  |
| TC-FLOW-04 | Location unverified, host confirms → inside, location_unverified | confirm-arrival path | resident-approvals TC-FLOW-04 | PASS |  |
| TC-FLOW-05 | Overnight steps out mid-stay → approved; re-entry allowed | checkOut | visits-service (stepping out) | PASS |  |
| TC-FLOW-06 | Dispute → host_disputed_at, warden push + SMS rows | disputeArrival | resident-approvals TC-FLOW-06 | PASS |  |
| TC-FLOW-07 | Invite opened with another phone → INVITE_PHONE_MISMATCH | claimInvite | invites, auth-routes | PASS |  |
| TC-FLOW-08 | Same scan session twice → SCAN_SESSION_EXPIRED | consumeScanSession | gate-routes (already-consumed) | PASS |  |
| TC-FLOW-09 | Wrong nonce → SCAN_SESSION_FORBIDDEN | validateAndBindSession | gate-routes (wrong nonce) | PASS |  |
| TC-FLOW-10 | Check-in replay with same Idempotency-Key → identical response, one gate event | gate check-in (no runIdempotent) | — | FAIL | Gate check-in does not implement Idempotency-Key replay (§9.12); a repeat returns SCAN_SESSION_EXPIRED. |
| TC-FLOW-11 | Visitor inside two visits → ALREADY_INSIDE | unique index + check | visits-concurrency | PASS |  |
| TC-FLOW-12 | Approve vs expiry race → one wins, other 409 | status-guarded updates | visits-concurrency | PASS |  |
| TC-JOB-01 | Overstay job twice → one host push, one guest SMS | job_flag_overstays | jobs-runner | PASS |  |
| TC-JOB-02 | Night sweep: 2 day + 1 overnight → warden told of 2 | job_night_sweep | jobs-runner | PASS |  |
| TC-SEC-01 | Resident A requests B's visit → 404 | visits.read policy | resident-onboarding-visits; resident-app e2e | PASS |  |
| TC-SEC-02 | Guest requests a visit they aren't on → 404 | visits.read policy | resident-onboarding-visits | PASS |  |
| TC-SEC-03 | Office charges: no phone/photo fields | charges serializer | staff-behaviour; media; warden-office e2e | PASS |  |
| TC-SEC-04 | Warden X uses X-Hostel-Id Y → 403 | staffScope | staff-behaviour; media | PASS |  |
| TC-SEC-05 | Deactivated user's token after 30 s → SESSION_REVOKED | RevocationCache | sessions; staff-behaviour | PASS |  |
| TC-SEC-06 | Reused refresh token → 401, session revoked | rotateRefreshToken | sessions | PASS |  |
| TC-SEC-07 | UPDATE gate_events as haven_api → permission error | grants + forbid_mutation | supabase/tests/004 (pgTAP) | PARTIAL | The pgTAP file is never executed (CI step commented out; embedded Postgres has no pgTAP). The trigger part is exercised indirectly (retention test asserts append-only on audit_log). |
| TC-SEC-08 | Audit row for a visit update has no invited_phone/name | audit_row strip-list | supabase/tests/003 (pgTAP) | PARTIAL | Never executed, as TC-SEC-07. |
| TC-SEC-09 | 4th OTP request in 10 min → RATE_LIMITED | requestOtp | otp-service; security | PASS |  |
| TC-SEC-10 | PNG with EXIF GPS → stored file has no EXIF | gate/media.ts | media | PASS |  |
| TC-SEC-11 | Same photo twice → PHOTO_REUSED | gate/media.ts + unique index | media | PASS |  |

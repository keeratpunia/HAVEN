# HAVEN — Requirement Traceability Matrix

Living document. Every row starts with **Implementation: —** and **Tests: —**. Update
a row in the same PR that implements or tests it — do not batch traceability updates
into a separate housekeeping PR. `docs/IMPLEMENTATION-PLAN.md` says which milestone
each requirement belongs to; this document says, at any point in time, whether it is
actually done.

Status legend: `—` not started · `WIP` in progress · `Done` implemented and tested ·
`Deferred` pushed to future scope (must cite the decision in `docs/DECISIONS.md`).

## 0. Bootstrap milestone (2026-10-01) — no FR/NFR/BR/E/TC status changed

The repository foundation (pnpm/Turborepo monorepo, TypeScript/ESLint/Prettier config,
a Fastify app with health/ready endpoints only, an Expo Router app shell with no
product screens, `supabase/` structure with no migrations) was built in this pass. It
is infrastructure that every later requirement depends on, not an implementation of
any requirement itself — **no row below changes status because of it.**

What the bootstrap genuinely produced, for context (not a traceability claim against
any requirement id):

| Built | Where | Note |
|---|---|---|
| Request ID generation + propagation | `apps/api/src/lib/request-id.ts` | Matches the SDD §9.11 format; feeds NFR-13 ("every request has a request ID") once real routes exist — NFR-13 itself stays unmarked since the Sentry half isn't built |
| Generic error envelope + handler | `apps/api/src/app.ts`, `apps/api/src/lib/errors.ts` | Matches the SDD §12.1 shape; only generic codes (`VALIDATION_FAILED`, `NOT_FOUND`, `INTERNAL`) exist — no business error codes from §12.2 |
| `Clock`/`FakeClock` abstraction | `apps/api/src/lib/clock.ts` | Prerequisite for the rules engine (M3) and job tests (M3) to be deterministic — implements no business time rule itself |
| DB connection + `/ready` health check | `apps/api/src/db/index.ts` | Empty `Database` interface — no schema exists yet to query |
| `supabase/` structure | `supabase/config.toml`, `migrations/`, `tests/` | Empty `migrations/`/`tests/` — the M1 schema migration (BR/audit-trigger work) is not here |

If a future reviewer sees this table and is tempted to mark e.g. FR-74 (audit log) or
NFR-13 (observability) "WIP" because *some* of their plumbing exists — don't. Flip a
row only when the requirement's actual behaviour (an audit trigger that fires, a
Sentry alert that fires) is implemented and tested, per the instructions in §7 below.

## 0b. Database foundation milestone (2026-10-01)

Unlike the bootstrap pass above, this milestone built behaviour that actually fires
and was actually tested against a real Postgres server — `supabase/migrations/` now
has the full SDD §11 schema (24 tables, 18 enums, 9 audit triggers, 4 append-only
triggers, `touch_updated_at`, the live-event trigger, 7 `haven.job_*` functions, the
`haven_api` role/grants, RLS on every table) plus a storage-buckets migration, and
`apps/api/scripts/seed.ts` populates it per SDD §11.9/§12.1. Validated end to end:
clean migration apply from empty, the pgTAP test files in `supabase/tests/` (logic
also verified directly, in the absence of a working local Docker/Supabase stack in
this environment — see `docs/DECISIONS.md`), and three successive idempotent seed
runs. No API route, no rules engine, and no business logic were implemented — only
schema, constraints, triggers, jobs, and fixture data.

This is why the four rows below (and only these four) change status, each because its
*specific, narrow* mechanism is now genuinely implemented and tested at the database
layer — not because "the schema exists now." Every other requirement in this document
still needs API code before it earns a status change, including ones that will
ultimately depend on this schema.

## 0c. API foundation milestone (2026-10-01)

This milestone built the reusable request-pipeline infrastructure every feature
module will use (SDD §8.2: request ID → rate limit → auth → validation → handler →
authorize() → service → repository → serializer → response) — wired together in
`apps/api/src/app.ts` and genuinely exercised end to end (86 tests; a real build +
boot + `curl` smoke test; two real bugs found and fixed by that testing, not by
inspection — see `docs/DECISIONS.md`). What exists now: JWT issue/verify
(`src/auth/jwt.ts`), the authentication hook and `Principal` type
(`src/auth/authenticate.ts`, `src/auth/principal.ts`), the central `authorize()`
policy dispatcher with zero registered rules (`src/auth/policy.ts`), Zod-via-Fastify
validation wiring (`src/lib/validation.ts`), a generic field-stripping serializer
pattern (`src/lib/serializer.ts`), the transaction/actor-context helper
(`src/lib/tx.ts`), the refresh-cookie name/options helper (`src/lib/cookies.ts`), and
configurable rate limiting + the SDD §16.4 security headers (`src/app.ts`).

**What this explicitly does NOT do, so no later reviewer mistakes plumbing for a
finished requirement (same discipline as §0 and §0b above):**
- No sign-in flow exists. OTP request/verify and Google Sign-In are not implemented —
  `jwt.ts` can issue/verify a token once something else decides who the principal is,
  but nothing decides that yet. **FR-01 and FR-03 stay unmarked.**
- `authorize()` has no registered policies — every action is denied by default
  (fail-closed). There is no permission matrix (SDD §3.3) here, only the mechanism a
  later module plugs a matrix into.
- Device-token (gate) authentication is recognized but not verified — it always
  resolves to a null principal. No gate-scoped action can succeed through this hook.
- Session revocation (SDD §9.5: "deactivation takes effect within 30s",
  `SESSION_REVOKED`) is not implemented — the auth hook verifies JWT signatures only,
  it does not check a `sessions`/`users.is_active` row. **TC-SEC-05 and TC-SEC-06 stay
  unmarked.** (Closed in the authentication milestone — see §0e.)
- No real route exists under `/v1` — it is registered as an empty prefix boundary.

## 0d. Rules engine milestone (2026-10-01)

Implements `evaluateCreate`/`evaluateEntry`/`evaluateExit`/`nightsBetween`/`quotaUsed`
exactly per SDD §4.4's contract, in `packages/shared/src/rules/`. Pure TypeScript — no
I/O, no `Date.now()`, timezone maths via `luxon` (SDD §4.4). 138 tests, **100%
branches/statements/functions/lines** (measured via `@vitest/coverage-v8`, not
assumed — `pnpm --filter shared test:coverage`), satisfying NFR-12's "rules engine
100% branch coverage." Every SDD §4.6 worked example and every TC-RULE-01..16 case
from SDD §19.2 is a named test.

**What this does NOT do, so later reviewers don't overclaim (same discipline as §0,
§0b, §0c above):**
- The engine only *decides*; nothing calls it yet. No API route runs
  `evaluateCreate`/`evaluateEntry`/`evaluateExit`, so no BR below is "done" in the
  sense of actually gating a real request — only in the sense that its specific rule
  logic is implemented and tested in isolation. Every BR row below marked WIP (not
  Done) reflects exactly that split.
- Charge amounts (BR-08, BR-18) are **not** computed by this engine — the SDD's §4.4
  function contract lists exactly 5 functions (`evaluateCreate`, `evaluateEntry`,
  `evaluateExit`, `nightsBetween`, `quotaUsed`); charge calculation isn't one of them,
  and this implementation doesn't add a 6th function beyond what the SDD specifies.
  BR-08/BR-18 stay unmarked.
- Jobs (BR-12, BR-13's overstay-flagging half, BR-14) are SQL functions
  (`supabase/migrations/`, already tracked under §0b), not this engine. BR-12/BR-14
  stay unmarked here.
- Side effects named in some BRs (BR-10's "future visits are cancelled", BR-15's "DB
  constraint") are not this engine's job either — BR-10 is marked WIP only for the
  suspension-*check* half; BR-15 now has two independent implementations (the DB
  constraint from §0b, and `ALREADY_INSIDE` here) and both are credited.

A genuine SDD numeric contradiction was found and **not silently resolved** — see
`docs/DECISIONS.md` DEC-006: the TOO_EARLY worked example's clock digits (14:25
allow / 14:20 deny) don't algebraically match the SDD's own 30-minute rule (§4.5 step
6, §4.3 `early_arrival_minutes`, BR-20). This implementation follows the
three-way-corroborated 30-minute rule; the test suite documents the discrepancy
in-line rather than quietly matching whichever number was more convenient.

## 0e. Authentication milestone (2026-10-01)

Implements the complete authentication foundation per SDD §9.5 (guest phone OTP,
resident/staff Google sign-in, access/refresh tokens, sessions, revocation,
deactivation) and §9.6 (invite phone matching, for the claim half only — invite
*creation* stays out of scope, see below). 154 tests (unit + integration against a
real embedded Postgres — see `docs/DECISIONS.md` DEC-007), including 22 integration
test files exercising the real SQL. Two genuine transaction-rollback bugs were found
by those integration tests and fixed — see DEC-007 item 5 — not found by unit tests or
inspection alone.

What exists now, closing every gap §0c flagged as deferred:
- `POST /auth/otp/request` / `POST /auth/otp/verify` (`src/auth/otp-service.ts`,
  `src/auth/routes.ts`): 6-digit code via `crypto.randomInt`, `HMAC_SHA256(OTP_PEPPER,
  phone+'|'+code)` storage, 5-min TTL, 30s resend cooldown, 3/phone/10min +
  10/IP/hour request limits, 5-wrong-attempts locks the code, non-production test
  phones `+919999900001`-`09` accept `123456`, `SMS_PROVIDER=console` dev delivery.
  `guest_login` creates/finds a visitor and issues tokens; `phone_verify` (an
  authenticated user verifying their own phone) updates `users.phone`.
- `POST /auth/google` (`src/auth/google-service.ts`): verifies the ID token via an
  injectable `GoogleIdTokenVerifier` (real `google-auth-library` implementation in
  production, a fake double in tests — DEC-007 item 3), requires `email_verified`,
  upserts `users` by `google_sub`, auto-accepts any pending staff invite for the
  signed-in email (explicit `staffInviteToken` enforces `INVITE_EMAIL_MISMATCH` on a
  mismatched email; implicit acceptance needs no token at all).
- Sessions and refresh rotation (`src/auth/sessions.ts`): 32-random-byte base64url
  refresh tokens, SHA-256 stored, rotated on every use, reuse of an already-rotated
  token revokes the whole session (`SESSION_REVOKED`).
- The 30-second-cached session-revoked/user-inactive check (`src/auth/principal-
  loader.ts`'s `RevocationCache`), wired into the authentication hook
  (`src/auth/authenticate.ts`) — closes the exact gap §0c flagged. **TC-SEC-05 and
  TC-SEC-06 are now Done.**
- `GET/PATCH /me` with real `authorize()` policies (`src/auth/policy-rules.ts`:
  `me.read`/`me.update`, denying any resource whose owner id doesn't match the calling
  principal) — the first real policies registered against the mechanism §0c built.
- `POST /invites/{token}/claim` (`src/auth/invites.ts`): phone-matching only
  (`INVITE_PHONE_MISMATCH`, `INVITE_ALREADY_CLAIMED`, `INVITE_EXPIRED`) against an
  existing `visits` row — invite *creation* (a host/visits-module action) is out of
  scope for this milestone; tests construct fixture visit rows directly.
- `apps/api/src/db/types.ts`: hand-written Kysely `Database` types for the tables this
  milestone queries (DEC-007 item 2) — the `Database` interface is no longer an empty
  placeholder for these tables.

**What this explicitly does NOT do, so no later reviewer mistakes it for more than it
is (same discipline as §0, §0b, §0c, §0d above):**
- FR-04/FR-05 (resident registration: room number, ID card photo, selfie, warden
  approve/reject) are **not** implemented — only the phone-verification *half* of
  FR-04 (via `phone_verify` purpose) exists. FR-04/FR-05 stay unmarked.
- FR-06 (staff invite *creation*, 48h expiry) is not implemented — only invite
  *acceptance* (an existing `staff_invites` row via Google sign-in) exists. Tests
  insert fixture invite rows directly. FR-06 stays unmarked.
- FR-07's "warden deactivates staff / marks resident left" action itself is not
  implemented (no handler sets `users.is_active = false` or
  `residents.status = 'left'`) — only the *consequence* (a deactivated user's existing
  session is rejected within 30s) is implemented and tested. FR-07 stays unmarked.
- Device/gate-token authentication is still unimplemented (unchanged from §0c) — this
  milestone did not touch it.
- `SMS_PROVIDER=msg91` is not implemented (DEC-007 item 3) — only `console` works.
- Cloudflare Turnstile gating on `POST /auth/otp/request` (CLAUDE.md §4, SDD §16.1
  T10) is **not implemented** — `TURNSTILE_SECRET` is still unvalidated/unused. The
  per-phone/per-IP rate limits (TC-SEC-09) are implemented and tested; the additional
  Turnstile control is not. This is a real, open gap, not an oversight to paper over.
- `GET /invites/{token}` (the public, pre-claim read endpoint from SDD §12.7) is not
  implemented — only the authenticated claim endpoint.

## 1. Functional requirements (FR-xx) — SDD §5

### 5.1 Accounts and onboarding

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-01 | M | Guest signs in with 6-digit SMS OTP | `src/auth/otp-service.ts`, `src/auth/routes.ts` | `test/otp-service.integration.test.ts`, `test/auth-routes.integration.test.ts` | Done |
| FR-02 | M | First-time guest profile: name, gender, 18+, consent, profile selfie | — | — | — |
| FR-03 | M | Residents and staff sign in with Google | `src/auth/google-service.ts`, `src/auth/google.ts` | `test/google-service.integration.test.ts`, `test/auth-routes.integration.test.ts` | Done |
| FR-04 | M | Resident phone OTP, room number, ID card photo, selfie, awaits verification | `src/auth/otp-service.ts` (`phone_verify` purpose only) | `test/otp-service.integration.test.ts` | WIP — phone verification only; room/photo/submit not built |
| FR-05 | M | Warden sees pending residents, approves/rejects in one tap; ID card deleted on decision | — | — | — |
| FR-06 | S | Warden invites office by email; super admin invites wardens; 48h expiry bound to email | `src/auth/google-service.ts` (acceptance only) | `test/google-service.integration.test.ts` | WIP — invite acceptance only; invite creation not built |
| FR-07 | M | Warden deactivates staff / marks resident left; sessions end immediately | `src/auth/principal-loader.ts` (`RevocationCache`), `src/auth/authenticate.ts` | `test/sessions.integration.test.ts`, `test/auth-routes.integration.test.ts` | WIP — session-end-within-30s consequence only; the deactivate/mark-left action itself not built |
| FR-08 | S | Guest/resident edit name, retake profile photo | — | — | — |
| FR-09 | S | Guest/resident request account deletion | — | — | — |

### 5.2 Visits and invites

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-10 | M | Verified host creates pre-invite (name, phone, type, date, window) | — | — | — |
| FR-11 | M | Host shares invite link via native share sheet | — | — | — |
| FR-12 | M | Opening invite link requires OTP to invited number; other numbers refused | — | — | — |
| FR-13 | M | Host edits window / cancels visit until guest checks in | — | — | — |
| FR-14 | M | Host requests overnight/guest-room with quota + charge preview | — | — | — |
| FR-15 | M | Warden approves/rejects overnight/guest-room requests; approval creates pending charge | — | — | — |
| FR-16 | M | Host sees all visits: upcoming, inside, history, status, charges | — | — | — |

### 5.3 Gate

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-20 | M | Gate device shows rotating QR + countdown + hostel name + instruction | — | — | — |
| FR-21 | M | Scanning QR opens guest web app; requests location, validates token + GPS first | — | — | — |
| FR-22 | S | Guest app offers an in-app scanner on home screen | — | — | — |
| FR-23 | M | App offers Check in / Check out / Request entry based on visit state | — | — | — |
| FR-24 | M | Check-in/out capture live front-camera photo; no file picker ever | — | — | — |
| FR-25 | M | Walk-in: room search, pick resident, visit type, duration, live photo, submit | — | — | — |
| FR-26 | M | Guest waits on live status screen; approval flips to green without re-scan | — | — | — |
| FR-27 | M | 3x GPS failure or permission denied → host-confirm fallback | — | — | — |
| FR-28 | M | Host-assisted entry: host scans QR, enters guest details, photographs, checks in/out | — | — | — |
| FR-29 | S | Gate device heartbeat every 60s; warden alerted after 5 min offline | — | — | — |
| FR-30 | M | Gate device keeps screen awake; recovers automatically after network loss | — | — | — |

### 5.4 Host actions

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-40 | M | Host push for every walk-in with both photos; approve (adjust end time) or reject | — | — | — |
| FR-41 | S | SMS fallback if walk-in push unopened in 60s | — | — | — |
| FR-42 | M | Host push for every check-in with photo compare; Yes/Not my guest (30 min window) | — | — | — |
| FR-43 | M | "Not my guest" disputes the visit; alerts warden immediately (push + SMS) | — | — | — |
| FR-44 | M | Host push on guest check-out and on guest overstay | — | — | — |
| FR-45 | M | Host can mark "My guest has left"; logged and flagged to warden | — | — | — |

### 5.5 Warden and office

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-50 | M | Dashboard: live counts/lists, updates within 5s | — | — | — |
| FR-51 | M | Emergency roll call: everyone inside, printable/exportable | — | — | — |
| FR-52 | M | Visit detail: full timeline with photos, GPS distance, notifications, flags | — | — | — |
| FR-53 | M | Warden force check-out with reason | — | — | — |
| FR-54 | M | Warden bans guest (hostel/all, timed/permanent); suspends resident hosting | — | — | — |
| FR-55 | S | Warden edits rules config via form; each save is a new version | — | — | — |
| FR-56 | M | Warden pairs/revokes gate devices; sets gate location by 5-reading average | — | — | — |
| FR-57 | S | Warden searches visits (name/phone/host/room/date/status); CSV export | — | — | — |
| FR-58 | S | Warden views audit log filtered by actor/entity/date | — | — | — |
| FR-59 | M | Office sees charges; confirms, marks paid. **Waiving and manual fines are warden-only** (not office — see permission matrix §3.3 and `POST /admin/charges/{id}/waive`, caller: Warden) | — | — | — |
| FR-60 | C | Daily 08:00 digest to warden | — | — | — |

### 5.6 System

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-70 | M | Walk-in requests expire after 10 min; both parties told | — | — | — |
| FR-71 | M | Approved-never-entered visits expire at window_end | — | — | — |
| FR-72 | M | Overstay detection every 5 min; alerts host/guest; escalates to warden after 30 min | — | — | — |
| FR-73 | M | Night sweep at 22:00 lists day/quick guests still inside to the warden | — | — | — |
| FR-74 | M | Every state change and admin action written to append-only audit log | `supabase/migrations/20261001000001_init.sql` — `audit_row()` + 9 `t_audit_*` triggers on every table SDD §11.6 lists (visits, residents, role_assignments, bans, charges, gates, gate_devices, hostel_rules, staff_invites), plus `forbid_mutation()` making `gate_events`/`audit_log`/`approvals`/`hostel_rules` append-only | `supabase/tests/002_constraints_and_triggers.sql`, `supabase/tests/003_audit_pii_stripping.sql` | WIP — DB-level mechanism fires and is tested; still needs the API to set `haven.actor_type`/`haven.actor_id`/`haven.request_id` per transaction (SDD §11.6) before this is a complete, truthful audit trail |
| FR-75 | S | Personal data purged per retention schedule (§16.5) | — | — | — |

## 2. Non-functional requirements (NFR-xx) — SDD §17.1

| ID | Category | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| NFR-01 | Performance | `POST /scan-sessions` and check-in p95 < 800ms server; < 2s E2E on 4G | — | — | — |
| NFR-02 | Performance | Gate landing interactive < 3s on mid-range Android/4G (Lighthouse mobile) | — | — | — |
| NFR-03 | Performance | Host receives N-WALKIN/N-ARRIVED push within 10s (p95) | — | — | — |
| NFR-04 | Freshness | Warden dashboard reflects visit change within 5s | — | — | — |
| NFR-05 | Availability | API 99.5% between 07:00–23:00 IST during pilot | — | — | — |
| NFR-06 | Capacity | 50 scans/min/gate burst; 1,000 visits/day/hostel without changes | — | — | — |
| NFR-07 | Security | All §16.4 controls in place before real data loaded | — | — | — |
| NFR-08 | Privacy | Retention schedule §16.5 enforced automatically | — | — | — |
| NFR-09 | Usability | Returning guest ≤30s/≤4 taps; first-time guest ≤3 min | — | — | — |
| NFR-10 | Compatibility | Guest web: Chrome 100+/Android 9+, Safari iOS 15+, Samsung Internet 18+; app Android 9+ | — | — | — |
| NFR-11 | Accessibility | WCAG 2.1 AA for guest web; text scales to 200% | — | — | — |
| NFR-12 | Maintainability | Rules engine 100% branch coverage; API services ≥70% line coverage; no `any` | `packages/shared/vitest.config.ts` (coverage thresholds), `eslint.config.mjs` (`no-explicit-any` across every workspace) | `pnpm --filter shared test:coverage` — 100% branches/statements/functions/lines, verified | WIP — the rules-engine coverage bar and the no-`any` lint rule are both genuinely met and enforced; API services' ≥70% line coverage isn't tracked/enforced anywhere yet (no coverage config in `apps/api`) |
| NFR-13 | Observability | Every request has a request ID; errors reach Sentry within 1 min | `apps/api/src/lib/request-id.ts`, wired into every request/error envelope via `apps/api/src/app.ts` | `test/app.test.ts` ("unknown routes return the SDD §12.1 error envelope with a request id") | WIP — the request-ID half is genuinely done and tested on every response, including errors; Sentry is not integrated, so "errors reach Sentry within 1 min" is not satisfied |
| NFR-14 | Cost | ≤ ₹1,500/month during pilot | — | — | — |

## 3. Business rules (BR-xx) — SDD §4.2

| ID | Rule (summary) | Enforced at | Implementation | Tests | Status |
|---|---|---|---|---|---|
| BR-01 | No admission without verified, non-suspended host approval | Create + entry | `evaluateCreate`/`evaluateEntry` — `HOST_NOT_VERIFIED`/`HOST_SUSPENDED` checks, `packages/shared/src/rules/evaluate-create.ts`, `evaluate-entry.ts` | `evaluate-create.test.ts`, `evaluate-entry.test.ts` (incl. TC-RULE-13/14) | WIP — rule logic implemented and tested; no API route calls it yet |
| BR-02 | Day/quick-drop guests must check in before 20:00 | Entry | `evaluateEntry` — `AFTER_ENTRY_CUTOFF` | `evaluate-entry.test.ts` (worked example + exact-boundary tests) | WIP |
| BR-03 | No guest may check in at/after 22:00 | Entry | `evaluateEntry` — `AFTER_HARD_CUTOFF` | `evaluate-entry.test.ts` (worked example + exact-boundary tests) | WIP |
| BR-04 | Day visit windows between visiting_start and day_visit_latest_end, one date | Create | `evaluateCreate` — `WINDOW_INVALID` (crosses-dates + visiting-hours checks) | `evaluate-create.test.ts` | WIP |
| BR-05 | Overnight in room: max 3 nights/host/calendar month (IST) | Create | `evaluateCreate` — `QUOTA_EXCEEDED`, using `nightsBetween`/`quotaUsed` | `evaluate-create.test.ts` (worked examples incl. Oct/Nov boundary), `nights.test.ts` | WIP |
| BR-06 | Overnight in room: at most one overnight guest per host at a time | Create | `evaluateCreate` — `OVERNIGHT_OVERLAP` | `evaluate-create.test.ts` (TC-RULE-15 + boundary tests) | WIP |
| BR-07 | Opposite/undisclosed gender → visitors_room zone, no overnight/guest_room | Create + display | `evaluateCreate` — `TYPE_NOT_ALLOWED_FOR_GENDER` + `computeZone`, `packages/shared/src/rules/zone.ts` | `zone.test.ts`, `evaluate-create.test.ts` | WIP |
| BR-08 | Overnight ₹50/night, guest room ₹150/night; pending charge on warden approval. **₹150 is an SDD working default awaiting warden confirmation, not yet a final decision** — see `docs/DECISIONS.md` Q8 note | Approval | — | — | — (charge calculation is explicitly not one of the SDD §4.4's 5 rules-engine functions — see `docs/TRACEABILITY.md` §0d) |
| BR-09 | Banned guests cannot be invited, request entry, or check in | Create + entry | `evaluateCreate`/`evaluateEntry` — `VISITOR_BANNED` | `evaluate-create.test.ts`, `evaluate-entry.test.ts` | WIP |
| BR-10 | Suspended hosts cannot create/approve; future visits cancelled on suspension start | Create + entry | `evaluateCreate`/`evaluateEntry` — `HOST_SUSPENDED` check only | `evaluate-create.test.ts`, `evaluate-entry.test.ts` | WIP — the suspension *check* is implemented; "future visits cancelled" is a separate side effect no code implements yet |
| BR-11 | Host max `max_active_day_guests` (default 3) day/quick guests inside at once | Create + approval | `evaluateCreate` — `HOST_DAY_LIMIT` (deny, today only); `evaluateEntry` — `HOST_DAY_LIMIT` (flag) | `evaluate-create.test.ts`, `evaluate-entry.test.ts` | WIP |
| BR-12 | Walk-in expires if host doesn't decide within 10 min | Job | — | — | — |
| BR-13 | Overstay when inside past `window_end + 15 min` | Job | — | — | — (the *job* that flags overstay is unrelated to this milestone; `evaluateExit`'s `LATE_EXIT` flag is a distinct, SDD-explicit check at the moment of exit — see TC-RULE-16 below) |
| BR-14 | At 22:00, every inside day/quick guest listed to warden | Job | — | — | — |
| BR-15 | A guest can be inside only one visit at a time, anywhere | DB constraint | `supabase/migrations/20261001000001_init.sql` (`visits_one_inside_per_visitor`) **and now also** `evaluateEntry` — `ALREADY_INSIDE`, `packages/shared/src/rules/evaluate-entry.ts` | `supabase/tests/002_constraints_and_triggers.sql`, `evaluate-entry.test.ts` | WIP — two independent layers now implement this (DB constraint + rules-engine check); still needs the API to wire both into the actual check-in handler |
| BR-16 | Pre-invites ≤7 days ahead; overnight requests ≤30 days ahead | Create | `evaluateCreate` — `TOO_FAR_AHEAD` | `evaluate-create.test.ts` (exact day-count boundaries for both limits) | WIP |
| BR-17 | Check-out never refused for rule reasons; failed GPS on exit allowed but flagged | Exit | `evaluateExit` — never returns `deny`; `LOCATION_UNVERIFIED` flag, `packages/shared/src/rules/evaluate-exit.ts` | `evaluate-exit.test.ts` | WIP |
| BR-18 | Warden manual fine, minimum ₹400 for unregistered guest | Warden action | — | — | — |
| BR-19 | Overnight window: visiting_start on arrival date to 22:00; checkout by overnight_checkout_time | Create + entry | `evaluateEntry`'s `AFTER_HARD_CUTOFF`/`TOO_EARLY`/`WINDOW_ENDED` correctly gate an overnight visit *given* a correctly-derived `windowStart`/`windowEnd` | `evaluate-entry.test.ts` (overnight worked examples) | WIP — the engine honours the window; deriving `windowStart`/`windowEnd` from `arrivalDate`/`departureDate` per this BR's formula is API-layer work (SDD §12.6) not yet built |
| BR-20 | Guest may arrive up to 30 min before window_start | Entry | `evaluateEntry` — `TOO_EARLY`, `packages/shared/src/rules/evaluate-entry.ts` | `evaluate-entry.test.ts` | WIP — see `docs/DECISIONS.md` DEC-006 for a documented SDD contradiction between this BR's "30 min" and the §4.6 worked example's literal clock digits, resolved in favour of the 30-minute rule |

## 4. Edge cases (E-xx) — SDD §17.3

| ID | Situation (summary) | Required behaviour | Implementation | Tests | Status |
|---|---|---|---|---|---|
| E-01 | Gate device offline when guest scans | QR still valid (local gen); warden alerted after 5 min | — | — | — |
| E-02 | Guest's phone clock is wrong | Irrelevant — server time decides token age | — | — | — |
| E-03 | Guest opens link in in-app browser (WhatsApp/IG/FB) | Detect via UA; show "Open in Chrome/Safari" | — | — | — |
| E-04 | Three friends arrive together | Each needs own visit; same token works for all within 30s | — | — | — |
| E-05 | Walk-in requested 19:58, approved 20:03 | Allowed — cutoff judged at scan session's created_at | — | — | — |
| E-06 | Same guest invited by two hosts same day | Gate landing lists both; only one `inside` at a time | — | — | — |
| E-07 | Guest changed phone after invite | Host cancels and re-invites | — | — | — |
| E-08 | Host has no internet when guest arrives | Walk-in can't be approved, expires in 10 min; pre-invites still check in | — | — | — |
| E-09 | Host isn't in the hostel but approves | Allowed; host accountable; visible in timeline | — | — | — |
| E-10 | Double tap Check in / network drop after commit | Idempotency-Key replays; one gate event only | — | — | — |
| E-11 | Host suspended while guest inside | Guest stays inside; no new entries; future visits cancelled | — | — | — |
| E-12 | Guest banned while inside | Warden force-checks out; ban blocks re-entry | — | — | — |
| E-13 | Rules changed during the day | New entries use new rules; existing visits keep their `rules_version` | — | — | — |
| E-14 | Gate location not set | `GATE_NOT_CONFIGURED`; red dashboard banner | — | — | — |
| E-15 | Guest has no mobile data at the gate | Host-assisted entry (F4) fallback | — | — | — |
| E-16 | GPS inside geofence but guest actually in a nearby room | Mitigated by calibration + live photo; documented limitation | — | — | — |
| E-17 | Guest denies camera permission | G-16 enable instructions; no check-in without photo | — | — | — |
| E-18 | Resident moves out with future visits | Marked `left`; future visits cancelled | — | — | — |
| E-19 | Overnight stay spans two months | Nights split by month for quota | `packages/shared/src/rules/nights.ts` (`monthsTouched`) + `evaluate-create.ts`'s per-month `QUOTA_EXCEEDED` loop | `nights.test.ts`, `evaluate-create.test.ts` (31 Oct → 2 Nov / 30 Oct → 1 Nov worked examples) | Done — the month-splitting logic itself is fully implemented and tested; no API/DB layer needed for this specific edge case, it's pure date arithmetic |
| E-20 | Two residents claim the same room | Allowed (roommates) | — | — | — |
| E-21 | Host disputes by mistake | Warden resolves after talking to host; visit stays as is | — | — | — |
| E-22 | Guest never checks out, host doesn't respond | Overstay → warden escalation → night sweep → force check-out | — | — | — |
| E-23 | Two gate devices paired to one gate | Both show valid QRs (same secret); either works | — | — | — |
| E-24 | Approved guest arrives at a different hostel's gate | No matching visit there; only Request entry offered | — | — | — |

## 5. Test cases (TC-xx) — SDD §19.2

### Rules engine (TC-RULE)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-RULE-01..11 | All worked examples in SDD §4.6 | As listed | `evaluate-create.test.ts`, `evaluate-entry.test.ts` | Done — 10 of 11 implemented exactly per the SDD's literal figures; the 11th (`TOO_EARLY` at "14:25") is implemented against the *correct* 30-minute rule rather than the SDD's self-contradictory literal digit — see `docs/DECISIONS.md` DEC-006 |
| TC-RULE-12 | Undisclosed gender, day invite to GH-8 | allow, zone `visitors_room` | `evaluate-create.test.ts` | Done |
| TC-RULE-13 | Host status `pending` creates invite | deny `HOST_NOT_VERIFIED` | `evaluate-create.test.ts` | Done |
| TC-RULE-14 | Suspended host until yesterday | allow (suspension expired) | `evaluate-create.test.ts` | Done |
| TC-RULE-15 | Overnight overlap with existing approved overnight | deny `OVERNIGHT_OVERLAP` | `evaluate-create.test.ts` | Done |
| TC-RULE-16 | Exit after window + grace | allow with `LATE_EXIT` flag | `evaluate-exit.test.ts` | Done |

### Gate token (TC-TOK)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-TOK-01 | Token generated at step s, verified at s, s+1, s+2 | valid | — | — |
| TC-TOK-02 | Verified at s+3 | `GATE_TOKEN_EXPIRED` | — | — |
| TC-TOK-03 | Verified at s−1 (device ahead); s−2 | valid; invalid | — | — |
| TC-TOK-04 | One MAC character changed | `GATE_TOKEN_INVALID` | — | — |
| TC-TOK-05 | Old secret within 120s of rotation; after 120s | valid; invalid | — | — |

### Geofence (TC-GEO)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-GEO-01 | Point 49m away, accuracy 20 | `gps_ok` | — | — |
| TC-GEO-02 | Point 51m away | `outside_geofence` | — | — |
| TC-GEO-03 | Accuracy 80m | `low_accuracy` | — | — |
| TC-GEO-04 | Fix age 61s | `stale_fix` | — | — |
| TC-GEO-05 | Fourth location attempt | `LOCATION_RETRY_LIMIT` | — | — |

### Flows (TC-FLOW)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-FLOW-01 | F1 end to end: invite → claim → scan → photo → check-in → host notified | `inside`, 1 gate event, 1 N-ARRIVED | — | — |
| TC-FLOW-02 | F2 walk-in approved | `inside`, entry event ts = approval time, session consumed | — | — |
| TC-FLOW-03 | F2 walk-in, no answer 10 min (clock advanced) | `expired`, host notified | — | — |
| TC-FLOW-04 | F3 location unverified, host confirms | `inside`, `location_unverified = true` | — | — |
| TC-FLOW-05 | F5 overnight guest steps out mid-stay | back to `approved`; re-entry allowed | — | — |
| TC-FLOW-06 | F9 dispute | `host_disputed_at` set, warden push+SMS rows | — | — |
| TC-FLOW-07 | Invite opened with different phone | `INVITE_PHONE_MISMATCH` | — | — |
| TC-FLOW-08 | Same scan session used twice | 2nd call `SCAN_SESSION_EXPIRED` | — | — |
| TC-FLOW-09 | Scan session used with wrong nonce | `SCAN_SESSION_FORBIDDEN` | — | — |
| TC-FLOW-10 | Check-in replay with same Idempotency-Key | identical response, still one gate event | — | — |
| TC-FLOW-11 | Visitor tries to be inside two visits | `ALREADY_INSIDE` | — | — |
| TC-FLOW-12 | Host approves while expiry job runs | exactly one of approve/expire wins; other 409 | — | — |

### Jobs (TC-JOB)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-JOB-01 | Overstay job twice in a row | one host push, one guest SMS (dedupe) | — | — |
| TC-JOB-02 | Night sweep: 2 day guests + 1 overnight guest inside | warden notified of 2 only | — | — |

### Security (TC-SEC)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-SEC-01 | Resident A requests resident B's visit | 404 | — | — |
| TC-SEC-02 | Guest requests a visit they aren't on | 404 | — | — |
| TC-SEC-03 | Office lists charges | no phone or photo fields in JSON | — | — |
| TC-SEC-04 | Warden of hostel X uses `X-Hostel-Id` of hostel Y | 403 | — | — |
| TC-SEC-05 | Deactivated user's access token after 30s | `SESSION_REVOKED` | `test/sessions.integration.test.ts`, `test/auth-routes.integration.test.ts` | Done |
| TC-SEC-06 | Reused refresh token | 401 and whole session revoked | `test/sessions.integration.test.ts` | Done |
| TC-SEC-07 | `UPDATE haven.gate_events` as `haven_api` | permission error | `supabase/tests/004_api_role_and_rls.sql` | Done |
| TC-SEC-08 | Audit row for a visit update | contains no `invited_phone`, `invited_name` | `supabase/tests/003_audit_pii_stripping.sql` | Done — the test exercises the shared `audit_row()` trigger via `haven.gates` (lat/lng) rather than a literal visit update, because no audit trigger is attached to `haven.users` and a *visit* update needs API-level `evaluateEntry`/state-machine code that doesn't exist yet to reach meaningfully; the strip-list (`invited_phone`, `invited_name` included) is the same function for every audited table, so this proves the mechanism TC-SEC-08 is about |
| TC-SEC-09 | 4th OTP request in 10 min for one phone | `RATE_LIMITED` | `test/otp-service.integration.test.ts` | Done — rate limiting only; Turnstile gating (CLAUDE.md §4) not implemented, see §0e |
| TC-SEC-10 | Upload a PNG with EXIF GPS | stored file has no EXIF | — | — |
| TC-SEC-11 | Same photo bytes uploaded twice by one visitor | `PHOTO_REUSED` | — | — |

## 6. Coverage summary (update when rows change)

| Category | Total IDs | Done | WIP | Not started | Deferred |
|---|---|---|---|---|---|
| FR | 50 (FR-01..09, 10..16, 20..30, 40..45, 50..60, 70..75) | 2 (FR-01, FR-03) | 3 (FR-04, FR-06, FR-07) | 45 | 0 |
| NFR | 14 | 0 | 2 (NFR-12, NFR-13) | 12 | 0 |
| BR | 20 | 0 | 15 (BR-01..07, 09..11, 15..17, 19..20) | 5 (BR-08, 12, 13, 14, 18) | 0 |
| E | 24 | 1 (E-19) | 0 | 23 | 0 |
| TC | 51 (TC-RULE ×16 [incl. the TC-RULE-01..11 worked-examples group], TC-TOK ×5, TC-GEO ×5, TC-FLOW ×12, TC-JOB ×2, TC-SEC ×11) | 21 (TC-RULE ×16, TC-SEC-05, TC-SEC-06, TC-SEC-07, TC-SEC-08, TC-SEC-09) | 0 | 30 | 0 |

Corrected during the rules-engine milestone: this table had silently gone stale after
the API-foundation milestone set NFR-13 to WIP without updating the summary row —
fixed here, and flagged so future milestones remember to update this table in the same
PR that changes a status above it (§7 below already says this; the instruction alone
didn't prevent the drift once, so this note is a second line of defence).

Counts verified by direct enumeration against SDD §5, §17.1, §4.2, §17.3, §19.2 during
the hostile planning review (2026-10-01). Recount this table if any ID range in the SDD
changes — do not hand-adjust without re-enumerating.

## 6a. Database-level guarantees implemented but not mapped to a single ID

These are real, tested database-foundation deliverables (2026-10-01) that don't map
cleanly to one FR/NFR/BR/E/TC id — recorded here instead of being force-fit into a row
above or silently omitted:

| Guarantee | Where | Tested by |
|---|---|---|
| `gate_events`, `audit_log`, `approvals`, `hostel_rules` reject UPDATE/DELETE outright (not just via role grants) | `forbid_mutation()` trigger, SDD §11.6 | `supabase/tests/002_constraints_and_triggers.sql` |
| Charges: `paid` requires `receipt_no`; `waived` requires `waive_reason` | `haven.charges` check constraints, SDD §11.4 | `supabase/tests/002_constraints_and_triggers.sql` |
| `haven_api` role: full select/insert/update, delete only on the 5 explicitly-ephemeral tables, no update on append-only tables, RLS enabled on all 24 tables | SDD §11.7 | `supabase/tests/004_api_role_and_rls.sql` |
| Live SSE event trigger fires `pg_notify('haven_events', ...)` on visit insert/update | `notify_visit()`, SDD §11.6/§9.9 | Not yet tested — needs a `LISTEN` client, which is API work (M3); schema-level creation only verified by inspection |
| Storage buckets declared (`visitor-photos`, `gate-photos`, `resident-docs`, all private) | `supabase/migrations/20261001000002_storage_buckets.sql`, SDD §9.10 | Guarded no-op verified on plain Postgres; real bucket creation only provable on an actual Supabase project (see `docs/DECISIONS.md`) |
| 7 scheduled-job functions exist and match their SDD §11.8 prose spec (`job_expire_walkins`, `job_expire_approved`, `job_flag_overstays`, `job_night_sweep`, `job_gate_offline`, `job_retention`, `job_expire_sessions`) | `supabase/migrations/20261001000001_init.sql` | Created and confirmed present by inspection; **not** unit-tested against fixture data yet (pgTAP tests with a fixed `p_now` per SDD §19.3 are M3 work, once the jobs have real traffic to act on) — do not read "the function exists" as "the job is tested" |

## 6b. API-level guarantees implemented but not mapped to a single ID

Real, tested API-foundation deliverables (2026-10-01) that are infrastructure every
feature module will rely on, not a specific FR/NFR/BR/E/TC requirement in their own
right:

| Guarantee | Where | Tested by |
|---|---|---|
| Request pipeline order matches SDD §8.2 exactly (request ID → rate limit → auth → validation, with `authorize()`/service/repo/serializer left as per-handler concerns for later modules) | `apps/api/src/app.ts` | `test/app.test.ts`, `src/auth/authenticate.test.ts`, `src/lib/validation.test.ts` |
| Access JWT issue/verify: HS256, exact SDD §9.5 claim shape (`sub`/`typ`/`sid`/`roles`/`iss`/`aud`), 15 min TTL, fails closed (wrong secret/issuer/audience/expired/malformed all → `AUTH_REQUIRED`) | `apps/api/src/auth/jwt.ts` | `src/auth/jwt.test.ts` (11 cases) |
| Central `authorize()`: unregistered action denied (fail-closed), not fail-open; a rule that throws is treated as a denial, not an unhandled exception (SDD §3.4, CLAUDE.md §3.10 — "no inline role checks") | `apps/api/src/auth/policy.ts` | `src/auth/policy.test.ts` |
| Global rate limit (SDD §12.11 default, 120/min/IP), returning the SDD §12.2 `RATE_LIMITED` envelope with `Retry-After` | `apps/api/src/app.ts` | `test/app.test.ts` — **this test is also what caught a real bug**: an un-awaited `@fastify/rate-limit` registration silently disabled rate limiting entirely (server booted fine, 429 never fired); see `docs/DECISIONS.md` |
| Security headers (CSP `default-src`/`frame-ancestors 'none'`, HSTS `max-age=31536000`, `X-Content-Type-Options`) | `apps/api/src/app.ts` (`@fastify/helmet` config) | `test/app.test.ts` |
| CORS restricted to configured origins with credentials (SDD §16.4) | `apps/api/src/app.ts` (`@fastify/cors` config) | Not directly tested (would need a cross-origin `fetch`-style check `.inject()` can't exercise); configuration reviewed against SDD §16.4 by inspection |
| `haven_rt` refresh-cookie name/attributes (httpOnly, Secure outside local dev, SameSite=Lax, `Path=/v1/auth`, `Domain=.<domain>`) defined once, ready for the auth module to use | `apps/api/src/lib/cookies.ts` | `src/lib/cookies.test.ts` |
| Zod-via-Fastify request validation → SDD §12.2 `VALIDATION_FAILED` (400) envelope with a real `details.issues` array | `apps/api/src/lib/validation.ts` | `src/lib/validation.test.ts` |
| Generic field-stripping serializer pattern (`omitFields`), ready for the first role-based serializer (SDD §3.4 office/phone/photo stripping) that actually has a row to shape | `apps/api/src/lib/serializer.ts` | `src/lib/serializer.test.ts` |
| Transaction wrapper sets `haven.actor_type`/`haven.actor_id`/`haven.request_id` before any service logic runs, so the `audit_row()` trigger (SDD §11.6) attributes rows correctly once a real service calls it | `apps/api/src/lib/tx.ts` | `src/lib/tx.test.ts` (control-flow unit tests against a fake transaction — no live DB in this test run; the underlying trigger mechanism itself was proven against a real Postgres server in the database-foundation milestone) |
| PII log redaction (phone, OTP code, tokens, secrets, photo paths, Authorization/Cookie headers) — scoped precisely enough not to swallow non-PII fields with the same name (e.g. `AppError.code`) | `apps/api/src/lib/logger.ts` | `src/lib/logger.test.ts` (9 cases, including a regression test for the `AppError.code` bug this milestone's own manual smoke test found) |

## 7a. Categories this matrix does NOT cover, by design — and where they live instead

Identified during the hostile planning review (2026-10-01). The SDD's own ID scheme is
FR/NFR/BR/E/TC only (SDD §0); these three categories are real, numbered, and
load-bearing in the SDD, but they use a different naming convention and are not meant
to be force-fit into this matrix:

- **Screen IDs** (`G-xx`, `R-xx`, `W-xx`, `D-xx`, `O-xx` — SDD §13.4): tracked instead
  by milestone in `docs/IMPLEMENTATION-PLAN.md`'s per-milestone "App screens" task
  lines. If a screen is built, the FR/E rows it implements should still be filled in
  here — the screen ID itself is not a separate traceability row.
- **Flow IDs** (`F1`–`F11` — SDD §6): covered indirectly through the `TC-FLOW-xx` rows
  above (each names its flow in the Case column) and through
  `docs/IMPLEMENTATION-PLAN.md`'s milestone task lists, which cite flow IDs directly.
- **Notification kinds** (`N-xx` — SDD §15.2, 18 kinds): not separately tracked by ID
  since they are triggered by, not independent of, the FR/E rows above (e.g. N-ARRIVED
  is produced by the FR-21–26 check-in path, not a requirement in its own right). A
  reviewer checking "were all 18 notification kinds built" should cross-reference SDD
  §15.2 directly against the notify-worker code, not this matrix — add that check to
  the M3 exit review (`docs/IMPLEMENTATION-PLAN.md` §5) since that's where the
  notification catalogue is completed.

## 7. How to update this document

1. When a PR implements requirement `X-nn`, fill in the **Implementation** cell with
   the file/module path (e.g. `apps/api/src/gate/token.ts`).
2. When a PR adds the test(s) for it, fill in **Tests** with the test file and, for TC-
   rows, confirm the `it('TC-RULE-03 ...')`-style name matches SDD §19.2 exactly (SDD
   §0: reference requirement IDs in commit messages and PR titles; SDD §19.2: IDs are
   used in test names).
3. Flip **Status** to `WIP` when implementation starts, `Done` only when both
   Implementation and Tests are filled and CI is green.
4. If a requirement is deliberately not built for the prototype, set Status to
   `Deferred` and add a one-line reason plus a link to the `docs/DECISIONS.md` entry —
   do not leave a deferred requirement looking like an oversight.

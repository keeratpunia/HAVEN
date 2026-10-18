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

## 0f. Visit domain and state machine milestone (2026-10-01)

Implements the complete HAVEN visit state machine and visits service/repository per
SDD §7 — exactly the 8 `visit_status` values and the 19 transitions in §7.1's table
(4 creation rows + 15 update rows), no invented states. 95 new tests (270 exhaustive
state-machine unit tests + 28 service-level integration tests + 7 dedicated
concurrency-race tests), all against a real embedded Postgres (same infrastructure as
the authentication milestone's `test/global-setup.ts`).

What exists now:
- `apps/api/src/visits/stateMachine.ts`: the single transition map SDD §7.1 names by
  exact file path. `assertTransition(from, trigger)` is the one gate every service
  mutation calls first; `apps/api/src/visits/stateMachine.test.ts` exhaustively checks
  **every** `(from, trigger)` pair over all 9 possible `from` values (`'new'` + the 8
  real statuses) × all 19 trigger names — not just the 19 listed rows, every
  combination not listed is asserted to throw `INVALID_TRANSITION` (409).
- `apps/api/src/visits/repository.ts`: the SDD §7.3 optimistic-concurrency pattern
  (`UPDATE ... WHERE id = $id AND status = $expected RETURNING *`, zero rows →
  `INVALID_TRANSITION` 409) as the *only* place `haven.visits.status` is written, plus
  translating the `visits_one_inside_per_visitor` unique-constraint violation (BR-15)
  into `409 ALREADY_INSIDE`.
- `apps/api/src/visits/policy.ts`: real `authorize()` registrations for every one of
  the 19 triggers (host-only, visitor-self-only, warden-only, or system-only resource
  checks) — the visits module's first real permission matrix, not a placeholder.
- `apps/api/src/visits/service.ts`: one function per trigger, each following the exact
  sequence the task specified — validate state (`assertTransition`) → `authorize()` →
  business rules (`evaluateCreate`/`evaluateEntry`/`evaluateExit` from
  `packages/shared`, now genuinely called against real DB-loaded host/visitor/booking
  data for the first time — closing the gap §0d flagged: "nothing calls it yet") →
  atomic state change → gate event / notification / charge side effects named in SDD
  §7.1's own table → return the updated row. Every mutation runs inside one `withTx`
  transaction (SDD §7: "inside one database transaction that also writes the gate
  event and audit row").
- `apps/api/src/visits/sideEffects.ts`: gate-event, notification-outbox (insert-only,
  CLAUDE.md §3.5 — nothing sends), and charge-lifecycle (pending → waived/confirmed)
  helpers, called from the service per transition.
- `apps/api/src/visits/context.ts`: loads real `HostState` (from `haven.residents`)
  and ban status (from `haven.bans`) for the rules engine — no more hand-built fixture
  contexts once past the test boundary.
- **A real bug found by exhaustive-but-correct testing, not shipped**: an early draft
  of `approveWalkIn` called `evaluateEntry` the same way `checkIn` does. Since a
  walk-in never passes through `approved` (SDD §7.1 — it goes `pending_host ->
  inside` directly), `evaluateEntry`'s own `VISIT_NOT_APPROVED` check (step 3) would
  have denied *every* walk-in approval, unconditionally. Caught before this file was
  updated to claim anything was "Done," by writing the walk-in integration tests and
  watching them fail for the right reason. Fixed by not calling `evaluateEntry` from
  `approveWalkIn` at all — see the function's own doc comment in `service.ts` for the
  full reasoning, kept there specifically so this isn't reintroduced.

**Concurrency — the task's explicit focus, SDD §7.3**: `apps/api/test/visits-
concurrency.integration.test.ts` fires genuinely concurrent requests (`Promise.
allSettled`, real separate DB connections from the same pg pool) against the same row
or constraint, for every race the task named:
- host approval vs. the 10-minute timeout — exactly one wins, loser gets
  `409 INVALID_TRANSITION` (SDD §7.3's own worked example).
- duplicate approval, duplicate check-in, duplicate check-out — each: exactly one
  succeeds, the rest get `409`, and exactly one gate event is written (not zero, not
  two) — proving the side effects are as atomic as the status column.
- simultaneous conflicting actions (guest cancels while host approves).
- two different visits trying to make the **same visitor** `inside` at once — the
  `visits_one_inside_per_visitor` partial unique index (BR-15) catches it for real
  under a live race; the loser gets `409 ALREADY_INSIDE`.
- a 10-way concurrent check-in stress case (not just 2-way) on one visit: exactly 1
  wins, 9 get `409`.

**What this explicitly does NOT do, so no later reviewer mistakes it for more than it
is (same discipline as §0, §0b, §0c, §0d, §0e above):**
- **No HTTP routes.** The task explicitly scoped this milestone to "service and
  repository... do not build UI yet" — nothing here is reachable over the network.
  Every FR row this milestone touches in §1 below is marked WIP, never Done, for
  exactly this reason.
- **No scheduled jobs.** `expireWalkIn`, `expireApprovedVisit`,
  `completeApprovedVisitWithoutReturn` are the *transitions* a cron job would call
  (BR-12, part of BR-13/FR-71/FR-72); nothing calls them on a schedule.
- **No gate/scan-session module.** Gate-involving triggers (`checkIn`, `checkOut`,
  `approveWalkIn`, `createHostAssistedEntry`) accept a plain `{gateId,
  locationVerified, distanceM?, accuracyM?, photoMediaId?}` struct the future gate
  module would supply from a real scan session — there is no QR/token verification,
  geofence check, or mock-location detection here.
- **Window derivation is the caller's job.** `createWalkIn`/`createOvernightRequest`
  take `windowStart`/`windowEnd` directly rather than deriving them from "now" /
  `arrivalDate`+`departureDate` per the SDD's own formulas (§12.6) — that derivation,
  and the `POST /v1/visits/preview` endpoint that would show it to a host before
  submission (SDD F6 step 2), are route-layer work, not built here.
- **Dispute handling (SDD F9, FR-42/FR-43) is not implemented at all** — "Not my
  guest" doesn't change `visits.status` (it stays `inside`), so it isn't one of SDD
  §7.1's 19 transitions and was correctly out of scope for a state-machine milestone;
  it belongs with the warden-dispute-resolution module, not here.
- **Host-assisted entry does not dedupe visitors** across repeated host-assisted
  visits for the same phoneless guest (SDD F4: "matched by host + name") — every call
  creates a new `haven.visitors` row. A documented simplification, not a correctness
  bug for anything this milestone tests.
- **Charge "recalculation"** (SDD §7.1's wording for `approved -> completed` /
  `inside -> completed`) is implemented as "confirm the charge as originally priced,"
  not as re-deriving the amount from actual nights stayed — the SDD doesn't specify a
  different formula, and no requirement here tests a stay that was shorter/longer
  than booked.

## 0g. Guest web golden-path milestone (2026-10-03)

Implements the guest web experience per SDD §13: invite landing, OTP sign-in, profile
completion (live camera, no gallery), check-in/check-out (real browser geolocation +
live camera against a simplified haversine geofence), a zone notice, a partial
walk-in flow, and the shared error/empty/offline/accessibility states — all against
the exact copy table in SDD §13.6 (`packages/shared/src/copy/en.ts`, transcribed
verbatim) and the exact design tokens in SDD §13.2 (`packages/ui/src/tokens.ts`). This
is a deliberately scoped **golden path**, not the full SDD §13 screen inventory — see
`docs/DECISIONS.md` DEC-009 for the scoping rationale and every simplification. Proven
end to end with Playwright (fake geolocation + fake camera device, 360×640 mobile
viewport, per SDD §19.1) against a real local API + real (embedded) Postgres database,
not mocks — not just unit-tested in isolation.

What exists now:
- `apps/api/src/visits/geo.ts` (`haversineDistanceMeters`) + `routes.ts`'s
  `resolveGateAndVerify` — the one piece of "gate module" functionality this milestone
  needed: a real distance check against a hostel's configured gate `lat`/`lng`/
  `radius_m`, called by the new `POST /v1/visits/:id/check-in` and `.../check-out`
  routes. **Not** the SDD's full rotating-QR/scan-session crypto (D1/D2) — see DEC-009.
- `GET /v1/invites/:token` (public invite landing) — closes the exact gap §0e flagged
  as not implemented. Combined with the already-existing `POST
  /invites/:token/claim` (§0e), the full SDD F1 "open link → sign in → claim" flow now
  has a real UI and a real route at both ends, proven end to end by the Playwright
  golden-path test (not just the claim logic in isolation, as §0e left it).
- `GET /v1/visits/:id`, `GET /v1/me/visits`, `GET /v1/hostels`, `GET /v1/rooms/search`,
  `POST /v1/visits/walk-in` (`apps/api/src/visits/routes.ts`) — the remaining read/
  write surface the guest web app needs; `POST /v1/visits/walk-in` wraps the
  already-built `createWalkIn` service function (§0f) with its first real HTTP caller.
- `PATCH /me` extended with `isAdultConfirmed` (`apps/api/src/auth/routes.ts`) — the
  18+ confirmation guests make during profile completion.
- The full guest web screen set (`apps/mobile/app/(guest)/**`): invite landing, phone +
  OTP sign-in, profile completion (name/gender/18+ + live photo capture), "My visits",
  the combined visit-status/gate-flow screen (location explainer → live camera → check-
  in/out → zone notice → errors), and a partial walk-in flow (room search → visit type
  → submit).
- Shared guest-web infrastructure: `packages/ui/src/tokens.ts` (SDD §13.2 design
  tokens), `packages/shared/src/copy/en.ts` (SDD §13.6 copy table, verbatim, with
  `{placeholder}` filling and a "never a dead end" fallback per §13.1 principle 5), and
  nine shared components (`Button`, `StatusChip`, `PhoneInput`, `OtpInput`, `Countdown`,
  `LiveCamera`, `Banner`/`OfflineBanner`, `EmptyState`, `ErrorState`) matching SDD
  §13.5's component list for the screens this milestone builds.
- `apps/mobile/e2e/playwright.config.ts` + `e2e/tests/golden-path.spec.ts`: a real,
  passing end-to-end run of invite landing → OTP → profile + live photo → check-in
  (real geolocation + live photo) → zone notice → check-out, against
  `apps/api/scripts/e2e-db.ts`/`e2e-server.ts` (a dedicated embedded-Postgres + frozen-
  clock API pair, separate from the unit/integration test infrastructure).
- **Two real bugs found by this end-to-end run, not by inspection or unit tests, fixed
  before this milestone was considered done** — see DEC-009 for the full write-up:
  a refresh-token-rotation race (two components independently retrying a 401 at once
  on a full page reload each tried to redeem the same single-use refresh cookie) and a
  dead-end camera-permission-denied state on the gate check-in/check-out screen (the
  profile screen handled this correctly; the gate screen silently left a disabled
  button with no explanation).

**What this explicitly does NOT do, so no later reviewer mistakes it for more than it
is (same discipline as every milestone above):**
- **No rotating-QR gate token, no scan session.** FR-20/FR-21/the TC-TOK-xx and
  TC-GEO-xx test cases remain entirely unbuilt — check-in/check-out here are driven
  directly from the visit-status screen, not a QR scan. D1/D2's actual mechanism is
  still future gate-module work.
- **Captured photos are not uploaded or persisted anywhere.** `LiveCamera` genuinely
  captures a live frame via `getUserMedia` (never a file picker — SDD §9.4/D4 honoured)
  but neither the profile photo nor the gate check-in/check-out photo reaches the API;
  there is no media-upload endpoint, no `media` table row, no host-facing photo compare
  (SDD §13.5's `PhotoCompare`). FR-24 stays WIP, not Done, for exactly this reason.
- **No live/real-time status updates.** "My visits" and the visit-status screen refetch
  on navigation/focus, not via the SDD §9.9 SSE channel — a host or guest sees a status
  change only after their own next navigation, not within 5s of it happening elsewhere.
- **Walk-in has no live wait screen and no scan session** (FR-25/FR-26 stay WIP) —
  submitting lands the visit in `pending_host`; nothing here polls or pushes to show
  the guest the moment a host (on the out-of-scope resident app) approves it.
- **No in-app QR scanner, no mock-location detection, no EXIF/dedup/signed-URL photo
  pipeline, no resident/warden/office apps** — all explicitly out of scope, matching
  the milestone's own stated boundary (see DEC-009).
- **Accessibility and responsive behaviour (SDD §13.7) were built and are exercised by
  the Playwright run at the 360×640 viewport**, but no dedicated axe/WCAG audit or a
  200%-text-zoom pass was run — NFR-11 stays unmarked.

## 0h. Gate subsystem milestone (2026-10-04)

Implements the complete gate subsystem per SDD §9.1-9.4, §11.3, §12.8: rotating QR
gate tokens, encrypted/versioned/rotatable gate secrets, scan sessions, geofence
verification, gate device pairing/heartbeat/revocation, a real photo-upload pipeline,
and the gate check-in/check-out/walk-in/host-assisted-entry/host-assisted-exit routes
— then rewires the entire guest web app onto it, replacing the guest-web milestone's
temporary, non-SDD `/v1/visits/:id/check-in`/`check-out`/`walk-in` endpoints (see
`docs/DECISIONS.md` DEC-010). 58 new tests (20 unit covering TC-TOK-01..05/
TC-GEO-01..05 and every malformed/unknown/inactive/expired/future/wrong-MAC/rotated-
secret case; 20 integration covering the full scan-session HTTP lifecycle including a
dedicated `awaiting_host_confirmation` regression test; the rest device-pairing/
profile-photo), plus a live Playwright suite covering the gate display's generated
token end to end (golden path, expired token, outside geofence, GPS-retry-limit-to-
ask-host path, and walk-in) against a real local API + database.

What exists now:
- `apps/api/src/gate/token.ts`: the SDD §9.1 token algorithm exactly — `gateCode +
  "." + step + "." + base32crockford(HMAC_SHA256(secret, "HVG1|"+gateCode+"|"+step)
  [0..10])`, verified with `crypto.timingSafeEqual`, accepting steps `-1..2` (30s old
  or one step ahead), trying the previous secret for 120s after a rotation.
- `apps/api/src/gate/secret.ts`: AES-256-GCM gate-secret generation/encryption/
  rotation (`gates.secret_enc`/`prev_secret_enc`/`secret_version`/`secret_rotated_at`,
  all already in the §0b-era schema — this milestone is the first real reader/writer).
- `apps/api/src/gate/geofence.ts`: `gps_ok` per SDD §9.3 step 3, reusing
  `visits/geo.ts`'s haversine helper (that module's own comment said the full gate
  system was out of scope for the milestone that added it — this is that system).
- `apps/api/src/gate/scanSessions.ts` + `repository.ts`: `POST /v1/scan-sessions`
  (token verify + geofence + insert), `POST /scan-sessions/:id/location` (retry, max
  3 attempts), nonce-bound single-use consumption (`validateAndBindSession`/
  `consumeSession`) — the first authenticated call binds the session to that
  principal; a different principal, wrong nonce, or an already-consumed/expired
  session all fail the same way SDD §9.3 specifies.
- `apps/api/src/gate/media.ts`: the real SDD §9.4 photo pipeline (magic-byte check,
  max 3MB, `sharp` EXIF-rotate/strip/resize-to-720/re-encode JPEG q80, SHA-256
  per-visitor dedup -> `PHOTO_REUSED`, `media` row insert) — used by both
  `POST /scan-sessions/:id/photo` (gate photos) and the new `POST /v1/me/profile-photo`
  (closing a DEC-009 gap). Storage is a disclosed local-disk substitute
  (`LocalDiskMediaStorage`) for the same reason DEC-004 used one for Postgres — no
  reliable Supabase Storage connection in this sandbox.
- `apps/api/src/gate/devices.ts`: `POST /gate-devices/pair`, `POST /gate-devices/
  heartbeat` (with secret-refresh-on-rotation and a revoked-device response the
  device actually receives, not a 401 — see the DEC-010 finding below), `POST
  /admin/gates/:id/pairing-codes` and `POST /admin/gate-devices/:id/revoke` (minimal
  warden-authenticated routes, just enough to exercise pairing/rotation for real —
  the full warden Gates screen, W-09, is not built).
- `apps/api/src/gate/routes.ts`: `GET /scan-sessions/:id` (resolves `check_in`/
  `check_out`/`request_entry`), and the five `★` actions from SDD §12.8 — check-in,
  check-out, walk-in, host-assisted-entry, host-assisted-exit — each verifying the
  scan session, then delegating the actual visit-state transition to the existing
  `visits/service.ts` functions.
- Real `Authorization: Device <token>` verification wired into `authenticate.ts`
  (previously a stub resolving to `null` always — see §0c/§0e).
- Guest web (`apps/mobile/app/(guest)/g/[token].tsx`): the real SDD F1 step 6+ flow —
  location explainer (first time only) -> scan session -> location retry (3 attempts,
  then "Ask host to confirm", FR-27) -> check-in/check-out/walk-in sub-flow -> live
  photo -> result. `visits/[id].tsx` is now a pure read-only status view; the
  temporary direct check-in/check-out buttons and the standalone `walk-in.tsx` screen
  are removed.
- Gate display page (`apps/mobile/app/gate/index.tsx`, `pair.tsx`): SDD §9.2 — local
  rotating QR generation via Web Crypto HMAC-SHA256 (works offline), redraws every
  250ms step-change tick, a 10s countdown bar, wake lock, fullscreen, 60s heartbeat
  with 5s/15s/60s backoff, a small offline badge, and D-01 (pair)/D-03 (revoked)
  screens. Verified to never render any personal data (hostel/gate name and a QR
  only) and to redraw the QR on every 10s step change.

**Two real bugs found while building/testing this milestone, fixed before it was
considered done:**
1. **Check-in unconditionally completed entry regardless of GPS verification.** The
   existing `checkIn()` service (built before the gate module existed) had no "wait
   for host" branch at all — SDD §12.8 requires `awaiting_host_confirmation` (visit
   stays `approved`, a `N-CONFIRM-LOCATION` notification queued) when `gpsOk` is false
   and the host hasn't already confirmed presence. The gate check-in route now
   short-circuits before calling `checkIn()` in exactly that case. Found while
   implementing FR-27's "ask host to confirm" path, not by inspection.
2. **A revoked gate device's heartbeat returned 401, never reaching the `{revoked:
   true}` response the device needs to show D-03.** `verifyDeviceToken` originally
   filtered out revoked devices (treating them like unknown tokens); fixed to resolve
   them (so `recordHeartbeat` can tell them to wipe their storage) — no other gate
   action accepts a device principal today, so this is a safe, narrow change.

**What this explicitly does NOT do, so no later reviewer mistakes it for more than it
is (same discipline as every milestone above):**
- **No in-app QR scanner** (FR-22, S-priority) — guests scan with their phone's own
  camera app, which opens `/g/<token>` directly; no in-app scanning UI exists.
- **FR-26's "waits on a live status screen... without re-scanning" is only half
  built.** A wait screen (`waiting_for_host` phase) exists, but it does not poll
  `GET /v1/me/visits/{id}` every 3s per SDD, and there is no `Cancel request` button
  (the `cancelWalkIn` service function exists from the visits milestone but has no
  HTTP route) — because nothing in this milestone can ever change a `pending_host`
  visit's status to observe (that's `approveWalkIn`, a Resident-app action), the
  guest-side polling would have nothing to react to yet. Flagged as a known gap
  rather than built speculatively; the Resident app milestone should add both the
  polling/cancel route and the thing that makes polling meaningful.
- **Host-assisted entry/exit have routes but no UI** — explicitly deferred to the
  Resident app milestone per the task's own scope boundary; this milestone is
  API-only for those two actions.
- **No warden-facing gate status** (FR-29's "warden sees gate status, alerted after 5
  min offline") — `gate_devices.last_seen_at`/`offline_alerted_at` are tracked and
  `job_gate_offline()` already exists in the DB (§0b), but no warden dashboard reads
  them. Same for `GATE_NOT_CONFIGURED`'s dashboard red banner (E-14) and W-09's Gates
  screen generally — this milestone's two `/admin/*` routes are the minimum needed to
  pair/revoke a device for real, not the Warden app.
- **No SSE/live updates (SDD §9.9).** "My visits" and the visit-status screen still
  refetch on navigation/focus only — building the notify-worker/SSE fan-out
  infrastructure is a separate subsystem or in and of itself, unrelated to the gate
  (visits service already produces the notification rows; nothing delivers them
  live). Reviewed against DEC-009's gap list per the task's own instruction and named
  here as its own future milestone rather than folded into this one.
- **E-23 (two devices paired to one gate, same secret, either works) is true by
  construction** (the secret is per-gate, not per-device) but not exercised by a
  dedicated two-device test. E-24 (approved visit at a different hostel's gate ->
  `request_entry`, not `check_in`) is correctly implemented (the scan-session actions
  query is scoped to the scanned gate's own `hostel_id`) but likewise untested by a
  dedicated case.

## 0i. Demo milestone (2026-10-04)

A resident minimal slice, FR-26's full polling/cancel behaviour, and a `pnpm demo`
environment, built to support a live demo without building the full Resident, Warden,
or Office apps (docs/DECISIONS.md DEC-011).

**What this builds:**
- Four resident screens at `/resident/*` (sign-in, invite, requests, visits) — see
  FR-10/FR-11/FR-40/FR-45 and the coverage table below.
- `POST /v1/visits` (invite only), `GET /v1/me/hosted-visits`, `POST /v1/visits/:id/
  approve` ★, `POST /v1/visits/:id/reject` ★, `POST /v1/me/visits/:id/cancel`
  (`apps/api/src/visits/host-routes.ts`), per SDD §12.6.
- `scan_sessions.visit_id` (new column) so walk-in approval can reuse the original
  scan session's GPS facts instead of re-checking location (SDD F2 step 9).
- FR-26's missing half: 3s polling + `Cancel request` on the guest wait screen.
- A dev-only sign-in bypass (`POST /v1/auth/dev-login`), gated two independent ways
  (route registration + a `buildApp`-level `NODE_ENV` boot refusal) — see DEC-011.
- `pnpm demo`: its own embedded Postgres, real clock, configurable gate coordinates,
  and a startup banner with the gate pairing code and sign-in instructions
  (`apps/api/scripts/demo-*.ts`, `scripts/demo.mjs`).
- `docs/DEMO.md`: the full presentation script, HTTPS tunnel setup, and failure-case/
  fallback guidance.

**What this explicitly does NOT do:**
- **No full Resident app shell.** Only the four screens this demo needs; no tab bar,
  no Home/Overnight-request/Guest-without-phone/Charges/Profile screens (SDD §13.4).
- **No native share sheet** (FR-11) — Copy-link only; see the FR-11 row.
- **No push notifications, photo comparison, or end-time adjustment on approval**
  (FR-40) — see the FR-40 row.
- **`GET /v1/me/hosted-visits` returns one flat list**, not the SDD's Upcoming/Inside/
  History segments (R-13).
- **Warden and office remain entirely unbuilt** — not reviewed or touched this
  milestone, per the task's explicit scope instruction.
- **No real Google OAuth** — the dev-login bypass exists specifically because no
  Google OAuth credentials are configured for this environment; a real deployment
  still requires SDD §9.5's Google Sign-In, this milestone does not change that
  requirement, it only adds a demo/dev-only alternative that cannot run outside
  `NODE_ENV=development`.

## 0j. Resident app milestone (2026-10-18)

The Resident application (SDD §13.4 R-01..R-15) on the web target, with the API
surface it needs (§12.4–§12.6), notification delivery (§9.7, §15) and push handling.
Decisions and interpretations: docs/DECISIONS.md DEC-012.

**What this builds:**
- **Auth/onboarding** (`apps/mobile/app/(auth)/`): R-01 sign-in (Google Identity
  Services on web when a client id is set; DEC-011 dev sign-in otherwise), R-02 phone
  OTP, R-03 hostel/room + live ID card + live selfie + consent, R-04 pending/rejected
  (one resubmission). API: `POST /residents/me`, `/residents/me/documents`,
  `/residents/me/submit`; resident profile on `GET /me`.
- **Resident shell** (`apps/mobile/app/(resident)/`): five tabs — R-05 Home (waiting
  requests in amber, inside now, upcoming today, quick actions), R-13 Guests (Upcoming/
  Inside/History, paged), R-06/R-07 Invite + Share (WhatsApp, share sheet, copy link;
  shared-rules hints + server preview), R-14 Charges (totals), R-15 Profile — plus R-08
  walk-in request (photos, editable end time, approve/reject), R-09 arrival (photo
  compare, confirm / "Not my guest"), R-10 visit detail (flags, timeline, cancel/edit/
  share/mark-left), R-11 overnight request (server preview: nights, charge, quota bars),
  R-12 host-assisted entry/exit (in-app QR scan, GPS with mock refusal, live photo), and
  the in-app notifications list.
- **API** (`apps/api/src/visits/host-routes.ts`, `host-actions.ts`, `dto.ts`):
  preview, invite/overnight create, bucketed paged list returning the §12.3 VisitDTO
  with `allowedActions`, detail + timeline (audited read), edit, cancel, invite-link,
  approve/reject/confirm-arrival/dispute/mark-left ★ under `Idempotency-Key`
  (`lib/idempotency.ts`), `/me/quota`, `/me/charges`, signed photo URLs
  (`media/`).
- **Notifications** (`apps/api/src/notify/`): verbatim §15 templates, outbox producer
  with 60 s SMS fallbacks, the worker (Expo push, console SMS, retries, dead-token
  disabling, staleness), push-token registration, in-app list, opened; the app routes
  taps via the shared screen table (`packages/shared/src/api/notifications.ts`).
- **Shared contracts** (`packages/shared/src/api/`) and display formats.

**What this does NOT do (see DEC-012):** native Google Sign-In; running on Android (no
SDK on this machine — native push, camera, location and secure-store code is
typechecked but unexecuted); the R-06 contact picker; account deletion (FR-09); the
push receipts job; `Idempotency-Key` on the guest's own ★ routes; warden/office
screens. A guest-web behaviour was found: after the sign-in detour the guest app re-checks the
stale gate token — since accepted as a deviation (DEC-013, FR-21 row).

## 0k. Warden and office milestone (2026-10-18)

The warden and office experiences (SDD §13.4 W-01..W-12, O-01) on the web target, the
`/v1/admin` API (§12.9) and live updates (§9.9). Decisions and interpretations:
docs/DECISIONS.md DEC-014. The accepted guest re-scan deviation is DEC-013.

**What this builds:**
- **Authorization** (`apps/api/src/admin/policy.ts`, `scope.ts`): one `authorize()`
  policy per §3.3 capability; hostel scope only from live `role_assignments` checked
  against `X-Hostel-Id`. Records in another hostel are `NOT_FOUND`. Super admin grants
  are `h: '*'`. Role changes clear the revocation cache at once and drop open streams.
- **API** (`apps/api/src/admin/`): dashboard, visit search/detail (audited read),
  force check-out, resolve dispute, emergency roll call (JSON/CSV, audited), approvals,
  reports (JSON + CSV, audited), residents (verify/reject with ID card deletion,
  suspend/unsuspend, mark left), bans, rules (versioned publish), gates (location,
  pairing codes, revoke), staff (invites, deactivate), hostels, audit log, charges
  (list, fine, confirm, mark paid, waive) with the office serializer stripping phone and
  photo fields.
- **Live updates** (`apps/api/src/stream/`): `pg_notify` triggers → one `LISTEN`
  connection → in-memory fan-out by hostel and role; `GET /v1/stream` with 25 s pings and
  a session/role re-check per ping. Client: `apps/mobile/lib/live.ts` (web) /
  `live.native.ts`, with backoff reconnect and 15 s polling fallback.
- **Jobs** (`apps/api/src/jobs/runner.ts`): the §9.8 SQL jobs run in-process where
  `pg_cron` isn't installed. Migration `20261018000002` fixes `job_flag_overstays`, which
  had never run. Migration `20261018000001` adds gate-device events.
- **App** (`apps/mobile/app/warden/`, `app/office/`, `components/staff/`): W-01..W-12
  and O-01, the hostel picker, the role switcher, the staff invite landing page, and
  push registration for staff.
- **Demo** (`pnpm demo`): warden, office user and super admin with seeded visits and
  charges (docs/DEMO.md §H).

**Tests added:** `apps/api/test/staff-permissions.integration.test.ts` (188: every §3.3
staff capability × guest, resident, warden, office, super admin, gate device, plus the
stream and scope edge cases, asserting exact error codes); `staff-behaviour.integration.test.ts`
(22: cross-hostel isolation incl. SSE, TC-SEC-03, FR-07 session end, SSE check-in,
verify/reject, suspend, force check-out + ban, rules versions, fines and charges, roll
call, invites, an audit row for every privileged action); `jobs-runner.integration.test.ts`
(runner cadence, TC-JOB-01); `apps/mobile/e2e/tests/warden-office.spec.ts` (4 Playwright
flows); staff routing in `apps/mobile/test/resident-logic.test.ts`.

**What this does NOT do:** Google sign-in for staff is untested (no OAuth client here;
staff use the DEC-011 dev sign-in, so a staff invite can be created but not accepted in
dev); Android was never run; W-09 has no map preview (DEC-014 item 18); the FR-60 daily
digest (priority C) isn't built; account deletion (FR-09) isn't built.

## 0l. Async milestone: notifications, jobs, retention, deletion (2026-10-18)

### 0l.1 Audit before changes

Audited against SDD §9.7, §9.8, §11.5, §11.8, §15, §16.5 and §16.6, at commit 5d47684,
before any code changed.
- **MATCHES:** implementation and text agree with the SDD, and a test proves it.
- **WRONG:** behaviour or text differs from the SDD.
- **MISSING:** not built.
- **UNTESTED:** looks right but no test proves it.

"Same tx" means the row is inserted in the same database transaction as the state
change that causes it. The SQL jobs insert in the same statement as their `UPDATE`.

**Notifications (§15.2)**

| Kind | Trigger → recipient | Channel(s) and fallback | Text vs SDD | Enqueued in | Same tx | Test | Before |
|---|---|---|---|---|---|---|---|
| N-WALKIN | Walk-in submitted → host | Push (approvals); SMS `HAVEN_WALKIN` after 60 s if unopened | Verbatim | `visits/service.ts` `createWalkIn` | Yes | `resident-approvals-notifications` (text, opening cancels the SMS, no-token immediate SMS) | UNTESTED: "unopened → exactly one SMS at 60 s" isn't proven |
| N-WALKIN-EXPIRED | 10 min, no decision → host | Push (updates) | Verbatim (migration 20261017000001) | SQL `job_expire_walkins` | Yes | `resident-approvals-notifications` (job expires it, host told by name) | WRONG: job boundary is `<`, so the walk-in isn't expired at exactly 10:00 (BR-12) |
| N-CONFIRM-LOCATION | Unverified check-in/walk-in → host | Push (approvals); SMS `HAVEN_CONFIRM_LOC` after 60 s | Verbatim | `visits/service.ts`, `visits/host-actions.ts` | Yes | `resident-approvals-notifications` (F3, TC-FLOW-04) | MATCHES |
| N-ARRIVED | Check-in → host | Push (updates) | Verbatim | `visits/service.ts` `checkIn` | Yes | `resident-approvals-notifications`, `templates.test.ts` | MATCHES |
| N-LEFT | Check-out → host | Push (updates) | Verbatim + F5 sentence (DEC-012) | `visits/service.ts` `checkOut` | Yes | `templates.test.ts`, `resident-approvals-notifications` | MATCHES |
| N-OVERSTAY-HOST | Overstay flagged → host | Push (alerts), at most one per visit | Verbatim | SQL `job_flag_overstays` | Yes | `jobs-runner` (TC-JOB-01) | WRONG: flags only *after* window_end + 15:00 (strict `>`); BR-13 says + 15:00 is overstaying. Job reads the database clock, so the boundary can't be tested with an injected clock |
| N-OVERSTAY-GUEST | Overstay flagged → guest | SMS `HAVEN_OVERSTAY` | Uses the §15.2 body ("…visit to {hostelCode} ended at…"), not the registered §15.3 DLT text ("Your HAVEN visit ended at {#var#}…") | SQL `job_flag_overstays` | Yes | `jobs-runner` (TC-JOB-01) | WRONG: an SMS must match its DLT template exactly or the operator rejects it (SDD conflict, see DEC-015) |
| N-OVERSTAY-WARDEN | 30 min after flag → wardens | Push (alerts) | Verbatim | SQL `job_flag_overstays` | Yes | none | WRONG + UNTESTED: escalates only *after* 30:00 (strict `<`); no test of the escalation |
| N-NIGHT-SWEEP | 22:00 → wardens | Push (alerts), in-app if zero | Verbatim; zero case uses the §11.8 text | SQL `job_night_sweep` | Yes | none | WRONG + UNTESTED: tapping it opens a *resident* screen, not W-02 filtered to the guests (§11.8); TC-JOB-02 not written |
| N-NIGHT-SWEEP-HOST | 22:00, day guest inside → host | Push (alerts) | Verbatim | SQL `job_night_sweep` | Yes | none | UNTESTED |
| N-DISPUTE | "Not my guest" → wardens | Push (alerts) + SMS `HAVEN_DISPUTE` immediately | Verbatim | `visits/host-actions.ts` `disputeArrival` | Yes | `resident-approvals-notifications` (TC-FLOW-06) | MATCHES |
| N-OVERNIGHT-REQ | Overnight/guest-room requested → wardens | Push (approvals) | Verbatim | `visits/service.ts` | Yes | `resident-onboarding-visits` | MATCHES |
| N-OVERNIGHT-DECIDED | Warden decision → host | Push (updates) | Verbatim | `visits/service.ts` | Yes | `resident-onboarding-visits`, `templates.test.ts` | MATCHES |
| N-RES-SUBMITTED | Resident submits → wardens | Push (approvals) | Verbatim | `residents/service.ts` | Yes | `resident-onboarding-visits` | MATCHES |
| N-RES-DECIDED | Warden verifies/rejects → resident | Push (updates) | Verbatim | `admin/people-routes.ts` | Yes | `staff-behaviour` | MATCHES |
| N-GATE-OFFLINE | Device silent 5 min → wardens | Push (alerts), once per outage | Time is zero-padded ("04:42 pm"; §13.1 is "4:42 pm") | SQL `job_gate_offline` | Yes | `staff-behaviour` (row exists) | WRONG: time format; tapping opens a resident screen, not W-09 |
| N-CHARGE | Charge created or marked paid → resident | In-app | Verbatim | `admin/charges-routes.ts` (fine created, paid) | Yes | `staff-behaviour` | MISSING: no N-CHARGE when an overnight approval creates the pending charge (BR-08) |
| N-HOST-SUSPENDED | Warden suspends → resident | Push (updates) | Verbatim; no-end-date wording proposed in DEC-014 | `admin/people-routes.ts` | Yes | `staff-behaviour` | MATCHES |
| N-WALKIN-REJECTED | Host rejects walk-in → guest page | In-app only | §13.6 "Walk-in rejected" copy; named in §7.1, not in the §15.2 table | `visits/service.ts` `rejectWalkIn` | Yes | `resident-approvals-notifications` | MATCHES (note: an in-app guest-page message from §7.1, not a sent push/SMS) |

**Delivery and sending rules (§9.7, §15.3, §15.5)**

| Requirement | Before |
|---|---|
| Producers only insert; a rolled-back transaction sends nothing | UNTESTED (every producer passes its transaction; no rollback test) |
| Claim with `FOR UPDATE SKIP LOCKED`; concurrent workers never double-send | UNTESTED (the query is the SDD's; no two-worker test) |
| Retries 10 s, 30 s, 2 min, 10 min, then `failed` | MATCHES (`resident-approvals-notifications`) |
| "failed (and logged to Sentry)" | MISSING: no Sentry anywhere in the API (NFR-13) |
| Idempotent if a row is processed twice; a crash mid-send leaves rows in `sending` forever | MISSING: no recovery for stuck `sending` rows; a late finish can overwrite another worker's result |
| Push via `expo-server-sdk`, chunked; `DeviceNotRegistered` disables the token | MATCHES for tickets (`resident-approvals-notifications`) |
| "A job fetches receipts 15 min later" | MISSING |
| `SmsProvider.send(to, templateId, vars)`; `ConsoleSmsProvider` | WRONG: the interface takes a pre-built body, not DLT variables, and nothing stops a template outside §15.3 |
| `Msg91SmsProvider` | MISSING (not in this milestone's brief: provider boundary + dev fake only) |
| Fallback: SMS after 60 s if the push is unopened; opened tracking | MATCHES for "opened cancels" and staleness; UNTESTED for timing (59 s vs 60 s, exactly one SMS) |
| No guest phone number or photo in any push or SMS body | UNTESTED (true of every template by inspection; nothing enforces or tests it) |
| At most one overstay push per visit to the host | MATCHES by dedupe key (TC-JOB-01) |
| At most one gate-offline push per outage | UNTESTED |
| No active push token → SMS fallback now for kinds that have one, else in-app only | MATCHES (`resident-approvals-notifications`) |

**Jobs (§9.8, §11.8)**

| Job | Schedule (SDD) | Runner | What it does vs SDD | Test | Before |
|---|---|---|---|---|---|
| `job_expire_walkins` | Every min | pg_cron / `JobRunner` every 1 min | Expires `pending_host` older than `walk_in_timeout_minutes`, notifies host | `resident-approvals-notifications` | WRONG: strict `<` (10:00 not expired); uses the DB clock |
| `job_expire_approved` | Every 5 min | every 5 min | Never-entered → `expired`, entered → `completed`; waives pending charges | none | WRONG + UNTESTED: strict `<` on `window_end` (FR-71 "at window_end"); charge waiving picks visits "closed in the last 5 minutes", which misses or repeats rows depending on timing |
| `job_flag_overstays` | Every 5 min | every 5 min | Flags, host push, guest SMS, 30-min warden escalation | `jobs-runner` (TC-JOB-01) | WRONG: boundaries (above), SMS text vs DLT template |
| `job_night_sweep` | 22:00 IST (16:30 UTC) | daily 22:00 IST | Per hostel: wardens get push (or in-app if none), hosts get push | none | WRONG + UNTESTED: tap target (above); TC-JOB-02 not written |
| `job_gate_offline` | Every 5 min | every 5 min | Silent > 5 min → wardens, once per outage | `staff-behaviour` (row exists) | WRONG: time format; once-per-outage UNTESTED |
| `job_retention` | 03:00 IST (21:30 UTC) | daily 03:00 IST | Marks media due, anonymises per §16.5 | none | WRONG + MISSING + UNTESTED (see §16.5 below) |
| `job_expire_sessions` | Hourly | every 60 min | Deletes old scan sessions, OTP challenges, idempotency keys, pairing codes | none | UNTESTED |
| Push receipts | "15 min later" (§9.7) | none | — | none | MISSING |
| Media file deletion | "the API worker deletes the files" (§11.8) | none | — | none | MISSING: `delete_after` is set but no file is ever deleted |
| Account deletion worker | "within 7 days" (§16.6) | none | — | none | MISSING |

**Retention schedule (§16.5) and account deletion (§16.6)**

| Row | Before |
|---|---|
| Scan sessions deleted 1 day after expiry | UNTESTED (`job_expire_sessions`) |
| OTP challenges deleted after 1 day | UNTESTED (`job_expire_sessions`) |
| Gate photos: `delete_after = created_at + 180 days`; file deleted, `deleted_at` set | MISSING: date set, file never deleted |
| Guest profile photo deleted 365 days after `last_visit_at` | WRONG: `delete_after` is stamped once and never moved, so a guest who comes back still loses their photo on the old date; MISSING: file never deleted |
| Guest identity anonymised 365 days after last visit with no future visits | WRONG: setting `phone = null` violates the `visitors` check (phone or host-created) for every self-registered guest, which aborts the whole retention run. Also `last_visit_at` is only set at sign-in, not at check-in |
| Visit rows: `invited_name`, `invited_phone` nulled after 2 years | UNTESTED |
| Resident ID card deleted at the verification decision | MATCHES (synchronous, `staff-behaviour` FR-05 tests) |
| Audit log kept 2 years | MISSING: never purged, and the append-only trigger blocks any delete |
| Notification bodies nulled after 90 days | UNTESTED |
| FR-09 / §16.6 account deletion: `POST /me/deletion-request`, sign-out, waiting rules, unpaid-charges block, worker, R-15 and G-17 buttons | MISSING |
| FR-60 daily digest (C) | MISSING (build only if everything else is done) |

**Summary before:** 19 notification kinds: 10 MATCHES, 6 WRONG, 1 MISSING, 2
UNTESTED. 14 delivery rules: 4 MATCHES, 1 WRONG, 4 MISSING, 5 UNTESTED. 10 jobs:
0 MATCHES, 6 WRONG, 1 UNTESTED, 3 MISSING. 11 retention/deletion rows: 1 MATCHES,
2 WRONG, 4 MISSING, 4 UNTESTED.

### 0l.2 After this milestone

Same rows as §0l.1, after the fixes. Decisions: docs/DECISIONS.md DEC-015.

| Area | Before (MATCHES / WRONG / MISSING / UNTESTED) | After |
|---|---|---|
| 19 notification kinds | 10 / 6 / 1 / 2 | 19 MATCHES (N-OVERSTAY-GUEST now sends the §15.3 DLT text — an SDD conflict, DEC-015 item 3) |
| 14 delivery and sending rules | 4 / 1 / 4 / 5 | 12 MATCHES, 2 MISSING: Sentry (NFR-13, not wired anywhere) and `Msg91SmsProvider` (outside this brief; no credentials) |
| 10 jobs and API-side workers | 0 / 6 / 3 / 1 | 10 MATCHES |
| 11 retention and deletion rows | 1 / 2 / 4 / 4 | 10 MATCHES, 1 deferred: FR-60 digest (no §15.2 text; proposal awaits approval) |

What changed, by finding:
- **Boundaries.** BR-12 (10:00), FR-71 (window_end), BR-13 (+15:00) and FR-72 (30:00)
  are inclusive. Every job takes the injected clock (`p_now`); pg_cron still calls
  them with none. Tested to the second in `apps/api/test/jobs-runner.integration.test.ts`.
- **N-OVERSTAY-GUEST** sends the registered DLT text. **N-GATE-OFFLINE** has its §15.2
  sentence, the "4:42 pm" time format, one alert per warden (only the first warden
  was alerted before) and once per outage. **N-NIGHT-SWEEP** opens W-02 filtered to
  the guests. **N-CHARGE** is also sent when an approval creates a charge.
- **Worker.** A two-worker concurrency test, a rolled-back transaction that sends
  nothing, a claim lease for crashed workers, and a guard against late finishes. SMS
  goes out as a DLT template + variables through `SmsProvider.send(to, templateId,
  vars)`. A §15.5 guard refuses phone numbers and photo links. Push receipts are
  fetched at 15 min. All in `apps/api/test/notification-worker.integration.test.ts`.
- **Retention.** Anonymisation works (constraint relaxed); `last_visit_at` moves on
  every entry; profile-photo dates follow the latest visit; audit rows are purged
  after 2 years; files are deleted; a `job.retention` audit row is written per run.
  In `apps/api/test/retention.integration.test.ts`.
- **Account deletion.** Built end to end: API, worker, R-15 and G-17. Tested in
  `apps/api/test/account-deletion.integration.test.ts` and
  `apps/mobile/e2e/tests/account-deletion.spec.ts`.
- **Guest page.** It now shows an expired walk-in instead of waiting forever.

**Tests added:** `jobs-runner.integration.test.ts` (rewritten, 10),
`notification-worker.integration.test.ts` (13), `retention.integration.test.ts` (7),
`account-deletion.integration.test.ts` (9), an N-CHARGE assertion in
`resident-onboarding-visits.integration.test.ts`, and Playwright
`account-deletion.spec.ts` (3).

**Not done:** FR-60 (deferred, above); Sentry; `Msg91SmsProvider`; a warden
notification list on the web (not in W-01..W-12); a Playwright test of the guest's
expired-walk-in screen; the proposed deletion copy awaits approval.

## 0m. Media verification and security audit (2026-10-19)

**Part 0** (DEC-016):
- the account-deletion copy is approved;
- FR-60's daily digest is built (N-DIGEST, a team-approved catalogue addition);
- the overstay SMS keeps the §15.3 DLT text (§15.2 to be corrected);
- SMS recipient phones are nulled after 90 days.

**Media** (§9.4, §9.10), checked line by line and fixed where it differed:
- storage is addressed by bucket and path;
- an upload over 3 MB returned 500 and is now `PHOTO_INVALID`;
- decoding is capped at 40 MP;
- a path-traversal guard was added;
- the media route goes through `authorize()`;
- web capture uses §9.4's ideal 720 px constraints and a mirrored preview.

Tests: `apps/api/test/media.integration.test.ts` (11).

**Security audit:** `docs/SECURITY-AUDIT.md`, written before fixing.
- Found: 3 HIGH, 10 MEDIUM, 10 LOW, 7 INFO.
- Fixed: every HIGH; every MEDIUM except SA-12 (web CSP, needs a decision); 4 LOW.
- Decisions recorded in DEC-017.
- Sentry is wired (API and web).
- Turnstile is implemented behind `BotVerifier` (API and web).
- Regression tests: `apps/api/test/security.integration.test.ts` (23). 17 of its first
  20 fail on the pre-fix code.

## 1. Functional requirements (FR-xx) — SDD §5

### 5.1 Accounts and onboarding

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-01 | M | Guest signs in with 6-digit SMS OTP | `src/auth/otp-service.ts`, `src/auth/routes.ts`; guest web UI at `apps/mobile/app/(guest)/login.tsx` | `test/otp-service.integration.test.ts`, `test/auth-routes.integration.test.ts`, `apps/mobile/e2e/tests/golden-path.spec.ts` | Done |
| FR-02 | M | First-time guest profile: name, gender, 18+, consent, profile selfie | `apps/mobile/app/(guest)/profile.tsx`, `PATCH /me` (`isAdultConfirmed`, `src/auth/routes.ts`) | `apps/mobile/e2e/tests/golden-path.spec.ts` | WIP — name/gender/18+ confirmation genuinely implemented and tested end to end; the profile photo is captured live (no gallery) but never uploaded/persisted — no media endpoint exists yet |
| FR-03 | M | Residents and staff sign in with Google | `src/auth/google-service.ts`, `src/auth/google.ts`; R-01 `apps/mobile/app/(auth)/sign-in.tsx` + `components/GoogleSignInButton.tsx` (web Google Identity Services) | `test/google-service.integration.test.ts`, `test/auth-routes.integration.test.ts` | WIP — server side done; the web button is wired but untested without a Google client id, and native (`@react-native-google-signin`) is not built (DEC-012). The DEC-011 dev sign-in is what the e2e suite and demo use |
| FR-04 | M | Resident phone OTP, room number, ID card photo, selfie, awaits verification | `phone_verify` OTP; `POST /residents/me`, `/residents/me/documents`, `/residents/me/submit` (`apps/api/src/residents/`); R-02/R-03/R-04 (`apps/mobile/app/(auth)/phone.tsx`, `onboarding.tsx`, `pending.tsx`) | `apps/api/test/resident-onboarding-visits.integration.test.ts` (flow, missing-phone refusal, one resubmission, guest refused), `apps/mobile/e2e/tests/resident-app.spec.ts` (R-01 → R-04) | Done — the warden's side of verification is FR-05 |
| FR-05 | M | Warden sees pending residents, approves/rejects in one tap; ID card deleted on decision | `POST /admin/residents/{id}/verify` / `reject` (`apps/api/src/admin/people-routes.ts`, ID card file + record deleted, N-RES-DECIDED); W-04 `apps/mobile/app/warden/approvals.tsx` | `apps/api/test/staff-behaviour.integration.test.ts` (verify, reject), `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (warden verifies a resident) | Done |
| FR-06 | S | Warden invites office by email; super admin invites wardens; 48h expiry bound to email | `POST /admin/staff-invites` (`apps/api/src/admin/config-routes.ts`; warden → office, super admin → warden), `POST /admin/hostels`; acceptance in `src/auth/google-service.ts`; W-10 `apps/mobile/app/warden/staff.tsx`, `app/(auth)/staff-invite/[token].tsx` | `apps/api/test/staff-behaviour.integration.test.ts` (W-10 48 h, email-bound), `apps/api/test/staff-permissions.integration.test.ts`, `test/google-service.integration.test.ts` | WIP — creation and API acceptance tested; accepting in the app needs Google sign-in, untested without OAuth credentials (DEC-014) |
| FR-07 | M | Warden deactivates staff / marks resident left; sessions end immediately | `POST /admin/residents/{id}/mark-left`, `POST /admin/staff/{id}/deactivate` → `endAllSessions` (`apps/api/src/admin/effects.ts`: sessions revoked, push tokens disabled, cache cleared, streams closed); W-08, W-10 | `apps/api/test/staff-behaviour.integration.test.ts` (FR-07 block), `apps/api/test/staff-permissions.integration.test.ts`, `test/sessions.integration.test.ts` | Done |
| FR-08 | S | Guest/resident edit name, retake profile photo | — | — | — |
| FR-09 | S | Guest/resident request account deletion | `POST /v1/me/deletion-request` (`apps/api/src/account/routes.ts`), worker `processDeletionRequests` (`apps/api/src/account/deletion.ts`, every 15 min), table `deletion_requests`; R-15 and G-17 buttons (`apps/mobile/components/DeleteAccount.tsx`) | `apps/api/test/account-deletion.integration.test.ts` (sign-out everywhere, waits while inside / visit in 24 h, unpaid-charges block, staff refused, photos deleted, anonymised, visit rows kept), `apps/mobile/e2e/tests/account-deletion.spec.ts` | Done — copy approved (DEC-016) |

### 5.2 Visits and invites

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-10 | M | Verified host creates pre-invite (name, phone, type, date, window) | `createPreInvite`, `POST /v1/visits` + `POST /v1/visits/preview` (`apps/api/src/visits/host-routes.ts`, `host-actions.ts`); R-06 `apps/mobile/app/(resident)/invite.tsx` (shared Zod schema + shared `evaluateCreate` hints; server preview decides) | `apps/api/test/resident-onboarding-visits.integration.test.ts` (create, preview, TC-RULE-13), `apps/api/test/host-routes.integration.test.ts`, `apps/mobile/e2e/tests/resident-app.spec.ts` (create invite; 10 pm window refused) | Done — the contact picker for the phone field is not built (typed phone) |
| FR-11 | M | Host shares invite link via native share sheet | R-07 `apps/mobile/components/SharePanel.tsx` (T-INVITE / T-INVITE-OVERNIGHT verbatim, `packages/shared/src/format.ts`; WhatsApp first, OS share sheet, copy link); `POST /visits/{id}/invite-link` | `apps/api/test/resident-onboarding-visits.integration.test.ts` (new link invalidates the old one), `apps/mobile/e2e/tests/resident-app.spec.ts` (T-INVITE text + link) | Done |
| FR-12 | M | Opening invite link requires OTP to invited number; other numbers refused | `apps/api/src/auth/invites.ts`'s `claimInvite` + `POST /invites/:token/claim` (`src/auth/routes.ts`, §0e) + the new public `GET /v1/invites/:token` landing route (`apps/api/src/visits/routes.ts`) + guest web UI (`apps/mobile/app/(guest)/i/[token].tsx`, `login.tsx`) | `apps/api/test/invites.integration.test.ts`, `apps/mobile/e2e/tests/golden-path.spec.ts` (happy path only) | Done — the full "open link → sign in → claim" flow (SDD F1) now has a real UI and real routes at both ends, proven end to end; the `INVITE_PHONE_MISMATCH` rejection path is implemented (`login.tsx` surfaces it as a user-facing error, not swallowed) but has no dedicated automated test — TC-FLOW-07 stays unmarked |
| FR-13 | M | Host edits window / cancels visit until guest checks in | `PATCH /visits/{id}` (`editVisitWindow`, rules re-checked), `POST /visits/{id}/cancel`; R-10 Edit time / Cancel visit | `apps/api/test/resident-onboarding-visits.integration.test.ts` (edit incl. WINDOW_INVALID; cancel, second cancel 409) | Done |
| FR-14 | M | Host requests overnight/guest-room with quota + charge preview | `POST /visits/preview` + `POST /visits` kind overnight, `GET /me/quota`; R-11 `apps/mobile/app/(resident)/overnight.tsx` | `apps/api/test/resident-onboarding-visits.integration.test.ts` (preview numbers, N-OVERNIGHT-REQ text, QUOTA_EXCEEDED counting completed stays, TYPE_NOT_ALLOWED_FOR_GENDER), `apps/mobile/e2e/tests/resident-app.spec.ts` (R-11) | Done |
| FR-15 | M | Warden approves/rejects overnight/guest-room requests; approval creates pending charge | `approveOvernight`, `rejectOvernight` via `POST /visits/{id}/approve`/`reject` (warden branch; reason required); W-04 approvals queue `GET /admin/approvals` | `visits-service.integration.test.ts`, `apps/api/test/resident-onboarding-visits.integration.test.ts`, `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (approve → office sees the charge) | Done |
| FR-16 | M | Host sees all visits: upcoming, inside, history, status, charges | `GET /me/hosted-visits?bucket=` (paged VisitDTO), `GET /visits/{id}` (+ timeline), `GET /me/charges`; R-05, R-13, R-10, R-14 | `apps/api/test/resident-onboarding-visits.integration.test.ts` (buckets + paging, audited detail read, TC-SEC-01/02), `apps/mobile/e2e/tests/resident-app.spec.ts` | Done |

### 5.3 Gate

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-20 | M | Gate device shows rotating QR + countdown + hostel name + instruction | `apps/mobile/app/gate/index.tsx` (`qrcode`, 250ms tick, 10s countdown bar), `apps/mobile/lib/gateToken.ts` (Web Crypto HMAC-SHA256 token generation) | Manually verified live (QR redraws on step change; never renders personal data) — no automated test of the display page itself | WIP — genuinely implemented and manually verified; no Playwright coverage of the display page's own rendering (the Playwright suite drives the *guest* side with a locally-generated token, not this page) |
| FR-21 | M | Scanning QR opens guest web app; requests location, validates token + GPS first | `apps/api/src/gate/token.ts`/`scanSessions.ts`/`geofence.ts`, `POST /v1/scan-sessions`, `apps/mobile/app/(guest)/g/[token].tsx` | `apps/api/src/gate/token.test.ts`, `geofence.test.ts`, `apps/api/test/gate-routes.integration.test.ts`, `apps/mobile/e2e/tests/golden-path.spec.ts` + `gate-errors.spec.ts` | Done — **accepted deviation (DEC-013):** a first-time guest who signs up mid-scan must scan once more (SDD §9.3/F2 say no re-scan); they get the "You're signed in — scan once more" screen, tested in `apps/mobile/e2e/tests/gate-retry-and-walkin.spec.ts` (DEC-013 test) |
| FR-22 | S | Guest app offers an in-app scanner on home screen | — | — | — |
| FR-23 | M | App offers Check in / Check out / Request entry based on visit state | `GET /v1/scan-sessions/:id` (`gate/routes.ts`), `apps/mobile/app/(guest)/g/[token].tsx` | `apps/api/test/gate-routes.integration.test.ts`, `apps/mobile/e2e/tests/golden-path.spec.ts` + `gate-retry-and-walkin.spec.ts` | Done |
| FR-24 | M | Check-in/out capture live front-camera photo; no file picker ever | `apps/mobile/components/LiveCamera.tsx`, `apps/api/src/gate/media.ts` (`storeGatePhoto`/`storeVisitorProfilePhoto`) | `apps/api/test/gate-routes.integration.test.ts` (photo upload, dedup), `apps/mobile/e2e` suite (fake camera device) | Done — live-only capture is enforced and every captured photo (profile and gate) is now actually processed and persisted, closing the DEC-009 gap Verified against §9.4/§9.10 in the security milestone: bucket-addressed storage, 3 MB → `PHOTO_INVALID` (was 500), 40 MP decode cap, traversal guard, mirrored preview and ideal 720 px capture (`apps/api/test/media.integration.test.ts`). |
| FR-25 | M | Walk-in: room search, pick resident, visit type, duration, live photo, submit | `createWalkIn` (`visits/service.ts`) + `POST /v1/scan-sessions/:id/walk-in` (`gate/routes.ts`) + `apps/mobile/app/(guest)/g/[token].tsx`'s `find_host`/`visit_type` phases | `apps/api/test/gate-routes.integration.test.ts`, `apps/mobile/e2e/tests/gate-retry-and-walkin.spec.ts` | Done — accepted deviation DEC-013: a first-time walk-in who signs up mid-scan scans the QR once more Room search is now SDD §12.7 `GET /hostels/{id}/rooms/{number}/residents` (live scan session, display names, 10/min; SECURITY-AUDIT SA-01, `apps/api/test/security.integration.test.ts`). |
| FR-26 | M | Guest waits on live status screen; approval flips to green without re-scan | `apps/mobile/app/(guest)/g/[token].tsx`'s `waiting_for_host` phase (3s poll of `GET /v1/visits/{id}`, `Cancel request` via `POST /v1/me/visits/{id}/cancel`) | `apps/mobile/e2e/tests/resident-app.spec.ts` (approval turns the guest screen green without reload; reject) | Done |
| FR-27 | M | 3x GPS failure or permission denied → host-confirm fallback | `apps/mobile/app/(guest)/g/[token].tsx` (3-attempt retry, then "Ask host to confirm"), gate check-in route's `awaiting_host_confirmation` short-circuit | `apps/api/test/gate-routes.integration.test.ts` ("awaiting_host_confirmation"), `apps/mobile/e2e/tests/gate-retry-and-walkin.spec.ts` | Done |
| FR-28 | M | Host-assisted entry: host scans QR, enters guest details, photographs, checks in/out | `POST /v1/scan-sessions/:id/host-assisted-entry`/`-exit` ★ (now runs `evaluateEntry`, records real GPS facts); R-12 `apps/mobile/app/(resident)/assist.tsx` (web QR via `@zxing/browser`, native via expo-camera; native GPS refuses mock location) | `apps/api/test/gate-routes.integration.test.ts`, `apps/api/test/resident-approvals-notifications.integration.test.ts` (GPS facts, no N-LEFT to self, AFTER_ENTRY_CUTOFF) | WIP — API fully tested; the R-12 screen has no e2e test (the fake camera can't show a QR) and the native path hasn't run |
| FR-29 | S | Gate device heartbeat every 60s; warden alerted after 5 min offline | `POST /v1/gate-devices/heartbeat`; `job_gate_offline()` run by `JobRunner` where pg_cron is absent; online/offline/revoked events on `/v1/stream` (migration `20261018000001`); W-01 gate status, W-09 `apps/mobile/app/warden/gates.tsx` | `apps/api/test/gate-routes.integration.test.ts`, `apps/api/test/staff-behaviour.integration.test.ts` (gate events), `apps/api/test/jobs-runner.integration.test.ts` | Done |
| FR-30 | M | Gate device keeps screen awake; recovers automatically after network loss | `apps/mobile/app/gate/index.tsx` (`navigator.wakeLock`, heartbeat backoff 5s/15s/60s, offline badge) | Manually verified live — no automated test (Wake Lock API and real network-loss simulation aren't practical in this test setup) | WIP — genuinely implemented; not proven by an automated test |

### 5.4 Host actions

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-40 | M | Host push for every walk-in with both photos; approve (adjust end time) or reject | N-WALKIN / N-CONFIRM-LOCATION (§15 text) via `apps/api/src/notify/`; R-08 `apps/mobile/app/(resident)/walk-in/[id].tsx` (live photo large + profile photo, editable end time, approve right / reject left) | `apps/api/test/resident-approvals-notifications.integration.test.ts` (text, fallback, adjusted end + approvals row, idempotent replay, 409 on new key, expired, BR-11, authorization), `apps/mobile/e2e/tests/resident-app.spec.ts` (banner tap → R-08 → approve; reject) | Done on the web target — Android push is implemented but unexecuted here (DEC-012) |
| FR-41 | S | SMS fallback if walk-in push unopened in 60s | outbox producer `cancel_if_opened` + worker (`apps/api/src/notify/`) | `apps/api/test/resident-approvals-notifications.integration.test.ts` (cancelled when opened; sent after 60 s; released at once with no push token; stale after approval) | Done (console SMS — MSG91 per DEC-007) |
| FR-42 | M | Host push for every check-in with photo compare; Yes/Not my guest (30 min window) | N-ARRIVED; `POST /visits/{id}/confirm-arrival` ★; R-09 `apps/mobile/app/(resident)/arrival/[id].tsx` | `apps/api/test/resident-approvals-notifications.integration.test.ts` (N-ARRIVED text, confirm once, 30-min expiry, TC-FLOW-04 host confirm, expired session 410), `apps/mobile/e2e/tests/resident-app.spec.ts` (Notifications → R-09) | Done |
| FR-43 | M | "Not my guest" disputes the visit; alerts warden immediately (push + SMS) | `POST /visits/{id}/dispute` ★ (`disputeArrival`), N-DISPUTE push + immediate SMS; warden side: W-01 Disputed tile, W-05 Resolve dispute (`POST /admin/visits/{id}/resolve-dispute`) | `apps/api/test/resident-approvals-notifications.integration.test.ts` (TC-FLOW-06, duplicate 409, window expiry, not for walk-ins), `apps/mobile/e2e/tests/resident-app.spec.ts`, `apps/api/test/staff-permissions.integration.test.ts` | Done |
| FR-44 | M | Host push on guest check-out and on guest overstay | N-LEFT from `checkOut`; N-OVERSTAY-HOST from `job_flag_overstays()` (migration 20261019000007), one per visit | `apps/api/src/notify/templates.test.ts`, `apps/api/test/resident-approvals-notifications.integration.test.ts`, `apps/api/test/jobs-runner.integration.test.ts` (TC-JOB-01) | Done |
| FR-45 | M | Host can mark "My guest has left"; logged and flagged to warden | `POST /visits/{id}/mark-left` ★ (`hostMarksGuestLeft`, `close_reason = host_marked_left`); R-10; warden sees the flag in W-02/W-05 and search (`flag=host_marked_left`) | `apps/api/test/resident-approvals-notifications.integration.test.ts` (completed + identical replay) | Done — the warden-side filter has no dedicated test |

### 5.5 Warden and office

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-50 | M | Dashboard: live counts/lists, updates within 5s | `GET /admin/dashboard`; SSE `GET /v1/stream` (`apps/api/src/stream/`); W-01 `apps/mobile/app/warden/index.tsx`, W-02 `inside.tsx`, `lib/live.ts` | `apps/api/test/staff-behaviour.integration.test.ts` (SSE check-in), `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (check-in appears on Inside without reload) | Done |
| FR-51 | M | Emergency roll call: everyone inside, printable/exportable | `GET /admin/emergency` (JSON/CSV, audited `read.emergency`); W-03 `apps/mobile/app/warden/emergency.tsx` (print, CSV, share) | `apps/api/test/staff-behaviour.integration.test.ts` (W-03 JSON + CSV, audit), `apps/api/test/staff-permissions.integration.test.ts` | Done |
| FR-52 | M | Visit detail: full timeline with photos, GPS distance, notifications, flags | `GET /admin/visits/{id}` (events, notifications, signed photo URLs, distance only; audited `read.visit`); W-05 `apps/mobile/app/warden/visits/[id].tsx` | `apps/api/test/staff-behaviour.integration.test.ts` (audit), `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (detail shows phone) | Done |
| FR-53 | M | Warden force check-out with reason | `POST /admin/visits/{id}/force-checkout` ★ → `wardenForcesCheckout`; W-05 | `visits-service.integration.test.ts`, `apps/api/test/staff-behaviour.integration.test.ts`, `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` | Done |
| FR-54 | M | Warden bans guest (hostel/all, timed/permanent); suspends resident hosting | `POST /admin/bans`, `POST /admin/bans/{id}/lift`, `POST /admin/residents/{id}/suspend`/`unsuspend` (`people-routes.ts`; BR-10 side effects); W-05, W-07, W-08 | `apps/api/test/staff-behaviour.integration.test.ts` (ban → refused at gate; suspend), `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (ban → refused at the gate) | Done |
| FR-55 | S | Warden edits rules config via form; each save is a new version | `GET`/`PUT /admin/rules` (new `hostel_rules` version, cache invalidated), `apps/api/src/rules/provider.ts`; W-06 `apps/mobile/app/warden/rules.tsx` | `apps/api/test/staff-behaviour.integration.test.ts` (FR-55, E-13), `apps/api/test/staff-permissions.integration.test.ts` | Done |
| FR-56 | M | Warden pairs/revokes gate devices; sets gate location by 5-reading average | `PUT /admin/gates/{id}/location`, `POST /admin/gates/{id}/pairing-codes`, `POST /admin/gate-devices/{id}/revoke`; W-09 averages 5 GPS readings client-side | `apps/api/test/staff-permissions.integration.test.ts`, `apps/api/test/staff-behaviour.integration.test.ts` (pairing/offline events) | WIP — the 5-reading averaging on W-09 has no automated test (needs a GPS sequence), and the native path hasn't run |
| FR-57 | S | Warden searches visits (name/phone/host/room/date/status); CSV export | `GET /admin/visits` (status, type, flag, q, from, to, expectedToday, cursor), `GET /admin/reports/visits(.csv)` (audited `read.export`); W-12 `apps/mobile/app/warden/reports.tsx`, search `visits/index.tsx` | `apps/api/test/staff-permissions.integration.test.ts`, `apps/api/test/staff-behaviour.integration.test.ts` (audit of export) | Done |
| FR-58 | S | Warden views audit log filtered by actor/entity/date | `GET /admin/audit` (entity, entityId, actorId, from, to); W-11 `apps/mobile/app/warden/audit.tsx` | `apps/api/test/staff-behaviour.integration.test.ts` (entity filter), `apps/api/test/staff-permissions.integration.test.ts` | Done |
| FR-59 | M | Office sees charges; confirms, marks paid. **Waiving and manual fines are warden-only** (not office — see permission matrix §3.3 and `POST /admin/charges/{id}/waive`, caller: Warden) | `apps/api/src/admin/charges-routes.ts` (list, fine, confirm, mark-paid with receipt, waive with reason; office serializer); O-01 `apps/mobile/app/office/charges.tsx`, warden `app/warden/charges.tsx` | `apps/api/test/staff-behaviour.integration.test.ts` (BR-18/FR-59, TC-SEC-03), `apps/api/test/staff-permissions.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (office marks paid) | Done |
| FR-60 | C | Daily 08:00 digest to warden | `haven.job_daily_digest(p_now)` (migration 20261020000002), 08:00 IST via pg_cron or `JobRunner`; N-DIGEST is a team-approved catalogue addition (DEC-016); tap opens W-12 for that day | `apps/api/test/jobs-runner.integration.test.ts` (FR-60) | Done |

### 5.6 System

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-70 | M | Walk-in requests expire after 10 min; both parties told | `haven.job_expire_walkins(p_now)` (expires at exactly 10:00, migration 20261019000007); host gets N-WALKIN-EXPIRED; the guest page shows §13.6 "No answer from …" (fixed: it had no expired state) | `apps/api/test/jobs-runner.integration.test.ts` (BR-12 boundary), `apps/api/test/resident-approvals-notifications.integration.test.ts`, `visits-concurrency.integration.test.ts` | Done — the guest page's expired state has no Playwright test |
| FR-71 | M | Approved-never-entered visits expire at window_end | `haven.job_expire_approved(p_now)` (at window_end; waives only that visit's pending charge) | `apps/api/test/jobs-runner.integration.test.ts` (FR-71), `visits-service.integration.test.ts` | Done |
| FR-72 | M | Overstay detection every 5 min; alerts host/guest; escalates to warden after 30 min | `haven.job_flag_overstays(p_now)`: host push, guest SMS (§15.3 HAVEN_OVERSTAY), wardens at exactly 30:00 | `apps/api/test/jobs-runner.integration.test.ts` (BR-13 / FR-72 boundaries, TC-JOB-01) | Done |
| FR-73 | M | Night sweep at 22:00 lists day/quick guests still inside to the warden | `haven.job_night_sweep(p_now)` at 22:00 IST; tap opens W-02 filtered to the guests (`/warden/inside?ids=`) | `apps/api/test/jobs-runner.integration.test.ts` (TC-JOB-02, incl. around midnight IST) | Done — web wardens have no notification list (DEC-015) |
| FR-74 | M | Every state change and admin action written to append-only audit log | `supabase/migrations/20261001000001_init.sql` — `audit_row()` + 9 `t_audit_*` triggers on every table SDD §11.6 lists (visits, residents, role_assignments, bans, charges, gates, gate_devices, hostel_rules, staff_invites), plus `forbid_mutation()` making `gate_events`/`audit_log`/`approvals`/`hostel_rules` append-only. **Every `haven.visits` state change now sets real actor context** — every `visits/service.ts` mutation runs inside `lib/tx.ts`'s `withTx`, which sets `haven.actor_type`/`haven.actor_id`/`haven.request_id` from the real `Principal` (or `system` for job-triggered transitions) before the UPDATE/INSERT, so `audit_row()` attributes correctly for visits specifically | `supabase/tests/002_constraints_and_triggers.sql`, `supabase/tests/003_audit_pii_stripping.sql` | WIP — the mechanism is correct and exercised for every visits transition; other SDD §11.6 tables (residents, bans, charges, gate devices, ...) still have no API caller setting actor context yet, so this remains incomplete hostel-wide. **Warden/office milestone (§0k):** every `/v1/admin` action writes a named `audit_log` row (`apps/api/src/admin/audit.ts`), and reads of visit detail, the emergency list and CSV exports write `read.*` rows; tested in `apps/api/test/staff-behaviour.integration.test.ts` ("every privileged action writes an audit entry") |
| FR-75 | S | Personal data purged per retention schedule (§16.5) | `haven.job_retention(p_now)` (03:00 IST) + `purgeDueMedia` (`apps/api/src/jobs/media-purge.ts`, deletes files) + `job_expire_sessions` | `apps/api/test/retention.integration.test.ts` (one test per §16.5 row, file deletion included), `apps/api/test/jobs-runner.integration.test.ts` (scan sessions, OTPs) | Done |

## 2. Non-functional requirements (NFR-xx) — SDD §17.1

| ID | Category | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| NFR-01 | Performance | `POST /scan-sessions` and check-in p95 < 800ms server; < 2s E2E on 4G | — | — | — |
| NFR-02 | Performance | Gate landing interactive < 3s on mid-range Android/4G (Lighthouse mobile) | — | — | — |
| NFR-03 | Performance | Host receives N-WALKIN/N-ARRIVED push within 10s (p95) | — | — | — |
| NFR-04 | Freshness | Warden dashboard reflects visit change within 5s | — | — | — |
| NFR-05 | Availability | API 99.5% between 07:00–23:00 IST during pilot | — | — | — |
| NFR-06 | Capacity | 50 scans/min/gate burst; 1,000 visits/day/hostel without changes | — | — | — |
| NFR-07 | Security | All §16.4 controls in place before real data loaded | Independent audit `docs/SECURITY-AUDIT.md` (SA-01..SA-30) and fixes (DEC-017) | `apps/api/test/security.integration.test.ts` (23), `apps/api/test/media.integration.test.ts` (11) | WIP — every HIGH and MEDIUM fixed except SA-12 (web CSP/HSTS needs the hosting and API-domain decision); the people/process rows (two owners, MFA) are a Week 0 checklist, not code |
| NFR-08 | Privacy | Retention schedule §16.5 enforced automatically | JobRunner / pg_cron run `job_retention` daily and the media purge hourly | `apps/api/test/retention.integration.test.ts` | Done |
| NFR-09 | Usability | Returning guest ≤30s/≤4 taps; first-time guest ≤3 min | — | — | — |
| NFR-10 | Compatibility | Guest web: Chrome 100+/Android 9+, Safari iOS 15+, Samsung Internet 18+; app Android 9+ | — | — | — |
| NFR-11 | Accessibility | WCAG 2.1 AA for guest web; text scales to 200% | — | — | — |
| NFR-12 | Maintainability | Rules engine 100% branch coverage; API services ≥70% line coverage; no `any` | `packages/shared/vitest.config.ts` (coverage thresholds), `eslint.config.mjs` (`no-explicit-any` across every workspace) | `pnpm --filter shared test:coverage` — 100% branches/statements/functions/lines, verified | WIP — the rules-engine coverage bar and the no-`any` lint rule are both genuinely met and enforced; API services' ≥70% line coverage isn't tracked/enforced anywhere yet (no coverage config in `apps/api`) |
| NFR-13 | Observability | Every request has a request ID; errors reach Sentry within 1 min | `apps/api/src/lib/request-id.ts`; Sentry: `apps/api/src/lib/error-reporter.ts` (500s, failed notifications, failed jobs), `apps/mobile/lib/sentry.ts` (web), scrubbed by `packages/shared/src/scrub.ts` | `test/app.test.ts`, `apps/api/test/security.integration.test.ts` (SA-13), `packages/shared/src/scrub.test.ts` | WIP — wired and tested with a fake; not yet exercised against a real Sentry project, and the Android build is a no-op |
| NFR-14 | Cost | ≤ ₹1,500/month during pilot | — | — | — |

## 3. Business rules (BR-xx) — SDD §4.2

| ID | Rule (summary) | Enforced at | Implementation | Tests | Status |
|---|---|---|---|---|---|
| BR-01 | No admission without verified, non-suspended host approval | Create + entry | `evaluateCreate`/`evaluateEntry`, now called for real by `apps/api/src/visits/service.ts` (`createPreInvite`, `createWalkIn`, `createOvernightRequest`, `checkIn`, ...) | `evaluate-create.test.ts`, `evaluate-entry.test.ts` (incl. TC-RULE-13/14), `apps/api/test/visits-service.integration.test.ts` ("HOST_NOT_VERIFIED") | WIP — called by the visits service against a real DB in every creation/entry trigger; still no HTTP route |
| BR-02 | Day/quick-drop guests must check in before 20:00 | Entry | `evaluateEntry` — `AFTER_ENTRY_CUTOFF`, called by `visits/service.ts`'s `checkIn` | `evaluate-entry.test.ts` (worked example + exact-boundary tests) | WIP — same as BR-01 |
| BR-03 | No guest may check in at/after 22:00 | Entry | `evaluateEntry` — `AFTER_HARD_CUTOFF`, called by `visits/service.ts`'s `checkIn` | `evaluate-entry.test.ts` (worked example + exact-boundary tests) | WIP — same as BR-01 |
| BR-04 | Day visit windows between visiting_start and day_visit_latest_end, one date | Create | `evaluateCreate` — `WINDOW_INVALID`, called by `visits/service.ts`'s creation triggers | `evaluate-create.test.ts`, `visits-service.integration.test.ts` ("WINDOW_INVALID") | WIP — same as BR-01 |
| BR-05 | Overnight in room: max 3 nights/host/calendar month (IST) | Create | `evaluateCreate` — `QUOTA_EXCEEDED`, using `nightsBetween`/`quotaUsed`, fed real existing-booking data by `visits/repository.ts`'s `findActiveOvernightBookings` | `evaluate-create.test.ts` (worked examples incl. Oct/Nov boundary), `nights.test.ts`, `visits-service.integration.test.ts` ("QUOTA_EXCEEDED") | WIP — same as BR-01 |
| BR-06 | Overnight in room: at most one overnight guest per host at a time | Create | `evaluateCreate` — `OVERNIGHT_OVERLAP` | `evaluate-create.test.ts` (TC-RULE-15 + boundary tests) | WIP — now called by `createOvernightRequest`; no HTTP route |
| BR-07 | Opposite/undisclosed gender → visitors_room zone, no overnight/guest_room | Create + display | `evaluateCreate` — `TYPE_NOT_ALLOWED_FOR_GENDER` + `computeZone`, result persisted as `visits.zone` by `visits/repository.ts`'s `insertVisit` | `zone.test.ts`, `evaluate-create.test.ts` | WIP — same as BR-01 |
| BR-08 | Overnight ₹50/night, guest room ₹150/night; pending charge on warden approval. **₹150 is an SDD working default awaiting warden confirmation, not yet a final decision** — see `docs/DECISIONS.md` Q8 note | Approval | `apps/api/src/visits/sideEffects.ts` (`createPendingCharge`/`waiveChargeForVisit`/`confirmChargeForVisit`), called by `visits/service.ts`'s `approveOvernight`/`cancelApprovedVisit`/`checkOut`/etc.; office/warden charge routes (`apps/api/src/admin/charges-routes.ts`) | `visits-service.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` (approval → charge appears for office) | Done |
| BR-09 | Banned guests cannot be invited, request entry, or check in | Create + entry | `evaluateCreate`/`evaluateEntry` — `VISITOR_BANNED`, fed by `visits/context.ts`'s `isVisitorBanned` against `haven.bans` | `evaluate-create.test.ts`, `evaluate-entry.test.ts` | WIP — same as BR-01 |
| BR-10 | Suspended hosts cannot create/approve; future visits cancelled on suspension start | Create + entry | `evaluateCreate`/`evaluateEntry` — `HOST_SUSPENDED`; `cancelFutureVisits` (`apps/api/src/admin/effects.ts`) on suspend, ban and mark left (DEC-014 item 13) | `evaluate-create.test.ts`, `evaluate-entry.test.ts`, `apps/api/test/staff-behaviour.integration.test.ts` (BR-10) | Done |
| BR-11 | Host max `max_active_day_guests` (default 3) day/quick guests inside at once | Create + approval | `evaluateCreate` — `HOST_DAY_LIMIT` (deny, today only); `evaluateEntry` — `HOST_DAY_LIMIT` (flag); counted for real by `visits/repository.ts`'s `countHostActiveDayGuests` | `evaluate-create.test.ts`, `evaluate-entry.test.ts` | WIP — same as BR-01 |
| BR-12 | Walk-in expires if host doesn't decide within 10 min | Job | `haven.job_expire_walkins(p_now)` (`<=`, so 10:00 exactly) | `apps/api/test/jobs-runner.integration.test.ts` (9:59 not expired, 10:00 expired), `visits-concurrency.integration.test.ts` | Done |
| BR-13 | Overstay when inside past `window_end + 15 min` | Job | `haven.job_flag_overstays(p_now)` (`>=`, so + 15:00 exactly) | `apps/api/test/jobs-runner.integration.test.ts` (+14:59 no, +15:00 yes) | Done |
| BR-14 | At 22:00, every inside day/quick guest listed to warden | Job | `haven.job_night_sweep(p_now)` | `apps/api/test/jobs-runner.integration.test.ts` (TC-JOB-02) | Done |
| BR-15 | A guest can be inside only one visit at a time, anywhere | DB constraint | `supabase/migrations/20261001000001_init.sql` (`visits_one_inside_per_visitor`) **and** `evaluateEntry`'s `ALREADY_INSIDE` check, **both now wired into** `apps/api/src/visits/repository.ts` (catches the constraint violation, maps to `409 ALREADY_INSIDE`) and `visits/service.ts`'s `checkIn`/`approveWalkIn` | `supabase/tests/002_constraints_and_triggers.sql`, `evaluate-entry.test.ts`, `visits-concurrency.integration.test.ts` ("two visits attempting to make the same visitor inside at once") — the last one races two real concurrent `checkIn` calls against the real constraint, not a mock | Done — both layers are now wired into the real check-in path and proven under an actual concurrent-request race, not just unit-tested in isolation |
| BR-16 | Pre-invites ≤7 days ahead; overnight requests ≤30 days ahead | Create | `evaluateCreate` — `TOO_FAR_AHEAD` | `evaluate-create.test.ts` (exact day-count boundaries for both limits) | WIP — now called by the visits service; no HTTP route |
| BR-17 | Check-out never refused for rule reasons; failed GPS on exit allowed but flagged | Exit | `evaluateExit` — never returns `deny`; `LOCATION_UNVERIFIED` flag, called by `visits/service.ts`'s `checkOut` | `evaluate-exit.test.ts`, `visits-service.integration.test.ts` | WIP — same as BR-01 |
| BR-18 | Warden manual fine, minimum ₹400 for unregistered guest | Warden action | `POST /admin/charges` (kind fine, min from `min_manual_fine_inr`), warden only | `apps/api/test/staff-behaviour.integration.test.ts` (BR-18), `apps/api/test/staff-permissions.integration.test.ts` | Done |
| BR-19 | Overnight window: visiting_start on arrival date to 22:00; checkout by overnight_checkout_time | Create + entry | `evaluateEntry`'s `AFTER_HARD_CUTOFF`/`TOO_EARLY`/`WINDOW_ENDED` correctly gate an overnight visit *given* a correctly-derived `windowStart`/`windowEnd` | `evaluate-entry.test.ts` (overnight worked examples), `visits-service.integration.test.ts` (overnight check-in/out) | WIP — the engine honours the window given one; `createOvernightRequest`'s caller still supplies `windowStart`/`windowEnd` directly rather than deriving them from `arrivalDate`/`departureDate` per this BR's formula (SDD §12.6) — that derivation is still API-layer/route work, not yet built |
| BR-20 | Guest may arrive up to 30 min before window_start | Entry | `evaluateEntry` — `TOO_EARLY`, called by `visits/service.ts`'s `checkIn` | `evaluate-entry.test.ts`, `visits-service.integration.test.ts` ("TOO_EARLY check-in") | WIP — see `docs/DECISIONS.md` DEC-006 for a documented SDD contradiction between this BR's "30 min" and the §4.6 worked example's literal clock digits, resolved in favour of the 30-minute rule |

## 4. Edge cases (E-xx) — SDD §17.3

| ID | Situation (summary) | Required behaviour | Implementation | Tests | Status |
|---|---|---|---|---|---|
| E-01 | Gate device offline when guest scans | QR still valid (local gen); warden alerted after 5 min | `apps/mobile/app/gate/index.tsx` (local token generation, offline badge); `job_gate_offline()` + W-01/W-09 offline status | `apps/api/test/staff-behaviour.integration.test.ts` (offline gate event) | WIP — the offline QR itself is only manually verified |
| E-02 | Guest's phone clock is wrong | Irrelevant — server time decides token age | — | — | — |
| E-03 | Guest opens link in in-app browser (WhatsApp/IG/FB) | Detect via UA; show "Open in Chrome/Safari" | — | — | — |
| E-04 | Three friends arrive together | Each needs own visit; same token works for all within 30s | — | — | — |
| E-05 | Walk-in requested 19:58, approved 20:03 | Allowed — cutoff judged at scan session's created_at | — | — | — |
| E-06 | Same guest invited by two hosts same day | Gate landing lists both; only one `inside` at a time | — | — | — |
| E-07 | Guest changed phone after invite | Host cancels and re-invites | — | — | — |
| E-08 | Host has no internet when guest arrives | Walk-in can't be approved, expires in 10 min; pre-invites still check in | — | — | — |
| E-09 | Host isn't in the hostel but approves | Allowed; host accountable; visible in timeline | — | — | — |
| E-10 | Double tap Check in / network drop after commit | Idempotency-Key replays; one gate event only | — | — | — |
| E-11 | Host suspended while guest inside | Guest stays inside; no new entries; future visits cancelled | `POST /admin/residents/{id}/suspend` + `cancelFutureVisits` | `apps/api/test/staff-behaviour.integration.test.ts` (BR-10: guest inside stays) | Done |
| E-12 | Guest banned while inside | Warden force-checks out; ban blocks re-entry | force-checkout + `POST /admin/bans`; `VISITOR_BANNED` at the gate | `apps/api/test/staff-behaviour.integration.test.ts`, `apps/mobile/e2e/tests/warden-office.spec.ts` | Done |
| E-13 | Rules changed during the day | New entries use new rules; existing visits keep their `rules_version` | `RulesProvider` (latest version, cleared on publish); `visits.rules_version` | `apps/api/test/staff-behaviour.integration.test.ts` (FR-55, E-13) | Done |
| E-14 | Gate location not set | `GATE_NOT_CONFIGURED`; red dashboard banner | `apps/api/src/gate/geofence.ts`/`scanSessions.ts` (`GATE_NOT_CONFIGURED` 503); `gates[].configured` on the dashboard and the red banner in W-01/W-09 | — (no automated test of the banner; the API code has no dedicated test) | WIP |
| E-15 | Guest has no mobile data at the gate | Host-assisted entry (F4) fallback | — | — | — |
| E-16 | GPS inside geofence but guest actually in a nearby room | Mitigated by calibration + live photo; documented limitation | — | — | — |
| E-17 | Guest denies camera permission | G-16 enable instructions; no check-in without photo | `apps/mobile/components/LiveCamera.tsx`'s `onPermissionDenied`, handled by `profile.tsx` and `visits/[id].tsx` | — (manually verified; no automated permission-denial test) | WIP — both the profile and gate screens show "Allow camera access..." instructions instead of a dead end; no check-in/profile-completion is possible without a captured photo. The gate screen's handling was a real bug found while writing this milestone's own traceability entry (it originally reused the geolocation-denied message and left the Take-photo button disabled with no explanation) — fixed, see `docs/DECISIONS.md` DEC-009 |
| E-18 | Resident moves out with future visits | Marked `left`; future visits cancelled | `POST /admin/residents/{id}/mark-left` | `apps/api/test/staff-behaviour.integration.test.ts` (FR-07 mark left) | Done |
| E-19 | Overnight stay spans two months | Nights split by month for quota | `packages/shared/src/rules/nights.ts` (`monthsTouched`) + `evaluate-create.ts`'s per-month `QUOTA_EXCEEDED` loop | `nights.test.ts`, `evaluate-create.test.ts` (31 Oct → 2 Nov / 30 Oct → 1 Nov worked examples) | Done — the month-splitting logic itself is fully implemented and tested; no API/DB layer needed for this specific edge case, it's pure date arithmetic |
| E-20 | Two residents claim the same room | Allowed (roommates) | — | — | — |
| E-21 | Host disputes by mistake | Warden resolves after talking to host; visit stays as is | `POST /admin/visits/{id}/resolve-dispute` (flag cleared, note in audit) | `apps/api/test/staff-permissions.integration.test.ts`, `apps/api/test/staff-behaviour.integration.test.ts` (audit) | Done |
| E-22 | Guest never checks out, host doesn't respond | Overstay → warden escalation → night sweep → force check-out | overstay job, night sweep, W-05 force check-out | `apps/api/test/jobs-runner.integration.test.ts` (overstay, escalation, night sweep), `apps/api/test/staff-behaviour.integration.test.ts` (force check-out) | Done |
| E-23 | Two gate devices paired to one gate | Both show valid QRs (same secret); either works | `apps/api/src/gate/devices.ts`'s `pairDevice` (secret is per-gate, every paired device gets the same one) | — (true by construction; no dedicated two-device test) | WIP |
| E-24 | Approved guest arrives at a different hostel's gate | No matching visit there; only Request entry offered | `apps/api/src/gate/routes.ts`'s `GET /scan-sessions/:id` (approved-visit query scoped to the scanned gate's own `hostel_id`) | — (correctly implemented; no dedicated cross-hostel test case) | WIP |

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
| TC-TOK-01 | Token generated at step s, verified at s, s+1, s+2 | valid | `apps/api/src/gate/token.test.ts` | Done |
| TC-TOK-02 | Verified at s+3 | `GATE_TOKEN_EXPIRED` | `apps/api/src/gate/token.test.ts` | Done |
| TC-TOK-03 | Verified at s−1 (device ahead); s−2 | valid; invalid | `apps/api/src/gate/token.test.ts` | Done |
| TC-TOK-04 | One MAC character changed | `GATE_TOKEN_INVALID` | `apps/api/src/gate/token.test.ts` | Done |
| TC-TOK-05 | Old secret within 120s of rotation; after 120s | valid; invalid | `apps/api/src/gate/token.test.ts` | Done |

### Geofence (TC-GEO)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-GEO-01 | Point 49m away, accuracy 20 | `gps_ok` | `apps/api/src/gate/geofence.test.ts` | Done |
| TC-GEO-02 | Point 51m away | `outside_geofence` | `apps/api/src/gate/geofence.test.ts` | Done |
| TC-GEO-03 | Accuracy 80m | `low_accuracy` | `apps/api/src/gate/geofence.test.ts` | Done |
| TC-GEO-04 | Fix age 61s | `stale_fix` | `apps/api/src/gate/geofence.test.ts` | Done |
| TC-GEO-05 | Fourth location attempt | `LOCATION_RETRY_LIMIT` | `apps/api/test/gate-routes.integration.test.ts` | Done |

### Flows (TC-FLOW)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-FLOW-01 | F1 end to end: invite → claim → scan → photo → check-in → host notified | `inside`, 1 gate event, 1 N-ARRIVED | `apps/api/test/gate-routes.integration.test.ts`, `apps/mobile/e2e/tests/golden-path.spec.ts` | Done |
| TC-FLOW-02 | F2 walk-in approved | `inside`, entry event ts = approval time, session consumed | — | — (`approveWalkIn` itself is tested in the visits milestone; no test here drives it through a scan session, since that's a Resident-app action) |
| TC-FLOW-03 | F2 walk-in, no answer 10 min (clock advanced) | `expired`, host notified | — | — |
| TC-FLOW-04 | F3 location unverified, host confirms | `inside`, `location_unverified = true` | `apps/api/test/gate-routes.integration.test.ts` | WIP — the "stays `approved`, not yet confirmed" half is tested; the "host confirms -> `inside`" half has no route yet (Resident-app action) |
| TC-FLOW-05 | F5 overnight guest steps out mid-stay | back to `approved`; re-entry allowed | — | — |
| TC-FLOW-06 | F9 dispute | `host_disputed_at` set, warden push+SMS rows | — | — |
| TC-FLOW-07 | Invite opened with different phone | `INVITE_PHONE_MISMATCH` | — | — |
| TC-FLOW-08 | Same scan session used twice | 2nd call `SCAN_SESSION_EXPIRED` | `apps/api/test/gate-routes.integration.test.ts` | Done |
| TC-FLOW-09 | Scan session used with wrong nonce | `SCAN_SESSION_FORBIDDEN` | `apps/api/test/gate-routes.integration.test.ts` | Done |
| TC-FLOW-10 | Check-in replay with same Idempotency-Key | identical response, still one gate event | — | — |
| TC-FLOW-11 | Visitor tries to be inside two visits | `ALREADY_INSIDE` | — | — |
| TC-FLOW-12 | Host approves while expiry job runs | exactly one of approve/expire wins; other 409 | — | — |

### Jobs (TC-JOB)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-JOB-01 | Overstay job twice in a row | one host push, one guest SMS (dedupe) | `apps/api/test/jobs-runner.integration.test.ts` (delivered through the worker) | Done |
| TC-JOB-02 | Night sweep: 2 day guests + 1 overnight guest inside | warden notified of 2 only | `apps/api/test/jobs-runner.integration.test.ts` | Done |

### Security (TC-SEC)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-SEC-01 | Resident A requests resident B's visit | 404 | `apps/api/test/resident-onboarding-visits.integration.test.ts` (TC-SEC-01/02) | Done |
| TC-SEC-02 | Guest requests a visit they aren't on | 404 | `apps/api/test/resident-onboarding-visits.integration.test.ts` (TC-SEC-01/02) | Done |
| TC-SEC-03 | Office lists charges | no phone or photo fields in JSON | `apps/api/test/staff-behaviour.integration.test.ts` (TC-SEC-03 block), `apps/mobile/e2e/tests/warden-office.spec.ts` (no +91 on the office screen) | Done |
| TC-SEC-04 | Warden of hostel X uses `X-Hostel-Id` of hostel Y | 403 | `apps/api/test/staff-behaviour.integration.test.ts` (cross-hostel isolation incl. SSE), `apps/api/test/staff-permissions.integration.test.ts` | Done |
| TC-SEC-05 | Deactivated user's access token after 30s | `SESSION_REVOKED` | `test/sessions.integration.test.ts`, `test/auth-routes.integration.test.ts` | Done |
| TC-SEC-06 | Reused refresh token | 401 and whole session revoked | `test/sessions.integration.test.ts` | Done |
| TC-SEC-07 | `UPDATE haven.gate_events` as `haven_api` | permission error | `supabase/tests/004_api_role_and_rls.sql` | Done |
| TC-SEC-08 | Audit row for a visit update | contains no `invited_phone`, `invited_name` | `supabase/tests/003_audit_pii_stripping.sql` | Done — the test exercises the shared `audit_row()` trigger via `haven.gates` (lat/lng) rather than a literal visit update, because no audit trigger is attached to `haven.users` and a *visit* update needs API-level `evaluateEntry`/state-machine code that doesn't exist yet to reach meaningfully; the strip-list (`invited_phone`, `invited_name` included) is the same function for every audited table, so this proves the mechanism TC-SEC-08 is about |
| TC-SEC-09 | 4th OTP request in 10 min for one phone | `RATE_LIMITED` | `test/otp-service.integration.test.ts` | Done — rate limiting only; Turnstile gating (CLAUDE.md §4) not implemented, see §0e |
| TC-SEC-10 | Upload a PNG with EXIF GPS | stored file has no EXIF | `apps/api/test/media.integration.test.ts` ("strips EXIF, including GPS", "accepts a PNG ... re-encoded as JPEG") | Done |
| TC-SEC-11 | Same photo bytes uploaded twice by one visitor | `PHOTO_REUSED` | `apps/api/test/media.integration.test.ts` ("PHOTO_REUSED") | Done |

## 6. Coverage summary (update when rows change)

| Category | Total IDs | Done | WIP | Not started | Deferred |
|---|---|---|---|---|---|
| FR | 50 (FR-01..09, 10..16, 20..30, 40..45, 50..60, 70..75) | 40 (FR-01, FR-04, FR-05, FR-07, FR-09, FR-10..16, FR-21, FR-23..27, FR-29, FR-40..45, FR-50..55, FR-57..60, FR-70..73, FR-75) | 8 (FR-02, FR-03, FR-06, FR-20, FR-28, FR-30, FR-56, FR-74) | 2 (FR-08, FR-22) | 0 |
| NFR | 14 | 1 (NFR-08) | 3 (NFR-07, NFR-12, NFR-13) | 10 | 0 |
| BR | 20 | 7 (BR-08, BR-10, BR-12, BR-13, BR-14, BR-15, BR-18) | 13 (BR-01..07, 09, 11, 16, 17, 19, 20) | 0 | 0 |
| E | 24 | 7 (E-11, E-12, E-13, E-18, E-19, E-21, E-22) | 5 (E-01, E-14, E-17, E-23, E-24) | 12 | 0 |
| TC | 51 (TC-RULE ×16 [incl. the TC-RULE-01..11 worked-examples group], TC-TOK ×5, TC-GEO ×5, TC-FLOW ×12, TC-JOB ×2, TC-SEC ×11) | 42 (TC-RULE ×16, TC-TOK ×5, TC-GEO ×5, TC-FLOW-01/08/09, TC-JOB-01/02, TC-SEC-01..11) | 1 (TC-FLOW-04) | 8 | 0 |

Corrected during the rules-engine milestone: this table had silently gone stale after
the API-foundation milestone set NFR-13 to WIP without updating the summary row —
fixed here, and flagged so future milestones remember to update this table in the same
PR that changes a status above it (§7 below already says this; the instruction alone
didn't prevent the drift once, so this note is a second line of defence).

Counts verified by direct enumeration against SDD §5, §17.1, §4.2, §17.3, §19.2 during
the hostile planning review (2026-10-01). Recount this table if any ID range in the SDD
changes — do not hand-adjust without re-enumerating.

Updated 2026-10-03 for the guest web golden-path milestone (§0g): FR-12 moved WIP →
Done; FR-02 and FR-24 moved not-started → WIP; E-17 moved not-started → WIP. No ID
range changed, so this was a direct re-tally of the rows above, not a re-enumeration
against the SDD.

Updated 2026-10-04 for the gate subsystem milestone (§0h): FR-20, FR-21, FR-23,
FR-24, FR-25, FR-27 moved to Done; FR-26 and FR-28 stayed WIP (updated notes); FR-29
and FR-30 moved not-started → WIP. E-01, E-14, E-23, E-24 moved not-started → WIP.
TC-TOK ×5, TC-GEO ×5, TC-FLOW-01/08/09 moved not-started → Done; TC-FLOW-04 moved
not-started → WIP. Again a direct re-tally, no SDD ID range changed.

Updated 2026-10-04 for the demo milestone (§0i): FR-10 and FR-26 moved WIP → Done;
FR-11 and FR-40 moved not-started → WIP. Again a direct re-tally, no SDD ID range
changed.

Updated 2026-10-18 for the warden and office milestone (§0k), recounted directly from
the rows above (they had drifted: the resident milestone's FR-04, FR-11, FR-13, FR-14,
FR-16, FR-41, FR-42, FR-43 and TC-SEC-01/02 changes never reached this table). No SDD ID
range changed.

Updated 2026-10-18 for the async milestone (§0l), recounted from the rows above.

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

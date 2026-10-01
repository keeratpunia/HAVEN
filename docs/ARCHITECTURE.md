# HAVEN — Architecture

Derived from SDD §8 (High-level design), §9 (Low-level design), §10 (Data model), §11
(Database schema). This document is a reading aid, not a replacement — section
references point back to the SDD for exact formats, constants and SQL.

## 1. System shape

HAVEN is a **modular monolith**: one Expo codebase producing an Android app and a
static web export, one Fastify API service, and one Supabase project (Postgres +
Storage). Clients talk only to the API; the API is the only component with database
credentials (SDD §8, D7, D11).

```
                      ┌───────────────────────────────────────────┐
                      │                 Clients                    │
                      │                                             │
  Guest (mobile web)  │  Gate device   Resident app   Warden/Office │
  no install, browser │  (/gate page)  (Expo, native  (Expo, native│
  only                │  on receptionist's   + web)   + web, SSE)  │
                      │  phone)                                    │
                      └──────────────┬──────────────────────────────┘
                                      │ HTTPS, JSON, Bearer JWT / Device token
                                      ▼
                      ┌───────────────────────────────────────────┐
                      │            Fastify API (single service)    │
                      │ request ID → rate limit → auth → Zod       │
                      │ validate → handler → authorize() →         │
                      │ service → repository (Kysely) → serializer │
                      │                                             │
                      │  Modules: auth · visits · gate · rules      │
                      │  (pure fn) · media · admin · notify worker  │
                      │  · stream (SSE)                             │
                      └───────┬───────────────────┬─────────────────┘
                              │                    │
                 Postgres (via pooler,             │ Expo Push, SMS provider
                 port 6543) + LISTEN (direct,       │ (console in dev, Msg91
                 port 5432 for SSE)                 │ in prod)
                              ▼                     ▼
                      ┌───────────────┐     ┌───────────────┐
                      │ Supabase       │     │ Expo Push API  │
                      │ Postgres +     │     │ SMS provider   │
                      │ Storage        │     │ (DLT templates)│
                      │ (schema haven, │     └───────────────┘
                      │  not exposed   │
                      │  via REST)     │
                      └───────────────┘
```

## 2. Clients (SDD §8.1, §13)

| Client | Surface | Signs in with | Notes |
|---|---|---|---|
| Guest web | Mobile browser, no install | Phone OTP | Invite claim, OTP, profile, gate scan landing (`/g/:token`), check-in/out, walk-in, status pages. Must load under 200 KB JS before the camera opens. |
| Gate display | `/gate` web page, full screen, no chrome | Device token from pairing | Runs on the receptionist's phone. Shows **no personal data, ever**. Rotating QR generation is offline-capable. |
| Resident app | Expo (Android + web fallback) | Google Sign-In + phone OTP | Onboarding, invites, approvals, arrival confirmation, overnight requests, host-assisted check-in. |
| Warden / Office | Expo (Android + web), SSE-driven dashboard | Google Sign-In | Live dashboard, approvals, verification, rules, bans, gate devices, audit, charges. |

One Expo Router app serves guest, resident, warden and office — route groups decide
which shell a signed-in principal sees (SDD §13.3). The receptionist has no account; her
phone is just a charged, unlocked screen showing `/gate`.

## 3. API (SDD §8.1–8.2, §12)

Fastify service, REST over HTTPS at `https://api.<domain>/v1`, JSON in/out, camelCase
fields. Every request/response schema is a Zod schema in `packages/shared/src/api/`,
imported by both the API (validation) and the client (typed calls). **If an endpoint
isn't documented in SDD §12, it doesn't exist** — do not add undocumented endpoints
without recording the addition in `docs/DECISIONS.md`.

Request path, in order (SDD §8.2):
1. Request ID assigned.
2. Rate limit (SDD §12.11).
3. Auth: verify JWT or device token, load principal.
4. Zod validation of params/body.
5. Handler → `authorize(principal, action, resource)` (SDD §3.4) → service.
6. Service → repository (Kysely) — repos never decide anything, services never touch
   the DB directly (SDD §20.2 module pattern: `routes.ts` → `service.ts` → `repo.ts`).
7. Serializer strips fields by role (e.g. office never sees phone/photos).
8. Response.

Every mutating service call runs in **one transaction** that writes the row change, the
audit log row (via trigger), any `gate_events` row, and any `notifications` rows.
Notifications are sent after commit by the worker — a rolled-back change never
notifies anyone.

**Idempotency (SDD §9.12):** every POST that changes gate or visit state — check-in,
check-out, walk-in, host-assisted entry, approve, reject, dispute, force check-out —
MUST carry an `Idempotency-Key: <uuid>` header. The API stores
`(key, principal, route) → (status, body)` in `idempotency_keys` for 24 h and replays
the stored response on a repeat, rather than re-running the handler. The client
generates the key once per user action (not once per HTTP attempt) and reuses it on
retries — this is what makes a double-tapped "Check in" button or a network-drop-after-
commit produce exactly one `gate_events` row (E-10, TC-FLOW-10), not an application-
level dedupe check inside the handler.

**Reads are audited too, not just writes (SDD §16.4):** viewing a visit detail with
photos, the emergency roll-call list, and CSV exports must write `audit_log` rows
(`action = 'read.*'`) from the API — this is a named security control for staff-misuse
detection (threat T15, SDD §16.1), separate from and in addition to the mutation
auditing the `audit_row()` trigger already provides automatically. Because it isn't
trigger-driven, it does **not** happen for free — the handlers for those three read
paths must explicitly insert the audit row themselves.

### API modules (SDD §8.1)

| Module | Responsibility | Talks to |
|---|---|---|
| Auth | Phone OTP, Google ID-token verification, JWT issue/refresh, sessions, `authorize()` policy | Postgres, SMS, Google |
| Visits | Create/edit/cancel visits, approvals, disputes, state machine, charges | Postgres, rules engine, outbox |
| Gate | Gate token verification, geofence, scan sessions, check-in/out, host-assisted entry, device pairing/heartbeat | Postgres, rules engine, media, outbox |
| Rules engine | Pure evaluation of rules config, shared with the app for instant form feedback | — (no I/O) |
| Media | Accept JPEG uploads, validate, strip EXIF, store, issue 120 s signed URLs | Storage |
| Admin | Rules versions, bans, resident verification, staff invites, gate devices, audit queries, CSV export | Postgres |
| Notify worker | Polls `notifications` outbox, sends push/SMS, retries, SMS fallback timers | Postgres, Expo Push, SMS |
| Stream | `GET /v1/stream` SSE: forwards `LISTEN haven_events` to authorised dashboard clients | Postgres |

`pg_cron` jobs (expiries, overstay flagging, night sweep, retention purge) are SQL
functions that insert outbox rows directly — they are logically part of the "jobs"
layer, not the API process, but share the same database.

## 4. Database and storage (SDD §10–11)

One Supabase project. Everything lives in schema `haven`, which is **not** exposed
through Supabase's auto-generated REST API — the API's own `haven_api` Postgres role,
connecting through the pooler, is the only way in. RLS is enabled on every table with a
single `api_all` policy granting `haven_api` full access and everyone else nothing
(SDD §11.7).

`visits` is the centre of the model: it ties one verified resident host to one guest for
one time window; everything that happens at the gate hangs off it as an append-only
`gate_events` row. Identity is split by kind: `users` (Google sign-in — resident, warden,
office, super admin) vs `visitors` (phone sign-in — guests, including phone-less
host-assisted guests).

Key modelling decisions (SDD §10.2):
- Guests are not users — different privacy rules, simpler retention.
- `visits.status` is a **projection**; `gate_events` and `audit_log` are **history** and
  are append-only (trigger-enforced).
- Invited phone/name live on the visit until claimed, because the guest may not exist
  yet as a row.
- `visits.rules_version` pins which rules config approved a visit — later rule changes
  never rewrite history.
- No deletes of business rows — only retention jobs anonymise.

### Storage buckets (private, signed URLs only, SDD §9.10)

| Bucket | Path | Contents | Retention |
|---|---|---|---|
| `visitor-photos` | `{visitorId}/{mediaId}.jpg` | Guest profile selfie | 365 days after last visit |
| `gate-photos` | `{hostelId}/{yyyy}/{mm}/{mediaId}.jpg` | Live check-in/out photos | 180 days |
| `resident-docs` | `{userId}/{mediaId}.jpg` | ID card, resident selfie | ID card: deleted on verification decision. Selfie: while account active |

## 5. Authentication (SDD §9.5)

Two principal kinds, two sign-in methods:

- **Guests (`visitors`)**: phone OTP only. 6-digit code, HMAC-peppered, 5 min TTL, rate
  limited (3/phone/10min, 10/IP/hour, 5 wrong attempts burns the code).
- **Residents, staff (`users`)**: Google Sign-In (ID token verified server-side against
  allowed client IDs), plus phone OTP for residents specifically (`phone_verify`
  purpose) as part of onboarding.

Tokens: access JWT (HS256, 15 min, memory only, claims `sub`/`typ`/`sid`/`roles`),
refresh token (32 random bytes, 30 days, **rotated on every use with reuse
detection** — presenting an already-rotated token revokes the whole session), gate
device token (`gd_` + 32 random bytes, until revoked). Web stores refresh in an
httpOnly cookie scoped to `/v1/auth`; native stores it in `expo-secure-store` and sends
it in the body (`X-Client: native`).

Deactivation/session revocation takes effect within **30 seconds** (auth hook caches
active/revoked status for 30 s).

## 6. Rules engine and gate system

### 6.1 Rules engine (SDD §4)

Pure TypeScript in `packages/shared/src/rules/` — **no I/O, no `Date.now()`**, time is
always passed in. Shared verbatim between API and client so the app can give instant
form feedback before submitting.

```
evaluateCreate(ctx, cfg): RuleResult   // pre-invite, walk-in request, overnight request
evaluateEntry(ctx, cfg): RuleResult    // gate check-in, host-assisted entry
evaluateExit(ctx, cfg): RuleResult     // never denies
nightsBetween(arrivalDate, departureDate): string[]
quotaUsed(hostNights, month): number
```

`RuleResult` is `{ decision: 'allow'|'allow_flagged'|'deny', codes: RuleCode[], zone? }`.
Deny codes stop evaluation and return immediately (ordered list in SDD §4.5); flag
codes accumulate. The API loads all context (host status, bans, existing visits, counts)
and passes it in — this is what keeps the engine testable with plain objects.

Rules config itself is versioned, insert-only data (`hostel_rules.config`, validated by
the `RulesConfigSchema` Zod schema) — **changing a rule never requires a deploy.**

### 6.2 Gate system (SDD §9.1–9.3)

Three cooperating mechanisms:

1. **Rotating gate token** (generated client-side on the gate device, works offline):
   `HVG1|gateCode|step` HMAC-SHA256'd with the gate's secret, truncated to 80 bits,
   base32-Crockford encoded. Rotates every 10 s (`STEP_MS = 10_000`); the server
   accepts tokens up to 30 s old (`-1 ≤ age ≤ 2` steps). Tokens are not single-use —
   several guests can scan the same code within its window.
2. **Scan session**: proves "this browser saw a fresh gate QR at the gate, with this GPS
   result." Created by `POST /v1/scan-sessions`, lives ≤ 10 min, is bound to one
   principal via `X-Scan-Nonce`, and is consumed by exactly one gate action
   (`consumed_at` set in the same transaction as that action).
3. **Geofence**: haversine distance between the gate's calibrated lat/lng and the
   client's GPS fix. `gps_ok` requires: location present, accuracy ≤ `max_accuracy_m`
   (default 75 m), distance ≤ `radius_m` (default 50 m), fix age ≤ 60 s. A scan session
   allows **up to 3 location attempts in total** (the initial fix plus 2 retries via
   `POST /scan-sessions/{id}/location`, enforced by `location_attempts < 3`) before the
   client falls back to "ask host to confirm" (`LOCATION_RETRY_LIMIT`). Don't implement
   this as 3 retries *after* the first attempt (4 total) — it's 3 attempts, full stop.

Gate secrets are 32-byte random values, AES-256-GCM encrypted at rest
(`DATA_ENCRYPTION_KEY`), versioned, with a 120-second grace window on the previous
secret after rotation (so in-flight devices aren't locked out mid-rotation).

**Mock-location detection (host-assisted entry only, SDD §9.3, F4):** on native
(`expo-location`), if `location.mocked === true` (Android), the client aborts before
ever calling the API, with "Turn off fake location apps." The server-side mirror of
this is error code `MOCK_LOCATION` (403) — the host app must check and refuse locally,
not just trust the server to catch it, since the check only exists on the native host
app path (there is no equivalent check for guest web, where mock-location can't be
reliably detected in-browser — see threat T4 in SDD §16.1, accepted as medium residual
risk).

**OTP abuse mitigation (SDD §16.1 T10, §20.3):** beyond the per-phone/per-IP rate
limits (SDD §12.11), `POST /auth/otp/request` is gated behind **Cloudflare Turnstile**
after 3 requests from one IP (`TURNSTILE_SECRET` server-side,
`EXPO_PUBLIC_TURNSTILE_SITE_KEY` client-side — both are real env vars in SDD §20.3,
easy to miss since Turnstile isn't mentioned in the main auth flow text of §9.5). Do
not treat rate limiting alone as sufficient OTP protection — Turnstile is a named,
required second control.

## 6.3 Visit lifecycle and state machine (SDD §7)

`visits.status` has **8 values**: `pending_host`, `pending_warden`, `approved`,
`inside`, `completed`, `rejected`, `expired`, `cancelled`. Three independent boolean/
timestamp **flags** ride alongside status and do not themselves gate what a guest can
do: `overstay_since`, `host_disputed_at`, `location_unverified` /
`exit_location_unverified`. A flagged guest can still check out normally — flags are
for the warden's attention, not additional states.

The full transition table (every `(from, to, trigger, actor, side effect)` row) is
normative in SDD §7.1 and is implemented as **one map** in
`apps/api/src/visits/stateMachine.ts` — never as scattered `if` checks across route
handlers. **Any transition not in that table MUST be rejected with
`409 INVALID_TRANSITION`.**

Concurrency (SDD §7.3): every status change is written as
`UPDATE visits SET status = $new, ... WHERE id = $id AND status = $expected
RETURNING *`. Zero rows returned means someone else changed it first — respond `409`
and let the client refetch; do not read-then-write with a separate `SELECT`. A partial
unique index (`visits_one_inside_per_visitor`) enforces BR-15 (one `inside` visit per
visitor, anywhere) at the database level, independent of the state machine — a race
that the application layer missed still cannot produce two simultaneous `inside`
visits for one guest; it surfaces as `409 ALREADY_INSIDE`.

## 7. Notifications (SDD §9.7, §15)

Database-outbox pattern (D10): producers (API services, SQL jobs) only `INSERT` into
`notifications`. Nothing calls Expo Push or an SMS provider inside a request. A worker
loop (every 2 s, in the API process when `WORKER_ENABLED=true`) claims rows with
`FOR UPDATE SKIP LOCKED`, checks staleness/`cancel_if_opened`, and sends via the
channel adapter (`expo-server-sdk` for push, a `SmsProvider` interface for SMS —
`ConsoleSmsProvider` in dev, `Msg91SmsProvider` in prod). Retries at 10 s, 30 s, 2 min,
10 min, then `failed`. `dedupe_key` (unique) prevents duplicate jobs from double-firing.
Every notification kind, trigger, recipient, channel and exact copy is enumerated in
SDD §15 — nothing outside that table may be sent.

## 8. Live updates (SDD §9.9)

A Postgres trigger (`pg_notify('haven_events', ...)`) fires on visit/gate-device changes.
The API holds one dedicated `LISTEN` connection (via the **direct** connection, port
5432 — `LISTEN` does not work through the transaction pooler) and fans out to SSE
subscribers (`GET /v1/stream?hostelId=`), filtered by hostel and role. Guests and hosts
don't use SSE — the guest waiting page polls every 3 s, hosts get push; only
warden/office dashboards use SSE, with a 15 s poll fallback on disconnect.

## 9. Major modules and request flow (end to end example)

Pre-invite check-in (F1, SDD §6):

```
Host app            API                         DB                   Guest browser
  │  POST /visits      │                           │                       │
  ├────────────────────▶ evaluateCreate()          │                       │
  │                     ├──────────────────────────▶ INSERT visits         │
  │  ◀── inviteUrl ─────┤                           │                       │
  │  (share sheet)      │                           │                       │
  │                     │                           │   guest opens link,   │
  │                     │                           │   OTP, profile        │
  │                     │                           │   (first time)        │
  │                     │                           │                       │
  │                     │   guest scans gate QR ────┼───────────────────────▶
  │                     │◀── POST /scan-sessions ───┼───────────────────────┤
  │                     │  verify token + geofence  │                       │
  │                     ├──────────────────────────▶ INSERT scan_sessions  │
  │                     │── scanSessionId, gpsOk ───┼───────────────────────▶
  │                     │                           │   live photo upload   │
  │                     │◀── POST .../photo ────────┼───────────────────────┤
  │                     │◀── POST .../check-in ─────┼───────────────────────┤
  │                     │  evaluateEntry()          │                       │
  │                     ├──────────────────────────▶ TX: gate_events(entry) │
  │                     │                             visits → inside       │
  │                     │                             audit_log row         │
  │                     │                             notifications row     │
  │  ◀── push N-ARRIVED─┤                           │                       │
  │  (worker, after     │                           │── 'inside' ───────────▶
  │   commit)           │                           │                 green screen
```

## 10. Deployment architecture (SDD §8.3)

| Component | Prototype hosting | Region | Notes |
|---|---|---|---|
| API | Render (web service, starter) or Railway | Singapore | One instance; worker runs in-process (`WORKER_ENABLED=true`) |
| Database + Storage | Supabase (free tier for dev, Pro if the pilot needs backups) | Mumbai (ap-south-1) | Data at rest stays in India |
| Web (guest, gate, warden web) | Vercel, static export of Expo web | Global CDN | `app.<domain>`; guest links are short: `/i/:token`, `/g/:token` |
| Android app | EAS Build → APK | — | Distributed by link for the pilot; Play Store later |
| Domain | One domain (e.g. `haven-gh8.in`) | — | `app.` and `api.` subdomains so cookies are same-site |

### 10.1 External providers (consolidated — scattered across SDD §8.4, §16, §18, §20.3)

Beyond the hosting providers in the table above: **Google** (Sign-In, ID token
verification), **Expo Push** (`expo-server-sdk`), an **SMS provider** (Msg91 in
production behind the `SmsProvider` interface, console in dev/staging), **Sentry**
(API + app error tracking, including a cron monitor on the worker loop per SDD §18.2),
**UptimeRobot** (free tier — polls `/ready` and `https://app.<domain>/gate` every
1 minute, alerts on 2 consecutive failures; SDD §18.2), and **Cloudflare Turnstile**
(OTP-request CAPTCHA, §6.2 above). None of these are optional "nice to haves" — each is
named as the mitigation for a specific threat or NFR in the SDD and should be
provisioned in Week 0 alongside the hosting accounts.

## 11. Environment separation (SDD §8.3)

Three environments, never pointed at each other's data:

- **local** — Supabase CLI in Docker.
- **staging** — separate Supabase project, auto-deploy from `main`.
- **production** — manual promote from a git tag (`vX.Y.Z`), after the staging smoke
  test passes (SDD §19.5).

Migrations run before the API deploys in each environment and must be
backward-compatible with the *previous* API version (add columns first, remove later —
SDD §18.5). No production deploys between 17:00–22:00 IST on pilot days.

## 12. Technology stack summary

See `CLAUDE.md` §5 and SDD §8.4 for the full pinned list. Headline choices: TypeScript
strict everywhere, pnpm + Turborepo monorepo, Expo Router for all four client
surfaces, Fastify + Zod + Kysely + Supabase-managed Postgres, `jose` JWTs, `sharp` for
image processing, `luxon` for timezone-correct date maths, Vitest/Supertest/Playwright
for testing.

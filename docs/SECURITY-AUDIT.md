# HAVEN — Security audit

**Scope.** The API (`apps/api`), database migrations (`supabase/migrations`), the web
and Android app (`apps/mobile`), scripts, repository and git history, and
dependencies.

**Checked against:**
- SDD §16.1 threat model (T1–T16);
- the §16.4 controls checklist;
- §3.3 / §3.4 authorization;
- §9.3–§9.5 and §12.11 rate limits;
- every TC-SEC case (§19.2).

**Method.**
- Read the code path for each control.
- Grepped for every route registration and checked how it authorizes.
- Grepped for string-built SQL, secrets and logging.
- Ran `pnpm audit`.
- Reproduced issues with the integration test harness where possible.

**Date:** 2026-10-18. Audited at commit `0bc7c3f`. Findings were written down
**before** any fix. The *Status* column was filled in afterwards; final state is at
the end.

**Severity scale:**

| Severity | Meaning |
|---|---|
| CRITICAL | Remote compromise or mass data exposure with no preconditions |
| HIGH | Unauthenticated PII exposure, auth bypass with a realistic precondition, or a known exploitable dependency on an untrusted-input path |
| MEDIUM | A control the SDD requires is missing or bypassable under load or concurrency |
| LOW | Defence-in-depth gap, or one needing an unlikely precondition |
| INFO | Checked and fine, or accepted by the SDD's design |

## Summary

| ID | Sev | Finding | Status |
|---|---|---|---|
| SA-01 | HIGH | `GET /v1/rooms/search` is public and returns residents' full names and user ids for any room: the whole hostel can be enumerated without signing in | Fixed `782a8cc` |
| SA-02 | HIGH | `APP_ENV` defaults to `local`. A deploy that forgets it accepts `123456` for the test phones, allows console SMS, and drops `Secure` and `Domain` from the refresh cookie. The seed script would add fake residents | Fixed `782a8cc` |
| SA-03 | HIGH | `sharp` 0.33.5 (libvips/libheif/librsvg CVEs) decodes every untrusted upload | Fixed `c050861` |
| SA-04 | MEDIUM | OTP verify reads, then increments, the attempt counter, so parallel guesses beat the 5-attempt limit | Fixed `782a8cc` |
| SA-05 | MEDIUM | OTP request counts, then inserts, so parallel requests beat 3/phone and 10/IP (SMS pumping, T10) | Fixed `782a8cc` |
| SA-06 | MEDIUM | §12.11's `POST /auth/otp/verify` limit (10 per IP per 10 min) is missing | Fixed `782a8cc` |
| SA-07 | MEDIUM | No CAPTCHA (Cloudflare Turnstile) after 3 OTP requests from one IP (T10, CLAUDE.md §4) | Fixed `782a8cc` (API), `9a57d52` (web) |
| SA-08 | MEDIUM | Request URLs are logged raw: invite tokens, media signatures, and phone numbers typed into the warden's search | Fixed `782a8cc` |
| SA-09 | MEDIUM | No 64 KB JSON body limit (§16.4 Input); Fastify's default is 1 MB | Fixed `782a8cc` |
| SA-10 | MEDIUM | Behind the hosting proxy every client shares the proxy's IP, so per-IP limits apply to everyone at once | Fixed `782a8cc` (config; set per environment) |
| SA-11 | MEDIUM | Reading residents' ID-card and selfie photos (W-04/W-08) writes no `read.*` audit row (T15) | Fixed `782a8cc` |
| SA-12 | MEDIUM | The web app has no CSP / `frame-ancestors` / HSTS headers configured anywhere (§16.4 Headers) | Fixed for the Phase 1 deployment: `apps/mobile/vercel.json` (DEC-028); check the headers on the live site (docs/DEPLOY-TEST.md) |
| SA-13 | MEDIUM | Sentry is not wired (NFR-13, §9.7 "logged to Sentry") | Fixed `91b0218` (API + web; Android no-op) |
| SA-14 | LOW | The console OTP line logs the full phone number (§16.4: phones masked only) | Fixed `782a8cc` |
| SA-15 | LOW | Some handlers enforce access by principal type or scan-session binding, not `authorize()` (CLAUDE.md §3.10 consistency) | Fixed (DEC-018): runtime enforcement; found SA-31..33 |
| SA-16 | LOW | Access-token verification doesn't pin the HS256 algorithm | Fixed `782a8cc` |
| SA-17 | LOW | PHOTO_REUSED is check-then-insert (a race lets two identical uploads through) | Fixed (DEC-018): unique index |
| SA-18 | LOW | Registering a push token another user holds moves it to the caller | Open (accepted by design) |
| SA-19 | LOW | `X-Client: native` makes `/auth/refresh` return the refresh token in JSON on the web too, so XSS could read it | Fixed (DEC-018): Origin check |
| SA-20 | LOW | CORS config accepts a `*` entry | Fixed `782a8cc` |
| SA-21 | LOW | Phone-verifying a number another user owns returns 500, not 409 | Fixed `782a8cc` |
| SA-22 | LOW | Warden search uses ILIKE without escaping `%` and `_` (wider matches only) | Not an issue: both searches already escape `\ % _` (false positive) |
| SA-23 | LOW | Dev-tooling advisories (braces, node-forge, sprintf-js, decode-uri-component, uuid) via Expo/Metro/Jest; `pnpm audit` fails at high | Accepted (DEC-018): dev tooling only, no patch |
| SA-24 | INFO | The test OTP is enabled in staging by SDD design (§9.5 "non-production"); you asked it to be development-only | Decided (DEC-018): follow §9.5; never production |
| SA-25 | INFO | The gate secret lives in the gate browser's localStorage (§9.2 design) | Accepted |
| SA-26 | INFO | Mock location is client-reported (T4 accepted) | Accepted |
| SA-27 | INFO | CSRF: bearer tokens everywhere except the refresh cookie (SameSite=Lax, POST) | OK |
| SA-28 | INFO | SQL: Kysely and parameterised `pg` only; the one `format('%I')` iterates `pg_tables` | OK |
| SA-29 | INFO | SSRF: no user-controlled outbound URL | OK |
| SA-30 | INFO | The dev sign-in is refused at boot unless `NODE_ENV=development`, but no test proved it | Fixed (tests) `782a8cc` |
| SA-31 | MEDIUM | `POST /scan-sessions/{id}/location` didn't check `X-Scan-Nonce` (§12.1). Found by the SA-15 enforcement | Fixed (DEC-018) |
| SA-32 | LOW | Idempotent replays of ★ host actions returned the stored response without authorizing (the key is already scoped to the caller) | Fixed (DEC-018) |
| SA-33 | LOW | `GET /me/hosted-visits`, `/me/quota`, `/me/charges` relied on self-scoped queries without `authorize()` | Fixed (DEC-018) |
| SA-M1..M4 | MEDIUM/LOW | Media (found and fixed in the Part 1 media review): 3 MB+ upload gave 500; no pixel limit; no traversal guard; the media route skipped `authorize()` | Fixed in `0bc7c3f` |

**Totals.** 3 HIGH, 10 MEDIUM, 10 LOW and 7 INFO, plus 4 media findings already
fixed.

## Findings

### SA-01 (HIGH): public resident enumeration through room search

- **Location:** `apps/api/src/visits/routes.ts` `GET /v1/rooms/search`.
- **Reproduce:** `curl '/v1/rooms/search?hostelId=<id>&number=101'` with no
  credentials returns `[{ userId, fullName: "Priya Sharma" }]`. Iterating room
  numbers lists every resident.
- **SDD:**
  - §12.7: `GET /hostels/{id}/rooms/{number}/residents`, "Visitor with live scan
    session, header X-Scan-Session", `[{ residentId, displayName }]`, verified only,
    "rate-limited 10/min";
  - F2 step 3 shows "Priya S.";
  - §16.2: the room is shown only as part of host search;
  - T13.
- **Fix:** implement the §12.7 endpoint exactly:
  - signed-in visitor;
  - `X-Scan-Session` naming a live, unconsumed scan session that has the caller's
    nonce, belongs to the caller, and is at a gate of that hostel;
  - display name only;
  - 10 per minute;
  - remove `/rooms/search`.

### SA-02 (HIGH): security controls fail open when APP_ENV is unset

- **Location:** `apps/api/src/config.ts` (`APP_ENV … default('local')`); also
  `apps/api/scripts/seed.ts`.
- **Effect:** `otp-service.ts` accepts `123456` for `+919999900001..09` whenever
  `APP_ENV !== 'production'`. Also:
  - `ConsoleSmsSender` and the OTP console path run;
  - `refreshCookieOptions` drops `Secure` and `Domain` when `local`;
  - `seed.ts` inserts fake residents and visitors.
  A production service missing one environment variable silently gets all of
  these.
- **Reproduce:** boot `buildApp` with every production variable except `APP_ENV`,
  then `POST /auth/otp/verify { phone: +919999900001, code: 123456 }` returns tokens.
- **SDD:** §9.5 ("Non-production only"), §16.4 (Cookies).
- **Fix:** `APP_ENV` is required, with no default, in the API and the seed script. A
  missing value stops boot.

### SA-03 (HIGH): vulnerable sharp on the upload path

- **Location:** `apps/api/package.json` (`sharp@0.33.5`). `pnpm audit` reports
  GHSA advisories for libvips, libheif and librsvg (fixed in ≥ 0.35.5).
- **Reach:** every photo upload is decoded by sharp before anything else (§9.4).
- **Fix:** upgrade to `sharp@0.35.5`, in its own commit (CLAUDE.md §5: dependency
  upgrades in dedicated changes).

### SA-04 (MEDIUM): OTP attempt counter race

- **Location:** `apps/api/src/auth/otp-service.ts` `verifyOtp`.
- **Problem:** it reads `attempts`, compares the code, then writes `attempts + 1`.
  N parallel requests all read the same count, so one challenge can take far more
  than 5 guesses.
- **SDD:** §9.5 "5 wrong attempts per code then it is burned".
- **Fix:** one atomic `UPDATE … SET attempts = attempts + 1 WHERE … AND attempts < 5
  RETURNING …` before comparing.

### SA-05 (MEDIUM): OTP request limit race

- **Location:** `requestOtp` counts recent challenges, then inserts.
- **Reproduce:** 20 parallel requests for one phone create more than 3 challenges
  (and SMS).
- **SDD:** §12.11, T10.
- **Fix:** take transaction-scoped advisory locks on the phone and the IP (always in
  that order), then count and insert in the same transaction.

### SA-06 (MEDIUM): no OTP verify rate limit

- **Location:** `apps/api/src/auth/routes.ts` `POST /auth/otp/verify` has only the
  global 120/min.
- **SDD:** §12.11 "10 per IP per 10 min".
- **Fix:** add a route-level limit of 10 per 10 min.

### SA-07 (MEDIUM): no CAPTCHA on OTP requests

- **SDD:** T10 "CAPTCHA (Cloudflare Turnstile) after 3 requests from one IP";
  §20.3 lists `TURNSTILE_SECRET` and `EXPO_PUBLIC_TURNSTILE_SITE_KEY`.
- **Fix:**
  - a `BotVerifier` interface: Turnstile `siteverify`, plus a dev bypass that's
    allowed only when `TURNSTILE_SECRET` is unset and `APP_ENV=local`;
  - from the 4th request in an hour from one IP, the request must carry a valid
    `captchaToken`;
  - otherwise `429 RATE_LIMITED` with `details.reason = 'CAPTCHA_REQUIRED'`
    (§12.2 has no specific code);
  - the web login shows the Turnstile widget when asked.

### SA-08 (MEDIUM): secrets and PII in logged URLs

- **Location:** Fastify's request log line logs `req.url` verbatim. This leaks:
  - `GET /v1/invites/<128-bit token>` (a credential, T11);
  - `GET /v1/media/<id>?exp=…&sig=…` (a live credential for 120 s);
  - `GET /v1/admin/visits?q=+9198…` (a phone number);
  - `?number=` room numbers.
- **SDD:** §16.4 Logs (redact `token`, phone; phones masked only).
- **Fix:** a request serializer that logs the path without its query string and
  replaces the invite-token path segment with `[redacted]`.

### SA-09 (MEDIUM): JSON body limit

- **Location:** `Fastify({...})` sets no `bodyLimit`.
- **SDD:** §16.4 "max body 3 MB (uploads), 64 KB otherwise".
- **Fix:** `bodyLimit: 64 KB`. Multipart keeps its 3 MB file limit.

### SA-10 (MEDIUM): proxy IP used as the client IP

- **Location:** `Fastify({...})` sets no `trustProxy`. On Render and Vercel the TCP
  peer is the proxy, so `request.ip` is the same for everyone. This affects:
  - §12.11's per-IP limits;
  - the OTP per-IP count;
  - the pairing-code limit;
  - the T10 CAPTCHA trigger.
- **Fix:** a `TRUST_PROXY_HOPS` setting (default 0 = trust none). Set it to the
  number of proxies in front of the API in each environment. It's documented in
  `.env.example`.

### SA-11 (MEDIUM): unaudited reads of resident ID documents

- **Location:** `GET /v1/admin/residents` (W-04, W-08) returns signed URLs for the
  ID card and selfie with no `read.*` row.
- **SDD:** T15 "all reads of photos and exports are audited".
- **Fix:** write one `read.resident_documents` audit row per response that contains
  any ID-card or selfie URL, listing the resident ids.

### SA-12 (MEDIUM): web app security headers

- **Location:** there's no hosting config for the Expo web export. CSP
  (`connect-src` the API domain, `frame-ancestors 'none'`), HSTS and `nosniff` are
  required by §16.4 on the web app.
- **Status: needs your decision.** The `connect-src` value is the production API
  domain, and where headers live depends on the host (Vercel per §8.4). A proposed
  `vercel.json` is in "Open items" below.

### SA-13 (MEDIUM): Sentry not wired

- **Fix:** `@sentry/node` in the API and `@sentry/react` in the web app:
  - a no-op when `SENTRY_DSN` / `EXPO_PUBLIC_SENTRY_DSN` is unset;
  - a `beforeSend` scrubber using the §16.4 redaction list (and phones);
  - no user identity, no IP, no request bodies.

### SA-14 (LOW): unmasked phone in the console OTP line

- **Location:** `otp-service.ts` `sendOtpViaProvider`. It prints `[otp:dev] +9198…`
  in local and staging.
- **Fix:** mask the phone as the SMS provider does (`+91•••••43210`). The code is
  still printed, as §9.5 says.

### SA-15 (LOW): handlers that don't call authorize()

- **Location:** about 30 handlers (the auth endpoints, scan-session endpoints, some
  resident and host routes, `/me/profile-photo`) enforce access by principal type,
  self-scoping or scan-session binding. Several call `authorize()` inside their
  service. No missing check was found, but CLAUDE.md §3.10 asks for `authorize()` in
  every handler.
- **Recommendation:** add self-policies route by route. Left open because it's a
  wide refactor with no exploit.

### SA-16 (LOW): JWT algorithm not pinned

- **Fix:** `jwtVerify(…, { algorithms: ['HS256'] })`.

### SA-17 (LOW): PHOTO_REUSED race

- Two parallel identical uploads both pass the select. Low impact: same person,
  same photo. A unique index on `(owner_visitor_id, sha256)` needs a migration and a
  decision on deleted rows. Open.

### SA-18 (LOW): push-token takeover

- `POST /me/push-tokens` upserts by `expo_token` and moves an existing token to the
  caller. That's intended for a phone that changes account. Exploiting it needs the
  victim's Expo token (unguessable, never exposed by the API). Open, by design.

### SA-19 (LOW): refresh token in JSON on the web

- `X-Client: native` makes `/auth/refresh` return the token in the body. On the web
  that only matters with XSS (T12). Open: the fix (refuse body tokens to browser
  origins) needs a decision on how native clients are identified.

### SA-20 (LOW): wildcard CORS not rejected

- **Fix:** config validation rejects `*` and anything that isn't an `http(s)` origin.

### SA-21 (LOW): phone-verify conflict gives 500

- **Fix:** map the unique violation to `409 CONFLICT`.

### SA-22 (LOW): unescaped ILIKE

- **Fix:** escape `\`, `%` and `_` in the warden's search term.

### SA-23 (LOW): dev-tooling advisories

- After the sharp upgrade, `pnpm audit` still reports HIGH for `braces` and
  `node-forge` (no patched versions), and MODERATE for `uuid`, `sprintf-js` and
  `decode-uri-component`. All come in through Expo CLI, Metro and Jest. None are in
  the API's runtime or the shipped web bundle's request path.
- **Recommendation:** run `pnpm audit --prod` in CI, or allow-list these advisories
  with an expiry date. Open.

### SA-24 (INFO): test OTP outside development

- §9.5 allows the `123456` test phones in any non-production environment (staging
  included). Your brief asks that they never work outside `NODE_ENV=development`.
  That changes SDD behaviour, so it's left for you to decide.
- After SA-02 the bypass can't be enabled by accident (`APP_ENV` must be set
  explicitly), and it never works when `APP_ENV=production`.

### SA-25 – SA-29 (INFO)

| ID | What was checked | Result |
|---|---|---|
| SA-25 | The gate secret in localStorage | §9.2 design. Revoking a device rotates the secret. Accepted. |
| SA-26 | Mock location | Detected by the native app and mirrored by the server (`MOCK_LOCATION`). The web can't detect it (T4, accepted). |
| SA-27 | CSRF | Every state-changing call needs a bearer token. `haven_rt` is SameSite=Lax, path `/v1/auth`. No exposure. |
| SA-28 | SQL injection | No `sql.raw` or string-built SQL in `apps/api/src`. Scripts use parameterised `pg`. The migrations' only dynamic SQL is `format('… %I …')` over `pg_tables`. |
| SA-29 | SSRF | The only outbound calls are Google token verification, Expo push and Turnstile (fixed URLs). |

### SA-30 (INFO): dev sign-in gating proven

- `buildApp` throws when `DEV_LOGIN_ENABLED=true` and `NODE_ENV !== 'development'`,
  and the route isn't registered unless the flag is on.
- **Added tests:** boot refused under `NODE_ENV=production`, `staging` and `test`;
  route absent (404) when the flag is off; flag parsing rejects anything but
  `'true'` / `'false'`.

### TC-SEC status

| Case | Status | Test |
|---|---|---|
| TC-SEC-01..09 | Done | See TRACEABILITY |
| TC-SEC-10 | Done | `apps/api/test/media.integration.test.ts` ("strips EXIF, including GPS") |
| TC-SEC-11 | Done | `apps/api/test/media.integration.test.ts` ("PHOTO_REUSED") |

## Open items needing a decision

1. **SA-12, web security headers.** The proposal is
   `apps/mobile/vercel.json` with:
   - `Content-Security-Policy: default-src 'self'; script-src 'self'
     https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src
     'self' data: blob: https://api.<domain>; connect-src https://api.<domain>
     https://*.ingest.sentry.io; frame-src https://challenges.cloudflare.com;
     frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
   - `Strict-Transport-Security: max-age=31536000; includeSubDomains`;
   - `X-Content-Type-Options: nosniff`;
   - `Referrer-Policy: no-referrer`.

   `style-src 'unsafe-inline'` is needed by react-native-web's injected styles.
   **Needed from you:** confirm Vercel, and the production API domain.
2. **SA-24.** Keep §9.5 (test phones in staging), or restrict them to
   `NODE_ENV=development`? The second needs an SDD change.
3. **SA-17, SA-19, SA-23.** Accept or schedule.

## Final status

Updated after the team's decisions (DEC-018).

| Severity | Found | Fixed | Open / decided |
|---|---|---|---|
| CRITICAL | 0 | 0 | — |
| HIGH | 3 | 3 | — |
| MEDIUM | 11 | 10 | SA-12 scheduled for the deployment milestone |
| LOW | 12 | 8 (+1 false positive) | SA-18 accepted by design; SA-23 accepted |
| INFO | 7 | 1 (tests) | SA-24 decided: follow §9.5 |
| Media (Part 1) | 4 | 4 | — |

The rest of the history (regression evidence, deployment checklist) is unchanged
below.



| Severity | Found | Fixed | Open | Open items |
|---|---|---|---|---|
| CRITICAL | 0 | 0 | 0 | — |
| HIGH | 3 | 3 | 0 | — |
| MEDIUM | 10 | 9 | 1 | SA-12 web CSP/HSTS (needs the hosting and API-domain decision) |
| LOW | 10 | 4 (+1 false positive) | 5 | SA-15 authorize() consistency, SA-17 reuse race, SA-18 token takeover (by design), SA-19 body refresh token on web, SA-23 dev-tooling advisories |
| INFO | 7 | 1 (tests) | 1 decision | SA-24 test OTP in staging (SDD §9.5 vs your brief) |
| Media (Part 1) | 4 | 4 | 0 | — |

**Proof the regression tests are real.**
`apps/api/test/security.integration.test.ts` has 23 tests. Its first 20 were run
against the source as it was before the fixes (stashed sources, same tests):
- 17 failed;
- the 3 that passed are the SA-30 gating proofs, which describe behaviour that was
  already correct.

All 23 pass with the fixes.

**Other tests added for this audit:**
- `apps/api/test/media.integration.test.ts` (11);
- `apps/api/src/config.test.ts` (+4);
- `apps/api/src/lib/logger.test.ts` (+1, and 3 updated: the request serializer now
  drops headers and bodies entirely, so they assert absence);
- `packages/shared/src/scrub.test.ts` (3).

**`pnpm audit` after the fixes:** 2 high (`braces`, `node-forge`) and 3 moderate.
All are in Expo/Metro/Jest dev tooling, with no patched versions for the two highs
(SA-23).

**Deployment checklist these fixes add** (each fails closed if left unset):
- set `APP_ENV` explicitly;
- set `TURNSTILE_SECRET` (staging and production refuse to boot without it);
- set `TRUST_PROXY_HOPS` to the number of proxies in front of the API (Render: 1);
- set `SENTRY_DSN` and `EXPO_PUBLIC_SENTRY_DSN`, plus `EXPO_PUBLIC_TURNSTILE_SITE_KEY`
  for the web build.

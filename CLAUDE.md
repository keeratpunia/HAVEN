# CLAUDE.md — HAVEN Engineering Rules

This file is the permanent engineering constitution for the HAVEN project. It applies to
every contributor — human or AI — for the life of the prototype. It does not expire at the
end of a milestone.

The authoritative product specification is **`docs/HAVEN — Software Design Document
v3.pdf`** ("the SDD"). Section numbers below (e.g. "SDD §9.1") refer to it.

## 1. Source of truth and drift control

1. The SDD is the source of truth for product behaviour, business rules, flows, states,
   API contracts, security requirements, UI requirements, testing requirements and
   deployment requirements (SDD §0, Document control).
2. **Never invent product behaviour the SDD already specifies.** If the SDD states a
   format, constant, threshold, copy string, error code or flow step, use it verbatim. Do
   not "improve", simplify, or substitute a more conventional pattern.
3. **Never silently change, simplify, remove, or reinterpret a requirement.** If an
   implementation must diverge from the SDD (a bug in the spec, an impossibility, a
   platform limitation), the divergence MUST be:
   - flagged explicitly in the PR description,
   - recorded in `docs/DECISIONS.md` with the reasoning, and
   - reflected back into the SDD text or an explicit addendum in the same PR, so code
     and document never silently drift (SDD §0: "If code and this document disagree,
     fix one of them in the same pull request; never let them drift.").
4. If the SDD is ambiguous or silent on something needed to implement a feature, **stop
   and surface the ambiguity** (in the PR, in `docs/DECISIONS.md`, or by asking) rather
   than silently picking an interpretation. Exception: the SDD's own §23 "Open
   questions" already ships a working default for each listed question — use that
   default unless the warden/team overrides it, and record the override in
   `docs/DECISIONS.md`.
5. Requirement IDs (`FR-xx`, `NFR-xx`, `BR-xx`, `E-xx`, `TC-xx`) are mandatory in commit
   messages and PR titles whenever a change implements, fixes, or tests one (SDD §0).
   Keep `docs/TRACEABILITY.md` up to date in the same PR that adds or changes an
   implementation or test for a requirement.

## 2. RFC 2119 and document conventions (carried over from the SDD)

- MUST / MUST NOT / SHOULD / MAY follow RFC 2119 meanings. MUST is non-negotiable for
  the prototype.
- Times are IST (Asia/Kolkata) unless written as UTC. **The database stores everything
  in UTC.** Business-time comparisons convert `now()` to the hostel timezone with
  `luxon` before comparing against config times.
- Money is integer rupees (₹). No paise, no floats, anywhere — database, API, or UI.
- "Guest" and "visitor" mean the same person. UI copy always says **Guest**. Code always
  uses `visitor`.
- "Host" means the resident the guest is visiting. Code uses `host_id`, pointing to a
  resident user.
- Phone numbers are stored in E.164 format, Indian mobiles only: `+91` followed by 10
  digits starting 6–9.

## 3. Non-negotiable architectural rules

These are the load-bearing decisions from SDD §2.7 and §8. Do not re-litigate them
without a recorded decision in `docs/DECISIONS.md` and team sign-off:

1. **Clients never touch the database directly.** All data access goes through the
   Fastify API. Supabase's auto-generated REST API must never expose the `haven`
   schema (SDD §11.7, D7).
2. **Modular monolith, not microservices.** One Fastify API service, one Supabase
   project, one Expo codebase for Android + web (D11, D6).
3. **Rules are data, not code.** All hostel rules live in a versioned JSON config
   (`hostel_rules.config`) evaluated by one pure function shared by API and app
   (`packages/shared/src/rules/`). Changing a rule must never require a deploy (SDD §4).
4. **The rules engine has no I/O and no implicit clock.** No `Date.now()` inside; time
   is always passed in via an injected `Clock`. This is what makes `evaluateCreate`,
   `evaluateEntry`, `evaluateExit` unit-testable with plain objects (SDD §4.4, §19.3).
5. **Notifications only go out through the outbox.** Producers (API services, SQL jobs)
   only `INSERT` into `notifications`. Nothing calls Expo Push or an SMS provider
   inside a request handler (SDD §9.7, D10).
6. **The server clock decides everything.** Business-time and token-age comparisons
   never trust the client's clock (SDD §9.13, E-02).
7. **No file pickers, ever, in guest or host-assisted photo capture.** Live camera only
   (`getUserMedia` / `expo-camera`). This is a product and security requirement, not a
   UX nicety (SDD §9.4, D4).
8. **No receptionist verification.** The gate device shows only a QR and no personal
   data. The human check is the host's live-photo comparison, not a receptionist
   (SDD §0, "What changed from v2").
9. **Visit state changes are a single state machine**, implemented as one transition
   map in `apps/api/src/visits/stateMachine.ts`. Any transition not in SDD §7.1 MUST be
   rejected with `409 INVALID_TRANSITION`.
10. **Authorization is centralised.** Every API handler MUST call
    `authorize(principal, action, resource)` from `apps/api/src/auth/policy.ts`. No
    inline role checks anywhere (SDD §3.4).
11. **No deletes of business rows.** Residents become `left`, bans are lifted not
    deleted, visits are never deleted. Only retention jobs remove or anonymise personal
    data per the schedule in SDD §16.5.

## 4. Security and privacy rules (non-negotiable)

HAVEN processes personal data under the DPDP Act, 2023 (India). The governing principle
from SDD §16: **collect the least, show it to the fewest, keep it the shortest, log who
looked.** The full checklist below mirrors SDD §16.4's table — every row there is a
build requirement, not a suggestion; none of it is optional for the prototype because
`NFR-07` requires it all "in place before real data is loaded."

**Data and access handling:**
- Office staff responses MUST strip `visitor.phone` and all photo URLs (serializer-level,
  tested in `TC-SEC-03`).
- Photos: max 3 MB, JPEG/PNG magic-byte checked, EXIF stripped, resized to max 720px,
  SHA-256 deduped per visitor, served only via 120-second signed URLs — never public
  paths.
- Gate tokens, pairing codes, refresh tokens, gate device tokens: always stored as
  hashes (SHA-256) or encrypted (AES-256-GCM for gate secrets), never in plaintext in
  the database.
- Logs: Pino with redaction of `authorization`, `cookie`, `phone`, `code`, `idToken`,
  `token`, `secret`, and photo paths. Phones are logged masked only.
- Audit log (`audit_log`) must never contain raw PII — enforced by the `audit_row()`
  trigger's strip-list (SDD §11.6). Do not widen what the trigger logs without updating
  the strip-list in the same change.
- **Reads of sensitive data are audited too, not only writes.** Viewing a visit detail
  with photos, the emergency roll-call list, and CSV exports MUST each write an
  `audit_log` row (`action = 'read.*'`) from the handler — this does not happen
  automatically via a trigger the way mutations do, so it is easy to silently skip.
  This is the specific mitigation for staff-misuse risk (threat T15); do not treat
  mutation-auditing alone as satisfying SDD §16.4's "Audit of reads" row.
- Every mutating service call runs inside one transaction that writes the state change,
  the audit row (via trigger), any `gate_events` row, and any `notifications` rows.
  Notifications are only ever sent **after commit**, by the worker — a rolled-back
  change must never notify anyone (SDD §8.2).
- Retention and deletion jobs (SDD §16.5, §16.6) are mandatory, not optional cleanup —
  treat `job_retention()` and account deletion as first-class features with tests.

**Transport, headers, and request handling (SDD §16.4):**
- HTTPS only, HSTS (`max-age=31536000`), TLS 1.2+.
- `@fastify/helmet`: CSP on the web app (no inline scripts except hashed),
  `connect-src` limited to the API domain, `frame-ancestors 'none'`,
  `X-Content-Type-Options`.
- CORS: allow only `https://app.<domain>` (plus `localhost` in dev), `credentials: true`
  — never a wildcard origin, even temporarily for debugging.
- Cookies: `haven_rt` is `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/v1/auth`,
  `Domain=.<domain>`.
- Input: Zod on every body/param/query; max body 3 MB for uploads, 64 KB otherwise.
- Output: role-based serializers only; **no stack traces in any response**, ever,
  including in non-production environments reachable over a network.
- SQL: Kysely parameterised queries only — no string-built SQL anywhere, no exceptions.
- OTP requests (`POST /auth/otp/request`) are gated behind Cloudflare Turnstile after 3
  requests from one IP, in addition to the per-phone/per-IP rate limits in SDD §12.11 —
  rate limiting alone is not the complete control.
- Mock-location detection: the native host-assisted-entry path MUST check
  `location.mocked === true` (Android) client-side and refuse before calling the API
  ("Turn off fake location apps"); the server mirrors this with `MOCK_LOCATION` (403).

**Operational security:**
- Encryption at rest: Supabase disk encryption, plus AES-256-GCM specifically for gate
  secrets (not covered by disk encryption alone, since they're read into app memory).
- Dependencies: Renovate or Dependabot weekly; `pnpm audit` in CI fails on high
  severity.
- Access to production: **two people maximum** hold Supabase owner access; MFA
  required on GitHub, Supabase, Render, Vercel, and Google Cloud. This is a people/
  process control, not a code change — track it as a Week 0 checklist item, not
  something that falls out of the code being correct.
- No secrets in the app bundle; Google client IDs are public by design; certificate
  pinning is explicitly not used in the prototype (a stated, accepted limitation, not
  an oversight).

## 5. Technology stack (pin, don't improvise)

Per SDD §8.4 — exact versions pinned in lockfiles at project start, upgraded only in
dedicated PRs:

TypeScript (strict, everywhere) · pnpm workspaces + Turborepo · Expo (Router, RN, RN
Web) · Fastify · Zod (+ `fastify-type-provider-zod`) · Kysely + `pg` (+ `kysely-codegen`)
· Supabase CLI SQL migrations · `jose` (HS256 JWT) · `sharp` · `luxon` · `pino` + Sentry ·
TanStack Query · React Hook Form + Zod resolver · `expo-camera` / `getUserMedia` +
`@zxing/browser` · `expo-location` / `navigator.geolocation` · `expo-notifications` +
`expo-server-sdk` · Google Identity Services / `@react-native-google-signin/google-signin`
· `qrcode` · Vitest, Supertest, Playwright, (optional) Maestro.

Do not introduce an alternative to any of the above (a different ORM, a different
validation library, a different push provider) without a recorded decision.

## 6. Working conventions

- Branches: short-lived from `main`, named `feat/FR-25-room-search`,
  `fix/E-05-cutoff-time`. Rebase, don't merge `main` in.
- Commits: Conventional Commits, referencing requirement IDs
  (`feat(gate): verify token age`, `fix(rules): judge cutoff at scan time`).
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, no `any`, no non-null
  `!` without a comment explaining why it's safe.
- Naming: DB `snake_case`; API JSON `camelCase`; files `kebab-case.ts` except React
  components `PascalCase.tsx`; constants `SCREAMING_SNAKE`.
- Migrations: one change per file, never edited after merge, reviewed by a second
  person, backward-compatible with the previous API version.
- Secrets: never in code, issues, screenshots, or chat. Rotate the same day if one
  leaks.
- Definition of done for a PR: see `docs/DEVELOPMENT.md` (mirrors SDD §21.3 verbatim).

## 7. How to use the other engineering documents

| Document | Purpose |
|---|---|
| `docs/ARCHITECTURE.md` | System architecture derived from the SDD: components, data flow, deployment, environments. |
| `docs/IMPLEMENTATION-PLAN.md` | Milestone breakdown and dependency order for the build. |
| `docs/TRACEABILITY.md` | Live mapping of every FR/NFR/BR/E/TC id to its implementation and tests. Update in the same PR as the code. |
| `docs/DECISIONS.md` | Record of decisions explicitly specified by the SDD, plus any new decisions made during the build with their rationale. |
| `docs/DEVELOPMENT.md` | Local dev setup, testing workflow, CI/CD, definition of done. |

**Do not build application code before the SDD has been read in full by whoever is
implementing a given section.** SDD §0 tells each role which sections are load-bearing
for them:

- Product and rules: §1–5 (everyone, first).
- Flows and states: §6–7 (source of truth for behaviour).
- Backend developers: §8–12 and §16–18.
- App developers: §6, 12, 13, 14, 15.
- Everyone, before the first commit: §20.

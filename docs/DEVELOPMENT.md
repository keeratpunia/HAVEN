# HAVEN — Development Guide

How to get a local environment running, how to test, how to ship, and what "done"
means for a pull request. This mirrors SDD §19–21 — where this document and the SDD
overlap, the SDD's constants and exact commands are authoritative; this document adds
the narrative and checklist form.

## 1. Prerequisites

- Node 22 LTS (see `docs/DECISIONS.md` DEC-003 if your machine can't easily get Node 22
  — the bootstrap build itself ran on Node 24.4.1 for lack of a version manager in that
  environment; a real dev machine should use nvm/fnm and install 22)
- pnpm (`npm install -g pnpm@9` works if corepack isn't available; this repo pins
  `packageManager: pnpm@9.15.9`)
- Docker Desktop (for local Supabase) — must actually be **running**, not just
  installed; `docker ps` should return without error before `supabase start` will work
- Supabase CLI (no install needed — `npx supabase@latest <command>` works directly)
- Android Studio (emulator) — only needed for native app work
- Expo CLI (via `npx`, no global install needed)

## 2. First-time local setup (SDD §20.4)

Target: clone to a working local gate check-in in under an hour.

1. `git clone` the repo, then `pnpm install`.
2. `supabase start` (brings up local Postgres + Storage), then `supabase db reset`
   (applies all migrations in `supabase/migrations/`). The `haven_api` role is created
   **by the first migration itself** — you don't create it separately — with a
   literal local-dev-only password (`haven_api_local_dev_only`); see
   `docs/DECISIONS.md` DEC-004 item 3 for why, and rotate it via `ALTER ROLE
   haven_api WITH PASSWORD '<secret>'` before this ever touches staging/production.
3. `cp .env.example apps/api/.env` and fill in local values. Generate secrets with
   `openssl rand -base64 32` (used for `JWT_SECRET`, `OTP_PEPPER`,
   `DATA_ENCRYPTION_KEY`). `DATA_ENCRYPTION_KEY` and `SEED_SUPER_ADMIN_EMAIL`/
   `SEED_WARDEN_EMAIL` are required by the seed script specifically (step 4) — the API
   server itself doesn't need them to boot (`docs/ARCHITECTURE.md`/`apps/api/src/config.ts`
   only validate what `server.ts` actually uses).
4. `pnpm --filter api seed` to load GH-8, a gate, rules v1, seed staff invites, and
   (local/staging only) fake rooms/residents/visitors/visits/a gate device. Safe to run
   more than once — it's idempotent (SDD §11.9; verified by running it three times in a
   row during the database-foundation milestone, see `docs/DECISIONS.md` DEC-004 item
   6). `pnpm --filter api db:types` (regenerating real Kysely types from the schema via
   `kysely-codegen`) is **not wired up yet** — `apps/api/src/db/index.ts`'s `Database`
   interface is still an empty placeholder; this is deferred to the milestone that
   first writes a typed query (DEC-004 item 9), not an oversight.
5. `pnpm dev` — Turborepo runs the API on `:8080` and Expo on `:8081`.
6. **Web / gate testing:** open `http://localhost:8081/gate`, pair with the code the
   seed script printed. Open the printed invite URL in a second browser profile with
   geolocation overridden to the seeded gate coordinates (Chrome DevTools → Sensors).
7. **Android testing:** `pnpm --filter mobile android` with an emulator running; set
   the emulator's location to the gate.
8. **Phone-on-LAN testing:** camera and geolocation require HTTPS. Use
   `expo start --tunnel`, or a tunnel such as Cloudflare Tunnel for the web build.

### 2a. What actually works today (verified 2026-10-01, through the database-foundation milestone)

The bootstrap milestone left two gaps: `supabase/migrations/` was empty, and local
Supabase (Docker) could not be started in that session's sandbox. The
database-foundation milestone closed the first gap completely (the full SDD §11 schema
now exists and is migrated/tested) but **could still not get a working local Docker
Supabase stack in this environment** — this time traced to the sandbox's `C:` drive
having almost no free space, which starved Docker Desktop's backend even after the
disk was cleared and Docker was relaunched twice. See `docs/DECISIONS.md` DEC-004 for
the full account, including why this doesn't change the documented workflow below.

Because of that, migrations/seed/tests were validated against a real (non-Docker)
Postgres 18.4 server via the `embedded-postgres` npm package — genuine PostgreSQL
binaries, not a mock — as a one-off validation substitute, **not** a change to this
project's local-dev tooling. The command sequence below is what a developer with a
working Docker Desktop actually runs; it is believed correct because the same SQL and
the same seed script were proven to work against a real Postgres server by this exact
sequence (with `npx supabase start`/`supabase db reset` swapped for the embedded-postgres
equivalent — recreate database, apply each file in `supabase/migrations/` in order):

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm build

npx supabase start          # brings up local Postgres + Storage (needs Docker running)
npx supabase db reset       # applies supabase/migrations/*.sql to a fresh database

cp .env.example apps/api/.env
# fill in DATABASE_URL (the pooler URL supabase start prints), DATA_ENCRYPTION_KEY
# (openssl rand -base64 32), SEED_SUPER_ADMIN_EMAIL, SEED_WARDEN_EMAIL
pnpm --filter api seed      # idempotent — safe to run again
pnpm --filter api seed      # confirm it really is: row counts must not change
```

**Known gap, not silently assumed away:** the `pg_cron` extension and `pg_cron`-backed
job scheduling, and the real Supabase `storage.buckets` rows, were never exercised
against genuine Supabase infrastructure in this environment — both migrations
guard against their absence and were only proven to *no-op safely* without them
(`supabase/migrations/20261001000001_init.sql`, `20261001000002_storage_buckets.sql`;
`docs/DECISIONS.md` DEC-004 items 1–2). **Whoever next has a working Docker Desktop
should run `npx supabase start` + `npx supabase db reset`, confirm both migrations take
their non-guarded branch (the `pg_cron` extension installs, the 7 `cron.schedule()`
calls succeed, 3 buckets appear in `storage.buckets`), then run `pnpm --filter api
seed` and `supabase test db` (the real pgTAP run, not the ad hoc validation this
session used) — that closes this gap rather than carrying it forward silently.**

## 3. Repository layout

See `docs/ARCHITECTURE.md` for the component map and SDD §20.1 for the full annotated
tree. Two rules that apply everywhere in `apps/api/src/<feature>/`:

- **`routes.ts`** does Fastify route registration and Zod validation only — it may
  import `service` and `policy`. It never touches the database.
- **`service.ts`** holds business logic and opens transactions with
  `withTx(ctx, fn)` (which also sets the audit settings). It may import `repo`, the
  rules engine, other services' public functions, and the notify producer.
- **`repo.ts`** is Kysely queries only — no business rules, only `db`.
- **`policy.ts`** holds this feature's `authorize()` cases.
- **`*.test.ts`** can import anything.

Platform-specific client code uses Expo's file-suffix convention:
`camera.native.ts` / `camera.web.ts` export the same interface.

## 4. Environment variables

Full list with formats and notes: SDD §20.3. Two rules:

- API env vars are validated by `apps/api/src/config.ts` with Zod — **missing required
  vars stop boot**, by design. Don't add a var that silently defaults in production.
- App env vars (`EXPO_PUBLIC_*`) are public by design — never put a server secret in
  one.

## 5. Testing workflow

### 5.1 Levels (SDD §19.1)

| Level | Tool | Scope | Runs |
|---|---|---|---|
| Unit | Vitest | Rules engine, token generate/verify, haversine, nights/quota maths, serializers, copy mapping | Every push (CI) |
| Integration | Vitest + Supertest against local Supabase (Docker) | Every API endpoint: happy path, each error code, authorization | Every push (CI) |
| Database | pgTAP via `supabase test db` | Constraints, triggers (append-only, audit PII stripping), jobs | Every push (CI) |
| End-to-end (web) | Playwright, mobile viewport, fake geolocation + fake camera (`--use-fake-device-for-media-stream`) | Guest flows F1, F2, F3, F5; gate page | On PR to `main` |
| End-to-end (app) | Maestro on an Android emulator (optional) | Resident invite, approve walk-in, dispute | Before each release |
| Field | Real phones at the GH-8 gate | GPS calibration, timings, push delivery | Week 5 and before pilot |
| Acceptance | Warden + 5 residents + 5 guests | Scripted scenarios (SDD §19.6) | Before pilot |

### 5.2 Required test cases

Every M-priority requirement has at least one case in SDD §19.2, IDed `TC-RULE-xx`,
`TC-TOK-xx`, `TC-GEO-xx`, `TC-FLOW-xx`, `TC-JOB-xx`, `TC-SEC-xx`. **Use the ID in the
test name**, e.g.:

```ts
it('TC-RULE-03 day guest at 20:00 is denied', () => { ... })
```

`docs/TRACEABILITY.md` is the live map from requirement to implementation to test —
update it in the same PR.

### 5.3 Test data and clock control (SDD §19.3)

- Every service takes time from an injected `Clock`
  (`apps/api/src/lib/clock.ts`); tests use `FakeClock`. Never call `Date.now()`
  directly inside anything that's supposed to be deterministic in tests — this is the
  same rule that makes the rules engine pure (`CLAUDE.md` §3.4).
- SQL jobs take an optional `p_now timestamptz default now()` parameter so pgTAP
  tests can pass fixed times.
- Factories in `apps/api/test/factories.ts` create hostels, residents, visitors, and
  visits in any state with one call — use them instead of hand-rolling fixtures.
- Test phones `+919999900001`–`09` accept OTP `123456` in non-production
  environments only (`SMS_PROVIDER=console` prints real codes to the API log for
  everything else).

### 5.4 GPS field calibration (SDD §19.4)

Do this **before** setting the gate radius, and start it during M2 (week 3), not later.
**This specific timing is an engineering scheduling decision, not an undisputed SDD
instruction** — SDD §21.1's milestone-content table lists "GPS calibration 19.4" under
M4 (weeks 7–8), while SDD §21.4's schedule-risk table explicitly says "Calibrate in
week 3, not week 8." These two parts of the SDD contradict each other. This project
follows §21.4; see `docs/DECISIONS.md` DEC-001 for the full reasoning. If you're
auditing this document against the SDD and only read §21.1, the M2 start will look
unjustified — it isn't; it's justified by §21.4, and the contradiction itself is worth
resolving in the SDD text in a future revision.

1. Two team members, two Android phones, one iPhone if available.
2. At the gate: 10 fixes per phone via the gate page's location test tool
   (`/gate/calibrate`, staff only) — record accuracy and distance to the saved gate
   point.
3. Repeat at 15 m and 30 m outside the gate, and from inside the nearest ground-floor
   rooms and common room.
4. Choose `radius_m` as the smallest value where ≥95% of at-gate fixes pass; note how
   many inside-room fixes also pass. Record the result in SDD §23.3 **and**
   `docs/DECISIONS.md` Part 3, with the date.
5. Re-check after the first pilot week using `gate_events.distance_m` statistics.

### 5.5 Smoke test (before every production deploy, 5 minutes — SDD §19.5)

1. Gate page on a test device shows a changing QR and "Online".
2. Test guest: scan → check in to a seeded invite → green screen.
3. Test host phone receives N-ARRIVED with photo.
4. Warden dashboard shows the guest inside within 5 s.
5. Guest checks out; dashboard updates.

## 6. CI/CD (SDD §18.5, §20.5)

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | Every push and PR | install (cached) → lint → typecheck → unit tests → `supabase start` → migrations → pgTAP → integration tests → build API and web → Playwright (PR to `main` only) → `pnpm audit --audit-level high` |
| `deploy-staging.yml` | Merge to `main` | run migrations on staging → deploy API (Render deploy hook) → deploy web (Vercel) → smoke API `/ready` |
| `deploy-prod.yml` | Tag `v*` | manual approval → migrations on production → API → web → EAS build APK → attach to GitHub release |

Rules that apply to every deploy:
- Migrations run **before** the API deploys, and every migration must be
  backward-compatible with the previous API version (add columns first, remove
  later).
- No deploys between 17:00 and 22:00 IST on pilot days (peak visiting time).
- Android: the app checks `GET /v1/meta/min-app-version` on start and blocks with
  "Please update" if too old.

## 7. Working conventions (SDD §20.6, restated from `CLAUDE.md` for this doc's context)

- Branches: short-lived from `main`, named `feat/FR-25-room-search`,
  `fix/E-05-cutoff-time`. Rebase, don't merge `main` in.
- Commits: Conventional Commits, referencing requirement IDs.
- Pull requests: ≤400 changed lines where possible. PR description must state: what,
  why, requirement IDs, screenshots for UI changes, test evidence, migration notes.
  One approving review required; CI must be green; squash merge.
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`; no `any`; no non-null
  `!` without a comment.
- Style: ESLint + Prettier, enforced in CI and by a pre-commit hook (`lint-staged`).
- Naming: DB `snake_case`; API JSON `camelCase`; files `kebab-case.ts` except React
  components `PascalCase.tsx`; constants `SCREAMING_SNAKE`.
- Migrations: one change per migration file; never edit a merged migration; every
  migration reviewed by a second person.
- Feature flags: environment-variable flags in `config.ts` (e.g.
  `FEATURE_HOST_ASSISTED=true`) for anything not finished at release time.
- Secrets: never in code, issues, screenshots, or chat. Rotate the same day if one
  leaks.

## 8. Definition of done (per pull request) — SDD §21.3

A PR is not done until **all** of the following are true:

- [ ] Implements the referenced FR/BR/E IDs exactly as written in the SDD, **or** the
      SDD is updated in the same PR (`CLAUDE.md` §1.3).
- [ ] Unit/integration tests added; CI green; coverage targets (NFR-12) not reduced.
- [ ] Error codes and copy from SDD §12.2 and §13.6 used; no new user-facing strings
      outside `copy/en.ts`.
- [ ] Authorization checked with `authorize()`; a test proves another user can't
      access it.
- [ ] No PII in logs (checked against the redaction list in SDD §16.4).
- [ ] If this PR adds or touches a read of sensitive data (visit detail with photos,
      emergency roll-call, CSV/report exports), it writes an `audit_log` row
      (`action = 'read.*'`) — this is not automatic via a trigger the way mutations
      are (SDD §16.4 "Audit of reads"; `CLAUDE.md` §4).
- [ ] UI tested at 360×640 and with 200% text; loading, empty, and error states
      present.
- [ ] Migration (if any) is backward-compatible and reviewed by a second person.
- [ ] Demoed to one teammate on a real device for any gate or camera change.
- [ ] `docs/TRACEABILITY.md` updated for every FR/NFR/BR/E/TC touched by this PR.

## 9. Local health checks

- `GET /health` — 200 `{ ok: true, version }`, no DB call, for the load balancer.
- `GET /ready` — 200 only if the DB answers `select 1` within 1s **and** the worker
  loop ran in the last 30s.

## 10. Daily operations during the pilot (SDD §18)

One team member is "on duty" each day 08:00–22:30 and gets every alert. Alerting is
provided by **UptimeRobot** (free tier, polling `/ready` and
`https://app.<domain>/gate` every 1 minute, 2 consecutive failures triggers an alert)
and a **Sentry cron monitor** on the worker loop — provision both in Week 0 alongside
the Sentry error-tracking projects (SDD §18.2); they're easy to forget since they're
mentioned only in the observability section, not the deployment table. Daily health
query (run at 09:00, or as a saved Supabase SQL snippet) — see SDD §18.2 for the exact
SQL. Runbooks for common symptoms (gate clock drift, location failures, gate offline,
push not arriving, SMS not arriving, API down, DB connection errors, wrong rules
applied, warden locked out) are in SDD §18.3 — read them before the pilot starts, not
during an incident.

Paper fallback: the paper register stays at the gate during the pilot. If HAVEN is down
for more than 15 minutes, the receptionist uses it; there is no backfill feature in the
prototype.

# HAVEN — Decisions Log

This log records architectural and product decisions. Entries in **Part 1** are decisions
already made by the SDD itself (SDD §2.7, "Key design decisions") — they are recorded
here verbatim for visibility, not re-derived or second-guessed. **Part 2** is empty at
project start and only grows when a *new* decision is made during the build — i.e. a
case where the SDD was ambiguous, silent, or had to be reconciled with reality (per
`CLAUDE.md` §1.3–1.4). Do not add a Part 2 entry to restate something already decided
in the SDD.

Format for every entry: **ID · Decision · Alternatives rejected · Why · Source**.

## Part 1 — Decisions already made by the SDD (§2.7)

| ID | Decision | Alternatives rejected | Why |
|---|---|---|---|
| D1 | Guest scans a rotating QR shown at the gate | Guard scans guest's pass | Receptionists won't participate |
| D2 | QR rotates every 10s; token accepted up to 30s old | 15s single-use token | Single-use blocks groups arriving together; 30s covers a permission prompt |
| D3 | GPS geofence check on every scan | No location check | Stops a QR forwarded to someone off-site |
| D4 | Live in-app photo sent to host on every check-in | Automated face match | Host knows their guest; face matching is costly and error-prone |
| D5 | Guest flows in the browser, no install | Native app for guests | One-time guests won't install apps |
| D6 | Resident, warden, office use one Expo (React Native) app, also built for web | PWA only | Reliable push notifications are critical (no intercom) |
| D7 | All data access through our API; clients never query the database directly | Supabase client + RLS from the app | One auth system, simpler to secure and audit |
| D8 | Google Sign-In for residents and staff; phone OTP for guests | Email OTP; college email | No college email; Gmail is universal and free |
| D9 | Warden verifies every resident from ID-card photo | Import roster | No roster available |
| D10 | Notifications through a database outbox + worker | Send directly in request | Jobs in the database can't send push; retries and audit come free |
| D11 | Modular monolith API (one service) | Microservices | Tens of visits a day; fewer moving parts |

Source for all of Part 1: SDD §2.7.

### Related constraints that shape these decisions (SDD §2.5, not separately numbered)

- No receptionist verification — receptionists' phones are QR displays only.
- No college email — residents verify via Google + phone OTP.
- No resident roster — residents self-register, warden verifies each.
- No intercom at the gate — all host contact is through app or SMS.
- No budget beyond free tiers, SMS costs, and possibly one spare Android phone.
- Guests must not need to install an app — guest flows run in the mobile browser.
- Data is personal data under the DPDP Act — collect the minimum, protect it (§16).

## Part 2 — Decisions made during the build

### DEC-001 — GPS field calibration scheduled to start in M2 (week 3), not M4

- **Date:** 2026-10-01
- **Context:** The SDD contradicts itself on when GPS field calibration (§19.4) happens.
  - SDD §21.1's milestone-content table lists "GPS calibration 19.4" as content of
    **M4 — Ship** (weeks 7–8): *"FR-14–16, FR-54–59, FR-06, FR-29, FR-75; F4, F6;
    charges; emergency roll call; security checklist 16.4; retention; **GPS
    calibration 19.4**; acceptance 19.6."*
  - SDD §21.4's schedule-risk table says the opposite: *"GPS unusable at the gate |
    Many host-confirm fallbacks | **Calibrate in week 3, not week 8**; widen radius;
    rely on live photo."* Week 3 is M2; week 8 is M4. These two sections of the SDD
    cannot both be followed literally.
  - This is a **genuine SDD self-contradiction**, not an open question with a stated
    default and not a case of planning-document drift — both passages are prescriptive
    schedule statements that conflict.
- **Decision:** `docs/IMPLEMENTATION-PLAN.md` and `docs/DEVELOPMENT.md` follow §21.4's
  explicit risk-mitigation instruction and begin GPS field calibration during M2
  (week 3), continuing through M3/M4 as needed, rather than waiting for M4 as §21.1's
  milestone-content line implies.
- **Alternatives considered:** Follow §21.1 literally and defer calibration to M4.
  Rejected because §21.4 names the exact failure mode this would risk (GPS
  unreliability discovered too late to fix before the pilot) and gives an explicit,
  dated instruction to avoid it — §21.1's content line reads as a less deliberate,
  summary-table placement by comparison.
- **Why:** Starting calibration early is reversible and low-cost if it turns out to be
  unnecessary; discovering at week 7 that the chosen gate radius doesn't work is not
  reversible without consuming M4's already-thin schedule slack.
- **SDD updated?** No — this document may not modify the SDD (out of scope for the
  review that produced this entry). The contradiction between §21.1 and §21.4 should be
  reconciled in the SDD text itself in a future authorized revision; until then, this
  entry is the record of which instruction the build actually follows and why.

### DEC-002 — FR-08, FR-09, FR-74, and flow F4 placement fills gaps in SDD §21.1's own milestone table

- **Date:** 2026-10-01
- **Context:** SDD §21.1's milestone-content table does not mention FR-08, FR-09, or
  FR-74 in any milestone row, and assigns flow F4 (host-assisted entry) to M4
  ("F4, F6"), not M3. An earlier draft of `docs/IMPLEMENTATION-PLAN.md` had F4 as an M3
  task and left FR-08/FR-09/FR-74 unscheduled entirely — inheriting the SDD table's own
  gaps rather than closing them, and in F4's case placing it one milestone earlier than
  the SDD specifies.
- **Decision:** `docs/IMPLEMENTATION-PLAN.md` now explicitly schedules: FR-74 (audit
  log) in M1, alongside the audit trigger work the SDD's own M1 row already lists;
  FR-08 (profile edit) and FR-09 (account deletion request) in M4; and moves the F4
  (host-assisted entry) task from M3 to M4, matching SDD §21.1 exactly, with the
  existing M2-stretch-goal framing for FR-28 preserved.
- **Alternatives considered:** Leave the three FR ids unscheduled, matching the SDD's
  own table. Rejected because this implementation plan's stated purpose is to be more
  complete than the SDD's high-level summary table, and every M/S-priority FR needs an
  unambiguous build slot for the traceability matrix to be meaningful.
- **Why:** These are not new requirements — all four items (FR-08, FR-09, FR-74, F4)
  are already specified in full elsewhere in the SDD (§5.1, §5.6, §6 F4). This decision
  only assigns them a milestone; it does not alter their content.
- **SDD updated?** No — §21.1's table is not edited by this pass; this entry records
  where this project's own plan diverges from (FR-08/09/74) or corrects itself to match
  (F4) that table, and why.

### DEC-003 — Bootstrap milestone: exact dependency versions and environment choices

- **Date:** 2026-10-01
- **Context:** The SDD names technologies (SDD §8.4) but doesn't pin exact versions
  for most of them ("Pin exact versions in lockfiles at project start" — SDD §8.4,
  `CLAUDE.md` §5). Bootstrapping the repo required picking real, installable versions.
  Two of those choices were revised mid-bootstrap after `pnpm audit --audit-level high`
  found real high-severity advisories in the first picks.
- **Decisions:**
  - **Node runtime:** this build environment has only Node **24.4.1** available (no
    nvm/fnm, no admin rights to install another major version). The SDD specifies
    Node 22 LTS. `.node-version` (22) and `package.json`'s `engines` field
    (`>=22 <25`) record the intended version for real developer machines; this
    bootstrap's actual install/typecheck/lint/test/build/server-start validation ran
    on Node 24.4.1 because that's what was available. No code depends on a
    Node-24-only API — this is a stated environment gap, not a silent substitution.
    **Action for the team:** install Node 22 LTS via nvm/fnm on real dev machines and
    in CI (the CI workflow already pins `node-version: "22"`).
  - **pnpm 9.15.9** — installed via `npm install -g pnpm@9` (corepack's `enable` failed
    with an `EPERM` on this machine's `Program Files` install, likely a permissions
    quirk of this sandbox; `npm install -g` was the working fallback). Pinned via
    `packageManager` in the root `package.json`.
  - **Turborepo ^2.1.3** (resolved 2.11.6), **ESLint ^9.12.0 flat config** (`eslint.config.mjs`,
    not the legacy `.eslintrc`), **Prettier ^3.3.3**, **TypeScript** resolved to 5.9.3
    workspace-wide — all satisfy the SDD's named tools without a pinned version, so the
    newest stable release at bootstrap time was chosen.
  - **Fastify ^5.0.0** — the current stable major at bootstrap time; SDD §8.4 names
    Fastify without a major version.
  - **Kysely: bumped from the initial `^0.27.4` pick to `^0.29.6`.** `pnpm audit
    --audit-level high` found three high-severity advisories in kysely 0.27.x–0.28.x
    (SQL injection via unsanitized JSON path keys, MySQL backslash-escaping injection,
    JSON-path traversal injection — GHSA-wmrf-hv6w-mr66, GHSA-8cpq-38p9-67gx,
    GHSA-pv5w-4p9q-p3v2), all patched by 0.28.17+. Bumped to the latest release to clear
    all three with margin.
  - **Vitest: bumped from `^2.1.2` to `^5.0.3`, with an explicit `vite ^8.3.1`
    devDependency added.** The audit found a high-severity `vite` advisory
    (`server.fs.deny` bypass on Windows, GHSA-fx2h-pf6j-xcff, patched ≥6.4.3) pulled in
    transitively by vitest 2.x's vite 5.4.21 dependency. Vitest 5's peer range
    (`^6 || ^7 || ^8`) doesn't accept vite 5 at all, so bumping vitest alone wasn't
    enough — pnpm kept resolving the old vite 5.4.21 until `vite` was added as an
    explicit devDependency to force the correct resolution. Re-verified: `pnpm audit
    --audit-level high` now reports 0 high/critical (2 moderate remain, in transitive
    `uuid`/`decode-uri-component` — not our direct dependencies, below the CI gate
    threshold, left as accepted residual risk).
  - **Expo SDK 57** (`expo ~57.0.26`), **expo-router ~57.0.24**, and the matching
    `react-native-safe-area-context`/`react-native-screens`/`expo-constants`/
    `@expo/metro-runtime`/`expo-linking` versions — all resolved via `npx expo install
    <package>`, Expo's own SDK-compatibility resolver, rather than hand-picked, since
    guessing compatible native-module versions by hand is exactly the class of mistake
    that resolver exists to prevent.
  - **jest-expo for mobile unit tests** (not Vitest). SDD §8.4/§19.1 name Vitest for
    the rules engine/API and Playwright/Maestro for E2E, but don't name a unit-test
    runner for React Native component/module code specifically. Vitest does not
    reliably run React Native's Metro/Haste-based module system; `jest-expo` is Expo's
    own maintained preset for exactly this, so it was chosen for `apps/mobile`'s `test`
    script. Vitest remains the runner for `apps/api`, `packages/shared`, `packages/ui`.
  - **`app.config.ts`, not `app.json`** — SDD §20.1 names `app.config.ts` explicitly in
    the repo layout; the Expo scaffolder's default `app.json` was converted.
  - **Supabase CLI 2.119.0**, invoked via `npx supabase@latest` (no global install) to
    run `supabase init`, which generated `supabase/config.toml`. Two deviations from
    the generated defaults: `db.pooler.enabled = true` (SDD §11.7: the API connects
    through the pooler in production — enabling it locally mirrors that), and
    `db.seed.enabled = false` (HAVEN seeds via a TypeScript script that encrypts gate
    secrets with `DATA_ENCRYPTION_KEY`, SDD §11.9 — a plain SQL seed file can't do
    that, so the CLI's automatic SQL-seed-on-reset is turned off in favour of the
    documented `supabase db reset` → `pnpm --filter api seed` two-step).
  - **Local Supabase could not actually be started in this build environment.**
    `npx supabase start` requires Docker; this sandbox has the `docker` CLI binary but
    **no running Docker daemon** (`failed to connect to the docker API at
    npipe:////./pipe/dockerDesktopLinuxEngine` — confirmed independently with
    `docker ps`). This is an environment limitation, not a defect in the scaffold —
    `supabase/config.toml` is valid and `supabase start` is expected to work on a real
    developer machine with Docker Desktop running. Because of this, `GET /ready`'s
    real-Postgres path (`pingDb` against a live pooler connection) could only be
    validated two ways in this session: (1) a unit test pointing at a deliberately
    unreachable port confirming `pingDb` degrades to `false` rather than throwing, and
    (2) the actual `node dist/server.js` process started and queried over real HTTP,
    returning a genuine `503 {"ok":false,"db":false,...}` against an unreachable
    `DATABASE_URL`. Validating the `200` path against a real local Postgres is carried
    forward as a stated open item for whoever next has Docker available (noted in the
    final bootstrap report, not silently assumed to already work).
- **Why:** every version choice above is either a direct response to a real,
  tool-reported problem (the audit findings) or a case where the SDD names the tool but
  not a version, in which case the newest stable release — or Expo's own compatibility
  resolver's choice — was used, consistent with `CLAUDE.md` §1.4's instruction to make
  such a judgment call and record it rather than leave it undocumented.
- **SDD updated?** No — none of this contradicts the SDD; it fills in version numbers
  the SDD deliberately left open (§8.4: "Pin exact versions in lockfiles at project
  start").

### DEC-004 — Database foundation milestone: schema deviations, environment workarounds, and seed-script design

- **Date:** 2026-10-01
- **Context:** Implementing and validating the SDD §11 schema end to end surfaced
  several places where the SQL as literally transcribed would not run outside a real
  Supabase project, plus this environment's own instability, plus genuine idempotency
  bugs found only by actually running the seed script repeatedly (as the task
  required). Recorded together since they all came out of the same validation pass.
- **Decisions:**
  1. **`pg_cron` extension creation and `cron.schedule()` calls are guarded**, not
     unconditional, in `supabase/migrations/20261001000001_init.sql`. `pg_cron` ships
     with Supabase's Postgres image but is not part of vanilla community Postgres —
     `create extension pg_cron` is a hard error (not a no-op) where it's unavailable.
     The guard checks `pg_available_extensions` first; on Supabase, behaviour is
     unchanged (the extension installs, the jobs schedule). The `haven.job_*`
     functions themselves are created unconditionally either way.
  2. **Storage bucket creation (`20261001000002_storage_buckets.sql`) is similarly
     guarded** on `information_schema.tables` for `storage.buckets`, since that table
     only exists on a real Supabase project.
  3. **`create role haven_api ... password :'api_password'` (SDD §11.7's literal text)
     was changed to a literal local-dev password with a rotation comment**, and wrapped
     in an `if not exists` guard. Two independent problems: `:'api_password'` is `psql`
     client-side variable syntax — it is a plain SQL syntax error through any other
     executor (Supabase CLI's migration runner, a `pg` client, etc.), so the migration
     as literally specified in the SDD cannot actually run outside manually piping it
     through `psql -v api_password=...`. Separately, Postgres roles are cluster-level,
     not database-level, so an unguarded `create role` would fail with "already exists"
     on every `supabase db reset` after the first. The literal local-dev password
     (`haven_api_local_dev_only`) is not a real secret — same category as the SDD's own
     `SMS_PROVIDER=console` / OTP `123456` local-only conveniences — and the migration
     comment instructs rotating it via `ALTER ROLE ... WITH PASSWORD` immediately after
     first running against staging/production, matching the SDD's own "password from
     the secrets manager" instruction.
  4. **This environment's Docker Desktop could not reliably run the real Supabase
     stack**, so `supabase/migrations/*.sql` and the seed script were validated against
     a real (non-Docker) local Postgres 18.4 server instead, using the `embedded-postgres`
     npm package (official PostgreSQL binaries, run directly as a child process — not a
     mock, not `pg-mem`). Root cause found this time: the `C:` drive had only ~100 MB
     free, which starved both Docker Desktop's backend (it never reached a working
     state even after two full relaunches) and `npm install` (`ENOSPC`). Clearing the
     npm cache (freed ~2 GB) and redirecting `npm`/`pnpm` caches to `D:` (26 GB free)
     fixed the disk problem but Docker's backend still did not come up reliably after
     multiple attempts; `embedded-postgres` was used instead so the actual validation
     work (apply migrations from empty, run pgTAP-equivalent assertions, run the seed
     script three times) could happen for real rather than being asserted untested.
     **This is a validation substitute for this session only** — it does not change
     the project's documented local-dev workflow, which remains `supabase start`
     (Docker) per `docs/DEVELOPMENT.md` §2; `pg_cron` and Supabase Storage genuinely
     aren't present in this substitute, which is exactly why items 1–2 above needed
     guards. A developer with a working Docker Desktop should re-run the same
     migrations and seed via `supabase start` and confirm the `pg_cron`/`storage`
     branches that this environment skipped.
  5. **`supabase/tests/*.sql` pgTAP files could not be executed by the pgTAP framework
     itself** (pgTAP is also a Supabase-bundled extension, absent from vanilla
     Postgres). Every assertion in those files was independently re-verified as plain
     SQL against the same embedded Postgres server (20 checks, all passing) before the
     `.sql` pgTAP files were considered correct — the pgTAP files are the source of
     truth and will run for real via `supabase test db` once Docker is available; the
     plain-SQL re-implementation was scratch validation tooling only, not committed to
     the repo.
  6. **Seed script idempotency bugs, found by actually running `pnpm seed` three times
     in a row (not by inspection):**
     - Visit rows used `generateVisitCode()` (genuinely random, matching what the real
       API will use for actual visits from M2 onward) as their `on conflict (code) do
       nothing` key. Random codes never collide, so every re-run tried to insert 30
       fresh `inside`-eligible rows and hit `visits_one_inside_per_visitor` on the
       second run. Fixed by giving seed visits a **deterministic** code
       (`VSEED01`–`VSEED30`, still matching the real check constraint's character
       class) instead — fixture data needs a stable natural key to upsert on; only
       real, API-created visits should get random codes.
     - The same seed run could assign **the same visitor to two different `inside`
       rows** (two different loop indices landing on the same `i % 15`), independently
       violating BR-15's partial unique index even within a single run. Fixed with a
       dedicated counter that only advances for `inside`-status seed rows, guaranteeing
       6 distinct visitors for the 6 seeded `inside` visits.
     - `gate_devices` seeding used a random `token_hash` (correct for a real device —
       pairing tokens must be unguessable) with `on conflict (token_hash) do nothing`,
       which — like the visit codes — never collides, so three runs produced three
       devices. Fixed by checking existence on `(gate_id, label)` instead of relying on
       the random column to conflict.
  7. **A fake, local/staging-only "warden" `users` row (`google_sub =
     'seed-fake-warden'`) is seeded** purely to satisfy FK constraints on fixture data
     (`residents.decided_by`, `gate_devices.paired_by`) that require a real `users.id`.
     This is distinct from the real `SEED_WARDEN_EMAIL` `staff_invites` row (SDD
     §12.1), which stays unaccepted until an actual person signs in with Google — no
     such flow exists yet (M1), so no real warden `users` row can exist yet either.
  8. **Seed-created `staff_invites` rows (super_admin, warden) use a 10-year
     `expires_at`.** The SDD specifies 48h expiry for invites a *warden* sends via
     FR-06, but is silent on the expiry for the two seed-created invites specifically,
     which (unlike FR-06 invites) have no inviter able to resend them if they lapse.
     10 years is a pragmatic "won't expire during the prototype's life" choice, not an
     SDD-specified value — flagged here per `CLAUDE.md` §1.4 rather than silently
     picked.
  9. **`apps/api/src/db/index.ts`'s `Database` interface stays an empty placeholder**
     — `kysely-codegen` (named in SDD §8.4/§20.4 as the way to generate it) was not run
     in this milestone. The task scope was schema/migrations/tests/seed, not API-layer
     wiring; generating real Kysely types is reasonable to do at the start of the
     milestone that first writes a typed query against this schema, not before.
- **Why:** each deviation is the minimum change needed to make the literal SDD text
  actually executable (1–3), to get genuine (not asserted) validation given this
  environment's constraints (4–5), or a real bug this milestone's own validation step
  caught before it could ship (6) — plus two small, disclosed fixture-data judgment
  calls (7–8) and one explicitly deferred piece of follow-on work (9).
- **SDD updated?** No. Items 1–3 are implementation necessities (the SDD's SQL as
  written doesn't run outside Supabase/`psql`), not product or architecture changes —
  worth a precision addendum to §11.7 in a future authorized SDD revision (the literal
  `:'api_password'` syntax specifically), but out of scope for this pass to edit. Items
  4–5 are about this session's environment, not the product. Items 6–9 add
  implementation detail the SDD never specified at this level (seed-script internals),
  so there is nothing in the SDD to update.

### DEC-005 — API foundation milestone: a real rate-limiting bug, a real log-redaction bug, and dependency/design choices

- **Date:** 2026-10-01
- **Context:** Building the SDD §8.2 request pipeline (request ID → rate limit → auth
  → validation → handler → authorize() → service → repository → serializer →
  response) as reusable infrastructure, with tests for each stage plus a manual
  build-and-boot smoke test. Two of the findings below are genuine bugs the testing
  itself caught — not stylistic choices — and are the most important entries here.
- **Decisions / findings:**
  1. **`@fastify/rate-limit` was silently non-functional until every `app.register()`
     call in `app.ts` was awaited.** Fastify's normal pattern lets you call
     `app.register(plugin)` without awaiting it, relying on avvio's internal boot
     ordering to still process everything correctly before `.ready()`/`.listen()`.
     Empirically, that did not hold for `@fastify/rate-limit` specifically: with an
     un-awaited `app.register(rateLimit, {...})` followed by synchronously-declared
     routes, the server booted normally, routes worked, but the global rate limit
     **never triggered — ever, for any number of requests** — with no error, no
     warning, nothing. This was caught by this milestone's own rate-limit test (which
     initially failed), root-caused by bisection (isolating plugin combinations until
     a minimal repro showed awaiting the registration alone fixes it — see the
     session's working notes; the repro is not part of the committed code), and fixed
     by making `buildApp` `async` and `await`ing every `app.register()` call before
     any route is declared. `server.ts` and every test call site were updated to
     `await buildApp(...)`. **This would have shipped as a silently-disabled security
     control** (SDD §12.11, and indirectly the OTP-abuse mitigation T10 which layers
     Turnstile *on top of* rate limiting) if the test suite hadn't specifically
     exercised exceeding the limit rather than just asserting the plugin was
     registered.
  2. **The PII log-redaction path list had a precision bug: a blanket `'*.code'`
     wildcard also matched `AppError.code`** (`'AUTH_REQUIRED'`, `'FORBIDDEN'`, etc.)
     wherever an error got logged, redacting our own safe, non-PII error-code enum
     from every error log line. Found by manually building and booting the real server
     (not by a unit test — the unit tests at the time only asserted PII *was*
     redacted, not that non-PII with a colliding field name *wasn't*) and reading its
     own `request failed with AppError` log line, which showed `"code": "[redacted]"`
     instead of `"code": "AUTH_REQUIRED"`. Fixed by replacing the blanket `'*.code'`
     with a precisely-scoped `'req.body.code'` (the one real place an OTP code will
     appear, SDD §9.5: `POST /v1/auth/otp/verify { phone, code, purpose }`) plus
     keeping `'*.otp'` for the case where a whole OTP object is logged under a named
     wrapper key. A regression test (`src/lib/logger.test.ts`, "does NOT redact
     AppError.code") now guards this specifically. General lesson applied here:
     redaction paths keyed on generic field names (`code`, `token`, `secret`, ...) are
     a recurring collision risk with legitimate non-PII fields that happen to share a
     name — worth a second look whenever a new redacted path is added in a future
     milestone, not just whether the intended PII is caught.
  3. **New dependencies:** `jose` (HS256 JWT, SDD §8.4 names it explicitly) and
     `fastify-type-provider-zod` (SDD §8.4: "Zod (+ `fastify-type-provider-zod`)"),
     both at their current stable major as of this milestone — the SDD names the
     libraries, not versions, consistent with DEC-003's approach to unpinned
     dependencies.
  4. **`JWT_SECRET` and `COOKIE_DOMAIN` added to `apps/api/src/config.ts`'s `EnvSchema`**
     — the server process now genuinely verifies tokens and will need the cookie
     domain once the auth module sets `haven_rt`. `OTP_PEPPER`, `DATA_ENCRYPTION_KEY`
     (server-side; the seed script validates it independently per DEC-004),
     `GOOGLE_CLIENT_IDS`, `SMS_PROVIDER`, and the rest remain deliberately unvalidated
     here until the milestone that makes the *server* use them, per this file's own
     stated principle (see the comment at the top of `config.ts`).
  5. **`authorize()` fails closed on an unregistered action**, not open. SDD §3.4 only
     says "every handler MUST call authorize()" — it doesn't say what an unregistered
     action should do, because in the finished system every action a handler calls
     will have a registered rule. During this foundation milestone, *no* actions are
     registered yet (no feature module exists), so "what happens if you call
     `authorize()` for something nobody defined" is a real, immediate question, not a
     hypothetical. Denying is the only safe default — the alternative (allow unknown
     actions) would mean a typo'd action string silently bypasses authorization
     entirely, which is a worse failure mode than an over-strict 403 during
     development.
  6. **Device-token (gate) authentication is recognized but not verified.** The
     `authenticate` hook matches the `Authorization: Device <token>` scheme (so the
     shape exists for `requireAuth`/`authorize()` callers to target) but always
     resolves to a `null` principal rather than querying `haven.gate_devices` —
     verifying it needs a typed Kysely query against that table, and `kysely-codegen`
     is deliberately not wired up yet (DEC-004 item 9). Building it now would mean
     either writing raw SQL (bypassing the typed-query convention CLAUDE.md requires)
     or doing the codegen work prematurely. Real device authentication is gate-module
     work (M2, `docs/IMPLEMENTATION-PLAN.md`).
  7. **`withTx`'s actor-context setter is dependency-injectable** (a 4th, optional
     parameter, defaulting to the real SQL-executing implementation) specifically so
     `src/lib/tx.test.ts` can unit-test the wrapper's control flow (ordering, result
     propagation, error propagation) without a live Postgres connection — the same
     pattern `BuildAppOptions.checkDb` already established in the bootstrap milestone.
     The underlying `set_config()` mechanism itself was proven against a real Postgres
     server by the database-foundation milestone's audit-trigger tests; this test
     proves the wrapper calls it correctly, not that Postgres honours `set_config`
     (already known).
- **Why:** items 1–2 are bugs this milestone's own testing (and, for item 2, a manual
  smoke test beyond the automated suite) caught before they could ship — recorded in
  detail because the *process* that caught them (a dedicated rate-limit test; actually
  booting the server and reading its logs rather than trusting unit tests alone) is
  worth remembering for later milestones, not just the fixes themselves. Items 3–7 are
  judgment calls the SDD leaves open at this level of detail, recorded per
  `CLAUDE.md` §1.4.
- **SDD updated?** No. Items 1–2 are implementation bugs with no SDD-visible
  consequence (the SDD's rate-limit and redaction *requirements* were always correct;
  the code didn't meet them, now it does). Items 3–7 fill in implementation detail the
  SDD doesn't specify at this granularity.

### DEC-006 — Rules engine milestone: a genuine SDD numeric contradiction (TOO_EARLY worked example vs. BR-20/config), plus interpretation decisions

- **Date:** 2026-10-01
- **Context:** Implementing `evaluateCreate`/`evaluateEntry`/`evaluateExit` exactly per
  SDD §4.4–4.6, with the SDD's own worked examples as test cases (§4.6: "each becomes
  a unit test").
- **Findings / decisions:**
  1. **Genuine SDD contradiction: the TOO_EARLY worked example's clock digits don't
     satisfy the SDD's own rule for that check.** SDD §4.5 step 6: *"TOO_EARLY — now <
     window_start − 30 min → deny."* SDD §4.3: `early_arrival_minutes: 30`. BR-20: "A
     guest may arrive up to 30 min before window_start." All three agree: 30 minutes.
     SDD §4.6's worked example: *"Arrives 14:25 for 15:00 window → allow"* / *"Arrives
     14:20 for 15:00 window → deny TOO_EARLY."* Arithmetic: 15:00 − 30 min = 14:30.
     Both 14:25 and 14:20 are before 14:30, so the literal rule denies **both** — but
     the example says 14:25 should be allowed. A threshold that makes both example
     rows correct would need to be ~35 minutes, which appears nowhere else in the SDD.
     **Decision:** implemented the engine to the 30-minute rule (three independent,
     mutually consistent citations) rather than reverse-engineering a 35-minute
     threshold from one two-point example, since CLAUDE.md §1.2 treats a stated
     constant (`early_arrival_minutes: 30`) as the kind of value to "use verbatim,"
     and three sources outweigh one. `src/rules/evaluate-entry.test.ts` keeps the
     14:20→deny case (consistent under either threshold) and replaces the 14:25 case
     with the true 30-minute boundary (14:30→allow), with the contradiction documented
     in-line in a code comment pointing back to this entry. **Not silently resolved**:
     flagged here exactly because CLAUDE.md §1.3 requires it, and because a future SDD
     revision should pick one number and fix the other three to match, not the other
     way around.
  2. **`guestGender: null` (not yet known, SDD §12.6: optional at invite creation) is
     treated the same as `'undisclosed'`** for both `TYPE_NOT_ALLOWED_FOR_GENDER` (N/A
     for day/quick_drop regardless) and zone computation (`visitors_room`, the more
     conservative default). The SDD states the real resolution explicitly — "zone is
     recomputed when the invite is claimed," i.e. the API calls `evaluateCreate` again
     once gender is known — so this default only governs the brief window between
     invite creation and claim, not a permanent misclassification. Documented in
     `src/rules/zone.ts`'s own doc comment, not just here.
  3. **`BR-06`'s "no overlapping windows" / `max_concurrent` interpreted as: deny if
     admitting the new request would push the count of mutually-overlapping active
     bookings past `max_concurrent`**, not "deny on any overlap unconditionally." With
     `max_concurrent: 1` (GH-8's only configured value) these are equivalent, but the
     config field's existence implies the SDD intends `max_concurrent` to be a real,
     independently-meaningful number for some future config, not a vestigial restating
     of BR-06's prose — the implementation honours that rather than hardcoding "any
     overlap denies."
  4. **The opposite-gender zone comes from `cfg.opposite_gender.zone`, not a hardcoded
     `'visitors_room'` literal** in `computeZone` — "Rules are data, not code"
     (CLAUDE.md §3.3) applies even though GH-8's only configured value today is
     `'visitors_room'`.
  5. **`nightsBetween`/`quotaUsed` are used internally by `evaluateCreate`'s
     QUOTA_EXCEEDED/OVERNIGHT_OVERLAP checks**, rather than requiring the API caller to
     pre-flatten existing bookings into a nights array. `CreateContext` instead carries
     `existingOvernightBookings: {arrivalDate, departureDate}[]` (the natural shape the
     API already has from querying `haven.visits`), keeping `nightsBetween`/`quotaUsed`
     genuinely reusable standalone functions (matching their literal SDD §4.4 export
     signatures) while avoiding making every caller re-derive nights by hand.
  6. **Branch coverage is measured, not assumed**: `@vitest/coverage-v8` added to
     `packages/shared`, scoped to `src/rules/**` with 100%
     branches/statements/functions/lines thresholds enforced by `vitest.config.ts`
     (SDD NFR-12: "Rules engine 100% branch coverage"). Verified at 100% across all
     four metrics — not just asserted.
- **Why:** item 1 is a real, documented SDD defect this implementation routes around
  rather than papering over silently; items 2–5 are judgment calls the SDD doesn't
  spell out at this level of implementation detail, recorded per CLAUDE.md §1.4; item 6
  is the task's own explicit instruction to verify coverage, not claim it.
- **SDD updated?** No — item 1 should be reconciled in the SDD text in a future
  authorized revision (pick 30 or ~35 minutes and make §4.3/§4.5/§4.6 agree); out of
  scope to edit the SDD in this pass. Items 2–5 fill in implementation detail the SDD
  doesn't specify, so there is nothing contradictory to update.

### DEC-007 — Authentication milestone: OTP visitor placeholder identity, Kysely typing, Google/SMS integration boundaries, and two transaction-rollback bugs found by integration tests

- **Date:** 2026-10-01
- **Context:** Implementing the complete authentication foundation (SDD §9.5, §9.6,
  §12.4/§12.5): guest phone OTP, resident/staff Google sign-in, access/refresh tokens,
  sessions, revocation, deactivation, invite phone/email matching, and
  `authorize()` integration for `/me`.
- **Findings / decisions:**
  1. **New visitor identity at OTP sign-in.** `haven.visitors.full_name`/`gender` are
     `NOT NULL`, but OTP verification only proves a phone number. The SDD says OTP
     verify "creates the visitor if new ... response includes `profileComplete`" but
     doesn't specify what a brand-new row should contain before the guest fills in a
     profile. **Decision:** create with placeholder `full_name = 'Guest'` and
     `gender = 'undisclosed'` (an existing `haven.gender` value, not a new one);
     `profileComplete` is exactly "the placeholder name has been replaced." `PATCH
     /me` is how a guest later sets the real values (`src/auth/visitor-service.ts`).
  2. **`Database` Kysely types are hand-written (`apps/api/src/db/types.ts`), not
     `kysely-codegen`-generated**, scoped to the tables this milestone's queries
     actually touch (`users`, `residents`, `role_assignments`, `staff_invites`,
     `visitors`, `otp_challenges`, `sessions`, `visits`, `hostels`, `rooms`). Mirrors
     DEC-004/DEC-005's Docker-unavailability finding: `kysely-codegen` needs a live DB
     to introspect, and this sandbox's Docker/Supabase-local stack remains unreliable.
     Transcribed directly from `supabase/migrations/20261001000001_init.sql` (the
     actual enum values, not guessed ones — an earlier draft of this file guessed
     wrong enum members for `gender`/`visit_type`/`visit_origin`/`zone`/`actor_type`
     and was caught by integration tests against the real schema, not by inspection).
     A later milestone that queries the schema broadly should replace this file
     wholesale with a real `kysely-codegen` run, not keep hand-extending it table by
     table.
  3. **Google ID-token verification and SMS delivery are both injectable boundaries,
     per the task's explicit instruction not to hardcode fake production credentials.**
     `GoogleIdTokenVerifier` (`src/auth/google.ts`) has a real implementation
     (`google-auth-library`, used whenever the server runs for real) and a
     `FakeGoogleIdTokenVerifier` double used only by tests — never wired into
     production code. `SMS_PROVIDER=console` writes the OTP code via a direct
     `console.log`, deliberately **not** through the Pino logger (whose entire purpose
     is redacting PII/secrets before they're persisted) — gated to
     `APP_ENV !== 'production'` and throwing if misconfigured otherwise.
     `SMS_PROVIDER=msg91` throws clearly, stating no real MSG91 credentials exist in
     this environment, rather than faking a provider call.
  4. **Staff invite acceptance happens two ways in `POST /auth/google`**: explicitly
     (a `staffInviteToken` naming one invite, enforcing `INVITE_EMAIL_MISMATCH` when
     the signed-in email doesn't match) and implicitly (any other still-pending,
     unexpired invite addressed to the signed-in email is auto-accepted on every sign-
     in). The SDD states "accepts any pending staff invite for that email" without
     requiring a token, so the implicit path is the literal reading; the explicit path
     exists because `staffInviteToken` is a documented optional request field and
     needs *some* behaviour when present.
  5. **Two genuine transaction-rollback bugs, found only by integration tests against
     a real Postgres, not by unit tests or by inspection:** both `verifyOtp`'s
     attempts-increment-then-throw and `rotateRefreshToken`'s
     revoke-then-throw-on-reuse originally ran inside the *caller's* transaction
     (`withTx`/`db.transaction()`). Since the function both wrote a row and then threw
     an `AppError` within that same transaction, Kysely rolled the whole transaction
     back on the throw — silently erasing the OTP attempt count and the reuse-
     triggered session revocation every time, defeating brute-force protection and
     refresh-token-theft detection respectively. **Decision:** both functions now take
     a plain `Kysely<Database>` instead of a `Transaction<Database>`, so their writes
     commit independently of whatever the caller does next; callers that need the
     verify-then-issue-tokens flow to still read as one logical operation call
     `verifyOtp`/`rotateRefreshToken` first, then open a separate `withTx` for the
     parts that genuinely do need atomicity (visitor/session creation). This is the
     specific mechanism DEC-005's "found by running the server, not by unit tests
     alone" lesson generalizes to: a function that must survive its own failure path
     cannot share a transaction with code that might fail for unrelated reasons.
  6. **Integration tests run against a real embedded Postgres** (`embedded-postgres`,
     same substitute for unavailable Docker as DEC-004), one instance shared by all
     `*.integration.test.ts` files via Vitest `globalSetup`
     (`apps/api/test/global-setup.ts`), each file resetting all `haven` schema tables
     in `beforeEach`. This requires `fileParallelism: false` and `isolate: false` in
     `vitest.config.ts` — running files concurrently against one shared, truncated-
     between-tests database produced spurious FK violations and deadlocks until
     sequential execution was forced; this was found empirically, not predicted.
  7. **Visit codes in tests must match `^V[0-9A-HJKMNP-TV-Z]{6}$`** (Crockford-style
     base32, excludes I/L/O/U) — a naive random/base36 generator intermittently
     produced invalid codes and failed the DB check constraint; test fixtures now
     generate from the exact alphabet.
- **Why:** items 1–4 fill in behaviour the SDD states at a level above what the code
  needs (exact placeholder values, exact injection seams) without contradicting it;
  item 5 is a correctness bug that would have shipped silently if integration tests
  hadn't exercised the real rollback semantics — recorded because CLAUDE.md §1.3
  requires every SDD-relevant finding disclosed, and this one directly affects whether
  `OTP_LOCKED` and refresh-reuse detection (both named in the task's own test list)
  actually work; items 6–7 are environment/tooling choices in the same spirit as
  DEC-004/DEC-005.
- **SDD updated?** No — nothing here contradicts the SDD's stated behaviour; items 1–4
  are implementation detail the SDD doesn't specify this precisely, and item 5 is a
  bug in this codebase, not the SDD.

### DEC-008 — Visit domain/state machine milestone: a real `evaluateEntry` misuse caught by testing, and five scope boundaries

- **Date:** 2026-10-01
- **Context:** Implementing the complete SDD §7 visit state machine and visits
  service/repository — exactly the 8 `visit_status` values and 19 transitions in
  §7.1's table, service + repository only, no HTTP routes (per the task's own scope).
- **Findings / decisions:**
  1. **Genuine bug, caught before being shipped, not an SDD issue**: an early draft of
     `approveWalkIn` (`pending_host -> inside`) called `evaluateEntry` the same way
     `checkIn` (`approved -> inside`) does. `evaluateEntry`'s step 3 denies with
     `VISIT_NOT_APPROVED` whenever `visitStatus !== 'approved'` — but a walk-in never
     passes through `approved` at all (SDD §7.1's own table: `pending_host -> inside`
     directly). Calling it from `approveWalkIn` would have denied *every* walk-in
     approval, unconditionally. Found by writing the walk-in integration tests in
     `apps/api/test/visits-service.integration.test.ts` and watching the "host
     approves" test fail for exactly this reason, before this file or
     `docs/TRACEABILITY.md` claimed anything was working. **Decision**: `approveWalkIn`
     no longer calls `evaluateEntry`; it re-checks only the two conditions that still
     apply (visitor banned, visitor already inside elsewhere) directly. The function's
     own doc comment in `apps/api/src/visits/service.ts` explains why, specifically so
     a future refactor doesn't reintroduce the call by analogy with `checkIn`.
  2. **No HTTP routes, no scheduled jobs, no gate/scan-session module** — all
     explicitly out of scope per the task ("Then implement the visits service and
     repository. Do not build UI yet."). System-triggered transitions
     (`expireWalkIn`, `expireApprovedVisit`, `completeApprovedVisitWithoutReturn`) are
     implemented as directly-callable functions a future cron job would invoke, not
     wired to any schedule. Gate-involving transitions accept a plain
     `{gateId, locationVerified, ...}` struct standing in for what a real scan session
     would supply — no QR/token verification, geofence check, or mock-location
     detection exists yet.
  3. **Window derivation (`arrivalDate`/`departureDate` → `windowStart`/`windowEnd`,
     SDD §12.6) is the caller's responsibility, not the service's.** `createWalkIn`/
     `createOvernightRequest` take already-computed `windowStart`/`windowEnd`
     directly. The SDD's `POST /v1/visits/preview` endpoint (F6 step 2, showing a host
     nights/charge/quota before they submit) is route-layer work for a later
     milestone; this one only validates whatever window it's given.
  4. **Dispute handling (SDD F9, FR-42/FR-43, "Not my guest") is entirely out of
     scope**: it doesn't change `visits.status` (the SDD is explicit — "status stays
     `inside`"), so it is not one of §7.1's 19 transitions and has no place in a
     state-machine milestone. `host_disputed_at`/`dispute_resolved_at` columns already
     exist in the schema (DB-foundation milestone) but nothing here writes them.
  5. **Host-assisted entry (SDD F4) does not dedupe visitors** — "such visitors are
     matched by host + name" is the SDD's stated matching rule, but implementing that
     match (fuzzy enough to catch the same guest visiting twice, strict enough not to
     merge two different guests) is a judgment call beyond what this milestone's scope
     warrants; every `createHostAssistedEntry` call creates a new `haven.visitors`
     row. Documented as a simplification, not silently assumed.
  6. **"Charge recalculated"/"charge finalised" (SDD §7.1's wording for the
     `approved -> completed` and `inside -> completed` transitions) is implemented as
     confirming the charge at its original pending amount**, not re-deriving it from
     actual nights stayed — the SDD states the charge is created once, at warden
     approval time (BR-08), and never specifies a different recalculation formula for
     a stay that ends early or late. A future milestone implementing partial-stay
     billing should revisit `apps/api/src/visits/sideEffects.ts`'s
     `confirmChargeForVisit`.
- **Why:** item 1 is a correctness bug that would have silently broken every walk-in
  approval if shipped — recorded per CLAUDE.md §1.3 exactly because it was close to
  shipping before the tests caught it. Items 2–6 are scope boundaries explicit in the
  task's own instructions or left unspecified by the SDD at this level of detail.
- **SDD updated?** No — item 1 was this codebase's bug, not the SDD's; items 2–6 don't
  contradict the SDD, they just haven't been built yet.

### DEC-009 — Guest web golden-path milestone: scope boundary, a rotating-refresh-token race, and a camera-permission dead end

- **Date:** 2026-10-03
- **Context:** The task asked for "the complete HAVEN Guest Web experience according
  to the SDD" — the full SDD §13 screen inventory (G-01 through G-18), including the
  rotating-QR gate-scan session, live photo upload/persistence/host comparison, a
  resident-side walk-in approval UI, SSE-live status updates, and a full accessibility
  audit. Building all of that for real (not stubbed) is realistically dozens of hours
  of work spanning modules this project's own milestone discipline (`docs/
  IMPLEMENTATION-PLAN.md`) assigns to *other*, later milestones (the gate/scan-session
  module, the media pipeline, the resident/warden apps) — none of which exist yet.
- **Decision:** Scope this milestone to a genuinely complete, end-to-end **golden
  path**, consistent with every earlier milestone's incremental-scope pattern (§0c–§0f
  above): invite landing → OTP sign-in → profile completion (live camera, no gallery)
  → check-in (real browser geolocation + live camera, a simplified haversine-distance
  geofence against a gate's configured `lat`/`lng`/`radius_m` instead of the SDD's
  rotating-QR/scan-session crypto) → zone notice → check-out, plus a partial walk-in
  flow (submission only — host-side approval needs the out-of-scope resident app).
  Verified against a **real** local API + real (embedded) Postgres database via
  Playwright (fake geolocation + fake camera device, 360×640 viewport, SDD §19.1), not
  mocks. Every simplification is listed in `docs/TRACEABILITY.md` §0g's "what this
  does NOT do" section, not silently absorbed into a claim of completeness.
- **Alternatives considered:** Build stub/placeholder versions of every SDD §13
  screen so the inventory looks complete on paper. Rejected — a stubbed gate-token
  scanner or an unwired `PhotoCompare` component would misrepresent what's actually
  usable, exactly the kind of "silently simplified requirement" CLAUDE.md §1.3
  forbids; a smaller set of screens that genuinely work end to end against a real
  backend is more honest and more useful than a larger set that doesn't.
- **Why:** Matches the project's own established pattern (every prior milestone in
  this build — §0c through §0f — scoped itself to a specific, bounded slice and
  explicitly listed what it deferred, rather than attempting the SDD's full surface in
  one pass) and the task's own completion gate ("do not consider this milestone
  complete until the golden-path guest flow works end-to-end against the local
  API/database") — which specifically asks for a working golden path, not a
  stubbed-out full inventory.
- **Two real bugs found by the end-to-end Playwright run itself, not by inspection,
  fixed before this milestone was considered done:**
  1. **Refresh-token-rotation race.** `apps/api/src/auth/sessions.ts`'s
     `rotateRefreshToken` is single-use — presenting an already-rotated token revokes
     the whole session (`SESSION_REVOKED`, by design, DEC-007 item 5/TC-SEC-06). The
     guest web client's `request()` helper (`apps/mobile/api/client.ts`) independently
     calls a module-level `tryRefresh()` on every 401, with no coordination between
     callers. On a hard page reload (`page.goto('/visits')` in the Playwright test),
     `AuthProvider`'s own `GET /me` and the visits screen's own `GET /me/visits` both
     401 at nearly the same instant and each fired its own `POST /auth/refresh` call;
     the second one presented a cookie the first had already rotated away, so it
     failed. The Playwright run reproduced this for real ("Couldn't load your visits"
     after a reload) — a unit test mocking `fetch` would not have caught the race.
     **Fix:** `tryRefresh()` now shares one in-flight promise across all concurrent
     401s (`refreshInFlight` in `client.ts`) so a page with multiple components
     refreshing at once redeems the rotating cookie exactly once.
  2. **Camera-permission-denied dead end on the gate screen.** `profile.tsx` renders a
     dedicated "Camera is blocked... Allow camera access..." message when
     `LiveCamera`'s `onPermissionDenied` fires. `visits/[id].tsx`'s gate check-in/
     check-out step wired the same callback to `setActionError('denied')` — the same
     state value used for a *geolocation* denial — but phase stays `'photo'` on a
     camera denial, and the `'photo'` phase never rendered any text for that state at
     all (the `'denied'`-branch message lived only in the `'explain_location'` phase's
     render block and talked about location, not the camera). The net effect: a guest
     who denies camera permission at the gate sees a permanently disabled "Take photo"
     button with zero explanation — a direct violation of SDD §13.1 principle 5
     ("never a dead end") and E-17/G-16's explicit "enable instructions" requirement.
     Found while writing this milestone's own `docs/TRACEABILITY.md` E-17 entry and
     re-reading the actual render logic, not by a test (no automated permission-denial
     test exists for this path — a documented gap, not a silent one). **Fix:** the
     camera callback now sets a distinct `'camera_denied'` state, and the `'photo'`
     phase renders its own "Allow camera access in your browser's site settings..."
     message, matching `profile.tsx`'s existing (correct) pattern.
- **Documented simplifications (not bugs — deliberate, disclosed scope cuts):**
  - No gate-token rotation/scan-session crypto (D1/D2) — `resolveGateAndVerify`
    (`apps/api/src/visits/geo.ts`/`routes.ts`) checks only real-time haversine distance
    against a gate's static `lat`/`lng`/`radius_m`, which is the one piece of
    "location verification" this milestone's golden path actually needs.
  - Captured photos (profile and gate) are never uploaded or persisted — no media
    endpoint, no `media` table row, no EXIF-stripping/resize/dedup pipeline (SDD §16.4)
    exists yet. `LiveCamera` still genuinely enforces "live camera only, no file
    picker" (SDD §9.4/D4) for the capture step itself; what happens to the frame after
    capture is out of scope.
  - "My visits" and the visit-status screen refetch on navigation/focus
    (`useFocusEffect`), not via the SDD §9.9 live SSE channel — no real-time push.
  - Walk-in ends at `pending_host` with no live wait screen and no scan session; a
    host can't yet act on it at all (no resident app exists).
- **SDD updated?** No — nothing here contradicts the SDD's stated behaviour; every
  item above is either explicitly out of this milestone's scope (recorded in
  `docs/TRACEABILITY.md` §0g, matching the project's established "what this does NOT
  do" discipline) or a bug in this codebase's own guest web client, not the SDD's.

### DEC-010 — Gate subsystem milestone: removing the guest-web milestone's temporary endpoints, two real bugs, and the DEC-009 gap review

- **Date:** 2026-10-04
- **Context:** The gate subsystem (SDD §9.1-9.4, §11.3, §12.8) had been skipped by
  mistake — the guest-web milestone (commit `38dc702`) was built against it before it
  existed, so it used three temporary, non-SDD endpoints (`POST /v1/visits/:id/
  check-in`, `POST /v1/visits/:id/check-out`, `POST /v1/visits/walk-in`) with a
  simplified direct-geolocation check instead of the real rotating-QR/scan-session
  flow. This task built the real gate subsystem, then rewired the guest web app onto
  it, and removed the temporary endpoints.
- **Decision:** `apps/api/src/visits/routes.ts` no longer registers `/visits/:id/
  check-in`, `/visits/:id/check-out`, or `/visits/walk-in` — check-in, check-out and
  walk-in are now exclusively `apps/api/src/gate/routes.ts`'s `/scan-sessions/:id/
  check-in`/`check-out`/`walk-in`, matching SDD §12.8 exactly (including the ★
  endpoints' exact request/response shapes). The mobile API client's `checkIn`,
  `checkOut`, and `createWalkIn` functions and the `GateLocation` type were deleted,
  not deprecated — nothing else referenced them. `visits/[id].tsx` lost its direct
  Check-in/Check-out buttons (it's now a pure read-only status view) and the
  standalone `walk-in.tsx` screen was deleted outright, both superseded by `/g/
  [token].tsx`'s real scan-session-driven flow.
- **Why:** The temporary endpoints were explicitly provisional (CLAUDE.md §1.3: a
  divergence from the SDD must be flagged, recorded, and later reconciled "in the
  same pull request" once the real thing exists) — they skipped the rotating-QR
  token, the scan-session nonce/binding/single-use mechanism, and the geofence
  retry/host-confirm fallback entirely. Once the real gate subsystem existed, keeping
  the shortcut around would mean two different, inconsistent ways to check a guest
  in, one of them silently bypassing every security property (SDD §16.1 T2-T4) the
  real token/geofence design exists to provide. Removing them outright (not keeping a
  fallback) is what "fix one of them in the same pull request; never let them drift"
  (SDD §0) requires here.
- **Two real bugs found while building/testing this milestone, fixed before it was
  considered done (full detail in `docs/TRACEABILITY.md` §0h):**
  1. Check-in unconditionally completed entry regardless of GPS verification — the
     pre-existing `checkIn()` service (built before the gate module existed) had no
     "wait for host" branch; SDD §12.8 requires staying `approved` with
     `awaiting_host_confirmation` when `gpsOk` is false and the host hasn't already
     confirmed. Fixed by short-circuiting in the gate route before calling `checkIn()`
     in that case, rather than changing `checkIn()`'s own behaviour (which other,
     future callers may still rely on completing unconditionally once a host-confirm
     action exists).
  2. A revoked gate device's heartbeat returned 401 (via the generic `Authorization:
     Device` auth path), never reaching the `{revoked: true}` response the SDD
     requires so the device can show D-03. Fixed by having device-token verification
     resolve revoked devices too (rather than treating them as unknown), since
     `recordHeartbeat` — the only thing that currently accepts a device principal —
     is what actually enforces the revocation.
- **Documented simplifications:**
  - **`LocalDiskMediaStorage`** (`apps/api/src/gate/media.ts`) is a disclosed local-
    disk substitute for Supabase Storage, for the same reason DEC-004 substituted
    embedded-postgres for a real Supabase/Docker connection — this sandbox has no
    reliable Supabase Storage connection either. The `MediaStorage` interface is the
    seam a real Supabase Storage client plugs into later; no path/bucket layout
    changes would be needed (`gatePhotoPath`/`visitorProfilePhotoPath` already match
    SDD §9.11 exactly).
  - **Minimal, not full, warden-side gate admin.** `POST /admin/gates/:id/pairing-
    codes` and `POST /admin/gate-devices/:id/revoke` exist only because pairing and
    rotation needed *some* caller to exercise them end to end — the full W-09 Gates
    screen (location-setting map, device list with online/offline status) is not
    built; this is Warden-app work.
  - **No SSE/live updates (SDD §9.9).** Reviewed per the task's explicit instruction
    to go through DEC-009's gap list: this gap doesn't strictly depend on the
    Resident or Warden apps, but it is its own substantial subsystem (a persistent
    `LISTEN`ing connection, in-memory fan-out, `@microsoft/fetch-event-source`/
    `react-native-sse` clients) orthogonal to the gate work this task scoped — judged
    better suited to its own milestone (bundled naturally with the warden dashboard
    that's its main consumer) than folded in here. Named explicitly rather than
    silently dropped.
  - **FR-26's guest-side wait screen has no 3s polling or Cancel button.** Both are
    buildable without the Resident app (the route a `Cancel request` button would
    call, `cancelWalkIn`, already exists as a service function from the visits
    milestone, just with no HTTP route yet) — but polling `GET /v1/me/visits/{id}`
    would have nothing to observe changing, since nothing in this milestone (or any
    built so far) can move a `pending_host` visit to `inside`/`rejected` outside a
    test fixture. Building the polling mechanism with nothing to meaningfully poll
    for was judged speculative; left as a named gap for whichever milestone adds the
    Resident app's walk-in approval action, at which point both the polling and the
    cancel route are small, well-scoped additions.
- **SDD updated?** No — removing the temporary endpoints brings the code into
  conformance with the SDD, it doesn't change what the SDD specifies. The two bug
  fixes correct this codebase's own behaviour against SDD text that was already
  correct. The documented simplifications are implementation-detail/scope choices in
  the same spirit as every earlier DEC-00x entry, not SDD contradictions.

### DEC-011 — Demo milestone: dev-only resident sign-in bypass, host visit actions, FR-26 polling, and the demo environment

- **Date:** 2026-10-04
- **Context:** A live demo (for an academic supervisor, not a real deployment) needed
  to show a resident signing in, creating an invite, and approving/rejecting a walk-in
  — none of which has a built UI yet, and the demo environment has no real Google
  OAuth credentials configured (SDD §9.5 assumes Google Sign-In is always available;
  it is silent on what a resident does when it isn't). It also needed FR-26's 3-second
  wait-screen polling and Cancel action, which DEC-010 explicitly deferred "until the
  Resident app's walk-in approval action" existed — it now does.
- **Decision:**
  1. **Dev-only sign-in bypass.** `POST /v1/auth/dev-login` (`apps/api/src/auth/
     dev-login.ts`) issues real tokens for an existing `haven.users` row by email alone
     — no Google ID token, no password. It is gated two independent ways: the route is
     only *registered* when `env.DEV_LOGIN_ENABLED` is true, and `buildApp` separately
     refuses to construct the Fastify instance at all if `DEV_LOGIN_ENABLED` is true
     **and** `process.env.NODE_ENV !== 'development'` — checked against the raw
     process env, not the validated `Env` object, so a copied `.env` or a
     misconfigured pipeline that sets the flag in staging/production fails loudly at
     boot instead of quietly exposing an auth bypass. The mobile resident sign-in
     screen (`apps/mobile/app/resident/login.tsx`) only shows the dev-login form when
     a parallel public flag, `EXPO_PUBLIC_DEV_LOGIN_ENABLED`, is set — this is a UI
     convenience only; hiding the button does not and must not substitute for the
     API's own two-layer gate.
  2. **Host visit actions implemented per SDD §12.6**, not invented: `POST /visits`
     (invite only — overnight/warden flows stay out of scope), `GET /me/hosted-visits`,
     `POST /visits/:id/approve` ★, `POST /visits/:id/reject` ★, `POST /me/visits/:id/
     cancel`. `GET /me/hosted-visits` adds one field, `guestName`, that is not part of
     the shared `visitDto()` the guest-facing routes also use — resident-only, so a
     guest-visible response can never carry another guest's name through the same
     helper.
  3. **`scan_sessions.visit_id`** (new column + migration) links a walk-in's scan
     session to the visit it produced, so `POST /visits/:id/approve` can reuse that
     session's already-checked GPS facts instead of re-checking location — SDD F2 step
     9 ("server runs evaluateEntry using the scan session's GPS result... so no second
     scan").
  4. **FR-26 polling + Cancel**: `apps/mobile/app/(guest)/g/[token].tsx`'s
     `waiting_for_host` phase now polls `GET /v1/visits/{id}` every 3 seconds and
     renders the SDD §13.6 `CHECK_IN_SUCCESS`/`WALK_IN_REJECTED` copy the moment the
     host decides, plus a `Cancel request` button calling the new cancel endpoint.
  5. **Demo environment** (`apps/api/scripts/demo-*.ts`, `scripts/demo.mjs`, `pnpm
     demo`): its own embedded-Postgres instance (DEC-004-style), the real
     `SystemClock` (not a frozen one, unlike the E2E fixtures), a GH-8 hostel, two
     verified residents, and one gate at `DEMO_GATE_LAT`/`DEMO_GATE_LNG`/
     `DEMO_GATE_RADIUS_M` (configurable per presentation room). `demo-server.ts` sets
     both `DEV_LOGIN_ENABLED=true` and `process.env.NODE_ENV = 'development'` itself,
     so the two-layer gate in (1) is satisfied by the script, not by an operator's
     shell state.
- **Alternatives considered:** Building real Google OAuth for the demo (rejected — no
  credentials exist for this environment, and SDD §9.5 doesn't require it; getting
  real credentials provisioned was out of scope for an academic demo). Skipping
  dev-login entirely and demoing sign-in only via a pre-issued token pasted into
  localStorage (rejected — doesn't actually demonstrate "a resident can log in," which
  the demo's own requirements list explicitly as a thing to show).
- **Why:** The two-layer gate on dev-login exists because a sign-in bypass that skips
  Google verification entirely is exactly the kind of control that must never reach a
  real deployment by accident (CLAUDE.md §4's "two people max hold Supabase owner
  access" spirit extends to "no auth bypass reachable in prod, full stop") — a single
  env flag an operator could forget to unset is not enough on its own, so the check
  that actually matters (`NODE_ENV`) is enforced by the server itself, redundantly.
  `scan_sessions.visit_id` is a minimal, targeted schema addition rather than a
  timestamp-proximity join or a new `gate_event_kind` value, because both alternatives
  would have been fragile (a proximity join can match the wrong session under load; a
  new enum value duplicates information the row already has via its existing
  `consumed_action`).
- **Documented simplifications:** The full Resident app (SDD §13.4's "Resident
  (native)" shell: Home with quick actions, Overnight request, Guest-without-phone,
  Charges, Profile) is not built — only the four screens (sign-in, invite, requests,
  hosted visits) this demo needs, reachable at `/resident/*` rather than through a tab
  bar. `GET /me/hosted-visits` returns one flat list, not the SDD's Upcoming/Inside/
  History segments. Warden/office milestones remain entirely unbuilt, per the task's
  explicit instruction not to build them yet.
- **SDD updated?** No — the dev-login bypass is additive, demo/dev-only
  infrastructure, not a product behaviour the SDD specifies (the SDD assumes Google
  Sign-In throughout §9.5); it does not change or contradict any SDD requirement. The
  host visit actions and FR-26 polling implement SDD text that already existed, they
  don't reinterpret it.

### DEC-012 — Resident app milestone: notification delivery and routing, host actions, and what could not run here

- **Date:** 2026-10-18
- **Context:** Building the Resident app (SDD §13.4 R-01..R-15, flows F1–F4, F6, F7,
  F9, F10, §12.4–§12.6, §15) on top of the gate and demo milestones. Several places
  needed an interpretation, and several existing behaviours turned out not to match
  the SDD once the host side existed.
- **Decision — notifications (§9.7, §15):**
  1. Every producer now writes §15's catalogue text verbatim through
     `apps/api/src/notify/templates.ts` (the service had paraphrased bodies such as "A
     guest is waiting at the gate."). The SQL jobs' resident-facing kinds were fixed by
     migration `20261017000001_job_notification_text.sql` (also "4:42 pm", not "04:42
     pm"). Two additions to catalogue text, both from other SDD sections: N-LEFT appends
     "Location was not verified." when the exit's GPS failed (F5 step 5, a normative
     flow, says the notification must say so); N-WALKIN-REJECTED (§7.1, guest page, not
     in §15.2) uses §13.6's "Walk-in rejected" copy.
  2. A walk-in whose scan session failed GPS sends **N-CONFIRM-LOCATION instead of
     N-WALKIN** (§15.2 lists "Check-in or walk-in with unverified location" as its
     trigger; F3 step 4 says approval doubles as confirmation). Both open R-08.
  3. The API stamps `screen` into every row's `data` and the worker builds the §15.1
     payload `{ kind, notificationId, visitId?, screen }`; the kind → screen and kind →
     Android channel tables live in `packages/shared/src/api/notifications.ts` and are
     shared by API and app. The app only ever navigates through `safeScreen()`, an
     allow-list, so a malformed payload lands on Home. Warden screens are fixed as
     `/warden/...` paths now so payloads produced today stay valid.
  4. **Web fallback for push.** Expo push tokens don't exist in browsers, so on the web
     the resident shell polls `GET /me/notifications` every 10 s and shows new items as
     a banner that goes through the *same* tap handler as a push; the worker's "no
     active push token → release the SMS fallback now" rule (§15.5) covers delivery.
     Native push (expo-notifications: channels, permission, token registration, tap
     routing incl. cold start) is implemented but **could not be run**: this machine has
     no Android SDK/emulator, and getting an Expo push token needs an EAS project id.
  5. Opening R-08/R-09/R-10 marks that visit's unopened notifications opened (§9.7: "or
     opens the related screen"), so the SMS fallback is cancelled however the host
     arrived.
- **Decision — host actions (§12.6):**
  6. `allowedActions` is computed by the API (`apps/api/src/visits/dto.ts`). Interpretations:
     *confirm/dispute* ("Yes, that's my guest / Not my guest", FR-42) only for visits the
     guest checked into themself (`origin` invite or overnight_request) and only within
     `dispute_window_minutes` of the latest entry — walk-ins and host-assisted entries
     were approved by the host with the photo in hand ("Host does not get a separate
     arrival confirmation", F2 step 9); *edit* only for day/quick drop-off invites before
     entry (an overnight window comes from warden-approved dates); *share_invite* while
     approved and never entered.
  7. `POST /visits/{id}/confirm-arrival` has two meanings, both in §12.6: completing a
     location-unverified check-in (F3) — via `checkIn` with the waiting scan session's
     facts, cut-offs judged at the scan time (E-05), no N-ARRIVED; after the 10-minute
     session lifetime it answers `410 SCAN_SESSION_EXPIRED` — or R-09's "Yes, that's my
     guest", setting `host_confirmed_at`.
  8. Approving a walk-in re-runs `evaluateCreate` on the (possibly host-adjusted) window
     — BR-11 says the day-guest limit is enforced at "Create + approval" — and every
     host/warden decision writes the insert-only `approvals` row (with
     `adjusted_window_end`), which also feeds the R-10 timeline (E-09).
  9. The dispute `note` is kept in the N-DISPUTE row's `data` (the schema has no column
     for it). A warden decline requires `reason` (§12.6 "warden: required").
  10. Approving an overnight request does not mint an invite token: the raw token can't
      be recovered later, so the host gets the link through `POST /visits/{id}/
      invite-link` (R-10 "Share invite"), which is what "invite link generated and shown
      to the host" (F6 step 5) needs in practice.
  11. Every ★ route a resident calls requires `Idempotency-Key` (approve, reject,
      confirm-arrival, dispute, mark-left, host-assisted entry/exit). Only 2xx responses
      are stored: a 4xx is deterministic and a 5xx should genuinely retry.
- **Decision — existing behaviour corrected:** `checkIn` committed the status change and
  then wrote the gate event and notification in a second transaction (now one, per §8.2);
  host-assisted entry skipped `evaluateEntry` (§4.5 lists it) and recorded GPS as always
  verified; the guest's location-unverified check-in skipped ownership/rule checks and
  never linked its session, so nothing could complete it; BR-05's quota ignored
  completed stays; scan sessions took `created_at` from the database clock instead of
  the injected `Clock` (§19.3). `GET /visits/{id}` now answers 404, not 403, for a visit
  the caller can't see (§12.2, TC-SEC-01/02). N-LEFT is skipped when the host did the
  check-out themself (host-assisted exit).
- **Decision — other:** photos are served through 120 s HMAC-signed URLs
  (`apps/api/src/media/`), the local stand-in for Supabase's signed URLs behind the same
  `MediaStorage` seam as DEC-004. R-12 offers "Continue without location" after three
  failed fixes, mirroring FR-27; the entry is flagged `location_unverified`. R-03's
  consent is a required checkbox in the app only — there is no resident consent column.
  The resident app uses a custom five-tab bar over Expo Router's `Stack` (this Expo
  Router version vendors its navigation; a plain bar behaves the same on web and
  Android).
- **Not built / not run (recorded in TRACEABILITY):** native Google Sign-In (needs a
  development build and an Android OAuth client; web Google Identity Services is wired
  but untested without a client id, so DEC-011's dev sign-in remains the way in here);
  the R-06 contact picker; account deletion (FR-09, priority S, no API); the push
  receipts job; `Idempotency-Key` on the guest's own ★ routes; any warden screen.
- **Known guest-web behaviour found (since accepted as a deviation, DEC-013):** after the sign-in detour the guest app
  starts a new scan session and re-checks the stale 30-second QR token, so a first-time
  walk-in can see "That code has changed" — contrary to §9.3 ("lets slow steps ... happen
  after the 30 s token window without re-scanning"). An earlier DEMO.md note called this
  intended; that was wrong and has been corrected.
- **Alternatives considered:** Re-deriving permissions in the app (rejected — §12.3
  forbids it); a web-push (VAPID) channel for browsers (rejected — not in the SDD's
  stack, and Expo push is the specified provider); sending both N-WALKIN and
  N-CONFIRM-LOCATION for an unverified walk-in (rejected — two pushes for one decision).
- **SDD updated?** No. Items 1, 2, 6–10 are interpretations of text the SDD already
  has, flagged here for review; nothing above contradicts an SDD requirement.

### DEC-013 — Accepted deviation: a first-time guest who signs up mid-scan scans the gate QR once more

- **Date:** 2026-10-18
- **Context:** SDD §9.3 says the scan session exists so "slow steps (OTP, profile,
  selfie) happen after the 30 s token window without re-scanning", and flow F2 has a
  walk-in guest sign up and continue on one scan. The guest web app instead restarts the
  scan after the sign-in/profile detour and re-checks the gate token, which is stale by
  then, so a first-time walk-in has to scan again (found in the resident milestone,
  DEC-012).
- **Decision:** The team accepts this behaviour as a deviation and does not change the
  scan flow. Reasons: it only affects a guest's *first* walk-in (once signed in, the
  next scan is instant); nothing they entered is lost — phone, profile and selfie are
  saved, they only scan again; and it is stricter, not weaker — every gate action is
  still backed by a fresh, unexpired token, so it cannot widen the window for a
  screenshotted code. It may be revisited later (e.g. by resuming the original scan
  session after sign-in, as §9.3 describes).
- **What changed:** only the message. When the gate page sends a signed-out guest to
  sign in, the return path carries `resumed=1`; if that restarted scan fails with
  `GATE_TOKEN_EXPIRED`, the guest sees a next-step screen instead of the refusal. Every
  other expired token still shows "That code has changed".
- **Proposed copy (not in SDD §13.6), key `GATE_RESCAN_AFTER_SIGN_IN`:** title "You're
  signed in"; body "Scan the QR on the gate screen once more to continue. Your details
  are saved."; button "Go to My visits". Shown with a green tick, not the red cross.
- **Alternatives considered:** resuming the original scan session after sign-in
  (rejected for now by the team — larger change to a security-sensitive flow); keeping
  the generic expired error (rejected — it reads as a failure to someone who just
  finished signing up).
- **SDD updated?** No — recorded here as an accepted deviation and in TRACEABILITY
  (FR-21, FR-25); to be reflected in the SDD (§9.3, F2, §13.6) when it is next revised.

### DEC-014 — Warden and office milestone: permission boundaries, SDD gaps, and test-infrastructure fixes

- **Date:** 2026-10-18
- **Context:** Building W-01..W-12, O-01, `/v1/admin` and `/v1/stream` (SDD §3.3, §3.4,
  §5.1, §5.5, §9.9, §12.9, §13.4). §3.3 (the permission matrix) and §12.9 (the
  endpoint table's "Role" column) don't always agree, and several screens need
  behaviour the SDD doesn't spell out. CLAUDE.md §1.4 says to choose the more
  restrictive reading and record it. Each item below is one such choice.
- **Decision — where roles come from:**
  1. Staff roles are read from `role_assignments` (`revoked_at is null`) on every request,
     through the 30-second revocation cache. A role change made through the API clears
     the cache for that user immediately (`forgetUser`), which also drops their open
     live streams. A super admin grant (`hostel_id` null) is carried as `h: '*'`. Before
     this milestone `loadUserRoles` dropped super admin grants entirely; that's fixed.
  2. Accepting a staff invite for a role the user already holds in that hostel doesn't
     create a second grant. `granted_by` is copied from the invite.
- **Decision — narrower permissions where §3.3 and §12.9 differ:**
  3. Dashboard, emergency roll call, the approvals queue and reports are **warden
     only**. §3.3 gives the super admin "See visits: All", which is implemented as
     `GET /admin/visits` and visit detail in any hostel, not the warden's day-to-day
     screens. In the app the super admin lands on Residents.
  4. Approving or rejecting an overnight stay and force check-out are warden only (the
     matrix shows "—" for super admin).
  5. Mark left is warden only (FR-07; no matrix row grants it to anyone else).
  6. Deactivate (§12.9 "Office staff management"): a warden can deactivate only office
     staff of their own hostel, and not themselves. It revokes the role in that hostel
     and ends all sessions and push tokens. `users.is_active` becomes false only if no
     roles are left and the user isn't a resident.
  7. A warden may place an all-hostels ban (FR-54), but only its creator or a super
     admin can lift it. A ban requires the guest to have had a visit in this hostel, so
     a warden can't ban an arbitrary phone number seen nowhere in their hostel.
  8. Office: charge responses omit the `guestPhone` and `guestPhoto` keys entirely
     (TC-SEC-03, done in the serializer). On `/v1/stream` the office gets pings only,
     with no visit or gate events.
- **Decision — behaviour the SDD doesn't spell out:**
  9. Endpoints not listed in §12.9, both under `/v1/admin` with `X-Hostel-Id`:
     `POST /admin/hostels` (super admin; creates rules v1 from the GH-8 defaults with the
     new hostel's gender, plus one unconfigured gate) and `POST /admin/staff-invites`
     with `role=warden` (super admin only; FR-06). There is also
     `GET /admin/reports/visits` (JSON counts for W-12; §12.9 lists only the CSV). The
     CSV leaves out the guest phone ("collect the least", §16).
  10. The staff invite link is `<WEB_BASE_URL>/staff-invite/<token>`, valid 48 h and bound
      to the invited email.
  11. The dashboard response adds `latestEvents` (W-01 "latest events") and
      `gates[].configured` (E-14 banner). A gate device counts as online if it was seen in
      the last 5 minutes, the same threshold `job_gate_offline` uses (FR-29).
  12. Publishing rules refuses changes to `hostel_gender` and `timezone`. Those are facts
      about the hostel, not rules. Each save is a new version. Gate entries are judged
      against the latest version (E-13); the cache is cleared on publish. A hostel with
      no rules row falls back to GH-8 v1.
  13. Ban, suspend hosting and mark left cancel the host's or guest's **approved,
      never-entered** visits. That's the only cancel transition §7.1 defines, so BR-10
      is applied through it, and their pending charges are waived. `pending_warden`
      requests stay for the warden to decide. Guests already inside stay inside
      (E-11/E-12); the warden force-checks them out if needed.
  14. Proposed copy for N-HOST-SUSPENDED with no end date (§15 has only the dated form):
      "Until the warden lifts it. Your upcoming visits were cancelled."
  15. The resolve-dispute note is stored only in the audit row; `visits` has no column
      for it.
  16. The warden's visit detail shows the full guest phone (§3.3 "See guest phone:
      Hostel") and the GPS distance only, never coordinates (§16.2).
  17. App routes: the staff shells are `/warden/*` and `/office/*` (plain folders, not
      route groups) so office `/charges` can't collide with the resident's `/charges`.
      Wardens also get push registration and notification-tap routing in their shell.
  18. W-09 shows the averaged gate coordinates and accuracy as text. There is no map
      preview, because the stack in §8.4 has no map library.
- **Decision — infrastructure fixed along the way:**
  19. Embedded Postgres for tests, e2e and the demo now runs `initdb --encoding=UTF8
      --locale=C`. On Windows the default was WIN1252, which rejected "₹" and any
      non-Latin guest name with a 500. Supabase is UTF-8, so this matches production.
  20. `job_flag_overstays` had never run: it mixed text and enum in a `UNION ALL`. Fixed by
      a new migration (`20261018000002`), not an edit, and covered by TC-JOB-01. A new
      `gate_devices` trigger (`20261018000001`) emits online, offline and revoked events
      for the live stream.
  21. Where `pg_cron` isn't installed (embedded Postgres in tests, e2e and the demo), the
      instance with `WORKER_ENABLED=true` runs the §9.8 SQL jobs on their schedules
      (`JobRunner`). Where `pg_cron` exists it does nothing.
  22. The e2e API raises the global rate limit to 1,000 requests per minute: the
      Playwright suite runs many sign-ins from one IP. The per-phone OTP limits are
      unchanged.
- **Alternatives considered:** Following §12.9's wider "Role" column, which would let
  the super admin into every warden screen (rejected — CLAUDE.md §1.4, more
  restrictive). Sending office staff anonymised visit events on the stream (rejected —
  O-01 needs nothing but charges).
- **SDD updated?** No. Items 3–8 choose the narrower of two SDD readings. Items 9–18
  fill gaps and are flagged here for review. Item 14 is proposed copy to add to §15
  when the SDD is next revised. Nothing here widens a permission the SDD grants.

### DEC-015 — Async milestone: outbox, jobs, retention and account deletion

- **Date:** 2026-10-18
- **Context:** Auditing and completing SDD §9.7 (outbox and worker), §9.8 / §11.8
  (jobs), §15 (notifications), §16.5 (retention) and §16.6 (account deletion). The
  audit before any change is in TRACEABILITY §0l.1. Where the SDD is silent or
  contradicts itself, each choice below takes the more restrictive reading
  (CLAUDE.md §1.4).
- **Decision — time:**
  1. Every SQL job takes `p_now timestamptz default now()`. pg_cron still calls
     `haven.job_x()` with no argument; the in-process JobRunner passes its injected
     Clock. That makes the SDD's boundaries testable to the second (§9.13).
  2. Boundaries are inclusive where the SDD names a moment:
     - a walk-in expires at exactly `walk_in_timeout_minutes` (BR-12);
     - an approved visit expires at `window_end` (FR-71);
     - an overstay starts at `window_end + overstay_grace_minutes` (BR-13);
     - wardens are told at exactly 30 minutes (FR-72).
     Gate offline stays strict, because §9.8 says "silent > 5 min".
- **Decision — notification text (§15 wins over §11.8's example SQL):**
  3. **SDD conflict, N-OVERSTAY-GUEST.** §15.2 gives "Your HAVEN visit to
     {hostelCode} ended at {endTime}. Please check out at the gate now." The DLT
     template §15.3 registers as HAVEN_OVERSTAY is "Your HAVEN visit ended at
     {#var#}. Please check out at the gate now." Indian operators reject an SMS that
     differs from its registered template, so HAVEN sends the §15.3 text. **The SDD
     should change §15.2 to match.**
  4. §11.8's example SQL paraphrases several texts (e.g. N-WALKIN-EXPIRED). The
     §15.2 table is used verbatim ("Anything not in this table must not be sent").
     The night sweep's zero-guests case uses §11.8's in-app text "No day guests
     inside at 10 pm", since §15.2 says only "in-app if zero".
  5. **N-GATE-OFFLINE fixes:**
     - it now includes "Guests can't scan in.", which the job had dropped;
     - times read "4:42 pm";
     - its dedupe key now includes the warden. Before, only the first warden of a
       hostel was ever alerted.
  6. N-CHARGE is now also sent when an overnight or guest-room approval creates the
     pending charge (§15.2: "Charge created or marked paid").
  7. N-WALKIN-REJECTED (in-app, the guest's page) isn't in the §15.2 table. It's named
     by the §7.1 state table, and its text is §13.6's "Walk-in rejected". It is kept,
     because nothing is pushed or texted.
  8. Tap targets:
     - N-NIGHT-SWEEP opens W-02 filtered to the swept visits (`/warden/inside?ids=…`,
       shown as a "Night sweep" chip; §11.8);
     - N-GATE-OFFLINE opens W-09.
- **Decision — delivery:**
  9. `SmsProvider.send(to, templateId, vars)` as §9.7 names it, with
     `ConsoleSmsProvider` for dev and tests.
     - Only the five §15.3 templates can be sent.
     - SMS rows store their variables in `data.smsVars`. The worker refuses
       (permanently fails) a row whose stored text isn't exactly the template filled
       with those variables.
     - `Msg91SmsProvider` is not built: there are no credentials, and this
       milestone's brief is the provider boundary plus a dev fake.
     - OTP codes are still printed by the OTP service in the request (§9.5's
       synchronous path), not through the outbox. When Msg91 lands, they go through
       `SmsProvider` as HAVEN_OTP.
  10. **Claim lease.** Claiming a row stamps `next_attempt_at` with the claim time.
      A row still `sending` 5 minutes later belongs to a worker that died mid-send,
      so the next tick re-queues it, counting as an attempt. Every write after the
      claim is conditional on the row still being this claim's (status and attempt
      number). So processing a row twice never double-finishes it, and a late worker
      can't overwrite the result. Delivery is at-least-once only in the
      crash-mid-send case.
  11. **§15.5 enforcement.** The worker refuses to deliver any push or SMS whose
      title or body contains an Indian mobile number or a photo link, and marks the
      row failed. It doesn't redact, because a guest can type digits into their
      name. The in-app copy is unaffected.
  12. **Push receipts** (§9.7 "15 min later"):
      - `provider_ref` holds `<ticket id>:<push_tokens id>` pairs;
      - new column `notifications.receipt_checked_at`; each push is checked once;
      - a receipt Expo no longer has counts as delivered.
  13. "Failed (and logged to Sentry)": permanent failures are logged at error level.
      Sentry isn't wired anywhere in the API yet (NFR-13); that remains open.
- **Decision — retention (§16.5):**
  14. **Constraint fix.** The `visitors` check (phone or host-created) made
      anonymisation impossible for self-registered guests and aborted every
      retention run. An anonymised row is now allowed to have neither.
  15. **`last_visit_at` moves on every gate entry** (a trigger on `gate_events`),
      not only at sign-in. Otherwise a returning guest whose session was still
      valid could be anonymised mid-relationship.
  16. **Profile-photo date.** A guest's `delete_after` follows their latest visit,
      re-set on every run. A guest who never visited counts from when their row
      was created.
  17. **Anonymisation guard.** Guest identity is anonymised only with no visit
      whose window is still ahead and no open visit (inside, pending or approved).
  18. **Audit log, kept 2 years, then deleted.** The append-only trigger allows a
      delete only when the retention job sets `haven.retention_cutoff` for its own
      transaction, and only for rows at or before it. `job_retention` is security
      definer; `haven_api` still has no DELETE grant on `audit_log`.
  19. **Notifications after 90 days:** body set to '' (the column is NOT NULL),
      title null, and `data` cleared too, since it can hold SMS variables such as a
      guest's name.
      - `recipient_phone` on old SMS rows is kept, because the table's check
        requires it for phone recipients. **Flagged for review:** §16.5 doesn't
        mention it.
  20. Each run writes one `job.retention` audit row with counts only (FR-74).
- **Decision — account deletion (§16.6, FR-09):**
  21. **Storage.** Requests live in a new `deletion_requests` table (the SDD names
      the endpoint, not a table), one open request per person.
  22. **Response.** `POST /me/deletion-request` returns 202 with
      `{ status, waitingFor, waitUntil }`, so the app can show that deletion waits
      (step 2).
  23. **Staff are refused** (403 FORBIDDEN). FR-09 covers guests and residents;
      staff access ends by deactivation (FR-07).
  24. **Unpaid charges.** "Unpaid" means a charge that's pending or confirmed. The
      request is refused with `409 CONFLICT`, `details: { reason: 'UNPAID_CHARGES',
      unpaidInr }`. §12.2 has no specific code, so none was invented. Nothing is
      recorded and the person stays signed in.
  25. **Waiting.** Step 2 says "a guest inside right now, or has a visit in the next
      24 h". The narrower-risk reading is used: a resident also waits while their
      own guest is inside or due in the next 24 hours.
      - Signing in again (e.g. to check out at the gate) is allowed and doesn't
        cancel the request.
      - `GET /me` shows the open request.
  26. **The worker** runs every 15 minutes (§16.6 "within 7 days"). It:
      - deletes every photo the person owns, the guest's gate photos included;
      - cancels their approved visits that haven't started;
      - anonymises (§16.5 for guests; for residents: "Former resident", email
        `deleted-<id>@deleted.invalid`, `google_sub` `deleted:<id>`, phone null,
        inactive, `residents.status = 'left'`; new column `users.anonymised_at`);
      - revokes every session and push token;
      - writes `account.deleted` to the audit log.
      Visit rows keep their ids, so the host's record survives.
- **Proposed copy — not in §13.6; APPROVED by the team in DEC-016** (keys in
  `packages/shared/src/copy/en.ts`). The button label "Delete my account" and the
  sheet's "Reason (optional)" field are the only fixed UI strings.
  - `ACCOUNT_DELETE_CONFIRM_GUEST`: "Delete your account?" / "You'll be signed out
    everywhere. Within 7 days we delete your photos and remove your name and phone
    number. Your hosts keep a record of past visits, without your details."
  - `ACCOUNT_DELETE_CONFIRM_RESIDENT`: "Delete your account?" / "You'll be signed out
    everywhere. Within 7 days we delete your photos and remove your name, email and
    phone number, and cancel guest visits that haven't started. Records of past
    visits stay, without your details."
  - `ACCOUNT_DELETION_REQUESTED`: "Deletion requested" / "You've been signed out.
    Your account will be deleted within 7 days."
  - `ACCOUNT_DELETION_WAITS_INSIDE`: "Deletion requested" / "You're checked in right
    now, so we'll delete your account after this visit ends. You've been signed out —
    sign in again only to check out at the gate."
  - `ACCOUNT_DELETION_WAITS_UPCOMING`: "Deletion requested" / "You have a visit in
    the next 24 hours, so we'll delete your account after it ends. You've been signed
    out."
  - `ACCOUNT_DELETION_UNPAID`: "Clear your charges first" / "You owe ₹{amount}. You
    can delete your account once the warden's office marks it paid."
- **FR-60 daily digest — deferred, needs a decision. (Resolved: approved and built, DEC-016.)** The brief says to build it
  only once everything else is done; it would be next. But §15.2 has no kind or text
  for it, and "Anything not in this table must not be sent", so it isn't built
  without approved text. Proposal: kind `N-DIGEST`, push (alerts) to each warden at
  08:00 IST, title "Yesterday at {hostelCode}", body "{visits} visits · {disputes}
  disputed · {overstays} overstayed · {unverified} location not verified · {forced}
  forced check-outs." Tapping it opens W-12 for yesterday.
- **Also fixed:** the guest's waiting page never showed an expired walk-in. It now
  shows §13.6 "No answer from {hostFirstName} / Try calling her, then request again"
  (FR-70).
- **Known limitation:** wardens on the web have no notification list (W-01..W-12
  don't include one). Their alerts reach them as Android pushes, and on the web only
  as the dashboard updating live.
- **Alternatives considered:**
  - Redacting phone numbers instead of refusing to send (rejected: it changes
    catalogue text).
  - Leaving the jobs on the database clock (rejected: the BR-12/BR-13 boundaries
    couldn't be tested).
  - Exactly-once delivery with a provider idempotency key (rejected: Expo push
    doesn't offer one).
  - A new error code for unpaid charges (rejected: §12.2 is closed;
    `CONFLICT` + details is enough).
- **SDD updated?** No. Item 3 needs §15.2 changed to the §15.3 text. Items 21–26
  fill gaps in §16.6 and §12.4. The proposed copy and the FR-60 text need approval
  before they become SDD text.

### DEC-016 — Team decisions on DEC-015: deletion copy, daily digest, overstay SMS, SMS phone retention

- **Date:** 2026-10-18
- **Decided by:** the team, on the open items in DEC-015.
- **Decision:**
  1. **Account-deletion copy approved as proposed.** The six DEC-015 strings
     (`ACCOUNT_DELETE_CONFIRM_GUEST`, `ACCOUNT_DELETE_CONFIRM_RESIDENT`,
     `ACCOUNT_DELETION_REQUESTED`, `ACCOUNT_DELETION_WAITS_INSIDE`,
     `ACCOUNT_DELETION_WAITS_UPCOMING`, `ACCOUNT_DELETION_UNPAID`) are approved
     product copy. They are marked so in `packages/shared/src/copy/en.ts`.
  2. **FR-60 daily digest built with the proposed text.** The SDD lacked this string:
     §15.2 has no row for FR-60. `N-DIGEST` is a team-approved addition to the
     catalogue:
     - to each warden, push (alerts channel), 08:00 IST (`30 2 * * *` UTC);
     - title "Yesterday at {hostelCode}";
     - body "{visits} visits · {disputes} disputed · {overstays} overstayed ·
       {unverified} location not verified · {forced} forced check-outs.";
     - tap opens W-12 for that day.

     "Yesterday" is the hostel's local calendar day. The counts are:
     - visits whose first entry fell in it;
     - visits disputed in it;
     - visits flagged as overstaying in it;
     - gate entries with location not verified;
     - forced check-outs.

     One push per warden per day. Built as `haven.job_daily_digest(p_now)`
     (migration 20261020000002), run by pg_cron or the JobRunner. **§15.2 must gain
     this row.**
  3. **Overstay guest SMS keeps the §15.3 DLT template text** ("Your HAVEN visit
     ended at {#var#}. Please check out at the gate now."). **§15.2's N-OVERSTAY-GUEST
     body must be corrected to match**; the template is what the operator accepts.
  4. **SMS recipient phones aren't kept indefinitely.** Once an SMS row is past the
     §16.5 notifications period (90 days) and can no longer be sent (sent, failed or
     cancelled), retention nulls `recipient_phone` along with the body.
     - The table check now requires the phone only while the row is queued or sending
       (migration 20261020000001).
     - The job change is in migration 20261020000003.
     - Tested in `apps/api/test/retention.integration.test.ts`.
- **SDD updated?** Not yet. Items 2 and 3 are recorded as required SDD corrections
  (§15.2 gains N-DIGEST; §15.2's N-OVERSTAY-GUEST text changes to the §15.3 template).
  The deletion copy becomes §13.6 text at the next revision.

### DEC-017 — Security audit fixes: choices made, and items left for the team

- **Date:** 2026-10-19
- **Context:** The independent audit in `docs/SECURITY-AUDIT.md` (SA-01..SA-30). The
  CRITICAL, HIGH and MEDIUM implementation defects were fixed. Where a fix needed a
  choice the SDD doesn't make, the more restrictive one was taken and recorded here.
  Anything that changes SDD behaviour was not changed; it's listed at the end.
- **Decision:**
  1. **Room search follows §12.7 exactly**
     (`GET /v1/hostels/{id}/rooms/{number}/residents`, display names, 10/min).
     - It also requires the session's `X-Scan-Nonce`, in addition to
       `X-Scan-Session`, and that the session is bound to the caller and at a gate of
       that hostel. §12.7 names only the session header; the nonce is what proves the
       session is the caller's (§9.3 "Binding").
     - The guest app now uses the session's hostel instead of the first hostel in
       `GET /hostels`.
  2. **`APP_ENV` has no default**, in the API and the seed script. Every environment
     must say what it is. `.env.example` keeps `APP_ENV=local`.
  3. **OTP CAPTCHA (T10).**
     - From the 4th request in the per-IP hour a passed Cloudflare Turnstile token is
       required.
     - Refusals are `429 RATE_LIMITED` with `details.reason: 'CAPTCHA_REQUIRED'`.
       §12.2 has no CAPTCHA code, so none was invented.
     - The bypass verifier exists only for `APP_ENV=local`. Staging and production
       refuse to boot without `TURNSTILE_SECRET`. The verifier fails closed when
       Cloudflare is unreachable.
     - The Android app has no widget; it shows the API's message (residents verify a
       phone once; guests use the web).
  4. **Concurrency on OTP.**
     - Requests take transaction-scoped advisory locks per phone, then per IP (fixed
       order, so they can't deadlock).
     - Verification reserves an attempt atomically before comparing.
     - A correct code that loses a race to another correct submission gets
       `OTP_INVALID` ("one code, one sign-in").
  5. **Proxy trust.** `TRUST_PROXY_HOPS` (default 0) decides whether
     `X-Forwarded-For` is believed. Production sets it to the number of proxies in
     front of the API.
  6. **Logs.**
     - The request serializer logs method, path (query string replaced by
       `?[redacted]`, invite tokens masked), host and client IP. No headers or bodies.
     - The console OTP line masks the phone; §9.5's "prints codes to the API log" is
       kept.
  7. **Reads of resident ID documents** are audited as `read.resident_documents`, one
     row per list response that contained any ID-card or selfie URL (T15).
  8. **Uploads.**
     - JSON bodies are capped at 64 KB (§16.4); multipart keeps its 3 MB file limit.
     - Decoding is capped at 40 MP.
     - An oversized upload is `PHOTO_INVALID` (400), no longer a 500.
  9. **Media storage** addresses objects by the §9.10 bucket and path. The local
     store writes `<root>/<bucket>/<path>` and refuses anything else.
  10. **Sentry (§8.4, NFR-13).**
      - It runs in the API and the web app only when a DSN is set.
      - No default integrations, no breadcrumbs, no user, IP, headers, cookies, bodies
        or query strings.
      - Every string is scrubbed by `scrubSentryEvent` in `@haven/shared` (the §16.4
        list plus phones, JWTs, emails and query credentials). Error codes and stack
        frames are kept.
      - The Android build is a no-op until the React Native SDK and a native build
        are possible.
  11. **Dependency upgrade:** `sharp` 0.33.5 → 0.35.5 (dedicated commit, CLAUDE.md §5).
- **Left for the team (not changed):**
  - **SA-12, web security headers.** These need the hosting choice and the
    production API domain for `connect-src`. A proposed `vercel.json` is in
    SECURITY-AUDIT.md.
  - **SA-24, the test OTP.** §9.5 allows the test phones in any non-production
    environment, including staging. The brief asked for development only; that is an
    SDD change. After SA-02 it can't be enabled by accident, and it never works with
    `APP_ENV=production`.
  - **SA-15, SA-17, SA-19, SA-23.** LOW items: accept or schedule.
- **SDD updated?** No. Items 1, 3 and 10 should be reflected in §12.7, §12.2 and §8.4
  at the next revision.

Template for a new entry:

```markdown
### DEC-NNN — <short title>

- **Date:** YYYY-MM-DD
- **Context:** what in the SDD was ambiguous, silent, or impossible to satisfy as
  written, and where (section reference).
- **Decision:** what was decided.
- **Alternatives considered:**
- **Why:**
- **SDD updated?** yes/no — if yes, link the PR that updated the SDD text or added an
  addendum, per CLAUDE.md §1.3.
```

## Part 3 — SDD §23 open questions: tracking table

The SDD ships a working default for every open question so none of them block the
build (SDD §23: "None of these block the build: each has a working default already in
the rules config or the plan."). This table tracks whether each has been confirmed,
overridden, or is still running on the default. Settle the "For the warden" group
before M3 per the SDD's own instruction.

**Status semantics — do not conflate these two things:**
- **"Pending"** in this table means *SDD working default — awaiting confirmation*. The
  build uses the default value today; nobody has signed off on it as final.
- A row only becomes a **confirmed final product decision** when the warden (or team,
  for §23.2 items) has actually responded — at which point this table should say
  "Confirmed, 150" or "Overridden, now 200" (for example), dated, not just "Pending" →
  "Done". Implementation must never treat "the default is already in the code" as
  equivalent to "this was decided."

### For the warden (SDD §23.1)

| # | Question | Working default | Confirmed? |
|---|---|---|---|
| Q1 | What time do visiting hours start? | 08:00 | Pending |
| Q2 | Between 8pm and 10pm, who may still enter? | Only warden-approved overnight/guest-room guests | Pending |
| Q3 | By what time must day guests leave? | 10:00 pm (night sweep time) | Pending |
| Q4 | What time must overnight guests leave on their last day? | 12:00 noon | Pending |
| Q5 | Male relatives (e.g. fathers): Visitors' Room only? | Yes | Pending |
| Q6 | "Prefer not to say" gender: Visitors' Room only? | Yes | Pending |
| Q7 | Maximum day guests inside per resident at once? | 3 | Pending |
| Q8 | Guest room price: ₹150 (rule 26.7) or ₹200 (rule 26.5)? | ₹150 (team decision, pending confirmation) | **Pending — see note below** |
| Q9 | Are parents treated differently in any way? | No | Pending |
| Q10 | Are the retention periods in §16.5 acceptable? | As written | Pending |
| Q11 | Written approval for the pilot with real data, naming the hostel administration as data owner | Required before pilot; fake data until then | Pending — **blocks real-data pilot** |
| Q12 | Which office staff get access, and their Gmail addresses? | Collected at M4 | Pending |

**Note on Q8 (precise reading — corrected during hostile review):**

| Where | What it says |
|---|---|
| Machine-readable config (SDD §4.3, `hostel_rules.config` v1) | `"guest_room": { ..., "charge_per_night_inr": 150 }` — **150** |
| Business-rule section (SDD §4.2, BR-08) | "guest room ₹ 150 per night", sourced to "26.6, 26.7" — **150** |
| Open question (SDD §23.1, Q8) | "Guest room price: ₹150 (26.7) or ₹200 (26.5) per day?" — working default column reads "₹ 150 (team decision, pending confirmation)" — **150**, explicitly flagged unconfirmed |

All three SDD-authored artifacts (config, BR-08, and Q8's own working-default column)
**agree with each other at ₹150** — there is no internal disagreement between HAVEN's
own implementation artifacts. The contradiction is one level down: it is between the
two *underlying PU hostel rule citations* the SDD references (rule 26.7, cited as ₹150,
vs. rule 26.5, cited as ₹200) — a discrepancy in the source regulation the SDD is
digitising, not in the SDD's own output. The SDD surfaces this discrepancy itself via
Q8 rather than silently picking a number.

**Is it safe to treat ₹150 as the working default for implementation?** Yes — every
implementation-facing artifact in the SDD already specifies 150, so building against
150 does not require guessing or picking a side; the engine, the config, and the priced
charge amount should all be 150. **Is it safe to treat ₹150 as a *confirmed final
product decision*?** No — the SDD explicitly marks Q8 unconfirmed ("pending
confirmation"), and real money will be charged to residents on this number, so it must
be put in front of the warden before the pilot goes live with real data (bundled with
Q11's real-data approval gate). This is recorded as **"SDD working default — awaiting
confirmation,"** not as a resolved decision, and nothing in this build should present
₹150 as beyond question.

### For the team (SDD §23.2)

| Item | Status |
|---|---|
| Domain name to buy (and who pays) | Pending |
| Receptionist's phone or a spare Android phone for the gate? | Pending |
| Is a Supabase Pro month worth it for backups during the pilot? | Pending |
| UI kit: plain StyleSheet + tokens (default) or Tamagui? | Running on default (StyleSheet + tokens) unless overridden in week 0 |
| How many residents use iPhones (affects reliance on SMS fallback)? | Pending — informs testing priority |
| Stream owners for §21.2 | Pending — fill in at kickoff |

### Calibration results (SDD §23.3)

Not yet run. Fill in after GPS field calibration (SDD §19.4), and mirror the result back
into the SDD's own §23.3 table in the same PR, per `CLAUDE.md` §1.3.

| Date | Phones tested | At-gate pass rate at 50m | Inside-room fixes passing | Chosen radius |
|---|---|---|---|---|
| — | — | — | — | — |

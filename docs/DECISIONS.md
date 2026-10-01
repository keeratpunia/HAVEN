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

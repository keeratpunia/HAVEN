# HAVEN — Implementation Plan

This plan expands the delivery plan in SDD §21 into dependency-ordered engineering
milestones. It does not change the SDD's milestone boundaries, requirement
assignments, or nine-week timeline — it adds the internal task breakdown and explicit
dependency order needed to execute each milestone without discovering missing
groundwork mid-sprint.

The gate loop (M2) is the critical path. If anything slips, protect M2 and cut from M4
("Ship") first — M4 already carries the C-priority slack items (SDD §21.4).

## 0. Guiding sequencing principles

1. **Schema before services; services before UI.** Every milestone below does
   migrations → shared types/rules → API services → client screens, in that order,
   because Kysely types are generated from the schema and Zod schemas in
   `packages/shared` are imported by both API and app.
2. **The rules engine is built once, in M1, and never duplicated.** It is pure and
   framework-free specifically so it can be unit-tested before any API route exists
   (SDD §4.4, §19.3). Build and 100%-branch-test it before wiring any endpoint that
   calls it.
3. **Auth and authorize() land before any protected route.** Nothing in M2+ can be
   built against a stubbed auth layer — `authorize()` is the single checkpoint every
   handler calls (SDD §3.4).
4. **The gate token + scan session + geofence trio is a single unit of work.** They are
   specified together (SDD §9.1–9.3) and the F1/F5 flows cannot be demoed with any one
   of them stubbed.
5. **Notifications outbox + worker is infrastructure, not a feature.** It must exist
   before any flow that promises a push (F1 onward) can be considered done, even in a
   throwaway/console-logging form, so later milestones don't retrofit it.
6. **Every M-priority FR ships inside its named milestone.** S- and C-priority items may
   slide to M4 or future scope if the critical path is at risk (SDD §21.4 risk table).

## 1. Milestone map

```
Week:     0        1    2        3    4        5    6        7    8        9  10
          ├─Setup──┤    ├──M1────┤    ├──M2────┤    ├──M3────┤    ├──M4────┤
                                                                    └── Pilot (2wk)──┘
```

| Milestone | Weeks | Depends on | Closing demo (SDD §21.1) |
|---|---|---|---|
| Week 0 — Setup | 0 | — | `/health` on staging; app opens on a phone; gate page renders a dummy QR |
| M1 — Foundation | 1–2 | Week 0 | A new resident signs up and the warden verifies her; audit log shows it |
| M2 — Gate loop | 3–4 | M1 | At the real GH-8 gate: invite → scan → photo → checked in → host sees photo → check out |
| M3 — Walk-ins and rules | 5–6 | M2 | A walk-in is approved from a push; one is rejected; one times out; the 22:00 sweep lists a planted guest |
| M4 — Ship | 7–8 | M3 | Warden runs the acceptance scenarios herself |
| Pilot | 9–10 | M4 | Success metrics (SDD §2.4) reviewed with the warden |

## 2. Week 0 — Setup

**Goal:** every environment exists and a trivial change can flow from laptop to staging.

- [ ] Repo scaffold matching SDD §20.1 layout (`apps/api`, `apps/mobile`,
      `packages/shared`, `packages/ui`, `packages/config`, `supabase/`,
      `.github/workflows/`).
- [ ] pnpm workspaces + Turborepo configured; `turbo.json`, `pnpm-workspace.yaml`.
- [ ] Supabase projects: local (CLI/Docker) + staging. `pg_cron`, `pgcrypto`, `citext`
      extensions enabled.
- [ ] Render/Railway API service (staging), Vercel web project (staging), EAS project.
- [ ] Google OAuth clients (web + Android), Expo push credentials.
- [ ] Domain purchased; `app.` and `api.` subdomains configured.
- [ ] Sentry projects (API + app).
- [ ] DLT SMS registration **started** (lead time is days–weeks — this is the item most
      likely to still be pending at pilot, per SDD §21.4 risk table; `SMS_PROVIDER=console`
      unblocks everything else).
- [ ] CI skeleton (`ci.yml`): install, lint, typecheck — green on an empty repo.
- [ ] `.env.example` populated with every variable name from SDD §20.3 (no values).
- [ ] Wireframe walkthrough with 2 guests and the warden (validates §13/§14 before
      code is written).
- [ ] Skeleton API (`/health`) and skeleton app deployed to staging.
- [ ] Gate page renders a dummy (non-cryptographic) QR, proving the Expo web → Vercel
      path works end to end.

**Exit criterion:** `/health` live on staging; app opens on a phone; gate page renders a
dummy QR (SDD §21.1).

## 3. M1 — Foundation

**Goal:** identity exists. A resident can sign up and get verified, with every action
audited.

Dependency order within the milestone:

1. **Schema**: migrations for §11.1–11.8 — extensions/enums, identity/hostel tables
   (`hostels`, `users`, `role_assignments`, `staff_invites`, `rooms`, `media`,
   `residents`, `visitors`, `bans`), rules/gate tables, triggers (`touch_updated_at`,
   `forbid_mutation`, `audit_row`), RLS + `haven_api` role. Visit/gate-event/charge
   tables are also created here (schema is one migration set) even though they're not
   exercised until M2 — this avoids a second schema-churn pass later.
2. **Shared package**: Zod schemas for auth/profile/resident endpoints
   (`packages/shared/src/api/`), constants (`packages/shared/src/constants.ts`), copy
   skeleton (`packages/shared/src/copy/en.ts`).
3. **Auth module** (`apps/api/src/auth/`): OTP request/verify (FR-01), Google sign-in
   (FR-03), JWT issue/refresh/rotation-with-reuse-detection, `policy.ts` with
   `authorize()` — even though only a few actions exist yet, the function and its test
   harness are built now so no later module invents its own check.
4. **Resident onboarding** (FR-02, FR-04): phone verify, hostel/room/ID card/selfie
   submission, warden verify/reject with ID-card deletion on decision (FR-05).
5. **Account lifecycle** (FR-07): warden deactivates any staff member or marks a
   resident `left`; the auth hook's 30-second revocation cache (built in step 3) means
   this takes effect within 30 s without any extra plumbing — this step is mostly a
   thin admin endpoint plus the W-04/W-08 "mark left" action.
6. **App**: R-01–R-04 screens (sign-in, verify phone, onboarding, pending), W-04
   Residents tab (warden verify/reject).
7. **Seed script** (`pnpm --filter api seed`): GH-8 hostel, gate (location unset),
   rules v1, super admin + warden seed invites; local/staging-only fake rooms,
   residents, visitors.
8. **CI**: integration tests against local Supabase (Docker) added; audit trigger
   covered by a pgTAP test proving no raw PII lands in `audit_log` (TC-SEC-08 lands
   here, early, since it's foundational). **FR-74** (every state change and admin
   action written to the append-only audit log) is substantively delivered here too —
   the audit trigger covers every mutating table from the single M1 migration batch
   (step 1), so FR-74 is tracked as an M1 deliverable even though the SDD's own §21.1
   milestone table doesn't name it in any milestone (see `docs/DECISIONS.md` DEC-002).

**Covers:** FR-01, FR-02, FR-03, FR-04, FR-05, FR-07, FR-74.

**Exit criterion:** a new resident signs up and the warden verifies her; audit log shows
it (SDD §21.1).

## 4. M2 — Gate loop (critical path)

**Goal:** the core product claim — scan, photo, in — works at the real gate.

Dependency order:

1. **Gate token** (`apps/api/src/gate/token.ts`, SDD §9.1): generate (client-side,
   offline-capable) and verify (server-side), secret encryption/rotation with 120 s
   grace. Unit tests TC-TOK-01..05 before anything calls it.
2. **Gate display page** (`/gate`, SDD §9.2): pairing flow (F8 steps 1–3), QR render
   loop, wake lock, heartbeat, offline badge. This replaces Week 0's dummy QR with the
   real cryptographic one.
3. **Scan sessions + geofence** (SDD §9.3): `POST /v1/scan-sessions`,
   `.../location` retry, haversine distance, `gps_ok` computation, nonce binding.
   Unit tests TC-GEO-01..05.
4. **Live photo capture** (SDD §9.4): web (`getUserMedia` + canvas) and native
   (`expo-camera`) behind one interface; server-side upload pipeline (magic bytes,
   `sharp` resize/strip-EXIF, SHA-256 dedupe).
5. **Visits module, invite half** (FR-10–FR-13): pre-invite creation, share-sheet
   link, invite claim (phone-match enforced), edit/cancel before entry.
6. **State machine** (`apps/api/src/visits/stateMachine.ts`, SDD §7.1): the full
   transition table is implemented now, even though only the invite→inside→completed
   path is exercised by M2's demo — this is the same reason the full schema landed in
   M1 (avoid a second pass). Concurrency rule (`WHERE status = $expected`) and
   `409 INVALID_TRANSITION` land with it.
7. **Check-in / check-out** (FR-21–FR-24, FR-26): gate landing page, scan →
   action-offer logic, check-in/out endpoints running `evaluateEntry`/`evaluateExit`
   inside the one-transaction pattern (gate event + visit update + audit + outbox, all
   or nothing).
8. **Gate device pairing — backend, plus the minimum warden-facing surface needed for
   calibration** (F8 steps 1–5): pairing endpoint, secret encryption/rotation,
   device-revoke endpoint. The **gate-location "Capture" flow** (F8 step 4: 5 GPS
   readings averaged, saved as the gate's lat/lng) is pulled forward into M2 — even
   though the SDD attributes the full warden-facing W-09 device-management screen to
   M4 — because GPS field calibration (SDD §19.4) cannot begin without a saved
   reference point to measure distance against, and this plan starts calibration in M2
   per the schedule-risk mitigation in SDD §21.4 (see `docs/DECISIONS.md` DEC-001 for
   the full reasoning — the SDD's own §21.1 and §21.4 disagree on timing, and this plan
   follows §21.4). The rest of W-09 (device list, add/revoke buttons, polished admin
   UX) stays an M4 deliverable; a minimal/unstyled "set location" control, or a seed
   script, is enough for M2's purposes. Full FR-56 (pairs **and** revokes **and** sets
   location, self-service, via the finished warden screen) is not claimed done until
   M4 — see M4 below.
9. **In-app QR scanner** (FR-22, S-priority): guest home screen offers an in-app
   scanner as an alternative to the device camera app, using `@zxing/browser`. Builds
   directly on the live-camera component from step 4.
10. **Notifications outbox + worker, minimal slice**: table, worker loop, N-ARRIVED and
    N-LEFT only (console/SMS-stub transport is fine — the DLT template registration
    from Week 0 may not have landed yet).
11. **Host arrival confirmation** (FR-42, R-09): push received, photo-compare screen,
    Yes/Not-my-guest buttons visible. FR-42 itself only requires the push and the
    buttons to exist — it is fully delivered here, in M2, matching SDD §21.1's explicit
    "FR-42" entry on the M2 row. (SDD §21.1's M3 row separately lists the range
    "FR-40–45", which numerically includes 42 again — this is read as the SDD's range
    shorthand sweeping in an already-delivered id, not a second build of FR-42; the
    substantive M3-only work behind the dispute button is FR-43, tracked separately
    below.)
12. **App screens**: G-01 through G-18 guest flow, D-01/D-02 gate device, R-05/R-06/R-07
    (host invite/share), R-09 (arrival card).
13. **E2E**: Playwright coverage of F1 and F5 with fake geolocation + fake camera.

**Covers:** FR-10, FR-11, FR-12, FR-13, FR-20, FR-21, FR-22, FR-23, FR-24, FR-26 (for
invites), FR-28 (stretch if time allows), FR-30, FR-42.

**Exit criterion:** at the real GH-8 gate — invite → scan → photo → checked in → host
sees photo → check out (SDD §21.1). **GPS field calibration (SDD §19.4) should begin
during this milestone, not deferred to week 8.** This is an engineering scheduling
decision, not an uncontested SDD requirement: SDD §21.1's milestone-content table lists
"GPS calibration 19.4" under **M4**, while SDD §21.4's schedule-risk table instructs
"Calibrate in week 3, not week 8" — i.e. M2. These two parts of the SDD contradict each
other; this plan follows §21.4 and logs the reasoning in `docs/DECISIONS.md` DEC-001.
Do not treat the M2-start choice as something the SDD unambiguously mandates.

## 5. M3 — Walk-ins and rules

**Goal:** the system enforces PU's actual rules automatically and handles the messy
real-world paths (unannounced guests, disputes, forgotten check-outs, overstays).

Dependency order:

1. **Rules engine, full** (SDD §4.4–4.6): `evaluateCreate`/`evaluateEntry`/`evaluateExit`
   complete per the evaluation order in §4.5, with every worked example in §4.6 as a
   unit test (TC-RULE-01..16). This was stubbed/partial in M1–M2 to the extent invite
   creation needed it; M3 completes gender/zone rules, overnight quota, day-guest
   limits, cutoffs.
2. **Walk-in flow** (F2, FR-25, FR-40, FR-41): room/resident search, visit-type
   picker, host approval push with 60 s SMS fallback, 10-minute expiry job.
3. **Location-unverified flow** (F3, FR-27): host-confirm path, `location_unverified`
   flag, amber badge plumbing to the warden dashboard.
4. **Dispute flow** (F9, FR-43): "Not my guest" → `host_disputed_at` → warden
   push+SMS → W-05 resolution actions. (FR-42, the push + Yes/Not-my-guest buttons
   themselves, is already done — delivered in M2; see M2 step 11. FR-43 is the
   consequence of tapping "Not my guest.")
5. **Forgotten check-out** (F10, FR-44, FR-45): overstay job, host "My guest has left",
   warden escalation after 30 min.
6. **Scheduled jobs** (SDD §9.8, §11.8): `job_expire_walkins`, `job_expire_approved`,
   `job_flag_overstays`, `job_night_sweep`, `job_gate_offline`, `job_expire_sessions`
   — all as idempotent `pg_cron` SQL functions, all tested with pgTAP and a fixed
   `p_now`. **Note:** `job_gate_offline` (the 5-minute-silent warden alert) is built
   here, but SDD §21.1 attributes the full **FR-29** id to M4, not M3 — this plan does
   not claim FR-29 "done" until M4 (matching the SDD), even though the underlying job
   lands earlier. See M4 below.
7. **Notifications outbox + worker, complete**: remaining kinds from SDD §15.2, SMS
   fallback timers, `dedupe_key` coverage, DLT templates live (registration should be
   approved by now, started in Week 0).
8. **SSE live dashboard** (SDD §9.9, FR-50): `LISTEN`/`NOTIFY` trigger, `/v1/stream`,
   W-01 Dashboard tiles, W-02 Inside now.
9. **App screens**: R-08 (walk-in approval), R-10 (forgotten check-out),
   W-01/W-02/W-03 (emergency roll call — FR-51, printable/exportable inside-now list),
   W-04/W-05.

**Covers:** FR-25, FR-27, FR-40, FR-41, FR-43, FR-44, FR-45,
FR-50, FR-51, FR-52, FR-53, FR-70, FR-71, FR-72, FR-73.

**Note on flow F4:** host-assisted entry (F4, FR-28 if the M2 stretch attempt doesn't
land) is **not** an M3 deliverable in this plan — SDD §21.1 explicitly places F4 under
**M4** ("F4, F6" on the M4 row). An earlier draft of this plan had it in M3; this was a
misreading, corrected during the 2026-10-01 hostile review (see `docs/DECISIONS.md`
DEC-002). FR-51, by contrast, genuinely is an M3 item — it falls within SDD §21.1's
explicit "FR-50–53" range on the M3 row — and stays here.

**Exit criterion:** a walk-in is approved from a push; one is rejected; one times out;
the 22:00 sweep lists a planted guest (SDD §21.1).

## 6. M4 — Ship

**Goal:** everything needed for a warden to run the hostel on HAVEN unsupervised, plus
the operational and compliance groundwork the pilot depends on.

Dependency order:

1. **Overnight / guest-room flow** (F6, FR-14, FR-15, FR-16): quota preview, warden
   approval, charge creation.
2. **Host-assisted entry** (F4, FR-28 if not already done as the M2 stretch goal):
   native QR scan, mocked-location detection (Android `location.mocked` check →
   `MOCK_LOCATION` 403), phone-less visitor creation, host-assisted exit. Placed here,
   not M3, per SDD §21.1's explicit "F4, F6" on the M4 row — corrected during the
   2026-10-01 hostile review (`docs/DECISIONS.md` DEC-002).
3. **Charges module** (BR-08, BR-18): pending/confirmed/paid/waived lifecycle, office
   view (confirm + mark-paid only — **not** waive), warden-only waive and manual fines.
4. **Bans and suspensions** (FR-54): guest ban (hostel or global, timed or permanent),
   host hosting-suspension with future-visit cancellation (BR-10).
5. **Rules admin UI** (FR-55, W-06): form-driven rules editing, versioned save.
6. **Gate device admin, complete** (FR-56, W-09): the full warden-facing screen — add
   device / generate pairing code, device list, revoke — plus gate-location recapture
   UX. (The underlying revoke/secret-rotation endpoints and a minimal location-capture
   path for GPS calibration were already built in M2, step 8 — this step delivers the
   self-service warden UI that makes FR-56 complete as the SDD describes it: *"warden
   pairs and revokes gate devices and sets the gate location."*)
7. **Search, audit, reports** (FR-57, FR-58, W-11, W-12): visit search/export, audit
   log viewer, CSV reports. The audit log viewer surfaces the `read.*` audit rows
   required by SDD §16.4 ("Audit of reads") in addition to the mutation rows already
   logged since M1 — confirm both kinds render correctly here.
8. **Staff invites** (FR-06, F11): warden invites office, super admin invites warden.
9. **Retention and deletion** (FR-75, FR-09, SDD §16.5–16.6): `job_retention`, account
   deletion request flow (FR-09) with the 7-day worker and unpaid-charges hold.
10. **Profile editing** (FR-08): guest and resident edit name, retake profile photo (no
    re-verification needed for guests; resident photo changes logged).
11. **Security checklist sign-off** (SDD §16.4): run every item before any real data is
    loaded, including the headers/CORS/cookie controls and the "two people max hold
    Supabase owner access, MFA everywhere" access-control item — this gates the pilot,
    not just the milestone.
12. **GPS field calibration, finalize** (SDD §19.4): if not already converged during
    M2/M3 (started early per `docs/DECISIONS.md` DEC-001), complete it now; record
    results in SDD §23.3.
13. **Daily digest** (FR-60, C-priority). The SDD's own §21.1 milestone table does not
    assign FR-60 to any milestone — consistent with its "could have if time allows"
    priority — so this placement in M4 is this plan's own scheduling judgment, not an
    SDD instruction. Cut first if time is short.
14. **Acceptance test pass** (SDD §19.6): warden runs all seven scripted scenarios
    herself.

**Covers:** FR-06, FR-08, FR-09, FR-14, FR-15, FR-16, FR-54, FR-55, FR-56, FR-57,
FR-58, FR-59, FR-60 (C, this plan's placement — see note above), FR-29, FR-75.

**Note on FR-29:** the heartbeat *send* mechanism and the gate's "online" indicator are
functionally needed from M2 onward (SDD §9.2 bundles heartbeat into the core `/gate`
page spec, and the M2 demo itself requires a visibly "Online" gate device). Only the
**5-minute-silent warden alert** (`job_gate_offline`, built in M3 — see M3 step 6) and
this formal "FR-29 covered" attribution follow SDD §21.1, which places the full FR-29
id in M4. Don't read the M4 attribution as meaning no heartbeat exists before M4 — it
means the complete requirement (send + alert) is only claimed done here.

**Exit criterion:** warden runs the acceptance scenarios herself (SDD §21.1).

## 7. Pilot (2 weeks)

Real guests at GH-8, paper register kept in parallel as a fallback (not a backfill
source — SDD §18.3). Daily health check by the on-duty team member (SDD §18.2). Fixes
only — no new features. Success metrics from SDD §2.4 reviewed with the warden at the
end.

Pre-pilot gate (must all be true before go-live):
- [ ] Written warden/hostel-administration approval for real data (SDD §16.3, Q11).
- [ ] Security controls checklist (SDD §16.4) fully checked.
- [ ] GPS calibration recorded (SDD §23.3).
- [ ] Restore drill completed once against a staging backup (SDD §18.4).
- [ ] Smoke test (SDD §19.5) green on production.

## 8. Team streams (SDD §21.2)

Four streams, one owner each; owners review each other's PRs across streams.

| Stream | Owns | Week 0 deliverable |
|---|---|---|
| A — Data and platform | Migrations, RLS, triggers, jobs, seed, CI/CD, environments, backups | Supabase local + staging, CI green |
| B — API core | Auth, visits service, state machine, rules engine (with tests), charges, admin endpoints | Skeleton Fastify app: config, errors, logging, `/health` |
| C — Gate and guest web | Gate display, token, scan sessions, geofence, live camera, guest screens G-01–G-18, Playwright | Gate page rendering a locally generated QR |
| D — Resident and warden app | Expo app shell, Google sign-in, push registration, R- and W- screens, office screen, SSE client | App with sign-in screen running on a phone |

Streams A and B jointly own §16 (security/privacy) sign-off. Everyone writes tests for
their own code.

## 9. Definition of done

See `docs/DEVELOPMENT.md` §"Definition of done" — based on SDD §21.3's eight items
verbatim, **plus one project-added item** (keeping `docs/TRACEABILITY.md` current).
That ninth item is an engineering-process addition this project is choosing to hold
itself to, not an SDD requirement — flagged here rather than silently folded in, per
`CLAUDE.md` §1.3's rule against letting code/process and the SDD drift without saying
so. Not restated twice to avoid the two copies drifting.

## 10. Schedule risks carried into this plan (SDD §21.4)

| Risk | Effect | Mitigation baked into this plan |
|---|---|---|
| DLT SMS registration slow | No real SMS during pilot | Started Week 0; M2/M3 build against `SMS_PROVIDER=console` so nothing blocks on it |
| GPS unusable at the gate | Many host-confirm fallbacks | Calibration starts in M2 (week 3) per SDD §21.4's explicit instruction, not M4 as SDD §21.1's milestone table would otherwise imply — see `docs/DECISIONS.md` DEC-001 for the contradiction and why this plan follows §21.4 |
| Expo/Google Sign-In config pain | Week 0–1 slip | Stream D spikes it on day 1 of Week 0 with a throwaway build |
| Camera behaviour differs on iOS Safari | Guests on iPhone blocked | Tested on a real iPhone during M2; host-assisted entry is the documented fallback |
| Exams / submissions | Team availability drops | M4 carries the only C-priority items (FR-60), so it's the milestone with slack to cut |

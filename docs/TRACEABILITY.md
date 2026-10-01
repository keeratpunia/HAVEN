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

## 1. Functional requirements (FR-xx) — SDD §5

### 5.1 Accounts and onboarding

| ID | Priority | Requirement (summary) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-01 | M | Guest signs in with 6-digit SMS OTP | — | — | — |
| FR-02 | M | First-time guest profile: name, gender, 18+, consent, profile selfie | — | — | — |
| FR-03 | M | Residents and staff sign in with Google | — | — | — |
| FR-04 | M | Resident phone OTP, room number, ID card photo, selfie, awaits verification | — | — | — |
| FR-05 | M | Warden sees pending residents, approves/rejects in one tap; ID card deleted on decision | — | — | — |
| FR-06 | S | Warden invites office by email; super admin invites wardens; 48h expiry bound to email | — | — | — |
| FR-07 | M | Warden deactivates staff / marks resident left; sessions end immediately | — | — | — |
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
| FR-74 | M | Every state change and admin action written to append-only audit log | — | — | — |
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
| NFR-12 | Maintainability | Rules engine 100% branch coverage; API services ≥70% line coverage; no `any` | — | — | — |
| NFR-13 | Observability | Every request has a request ID; errors reach Sentry within 1 min | — | — | — |
| NFR-14 | Cost | ≤ ₹1,500/month during pilot | — | — | — |

## 3. Business rules (BR-xx) — SDD §4.2

| ID | Rule (summary) | Enforced at | Implementation | Tests | Status |
|---|---|---|---|---|---|
| BR-01 | No admission without verified, non-suspended host approval | Create + entry | — | — | — |
| BR-02 | Day/quick-drop guests must check in before 20:00 | Entry | — | — | — |
| BR-03 | No guest may check in at/after 22:00 | Entry | — | — | — |
| BR-04 | Day visit windows between visiting_start and day_visit_latest_end, one date | Create | — | — | — |
| BR-05 | Overnight in room: max 3 nights/host/calendar month (IST) | Create | — | — | — |
| BR-06 | Overnight in room: at most one overnight guest per host at a time | Create | — | — | — |
| BR-07 | Opposite/undisclosed gender → visitors_room zone, no overnight/guest_room | Create + display | — | — | — |
| BR-08 | Overnight ₹50/night, guest room ₹150/night; pending charge on warden approval. **₹150 is an SDD working default awaiting warden confirmation, not yet a final decision** — see `docs/DECISIONS.md` Q8 note | Approval | — | — | — |
| BR-09 | Banned guests cannot be invited, request entry, or check in | Create + entry | — | — | — |
| BR-10 | Suspended hosts cannot create/approve; future visits cancelled on suspension start | Create + entry | — | — | — |
| BR-11 | Host max `max_active_day_guests` (default 3) day/quick guests inside at once | Create + approval | — | — | — |
| BR-12 | Walk-in expires if host doesn't decide within 10 min | Job | — | — | — |
| BR-13 | Overstay when inside past `window_end + 15 min` | Job | — | — | — |
| BR-14 | At 22:00, every inside day/quick guest listed to warden | Job | — | — | — |
| BR-15 | A guest can be inside only one visit at a time, anywhere | DB constraint | — | — | — |
| BR-16 | Pre-invites ≤7 days ahead; overnight requests ≤30 days ahead | Create | — | — | — |
| BR-17 | Check-out never refused for rule reasons; failed GPS on exit allowed but flagged | Exit | — | — | — |
| BR-18 | Warden manual fine, minimum ₹400 for unregistered guest | Warden action | — | — | — |
| BR-19 | Overnight window: visiting_start on arrival date to 22:00; checkout by overnight_checkout_time | Create + entry | — | — | — |
| BR-20 | Guest may arrive up to 30 min before window_start | Entry | — | — | — |

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
| E-19 | Overnight stay spans two months | Nights split by month for quota | — | — | — |
| E-20 | Two residents claim the same room | Allowed (roommates) | — | — | — |
| E-21 | Host disputes by mistake | Warden resolves after talking to host; visit stays as is | — | — | — |
| E-22 | Guest never checks out, host doesn't respond | Overstay → warden escalation → night sweep → force check-out | — | — | — |
| E-23 | Two gate devices paired to one gate | Both show valid QRs (same secret); either works | — | — | — |
| E-24 | Approved guest arrives at a different hostel's gate | No matching visit there; only Request entry offered | — | — | — |

## 5. Test cases (TC-xx) — SDD §19.2

### Rules engine (TC-RULE)

| ID | Case | Expected | Test file | Status |
|---|---|---|---|---|
| TC-RULE-01..11 | All worked examples in SDD §4.6 | As listed | — | — |
| TC-RULE-12 | Undisclosed gender, day invite to GH-8 | allow, zone `visitors_room` | — | — |
| TC-RULE-13 | Host status `pending` creates invite | deny `HOST_NOT_VERIFIED` | — | — |
| TC-RULE-14 | Suspended host until yesterday | allow (suspension expired) | — | — |
| TC-RULE-15 | Overnight overlap with existing approved overnight | deny `OVERNIGHT_OVERLAP` | — | — |
| TC-RULE-16 | Exit after window + grace | allow with `LATE_EXIT` flag | — | — |

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
| TC-SEC-05 | Deactivated user's access token after 30s | `SESSION_REVOKED` | — | — |
| TC-SEC-06 | Reused refresh token | 401 and whole session revoked | — | — |
| TC-SEC-07 | `UPDATE haven.gate_events` as `haven_api` | permission error | — | — |
| TC-SEC-08 | Audit row for a visit update | contains no `invited_phone`, `invited_name` | — | — |
| TC-SEC-09 | 4th OTP request in 10 min for one phone | `RATE_LIMITED` | — | — |
| TC-SEC-10 | Upload a PNG with EXIF GPS | stored file has no EXIF | — | — |
| TC-SEC-11 | Same photo bytes uploaded twice by one visitor | `PHOTO_REUSED` | — | — |

## 6. Coverage summary (update when rows change)

| Category | Total IDs | Done | WIP | Not started | Deferred |
|---|---|---|---|---|---|
| FR | 50 (FR-01..09, 10..16, 20..30, 40..45, 50..60, 70..75) | 0 | 0 | 50 | 0 |
| NFR | 14 | 0 | 0 | 14 | 0 |
| BR | 20 | 0 | 0 | 20 | 0 |
| E | 24 | 0 | 0 | 24 | 0 |
| TC | 51 (TC-RULE ×16 [incl. the TC-RULE-01..11 worked-examples group], TC-TOK ×5, TC-GEO ×5, TC-FLOW ×12, TC-JOB ×2, TC-SEC ×11) | 0 | 0 | 51 | 0 |

Counts verified by direct enumeration against SDD §5, §17.1, §4.2, §17.3, §19.2 during
the hostile planning review (2026-10-01). Recount this table if any ID range in the SDD
changes — do not hand-adjust without re-enumerating.

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

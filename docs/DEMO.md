# HAVEN — Demo script

A live walkthrough of the gate loop and the resident minimal slice (docs/DECISIONS.md
DEC-011), for a presentation audience, not a real deployment. This runs its own local
database and server — it never touches staging or production (see the "Safety"
section below).

## 0. Before you present

### 0.1 Start the stack

```
pnpm demo
```

This starts, in order: an embedded local Postgres with a fresh seed (GH-8 hostel, two
verified residents, one gate, a warden, an office user, a super admin, a resident
waiting for verification, three guests inside, an overnight request and two charges),
the real API (real clock, dev sign-in enabled, outbox worker and background jobs on),
and the Expo web app. Wait for the banner:

```
========================================================================
HAVEN demo is up.
  Web:  http://localhost:8081
  API:  http://localhost:8080
  Resident dev sign-in: priya@haven.demo, fatima@haven.demo (any password-free email)
  Staff dev sign-in: warden@haven.demo (warden), office@haven.demo (office), admin@haven.demo (super admin)
  Guest OTP: read "[otp:dev] ... purpose-code=" above, or use +91 9999900001/02 with code 123456
  Gate pairing code: printed above by [db] — regenerate anytime with:
    pnpm --filter @haven/api run demo:pair-code
========================================================================
```

Scroll up in the same terminal to find the line `Gate pairing code: XXXX-XXXX
(expires ...)` printed by `[db]`. **It expires 10 minutes after the stack starts** — if
you're still in setup when it expires, run `pnpm --filter @haven/api run demo:pair-code`
to mint a fresh one without restarting anything.

### 0.2 Set the gate location to the room you're presenting in

Stop the stack (Ctrl+C) and restart with your room's real coordinates:

```
DEMO_GATE_LAT=<your latitude> DEMO_GATE_LNG=<your longitude> pnpm demo
```

Find your coordinates from any map app (long-press a point → coordinates). The
geofence radius defaults to 150m (wider than production's real gates — indoor GPS at
a presentation venue is usually much less accurate than outdoors); override with
`DEMO_GATE_RADIUS_M` if needed.

### 0.3 Expose it over HTTPS (phones require HTTPS for camera + GPS)

**Use ONE tunnel, not two.** An earlier version of this doc had you tunnel ports 8080
and 8081 separately — a live rehearsal (2026-10-04) found that breaks sign-in: the
guest's session cookie is `SameSite=Lax`, and two different random tunnel hostnames
count as different *sites* to the browser, so it correctly refuses to send the cookie
from one to the other. Every time the guest's phone opened a fresh page (e.g. after
scanning the gate QR with the camera app), it forgot they were signed in and asked for
phone+OTP again. (A real deployment doesn't hit this because `WEB_BASE_URL` and
`API_BASE_URL` are subdomains of one shared domain there — same-site. A quick tunnel
has no such shared domain.)

The fix, and the only supported path now: tunnel a single local port that serves
**both** the web app and the API. `pnpm demo` already does the merging for you via
`scripts/demo-proxy.mjs` (`/v1/*` → the API on :8080, everything else → the web app on
:8081) — it starts automatically whenever `WEB_BASE_URL` and `API_BASE_URL` are set to
the *same* non-localhost value. You only need to tunnel port **9000**, not 8080/8081.

**Start the tunnel first** — you need its URL before starting the demo stack, because
the API bakes the web app's HTTPS URL into every QR code and invite link, and the web
app bakes the API's HTTPS URL in at build time. Since both are now the same URL, you
only do this once:

**cloudflared** (recommended, no account needed for a quick tunnel):

```
cloudflared tunnel --url http://localhost:9000
```

**ngrok** (equivalent):

```
ngrok http 9000
```

Note the `https://*.trycloudflare.com` (or ngrok) URL it prints — call it `TUNNEL_URL`.
Then start the demo stack pointed at it, setting `WEB_BASE_URL` and `API_BASE_URL` to
the **identical** value:

```
WEB_BASE_URL=<TUNNEL_URL> API_BASE_URL=<TUNNEL_URL> \
CORS_ORIGINS=<TUNNEL_URL> \
DEMO_GATE_LAT=<lat> DEMO_GATE_LNG=<lng> \
pnpm demo
```

Watch for this line in the output, confirming the proxy started:

```
WEB_BASE_URL and API_BASE_URL match — starting the local merge proxy on :9000.
```

If you don't see it, double-check `WEB_BASE_URL` and `API_BASE_URL` are set to the
*exact same string* (including `https://`, no trailing slash) — the proxy only starts
when they match.

`CORS_ORIGINS` must match `TUNNEL_URL` exactly or the browser will block API calls.

Quick tunnels (`cloudflared tunnel --url ...` / plain `ngrok http`) issue a **new
random URL every time they start** — if you restart the tunnel mid-rehearsal, restart
`pnpm demo` with the new URL too. For a longer rehearsal session, keep the tunnel
running continuously rather than restarting it.

### 0.4 Phone setup

- Any modern phone browser (Chrome/Safari) — no app install.
- Grant camera and location permission when the browser asks (both are requested only
  at the gate screen, not at sign-in).
- Turn off any "fake GPS" app before the real run — the client checks
  `location.mocked` and the server mirrors it (`MOCK_LOCATION`, 403); a dev phone with
  a mock-location app left on from testing will be refused.
- If you rehearsed with Chrome DevTools' location override, that only affects desktop
  Chrome — it has no effect on a real phone's GPS.

## 1. The script

Have two guest phones (or a phone + a desktop browser profile) ready: **Guest A**
(scripted check-in/check-out) and **Guest B** (walk-in).

### A. Resident signs in, creates an invite, copies the link

1. On a laptop, open `<WEB_TUNNEL_URL>/` (or `http://localhost:8081/` if not
   tunnelling) → **Resident sign-in** (R-01).
2. Under **Development sign-in**, enter `priya@haven.demo` → **Sign in**. (This is the
   dev-only bypass, docs/DECISIONS.md DEC-011 — point out there's no password because
   there's no real Google OAuth configured for this throwaway environment; a real
   deployment requires Google Sign-In, SDD §9.5.) You land on **Home** (R-05).
3. **Invite** tab (centre +) → fill in Guest A's name and phone, keep **Day visit**,
   today's date, a start/end time that brackets "now." The rule hints under the time
   fields come from the shared rules engine; **Create invite** enables once the
   server's preview agrees.
4. The **Share invite** screen (R-07) shows the exact SDD §15.4 T-INVITE message with
   **Share on WhatsApp**, **Share…** (phones) and **Copy link**.

### B. Guest A opens the link, OTP, profile with live selfie

5. Open the copied link on Guest A's phone.
6. Enter Guest A's phone number. Get the code either by reading `[otp:dev] ...
   purpose-code=` from the API terminal, or (simpler on stage) use one of the
   non-production test numbers `+91 9999900001`–`09` with the fixed code `123456` (SDD
   §9.5) — no server log needed.
7. First-time guest: fill in name/gender/18+ confirmation, then a live selfie (camera
   only, no file picker — CLAUDE.md §3.7).
8. "Your pass is ready."

### C. Laptop shows the gate display

9. Open `<WEB_TUNNEL_URL>/gate` on the laptop/projector.
10. Point out: the QR **changes every 10 seconds** (SDD D2) and the screen shows no
    personal data — just the rotating code (CLAUDE.md §3.8, "no receptionist
    verification").

### D. Guest A scans, GPS check, live photo, checked in

11. Guest A scans the laptop's QR with their phone camera.
12. First-time-only location explainer → **Allow location**.
13. Server confirms the geofence; app shows **Check in** with the visit summary →
    tap it → live photo → **Use photo**.
14. Green "You're checked in" screen, with the visit's zone and end time.

### E. Guest A checks out the same way

15. Back at `/gate`, Guest A scans the (now-different) QR again.
16. App offers **Check out** this time (same visit, now inside) → live photo → done.

### F. Walk-in: Guest B requests entry, resident approves, guest's screen turns green on its own

**Expect a brand-new Guest B to scan twice — this is an accepted deviation
(docs/DECISIONS.md DEC-013).** The QR code is only valid for 30 seconds, and a
first-time guest's sign-up (location → phone/OTP → profile → selfie) takes longer. When
they finish, the app says **"You're signed in — Scan the QR on the gate screen once
more to continue. Your details are saved."** How to narrate it: "First-time guests scan
once more after signing up. Nothing they typed is lost, and it means every gate action
is backed by a code that's under 30 seconds old — a screenshot can't be reused. From
their second visit on, it's one scan." Tip for a smooth demo: have Guest B sign in first
(open the app → **Sign in**) and then scan, which avoids the second scan entirely.

17. Guest B (no invite) scans the gate QR directly (`/gate` → camera).
18. Location check → signs in with OTP (or the test-number shortcut) → profile + live
    selfie (first time) → **Find your host** → room `101` → **Priya Sharma** → visit
    type → live selfie → **Waiting for host**. If they see **"You're signed in"**
    (see note above), they scan the gate QR once more — it picks up instantly, straight
    to **Find your host**.
19. On the resident's laptop (on **Home**): within ~10 seconds a **Guest at the gate**
    banner appears with the SDD §15 N-WALKIN text (on Android this is a push
    notification). Tap it — it opens the walk-in request (R-08) with Guest B's live
    photo next to their profile photo, visit type, duration, editable "Leaves by" time
    and the location-verified line.
20. Tap **Approve** (or **Reject** → reason → **Reject request**).
21. **Without touching Guest B's phone**, within ~3 seconds their screen turns green
    on its own (FR-26) — point this out explicitly, it's the thing that's easy to miss
    if you blink. Guest B's phone never reloads or re-scans.

### G. Failure cases

- **Old/screenshotted QR:** screenshot the gate screen, wait >30 seconds, then try to
  scan the screenshot. The app shows "That code has changed" (`GATE_TOKEN_EXPIRED`)
  and tells the guest to scan the live screen again.
- **GPS failure:** turn off phone location (or walk out of the geofence radius) before
  scanning. After 3 failed attempts the app offers **Ask host to confirm** — proceeds
  to `awaiting_host_confirmation` instead of blocking the guest outright (FR-27).

### H. Warden and office

Open a separate browser window (or a private window) at the web URL and sign in with
the dev sign-in. Wide windows (1024 px and up) show a sidebar; a phone-width window shows
bottom tabs. Staff land on their own screens: wardens on **Dashboard** (W-01), office
staff on **Charges** (O-01), the super admin on **Residents**.

What the seed gives you, relative to the moment you started `pnpm demo`:

| Who / what | Shows up on |
|---|---|
| Ananya Rao inside, guest of Priya (on time) | Dashboard "Inside now", Inside |
| Kavya Menon inside past her window (overstay) | Dashboard "Overstaying" (amber), Inside |
| Riya Das inside, Fatima said "Not my guest" | Dashboard "Disputed" (red), Search visits |
| Sneha Pillai invited for later today | Dashboard "Expected today" |
| Meghna Joshi, 2-night overnight request from Priya | Approvals → Overnight requests |
| Neha Verma, room 103, waiting for verification | Approvals → Residents (ID card + selfie) |
| ₹100 overnight charge (Fatima, pending), ₹400 fine (Priya, confirmed) | Office → Charges |

**Warden walkthrough** (`warden@haven.demo`):

22. **Dashboard:** point at the tiles, the gate status (offline until you pair the gate
    laptop; then green) and the latest gate events. The **● Live** badge means the
    screen is on the live stream (SDD §9.9). If it says "Updating every 15 s", the
    stream dropped and the screen is polling while it reconnects.
23. Keep the dashboard open on the projector and have a guest check in (step D). The new
    entry and the Inside count appear **without reloading**. Point this out.
24. **Approvals → Residents:** Neha Verma's ID card and selfie. **Verify Neha Verma**.
    The confirmation says the ID card photo was deleted (FR-05: it's kept only until the
    decision).
25. **Approvals → Overnight requests:** Meghna Joshi, nights, the ₹ charge and Priya's
    monthly quota. **Approve** creates the charge (BR-08).
26. **Inside → Riya Das** (W-05): timeline, the GPS distance (never raw
    coordinates), and the host's dispute. Show **Resolve dispute**. Then **Force
    check-out** (reason required) and **Ban guest**. If Riya scans the gate again, she
    gets "You can't enter this hostel". Every one of these lands in **Audit log**.
27. **Rules:** change a value (for example the day cutoff) and publish. It saves as a
    new version, and the very next gate scan uses it, with no deploy (SDD §4).
28. **Gates:** pair a device, **Set location** (it averages 5 GPS readings, FR-56) and
    **Revoke**. **Emergency roll call**, **Reports** (CSV export) and **Audit log** are
    under **More**.

**Office walkthrough** (`office@haven.demo`):

29. **Charges:** the overnight charge you just approved is here. **Confirm**, then type
    a receipt number and **Mark paid**. Point out what the office **doesn't** see: no
    guest phone numbers and no photos (TC-SEC-03, stripped by the API, not hidden by
    the screen).
30. Back as the warden: **More → Charges** can **Waive** (reason required) or **Create
    fine** (₹400 minimum, BR-18). The office can't do either.

**Super admin** (`admin@haven.demo`): lands on **Residents** and can manage residents,
bans, rules, gates and the audit log in any hostel, invite wardens and create hostels
(**Staff**). The day-to-day screens (dashboard, approvals of stays, emergency list,
reports, charges) are the warden's. This is deliberate (docs/DECISIONS.md DEC-014).

**Staff sign-in without Google:** this demo has no Google OAuth credentials, so staff
use the same dev sign-in as residents. It is refused outside `NODE_ENV=development`
(DEC-011). Staff invites (W-10) create a real 48-hour link bound to an email, but
accepting one needs Google sign-in, so you can show the invite being created, not
accepted.

### I. Notifications, background jobs and account deletion

**What runs in the background.** The demo API is the one instance with
`WORKER_ENABLED=true`. Every 2 seconds it delivers whatever is waiting in the
notification outbox. Every minute it runs the scheduled jobs from SDD §9.8 on their
real schedule: walk-in expiry every minute; overstays, approved-visit expiry and gate
offline every 5 minutes; the night sweep at 22:00 IST; retention at 03:00 IST.

- **Push** goes only to phones running the HAVEN Android app. On the web, residents see
  the same message under **Notifications**. Wardens on the web have no notification
  list (W-01..W-12 don't include one), so their alerts show up as the dashboard tiles
  changing live. To show a warden's alert itself, use the Android app.
- **SMS** isn't really sent. It's printed in the terminal using the registered DLT
  template, with the phone number masked, for example:
  `[api] [sms:dev] +91•••••43210 HAVEN_OVERSTAY: Your HAVEN visit ended at 4:30 pm. Please check out at the gate now.`

**Triggering a job now instead of waiting.** Run these in a second terminal while
`pnpm demo` is running:

```
pnpm --filter @haven/api run demo:job -- list                 # every job and its schedule
pnpm --filter @haven/api run demo:job -- overstay VDEM001     # Ananya's visit ended 16 min ago
pnpm --filter @haven/api run demo:job -- escalate VDEM001     # ...and was flagged 31 min ago
pnpm --filter @haven/api run demo:job -- run job_night_sweep  # the 22:00 sweep, now
pnpm --filter @haven/api run demo:job -- gate-offline         # paired gate screens silent 6 min
```

31. **Force an overstay.** Keep the warden dashboard on the projector and run
    `overstay VDEM001`. The **Overstaying** tile goes up without a reload. Priya's
    **Notifications** shows "Your guest is still inside", and the terminal prints the
    guest's SMS. Run it again and nothing new is sent. That's the rule: one overstay
    push per visit (SDD §15.5, TC-JOB-01).
32. **Escalate it.** `escalate VDEM001` sends the wardens a push (Android) "Guest
    overstaying — Ananya Rao (host Priya Sharma, room 101) is 30+ min past their end
    time." Kavya
    (VDEM002) is seeded as already overstaying, so about 10 minutes into the demo the
    wardens get her escalation on their own.
33. **Night sweep.** `run job_night_sweep`. Each host gets "Your guest is still inside
    after 10 pm" (Priya and Fatima can see it under **Notifications**). On Android the
    warden gets "3 day guests still inside", and tapping it opens **Inside** with a
    **Night sweep** chip showing just those guests. It counts once per night: running
    it again the same evening sends nothing new.
34. **Gate offline.** Pair the gate laptop (step C), then either run `gate-offline` or
    close the gate tab for more than 5 minutes. The gate's status on the dashboard
    turns offline live. On Android, each warden gets one "Gate screen offline" push
    per outage; once the screen comes back and goes silent again, they get one more.
35. **Walk-in expiry.** Leave a walk-in (step F) unanswered for 10 minutes. The guest's
    screen changes to "No answer from Priya — Try calling her, then request again", and
    Priya gets "Guest request expired".

**Account deletion (FR-09).**

36. **As a guest:** open **My visits** and choose **Delete my account**. The guest is
    signed out everywhere at once. If they're inside, or have a visit in the next 24
    hours, the app says deletion waits until that visit ends. The worker finishes
    within 15 minutes: photos deleted, name becomes "Former guest", phone removed. The
    host's visit history keeps the visit rows, without the guest's details.
37. **As a resident:** **Profile** (R-15) → **Delete my account**. Both seeded residents
    owe a charge (Priya ₹400, Fatima ₹100), so the app says "Clear your charges first".
    To show the full path, have the office mark the charge paid on **Charges**, then
    try again.
38. **Retention** (SDD §16.5) runs at 03:00 IST. `run job_retention` is safe to show,
    but demo data is minutes old, so nothing is due. The automated tests cover every
    retention row (`apps/api/test/retention.integration.test.ts`).

The wording after the "Delete my account" button is proposed copy that isn't in the SDD
yet (docs/DECISIONS.md DEC-015). Say so if anyone asks.

## 2. If something goes wrong on stage

### Venue Wi-Fi / indoor GPS is unreliable

- Increase `DEMO_GATE_RADIUS_M` (e.g. to 300–500) before you start — set it generously
  wide for the room, not realistically tight; nobody in the audience can tell the
  difference, and a failed geofence check live is worse than a wide radius.
- If GPS flatly won't lock indoors, lean on the **Ask host to confirm** path (step G
  above) as the primary demo path for check-in, not a fallback — it's a real,
  SDD-specified flow (FR-27), not a cheat.
- Phones on venue Wi-Fi may be on a captive portal that blocks the tunnel's domain —
  prefer cellular data on the demo phones if the venue Wi-Fi is unpredictable.

### The gate pairing code expired

Run (in a separate terminal, demo stack still running):

```
pnpm --filter @haven/api run demo:pair-code
```

### Ctrl+C didn't fully stop the stack

On Windows, embedded Postgres runs as its own `postgres.exe` process and can
occasionally outlive the `pnpm demo` process tree if the orchestrator is killed
forcefully (not a normal Ctrl+C in the terminal you launched it from — that case
is handled). If `pnpm demo` won't start again because a port is already in use,
find and end the leftover process:

```
netstat -ano | findstr ":8080 :8081 :54625"
taskkill /PID <pid> /F
```

### Resetting the database between rehearsals

The demo database is a disposable, in-memory-speed Postgres instance with no
persistence (`persistent: false` in `demo-db.ts`) — just stop the stack (Ctrl+C) and
run `pnpm demo` again. There's nothing to migrate or clean up; every rehearsal starts
from the same two-resident, one-gate seed. If you want to keep the stack running but
clear just the walk-in/invite visits created during rehearsal, there's no single
command for that today — restarting the whole stack is the supported way.

## 3. Safety: this cannot touch staging or production

- `demo-db.ts` starts its own embedded Postgres on `localhost:54625` — there is no
  `DATABASE_URL` override anywhere in the demo scripts, so it is structurally
  incapable of connecting to a real Supabase project.
- `demo-server.ts` sets `DEV_LOGIN_ENABLED=true` **and** `NODE_ENV=development`
  itself — `buildApp` independently refuses to start with the dev-login bypass on
  unless `NODE_ENV=development` is actually set (docs/DECISIONS.md DEC-011), so this
  isn't resting on an operator remembering a flag.
- `pnpm demo`'s orchestrator (`scripts/demo.mjs`) refuses to run at all if `APP_ENV` or
  `NODE_ENV` in your shell look like a real deployment (anything other than
  `local`/`development`/`test`/unset).

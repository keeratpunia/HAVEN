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
verified residents, one gate), the real API (real clock, dev sign-in enabled), and the
Expo web app. Wait for the banner:

```
========================================================================
HAVEN demo is up.
  Web:  http://localhost:8081
  API:  http://localhost:8080
  Resident dev sign-in: priya@haven.demo, fatima@haven.demo (any password-free email)
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

Pick one tunnel tool. **Start the tunnels first** — you need their URLs before
starting the demo stack, because the API needs to know the web app's HTTPS URL (it's
embedded in every QR code and invite link) and the web app needs to know the API's
HTTPS URL (compiled into the page at build time).

**cloudflared** (recommended, no account needed for a quick tunnel):

```
cloudflared tunnel --url http://localhost:8080   # note the https://*.trycloudflare.com URL → API_TUNNEL_URL
cloudflared tunnel --url http://localhost:8081   # note this one → WEB_TUNNEL_URL
```

**ngrok** (equivalent):

```
ngrok http 8080   # → API_TUNNEL_URL
ngrok http 8081   # → WEB_TUNNEL_URL
```

Then start the demo stack pointed at both tunnel URLs:

```
WEB_BASE_URL=<WEB_TUNNEL_URL> API_BASE_URL=<API_TUNNEL_URL> \
CORS_ORIGINS=<WEB_TUNNEL_URL> \
DEMO_GATE_LAT=<lat> DEMO_GATE_LNG=<lng> \
pnpm demo
```

`WEB_BASE_URL` is what `demo-server.ts` puts inside every invite link and QR payload —
if it's still `localhost`, a phone that isn't on your laptop's network can't open
anything it scans. `CORS_ORIGINS` must match `WEB_TUNNEL_URL` exactly (scheme +
host, no trailing slash) or the browser will block every API call with a CORS error.
The web app itself picks up `API_BASE_URL` via `EXPO_PUBLIC_API_URL`, which `pnpm
demo`'s orchestrator (`scripts/demo.mjs`) passes through to the Expo process
automatically — you don't need to set that one separately.

Quick tunnels (`cloudflared tunnel --url ...` / plain `ngrok http`) issue a **new
random URL every time they start** — if you restart a tunnel mid-rehearsal, you must
restart `pnpm demo` with the new URL too. For a longer rehearsal session, keep both
tunnels running continuously rather than restarting them.

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
   tunnelling) → **Resident sign-in**.
2. Enter `priya@haven.demo` → **Sign in**. (This is the dev-only bypass,
   docs/DECISIONS.md DEC-011 — point out there's no password because there's no real
   Google OAuth configured for this throwaway environment; a real deployment requires
   Google Sign-In, SDD §9.5.)
3. **Invite** tab → fill in Guest A's name and phone, pick **Day visit**, today's date,
   a start/end time that brackets "now." → **Create invite**.
4. The **Share invite** screen shows the exact SDD §15 T-INVITE message and the
   `/i/<token>` link. **Copy link**.

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

17. Guest B (no invite) scans the gate QR directly (`/gate` → camera).
18. Location check → signs in with OTP (or the test-number shortcut) → profile + live
    selfie (first time) → **Find your host** → room `101` → **Priya Sharma** → visit
    type → live selfie → **Waiting for host**.
19. On the resident's laptop, go to **Requests**. Guest B's card shows their name,
    visit type, and the location-verified/not-verified line.
20. Tap **Approve**.
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

# HAVEN — demo script (≈15 minutes)

A live walkthrough for an audience (our teacher), run entirely on one laptop with two
phones. Setup is in `docs/SETUP.md`; what this demo leaves out is in
`docs/NEXT-PHASE.md`.

The demo runs its own throwaway database on the laptop — it can never touch real data.
Everything you see is the real app; only sign-in (no Google, fixed SMS code) and the
temporary internet link are demo stand-ins.

---

## 0. Before the audience arrives (15 minutes before)

**Devices**

| Device | Used for | Window |
|---|---|---|
| Laptop (on the projector) | Resident **Priya** | Chrome, normal window |
| Laptop | **Warden** | Chrome, Incognito window (Ctrl+Shift+N) |
| Laptop | **Office** | Microsoft Edge |
| Second screen — a tablet, old phone or teammate's laptop (or an Edge InPrivate window on the laptop) | **Gate screen** | any browser, full screen |
| Phone 1 | **Guest A** (invited guest) | Chrome / Safari |
| Phone 2 | **Guest B** (walk-in guest) | Chrome / Safari |

**Steps**

1. In PowerShell, in the `haven` folder:

   ```powershell
   pnpm demo:reset
   notepad demo.config.json
   ```

   Set `lat`/`lng` to the room you're presenting in (Google Maps → long-press → copy),
   save, close.

2. Start:

   ```powershell
   pnpm demo:tunnel
   ```

   Wait for the box `HAVEN demo is up.` (1–3 min). Note the **link** and the **gate
   pairing code**. Leave this window open — closing it stops the demo.

3. **Time of day.** The hostel rules close entry at 20:00 IST. If you present after
   19:30, in a second PowerShell run `pnpm demo:clock 13:00` so the demo thinks it's
   1 pm (step F moves the clock on purpose; `pnpm demo:clock reset` puts it back).

4. Send the link to both phones (WhatsApp → open it in **Chrome/Safari**, not inside
   WhatsApp: the app offers *Continue here anyway* if it is opened in WhatsApp's own
   browser, but camera and GPS are more reliable in the real browser).

5. Open the link in each laptop window and sign in at `<link>/sign-in` with the email
   only (dev sign-in, no password):

   | Window | Email | Lands on |
   |---|---|---|
   | Chrome normal | `priya@haven.demo` | Home (resident, room 101) |
   | Chrome Incognito | `warden@haven.demo` | Warden dashboard |
   | Edge | `office@haven.demo` | Office charges |

6. Gate screen device: open `<link>/gate`, enter the pairing code → the rotating QR
   appears. **Do this within 10 minutes of starting** (or get a new code:
   `pnpm demo:pair-code`). Tap the screen for full screen. *(Step A shows this live — if
   you'd rather pair in front of the audience, skip it here.)*

7. Optional 2-minute rehearsal of the whole flow without phones: `pnpm demo:smoke`
   (then restart the demo — it leaves test data behind).

**Test phone numbers:** Guest A `99999 00001`, Guest B `99999 00002`, spare `99999 00003`
… `00009`. The SMS code is always **123456**.

---

## A. The gate screen (1 min) — presenter: ________

| | |
|---|---|
| **Device** | Gate screen device |
| **URL** | `<link>/gate` |
| **Do** | Type the pairing code from the banner → **Pair**. Tap for full screen. |
| **Audience sees** | Hostel name, "Main gate", a QR code that **changes every 10 seconds** with a countdown bar, "Guests: scan with your phone camera to enter or leave". |
| **Say** | "The gate screen has no personal data and no receptionist — it only shows a code that's valid for 30 seconds, so a photo of it is useless later." |
| **If it fails** | "Code expired/invalid": run `pnpm demo:pair-code`, use the new code. Blank page: reload once the demo banner has appeared. |

## B. Invite → guest signs up (3 min) — presenter: ________

| | |
|---|---|
| **Device** | Laptop, Chrome normal (Priya), then Phone 1 |
| **Do (Priya)** | Tab **Invite** → Guest name `Ananya`, Phone `9999900001`, today's date, Start = now (rounded up), End = 3 hours later → **Create invite** (enabled once the rules agree) → **Share invite** → **Copy link**. Send it to Phone 1. |
| **Do (Phone 1)** | Open the invite link → **Continue** → phone `9999900001` → **Send code** → `123456` → **Verify** → *About you*: name, gender, tick **I am 18 years or older** and **I agree to the privacy notice** → **Continue** → *Take your profile photo*: **Take photo** → **Use photo**. |
| **Audience sees** | The invite form checks the hostel rules live; the guest gets a pass screen ("My visits" shows the visit). |
| **Say** | "Residents invite by phone number; only that number can claim the invite. The guest consents to the privacy notice and takes a live selfie — there is no gallery upload anywhere, by design." |
| **If it fails** | *Create invite* stays disabled: the times are outside 08:00–22:00 or in the past — pick later times (or `pnpm demo:clock 13:00`). "This invite was sent to a different phone number": the guest typed another number. Camera blocked: phone Settings → Chrome → Camera → Allow, reload. |

## C. Check in at the gate (2 min) — presenter: ________

| | |
|---|---|
| **Device** | Phone 1, then laptop (Priya) |
| **Do (Phone 1)** | Open the phone **camera app**, point at the gate QR, tap the link → **Allow location** (first time) → **Check in** → **Take photo** → **Use photo**. (Or in the app: *My visits* → **Scan the gate QR**.) |
| **Audience sees** | Phone: "Checking you're at the gate…", then **You're checked in** (green). Laptop, Priya: a banner **"Ananya has arrived"** within ~10 s → opens a screen with the gate photo and the check-in time (nothing to tap: DEC-033). |
| **Say** | "Three checks at once: a fresh code from the screen, the phone's GPS inside the gate radius, and a live photo. The host — not a receptionist — confirms it's really her guest." |
| **If it fails** | "You're not at the gate yet": wrong `demo.config.json` coordinates or weak indoor GPS — **Try again** near a window; after 3 tries **Ask host to confirm** works too (Priya confirms). "That code has changed": scan again (the code moves every 10 s). |

## D. Walk-in, approved live (2 min) — presenter: ________

| | |
|---|---|
| **Device** | Phone 2, then laptop (Priya) |
| **Do (Phone 2)** | Scan the gate QR → **Allow location** → phone `9999900002` → `123456` → profile (name, gender, both ticks, selfie). If it says **"You're signed in — scan the QR on the gate screen once more"**, scan again. → **Find your host**: room `101` → **Search** → **Priya S.** → visit type **Continue** → live photo → **Waiting for host**. |
| **Do (Priya)** | Banner **Guest at the gate** → it opens the request: the live photo and the profile photo side by side, visit type, "Leaves by", ✓ Location verified → **Approve**. |
| **Audience sees** | Within ~3 s, **without touching Phone 2**, its screen turns green: checked in. |
| **Say** | "Walk-ins need the resident's approval in real time; if nobody answers in 10 minutes the request expires on its own." |
| **If it fails** | No banner: Priya's window → **Notifications** tab. Guest screen not green: it polls every 3 s — wait, or open *My visits*. |

## E. The warden and the office (2½ min) — presenter: ________

| | |
|---|---|
| **Device** | Laptop: Chrome Incognito (warden), Chrome normal (Priya), Edge (office) |
| **Do (warden)** | Dashboard: point at **Inside now** — it went up when the guests checked in (no reload, "● Live"). Tab **Inside** → click Guest B → the **visit timeline**: entry time, both photos, GPS distance, who approved. |
| **Do (Priya)** | Home → **Overnight** → guest name, phone `9999900003`, **Female**, **Hostel guest room** (or *Overnight in my room*), arrival tomorrow, departure the day after → see "1 night · ₹150" and the monthly quota → **Send to warden**. |
| **Do (warden)** | Tab **Approvals** → the new request → **Approve**. "Approved … The charge is pending." |
| **Do (office, Edge)** | **Charges**: the ₹150 charge for Priya appears → type a **Receipt number** (e.g. `GH8-0001`) → **Mark … paid** → tab **Paid** shows it. |
| **Audience sees** | Live counts; a full audit trail per visit; the office sees money only — no guest phone numbers or photos. |
| **Say** | "Overnight stays need the warden; the charge follows automatically, and the office only ever sees what it needs to collect it." |
| **If it fails** | Dashboard not updating: it falls back to refreshing every 15 s — wait or reload. The request isn't in *Approvals*: it was already decided — open it from **Search visits**. |

## F. The rules in action (2½ min) — presenter: ________

1. **Check out, then too late to enter.**

   | | |
   |---|---|
   | **Device** | Phone 1, PowerShell, gate screen |
   | **Do** | Phone 1 scans the gate → **Check out** → photo → "You've checked out". Then in PowerShell: `pnpm demo:clock 20:05`, and **reload the gate screen**. Phone 1 scans again → Find your host `101` → Priya → Continue → photo. |
   | **Audience sees** | **"Entry has closed for today — Guests can enter until 8:00 pm…"** |
   | **Say** | "The rules are data, not code — the 8 pm cut-off is judged by the server's clock at the moment of the scan." |
   | **Then** | `pnpm demo:clock reset` (or back to `13:00`) and reload the gate screen. |

2. **An old QR is useless.** Before step 1, press Win+Shift+S on the gate screen device
   (or take a phone photo of it). Wait 40 seconds, then scan the *screenshot* with Phone
   2 → **"That code has changed"**. *Say:* "A forwarded photo of the gate code doesn't
   work."

3. **GPS says no → ask the host.** Phone 1 (checked out after step 1): turn
   **Location off** in the phone's quick settings, scan the gate QR → the app can't
   confirm the location and says **"We can't pin your location"**. Android reports
   Location switched off as *unavailable*, so tap **Try again** twice more; after the
   third try **Ask host to confirm** appears (on a phone where the browser reports
   location as *blocked*, it appears straight away). Stop there — no need to finish.
   *Say:* "No GPS doesn't mean no entry — the host confirms instead, and that's logged."
   *(Turn Location back on.)*

| **If it fails** | The gate screen keeps the old time for up to 60 s after `demo:clock` — reload it. "That code has changed" when you didn't expect it: reload the gate screen. |
|---|---|

## G. Time-based jobs (1½ min) — presenter: ________

| | |
|---|---|
| **Device** | PowerShell, laptop (Priya, warden) |
| **Do** | `pnpm demo:job overstay VDEM001` → Priya's window: banner **"Your guest is still inside"** (Ananya Rao's visit ended 16 minutes ago). Then `pnpm demo:job escalate VDEM001` → warden: **Overstaying** count goes up; Notifications: **"Guest overstaying"**. Then `pnpm demo:job run job_night_sweep` → the 10 pm sweep lists day guests still inside. |
| **Audience sees** | The background jobs that normally run every 5 minutes (and nightly) firing on cue. |
| **Say** | "Nobody has to remember to chase a guest who stayed too long: 15 minutes after the visit ends the host and guest are told, 30 minutes later the warden." |
| **If it fails** | "VDEM001 is completed": pick another guest who is inside — the visit code is on the warden's visit timeline (e.g. `pnpm demo:job overstay VDEM002`). |

## H. Force check-out and ban (1½ min) — presenter: ________

| | |
|---|---|
| **Device** | Laptop (warden), then Phone 2 |
| **Do (warden)** | Tab **Inside** → Guest B → **Force check-out** → Reason (required) `Not who the host expected` → **Force check-out** → "Closed: forced". Then **Ban guest** → Reason `Unknown to the host` → **Confirm ban** → "Guest banned." (Tab **Bans** lists it.) |
| **Do (Phone 2)** | Scan the gate → Find your host `101` → Priya → Continue → photo. |
| **Audience sees** | **"You can't enter this hostel — Please contact the warden's office."** |
| **Say** | "The warden can remove and ban anyone; a banned guest is refused at the gate automatically, at every step." |
| **If it fails** | Guest B already left: ban from **Search visits** → open Guest B's visit → **Ban guest**. |

**Close (10 s):** "Everything you saw is the real app on a laptop; going live needs a
server, real SMS and Google sign-in, and GPS calibration at the real gate — that's our
next phase." (`docs/NEXT-PHASE.md`)

---

## If something goes wrong on stage

| Problem | Fix |
|---|---|
| The demo window shows `[web] stopped` / `[api] stopped`, or the link stops working | Ctrl+C, `pnpm demo:reset`, `pnpm demo:tunnel` — **the link changes**: send the new one to the phones, re-pair the gate screen. |
| Venue Wi-Fi blocks the tunnel ("No tunnel URL after 60 s") | Laptop on a phone hotspot; or the laptop-only demo (`pnpm demo`, `http://localhost:8081`, see SETUP.md 5b). |
| Indoor GPS is bad | Raise `radiusM` in `demo.config.json` (max 300) and restart, or use **Ask host to confirm**. |
| A phone shows the old app | Pull down to reload. |
| Need a fresh database between rehearsals | Ctrl+C, `pnpm demo:reset`, start again. |

## Safety

`pnpm demo` refuses to run if `APP_ENV`/`NODE_ENV` look like staging or production, and
it only ever talks to the database it starts on this laptop. Dev sign-in exists only in
this local mode; the real API refuses to start with it switched on.

# Phone test checklist: HAVEN test version

**Where:** https://haven-gh8-test-bay.vercel.app (dummy data only, `docs/DECISIONS.md`
DEC-026). It looks exactly like the pilot will: nothing on screen says "test" (DEC-032),
so keep this sheet handy for the numbers.

**Who:** four people, at least **one Android phone (Chrome)** and **one iPhone
(Safari)**. Tick each box as you go and write down anything odd next to it: what you
tapped, what you saw, phone model. A screenshot helps.

| Person | Plays | Test number | Phone |
|---|---|---|---|
| **A** | Resident **Priya** (room 101), the host | 99999 **00005** | Android |
| **B** | **Guest** (first 00001, later 00002) | 99999 **00001** / **00002** | iPhone |
| **C** | **Warden** Meera | 99999 **00007** | either |
| **D** | **Office** (00008) and **Admin** (00009); runs the gate laptop | 99999 **00008** / **00009** | either + a laptop |

**The code is always `123456`.**
- Residents and staff: **Resident or staff sign-in**.
- Guests: **Guest sign-in**, or just open the link or scan the QR.
- Real numbers are refused on purpose: "This is a test version. Please use one of the
  test numbers."

**Before you start (Person D, 5 minutes):**

- [ ] The gate laptop shows the rotating QR, landscape and full screen (if not:
      `docs/DEPLOY-TEST.md` step 7).
- [ ] Do the test between **08:00 and 19:30** (the hostel rules close entry for day
      guests at 20:00).
- [ ] The first page load of the day can take about a minute while the free server
      wakes up. After that it should feel normal.

---

## 1. Sign in (everyone)

- [ ] **A**: **Resident or staff sign-in** → `9999900005` → **Send code** → `123456` →
      **Verify** → lands on **HAVEN · Resident**, Home, with bottom tabs.
- [ ] **A**: from the front page, tap **Guest sign-in** by mistake → **‹ Back** returns to
      the front page.
- [ ] **D** on a laptop, signed in as admin (00009): the header says **HAVEN · Admin**,
      and **Sign out** is at the bottom of the left menu.
- [ ] **C** signs in with 00007 → lands on **HAVEN · Warden** with **● Live** on the
      dashboard. (If it says "Updating every 15 s", note it; it still works.)
- [ ] **D** signs in with 00008 → lands on **Charges** (office).
- [ ] Anyone tries a real number, e.g. their own → refused with the test-version
      message.

## 2. Invite a guest (A → B)

- [ ] **A**: **Invite** tab → guest name, phone `9999900001`, gender, today, start now,
      end in 2 hours → **Create invite** → **Share invite** → send the link to **B**
      (WhatsApp is fine).
- [ ] **B** opens the link. If it opens inside WhatsApp, HAVEN offers *Open in Safari*.
      Tap it (or *Continue here anyway* and note what happened).
- [ ] **B**: phone `9999900001` → code `123456` → *About you*: name, gender, both ticks
      → **Take photo**. It's the **live camera**, with no gallery option. → **Use
      photo**.
- [ ] **B** sees the visit under **My visits**.

## 3. Check in at the gate (B, with A watching)

- [ ] **B**, standing by the gate laptop: open the iPhone **Camera** app → point at the
      QR → tap the link → **Allow location**.
- [ ] **B** sees "Checking you're at the gate…", then **Check in** → live photo → **You're
      checked in** (green).
- [ ] **A** sees **"… has arrived"** within about 10 seconds (banner or **Notifications**),
      with the gate photo next to the profile photo → **Yes, that's my guest**.
- [ ] **C** sees the guest on **Inside** without reloading.
- [ ] The **gate laptop** keeps showing only the QR. By design the gate screen never
      shows the guest's name or photo (SDD §0). The host and the warden see the
      check-in, not the gate.

## 4. GPS outside the radius (D sets it up, B tries)

- [ ] **D** (admin 00009): walk **more than 200 m** from the gate laptop → **More →
      Gates → Set gate location to my current position**. The gate is now "over
      there".
- [ ] **B** (guest 00002 this time: **Guest sign-in** → 9999900002, finish the profile),
      at the gate laptop, scans the QR → **"You're not at the gate yet"**. After 3
      tries, **Ask host to confirm** appears.
- [ ] **D** walks back to the gate laptop → **Set gate location to my current position**
      again.
- [ ] **B** scans again → passes the location check.
- [ ] **iPhone location blocked:** on B's iPhone, Settings → Privacy & Security →
      Location Services → **Safari Websites → Never**. Scan → HAVEN says *Location is
      turned off for HAVEN* with the iPhone steps. Follow them; it works again.

## 5. Walk-in (B with 00002 → A approves)

- [ ] **B** scans → **Find your host**: room `101` → **Priya S.** → visit type → live
      photo → **Waiting for host**.
- [ ] **A** gets **Guest at the gate** → photos side by side → **Approve**.
- [ ] **B**'s screen turns green **without tapping anything**.

## 6. Check out (B)

- [ ] **B** scans the QR again → **Check out** → photo → done.
- [ ] **A** sees the guest left; **C**'s **Inside** count drops.

## 7. Overstay alert (quick, no waiting)

The real rule flags a guest still inside 15 minutes after their visit ends, and tells the
warden 30 minutes after that. To see it now, **Keerat** runs these on the laptop
(PowerShell in `D:\HAVEN`), using the visit code shown on the visit screen (e.g.
`VAB12CD`):

```powershell
pnpm --filter @haven/api run staging -- overstay VAB12CD
pnpm --filter @haven/api run staging -- escalate VAB12CD
```

- [ ] After `overstay`: **A** sees the overstay alert in **Notifications**. (The guest's
      SMS is not sent: the test version sends no SMS.)
- [ ] After `escalate`: **C** sees the warden's overstay alert.

## 8. Warden acts on an alert (C)

- [ ] **C**: dashboard tiles **Overstaying** / **Disputed** → open a visit → timeline with
      photos and GPS distance.
- [ ] **C** → **Force check-out** with a reason → the guest leaves the **Inside** list.
- [ ] **C** → **Approvals** → approve the waiting **overnight** request.
- [ ] **C** → **Residents** → open **Neha Verma** (waiting) → ID card and selfie →
      **Verify** (or Reject).
- [ ] **C** → **More → Search visits** → **Filters** opens from the bottom of the screen;
      the results are readable on the phone.

## 9. Office (D with 00008)

- [ ] **Charges**: the overnight charge **C** just approved is there → **Confirm** →
      receipt number → **Mark paid**.
- [ ] The office never sees guests' phone numbers or photos.

## 10. Admin pairs the gate (D with 00009)

- [ ] **More → Gates → Add device** → a code and QR appear.
- [ ] On a second laptop or tablet, open `…/gate` → type the code → **Pair** → a second
      QR screen works. (Then **Remove** it from Gates; the first gate keeps working.)

## 11. Install it like an app

- [ ] **Android (A):** **Profile → Install HAVEN** (or Chrome **⋮ → Add to Home
      screen**) → open it from the home-screen icon → it opens full screen, still
      signed in or signs in normally.
- [ ] **iPhone (B or C):** Safari **Share → Add to Home Screen → Add** → open from the
      icon → full screen; nothing hidden under the notch or the home bar.
- [ ] In the installed app, the camera and location still work (iPhone may ask again;
      that's normal).

## 12. Log out and back in

- [ ] **A**: **Profile → Sign out** → back to the start → sign in again with 00005 →
      the same home screen and visits.
- [ ] **C**: **More → Sign out** → sign in with 00007 → dashboard.
- [ ] Close the browser completely, reopen the address → you're still signed in.

## 13. General (everyone, all along)

- [ ] Nothing is cut off, overlapping or needs sideways scrolling.
- [ ] Every button is easy to tap; the keyboard never hides the field you're typing in.
- [ ] Text is readable with your phone's normal text size, and with it set larger.

---

## Report back

For each problem, send: **box number**, **phone model and browser**, **what you did**,
**what you saw** (screenshot), **what you expected**. Claude fixes them and the next
deploy goes out automatically. Then tick the box again.

**To start over with fresh dummy data** (after testing, or if things get confusing),
Keerat runs `pnpm --filter @haven/api run staging -- reset`. It deletes everything in
the test version and re-seeds; the gate then needs its location set and pairing again
(`docs/DEPLOY-TEST.md` step 7).

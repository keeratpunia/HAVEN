# Showing HAVEN to the warden: a 10-minute script

**What this is:** a short, friendly walk-through of the **test version** of HAVEN for a
hostel warden, on **her own phone** and on one of ours. Everything in it is made up:
made-up students, made-up guests, made-up phone numbers. Nothing she does can affect
anyone real.

**Address:** https://haven-gh8-test-bay.vercel.app
**All sign-in codes:** `123456`

**Who does what**

| Person | Phone | Signed in as |
|---|---|---|
| **The warden** | her own phone | the **warden** (number 99999 00007) |
| **Presenter 1** | our phone | **Priya**, a resident in room 101 (99999 00005) |
| **Presenter 2** | our second phone | a **visiting guest** (99999 00001) |
| (Laptop or tablet) | | the **gate screen**, showing a changing QR code |

**Before she arrives (15 minutes before):**
- [ ] Gate laptop on, plugged in, showing the QR in full screen, placed where the guest
      will "arrive".
- [ ] Open the address once on every phone, so the server is awake. (The first visit of
      the day can take a minute; after that it's quick.)
- [ ] Presenter 1 is signed in as Priya; Presenter 2 is *not* signed in yet.
- [ ] Gate location set to this room (admin phone: **More → Gates → Set gate location
      to my current position**).
- [ ] A notebook and a printed copy of `docs/WARDEN-QUESTIONS.md`.

---

## 1. What HAVEN is for (1 minute)

**Say:** "Today, guests sign a paper register and nobody really knows who is inside.
HAVEN does it on phones instead. The student who invites a guest is responsible for
them. The guest checks in at the gate with their own phone. You can see, at any moment,
who is inside, whose guest they are, and since when. This is a test version with made-up
people, so please try anything you like."

## 2. The warden signs in on her own phone (1 minute)

- Ask her to open the address on her phone (send it on WhatsApp, then **Open in
  Chrome/Safari**).
- Tap **Resident or staff sign-in** → phone `99999 00007` → **Send code** → code
  `123456` → **Verify**.
- She sees **Dashboard**: how many guests are inside now, expected today, overstaying,
  any "not my guest" reports, and requests waiting for her.

**Say:** "In the real one you would sign in with your own Google account; here everyone
uses a test phone number."

## 3. A student invites a guest (2 minutes)

- **Presenter 1 (Priya):** **Invite** → guest's name, phone `99999 00001`, today, from now
  for 2 hours → **Create invite**. The app checks the hostel's rules as you type (for
  example, it won't allow a visit outside visiting hours). → **Share invite** → send the link to
  Presenter 2.
- **Presenter 2 (guest):** opens the link → enters `99999 00001` and `123456` → name, tick
  "18 or older" and the privacy notice → takes a **live selfie**. There is no option to
  upload an old photo.

**Say:** "Only the phone number the student invited can use the invite. The guest agrees
to the privacy notice and takes a photo there and then."

## 4. The guest arrives at the gate (2 minutes)

- **Presenter 2:** opens the phone camera, points it at the QR on the gate screen, taps
  the link, allows location → **Check in** → takes a photo → green **"You're checked
  in"**.
- **Presenter 1 (Priya):** gets **"… has arrived"**, with today's photo next to the
  selfie → **Yes, that's my guest**.
- **Warden's phone:** the guest appears under **Inside** by herself, without refreshing.

**Say:** "Three checks happen together: the code on the gate screen changes every ten
seconds, the guest's phone must really be at the gate, and the host sees a live photo.
The gate screen itself never shows anyone's name or photo, so nobody standing near it
learns who came in."

## 5. When something is wrong (2 minutes)

On the **warden's phone**:
- Tap the **Overstaying** or **Disputed** tile → open the guest → she sees the photos,
  the times, and where the phone was.
- **Force check-out** with a reason. She can also **ban** a guest from the hostel, and
  any later attempt by that guest is refused at the gate.
- Show **Approvals**: an overnight stay waiting for her decision. She approves it, and
  the charge goes to the office automatically.
- Show **Residents**: a new student, **Neha**, waiting to be verified with her ID card
  photo. She can approve or reject.

**Say:** "If a student says 'that's not my guest', you're told immediately. Every action
is recorded, including who looked at whose photos."

## 6. Her questions (2 minutes, or as long as she likes)

Use `docs/WARDEN-QUESTIONS.md`. Write her answers in her words. Don't argue; just note.

**Close with:** "Thank you. We'll send you the changes you asked for, and before any real
student uses it we'd need your written permission for a small trial."

---

**If something goes wrong**
- A page takes a long time the first time: the free server was asleep. Wait a minute;
  it won't happen again that session.
- "You're not at the gate yet": the gate location is set somewhere else. Use **Set gate
  location to my current position** on the admin phone, or show **Ask host to
  confirm**, which is how a guest gets in when GPS doesn't work indoors.
- The gate screen says it's offline or asks for a code: pair it again from the admin
  phone (**More → Gates → Add device**).

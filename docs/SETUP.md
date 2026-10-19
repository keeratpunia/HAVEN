# HAVEN — setup on Windows 11

For a teammate who has never seen the project. Follow it top to bottom; every command
is a PowerShell block you can copy. It takes about 30–45 minutes the first time, mostly
downloads. You need: Windows 11, an internet connection, about **6 GB free on C:**, and
access to the GitHub repository (ask the owner to add you).

> Open **PowerShell** = Start menu → type *PowerShell* → Windows PowerShell (or Terminal).
> "As Administrator" = right-click it → *Run as administrator*.

---

## 1. Install the tools (once)

Open PowerShell (normal, not admin) and run:

```powershell
winget install --id Git.Git -e --source winget
winget install --id CoreyButler.NVMforWindows -e --source winget
winget install --id Google.Chrome -e --source winget
winget install --id Cloudflare.cloudflared -e --source winget
```

Each one ends with `Successfully installed` (or `Found an existing package already
installed` — also fine). Accept any Windows "allow changes?" prompt.

**Close every PowerShell window now** and open a new one *as Administrator* — the new
tools are only on the PATH of new windows, and nvm needs admin once.

### Node.js 24.4.1 (via nvm) and pnpm (via corepack)

In the **Administrator** PowerShell:

```powershell
nvm install 24.4.1
nvm use 24.4.1
corepack enable
```

Check (any PowerShell from now on, admin not needed):

```powershell
node -v
git --version
cloudflared --version
```

You should see `v24.4.1`, `git version 2.x`, and `cloudflared version 20xx.x.x`.

> The project pins Node in `.nvmrc` (24.4.1) and refuses other major versions. pnpm's
> version (9.15.9) is pinned in `package.json`; corepack fetches it automatically.

---

## 2. Get the code

In a normal PowerShell, pick a folder (Desktop is fine; spaces in the path are fine):

```powershell
cd $HOME\Desktop
git clone https://github.com/<OWNER>/haven.git
cd haven
```

Replace `<OWNER>` with the GitHub account that owns the repo. The first time, Git opens
a browser window to sign in to GitHub — sign in and approve.

Check pnpm (the first run asks to download it — type `Y`):

```powershell
pnpm -v
```

It prints `9.15.9`.

---

## 3. Install the project

```powershell
pnpm install
```

Takes 2–15 minutes depending on the connection (and Defender). It ends with something like `Done in 1m 17s using pnpm v9.15.9`. Warnings about
"deprecated" or "peer dependencies" are normal; red `ERR_PNPM_...` lines are not (see
Troubleshooting).

Then the browser the end-to-end tests use (one time, about 300 MB):

```powershell
pnpm --filter @haven/mobile exec playwright install chromium
```

It ends with `Chrome Headless Shell ... downloaded to ...`.

---

## 4. Run the tests

```powershell
pnpm typecheck
pnpm lint
pnpm test
```

Each ends with `Tasks: N successful, N total`. `pnpm test` takes about 5 minutes: the API
tests start their own small database (the first time, Windows Firewall may ask about
`postgres.exe` — see Troubleshooting). Expect about 1,000 passing tests and 0 failures.

Browser tests (another ~5 minutes; make sure the demo is **not** running):

```powershell
pnpm e2e
```

It ends with `31 passed`.

---

## 5. Start the demo

### 5a. With phones (the real demo)

Phones need an `https://` address to use the camera and GPS. `pnpm demo:tunnel` creates
one free temporary address with cloudflared and starts everything behind it.

First set the gate location to the room you're in. Run this once to create the config
file:

```powershell
pnpm demo:reset
```

Then open `demo.config.json` (in the `haven` folder) in Notepad:

```powershell
notepad demo.config.json
```

and replace `lat` / `lng` with your room's coordinates (Google Maps → long-press the
spot → the coordinates appear at the top; copy them). Save. This file stays on your
laptop — it's never committed.

Start it:

```powershell
pnpm demo:tunnel
```

After 1–3 minutes you'll see a box like this (your link and code will differ):

```
============================================================================
HAVEN demo is up.
  Open on the laptop and phones:  https://word-word-word-word.trycloudflare.com
  ...
  Gate screen:  https://.../gate   pairing code AB12-CD34  (valid 10 min)
  ...
============================================================================
```

Open that link in Chrome on the laptop and on each phone. Use the **same link
everywhere** — not `localhost`. The full presenter script is **docs/DEMO.md**.

Stop with **Ctrl+C**. The link changes every time you start, so send it to the phones
again after each restart.

### 5b. Laptop only (no phones, or no internet)

```powershell
pnpm demo
```

Open **http://localhost:8081** in Chrome. `localhost` is allowed to use the webcam and
location without https.

- **Two people on one laptop:** use a normal window for one person and an Incognito
  window (Ctrl+Shift+N) for the other — they stay signed in separately.
- **Location:** at the gate step, press F12 → the ⋮ menu (top right of DevTools) → *More
  tools* → *Sensors* → *Location* → *Other…* → type the `lat`/`lng` from
  `demo.config.json`. Choose *Location unavailable* or far-away numbers to show the GPS
  failure screen.
- **Camera:** the laptop webcam; Chrome asks once — choose *Allow*.

### 5c. Check the demo works (optional, 2 minutes)

With the demo running, in a second PowerShell in the `haven` folder:

```powershell
pnpm demo:smoke
```

It runs every step of DEMO.md through the API and ends with `All 9 checks passed`. It
adds test visits, so restart the demo afterwards (Ctrl+C, then `pnpm demo:tunnel` again).

---

## 6. Troubleshooting

**"Port 8080 (or 8081 / 9000 / 54625) is already in use", or the demo stops with
`[api] stopped` / `[web] stopped`.**
A previous run is still going (often a closed window). Run:

```powershell
pnpm demo:reset
```

It stops only the demo's own processes and deletes the demo database folder. Then start
again. `pnpm demo:reset --all` also clears what the tests and `pnpm e2e` leave behind.

**Leftover Postgres / "data directory exists but is not empty" / `EBUSY`.**
Same fix: `pnpm demo:reset --all`. If it says a folder is "still locked", close
VS Code / File Explorer windows open inside `apps\api`, wait 10 seconds, run it again.

**The first page load takes ages / phones show a blank page.**
The first time, the web app is compiled (2–5 minutes on a laptop). The demo waits for
this before printing the box; if you opened the page earlier, just reload once the box
appears.

**Windows Firewall asks about `node.exe` or `postgres.exe`.**
Choose *Private networks* and *Allow*, or *Cancel* — both work: the demo only needs
connections from this laptop and through the tunnel.

**`pnpm install` is very slow (Microsoft Defender).**
Defender scans every new file; the first install can take 15+ minutes. Let it finish. (If
you're comfortable with it, adding your `haven` folder as a Defender exclusion speeds
installs up — that's your call.)

**`pnpm` is not recognized / `node` is the wrong version.**
Open a new PowerShell. Still wrong: in an Administrator PowerShell run
`nvm use 24.4.1` and `corepack enable` again.

**`ERR_PNPM_UNSUPPORTED_ENGINE`.** Your Node isn't 22–24: `nvm use 24.4.1`.

**The gate pairing code expired** (they last 10 minutes):

```powershell
pnpm demo:pair-code
```

prints a new one (the demo keeps running).

**The phone says "That code has changed".** The QR on the gate screen changes every 10
seconds and a code is good for about 30 seconds — scan the live screen, not a photo of
it. If it keeps happening, reload the gate screen.

**"You're not at the gate yet" on the phone.**
`demo.config.json` has the wrong coordinates, or the phone's GPS is weak indoors. Fix
the coordinates and restart, or tap *Try again* near a window; after 3 tries the guest
can *Ask host to confirm* instead.

**OTP: "Please wait before requesting another code" or "Too many attempts".**
Use the test numbers `99999 00001`–`99999 00009` with code **123456** — no SMS involved.
The resend wait is 30 seconds and grows each time; restarting the demo resets it.

**`pnpm demo:tunnel` says cloudflared is not installed.**
`winget install --id Cloudflare.cloudflared -e`, then open a new PowerShell.

**`pnpm demo:tunnel` prints "No tunnel URL after 60 s".**
The network blocks cloudflared (some college Wi-Fi does). Try a phone hotspot, or use the
laptop-only demo (5b).

**Full reset** (as if freshly cloned; keeps your `demo.config.json`):

```powershell
pnpm demo:reset --all
pnpm clean
pnpm install
```

---

## 7. Working as a team

One branch per person per piece of work; never work directly on `main`.

```powershell
git switch main
git pull
git switch -c yourname/what-you-are-doing
```

…make changes, then check and commit:

```powershell
pnpm typecheck
pnpm lint
pnpm test
git add -A
git commit -m "fix(gate): short description of the change"
git push -u origin yourname/what-you-are-doing
```

Open a pull request on GitHub (it shows a "Compare & pull request" button after the
push), ask a teammate to review, and merge when CI is green. Before starting something
new:

```powershell
git switch main
git pull
```

Rules:

- **Never commit `.env` files or `demo.config.json`** — they're in `.gitignore`; if
  `git status` ever lists one, stop and ask.
- Don't commit photos, real phone numbers or real names. Use the test numbers.
- Commit messages follow `type(area): what` (see `CLAUDE.md` §6).

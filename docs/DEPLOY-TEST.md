# Deploying the HAVEN test version (Phase 1)

This guide puts the **test version** of HAVEN on the internet, so it works on any phone:
dummy data only, test phone numbers only, free plans only (`docs/DECISIONS.md` DEC-026,
DEC-028). It is written for Windows 11 and for someone who has not done this before.
Follow it in order. It takes about an hour.

**What you end up with**

| Piece | Where | Address |
|---|---|---|
| Web app (guests, residents, warden, office, gate screen) | Vercel, free | `https://haven-test.vercel.app` (or similar) |
| API | Render, free, Singapore | `https://haven-test-api.onrender.com` (only Vercel talks to it) |
| Database and photos | Supabase, free, Mumbai | your project's `*.supabase.co` |

**Ground rules**

- **Secrets never go in chat, email, WhatsApp, GitHub, screenshots or this repo.** You
  paste them only into the Render and Vercel dashboards and into one file on your own
  computer (`apps/api/.env.staging.local`, which git ignores).
- Keep a password manager open (Bitwarden is free) and save each secret there as you
  create it.
- Only two people are owners: you and one teammate (D-11). Both turn on 2-factor login on
  every provider (section 9).
- The test version accepts only the test numbers **+91 99999 00001 to 99999 00009**, and
  the code is always **123456**. Real numbers are refused with "This is a test version.
  Please use one of the test numbers."

---

## 0. Before you start

1. On your computer, in PowerShell in the `HAVEN` folder, check you're up to date:

   ```powershell
   git pull
   pnpm install
   ```

2. Decide two names now (you'll need them in steps 4 and 5):
   - **Vercel project name:** `haven-test` → your web address will be
     `https://haven-test.vercel.app`. If Vercel says the name is taken, it adds a
     suffix; that's fine, just use the address Vercel shows.
   - **Render service name:** `haven-test-api` (already in `render.yaml`) → the API
     address will be `https://haven-test-api.onrender.com`. If Render shows a different
     address, tell Claude, because `apps/mobile/vercel.json` must point to it.

3. Create the secrets file: in PowerShell run

   ```powershell
   node scripts/generate-secrets.mjs
   ```

   It prints four lines (`JWT_SECRET`, `OTP_PEPPER`, `DATA_ENCRYPTION_KEY`,
   `HAVEN_API_DB_PASSWORD`). **Copy them into your password manager now**, then close
   the window. Don't run it again unless you want new values everywhere.

---

## 1. Create the Supabase project (Mumbai)

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. If asked, create an **organization**: name `HAVEN`, type *Personal*, plan **Free**.
3. **New project**:
   - Name: `haven-test`
   - Database password: click **Generate a password**, then **Copy**, and save it in
     your password manager as "Supabase haven-test database password".
   - Region: **South Asia (Mumbai)**
   - Plan: **Free**
   - Click **Create new project** and wait 1–2 minutes until it says the project is
     ready.
4. **Turn on scheduled jobs (pg_cron):** left menu → **Database** → **Extensions** →
   search `pg_cron` → switch it **on** → **Enable extension**. (HAVEN's timed jobs, such
   as overstays, the night sweep and walk-in expiry, then run inside Supabase even while
   the free API sleeps.)
5. **Require encrypted connections:** left menu → **Database** → **Settings** (or
   **Project Settings → Database**) → **SSL Configuration** → turn **Enforce SSL on
   incoming connections** on.
6. **Keep the `haven` data private:** **Project Settings** → **Data API** → under
   *Exposed schemas*, make sure **`haven` is not in the list** (the default is `public`
   and `graphql_public`; leave it like that). HAVEN's own API is the only way in
   (SDD §11.7).
7. **Write down these values** (you'll paste them in steps 2 and 4):
   - **Project URL:** **Project Settings** → **API** (or **Data API**) → *Project URL*,
     e.g. `https://abcdefghijklmnop.supabase.co`. The part before `.supabase.co` is your
     **project ref**.
   - **service_role key:** **Project Settings** → **API Keys** → the **Legacy API keys**
     tab → `service_role` → **Reveal** → copy. Save it in your password manager. It can
     read and write everything; it only ever goes into Render and your local file. *(If
     you only see new "secret" keys and no legacy tab, stop and tell Claude.)*
   - **Connection strings:** click **Connect** at the top of the project page →
     **Connection String** → **Type: URI**. You need two:
     - **Transaction pooler** (port **6543**), looks like
       `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres`
     - **Session pooler** (port **5432**), the same host with `:5432`.

     Don't use the "Direct connection" (`db.<ref>.supabase.co`): on the free plan it can
     be IPv6-only, which Render can't reach.

Tell Claude **"Supabase done"** (no secrets, just "done"; the project ref is fine to
share if asked, it isn't secret).

---

## 2. Apply the database migrations (from your computer)

1. In Notepad, create a new file and paste this, replacing each `<…>`:

   ```ini
   APP_ENV=staging
   MIGRATION_DATABASE_URL=postgresql://postgres.<ref>:<Supabase database password>@aws-<n>-ap-south-1.pooler.supabase.com:5432/postgres
   HAVEN_API_DB_PASSWORD=<HAVEN_API_DB_PASSWORD from step 0>
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   DATA_ENCRYPTION_KEY=<DATA_ENCRYPTION_KEY from step 0>
   SEED_GATE_RADIUS_M=200
   ```

   - `MIGRATION_DATABASE_URL` is the **Session pooler** string (port 5432), with your
     database password in place of `[YOUR-PASSWORD]` (no brackets).
   - Don't add a gate position; you'll set it from your phone in step 7.

2. **File → Save As**:
   - folder: `HAVEN\apps\api`
   - *Save as type*: **All files (\*.\*)** (otherwise Notepad adds `.txt`)
   - file name: `.env.staging.local`
3. Check git ignores it. In PowerShell in the `HAVEN` folder:

   ```powershell
   git status --short apps/api
   ```

   The file must **not** appear. If it does, stop and tell Claude.
4. Apply the migrations:

   ```powershell
   pnpm --filter @haven/api run staging -- migrate
   ```

   You should see `applying …` for 20 files, then `Applied 20 migration(s).`,
   `haven_api password set.` and `pg_cron is on`. If it says pg_cron is **not**
   installed, redo step 1.4 and run the command again (it only applies what's missing).

---

## 3. Check the storage buckets

The migrations create the three private photo buckets.

1. Supabase → left menu → **Storage**.
2. You should see **`visitor-photos`**, **`gate-photos`** and **`resident-docs`**, each
   **without** a "Public" badge.
3. If one is missing: **New bucket** → that exact name → leave **Public bucket off** →
   **Create**.

---

## 4. Create the Render service (the API)

1. Go to **https://render.com** → **Get Started** → sign up with **GitHub**.
2. Allow Render to see the **HAVEN** repository (only that one is enough).
3. **New +** → **Blueprint** → choose the **HAVEN** repository → branch **main**.
   Render reads `render.yaml` and shows one service, **haven-test-api** (Free,
   Singapore).
4. It asks for the values marked *sync: false*. Fill them in like this:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the **Transaction pooler** string (port **6543**), with `postgres.<ref>` changed to **`haven_api.<ref>`** and the password changed to **`HAVEN_API_DB_PASSWORD`** |
   | `DATABASE_DIRECT_URL` | the **Session pooler** string (port **5432**), also with **`haven_api.<ref>`** and **`HAVEN_API_DB_PASSWORD`** |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
   | `JWT_SECRET` | from step 0 |
   | `OTP_PEPPER` | from step 0 |
   | `DATA_ENCRYPTION_KEY` | from step 0 (the same one as in your local file) |
   | `TURNSTILE_SECRET` | `1x0000000000000000000000000000000AA`: Cloudflare's published always-pass **test** key. Not a secret; fine for Phase 1 only (DEC-028) |
   | `API_BASE_URL` | your Vercel address, e.g. `https://haven-test.vercel.app` |
   | `WEB_BASE_URL` | the same Vercel address |
   | `CORS_ORIGINS` | the same Vercel address |

   No trailing `/` on the addresses.

5. Click **Apply** / **Create**. The first build takes 5–10 minutes. When it says
   **Live**, open `https://haven-test-api.onrender.com/health`: it should show
   `{"ok":true,...}`.
6. If the address Render gives is **not** `haven-test-api.onrender.com`, tell Claude.

Tell Claude **"Render done"** and the API address (it isn't secret).

> **The free API sleeps** after 15 minutes without visitors. The next visit waits about
> a minute while it wakes; after that it's normal. An open gate screen keeps it awake.
> Timed jobs (overstays, night sweep, walk-in expiry) run inside Supabase on time either
> way.

---

## 5. Create the Vercel project (the web app)

1. Go to **https://vercel.com** → **Sign Up** → **Hobby** → continue with **GitHub**.
2. **Add New… → Project** → **Import** the **HAVEN** repository.
3. On the configure screen:
   - **Project Name:** `haven-test`
   - **Framework Preset:** *Other*
   - **Root Directory:** click **Edit** → choose **`apps/mobile`** → **Continue**
   - Leave Build/Output/Install commands **unchanged**: `apps/mobile/vercel.json` sets
     them.
   - Open **Environment Variables** and add:

     | Name | Value |
     |---|---|
     | `EXPO_PUBLIC_APP_ENV` | `staging` |
     | `EXPO_PUBLIC_API_URL` | your Vercel address, e.g. `https://haven-test.vercel.app` |
     | `EXPO_PUBLIC_WEB_URL` | the same address |
     | `EXPO_PUBLIC_TURNSTILE_SITE_KEY` | `1x00000000000000000000AA`: Cloudflare's published always-pass **test** site key (Phase 1 only) |

4. **Deploy**. The first build takes 5–10 minutes.
5. After it's done: **Settings** → **General** → **Node.js Version** → **24.x** →
   **Save**. Then **Deployments** → the latest → **⋯** → **Redeploy**.
6. If the address Vercel shows is not the one you put into Render in step 4: Render →
   haven-test-api → **Environment** → change `API_BASE_URL`, `WEB_BASE_URL` and
   `CORS_ORIGINS` to the real address → **Save** (Render redeploys). Then in Vercel
   change `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WEB_URL` too and **Redeploy**.

Tell Claude **"Vercel done"** and the web address.

---

## 6. Put the dummy data in

In PowerShell in the `HAVEN` folder:

```powershell
pnpm --filter @haven/api run staging -- seed
```

It prints who to sign in as:

| Who | Test number | Code |
|---|---|---|
| Resident Priya Sharma, room 101 | 99999 00005 | 123456 |
| Resident Fatima Khan, room 102 | 99999 00006 | 123456 |
| Neha Verma, waiting for verification | 99999 00004 | 123456 |
| Warden Meera Iyer | 99999 00007 | 123456 |
| Office Omar Siddiqui | 99999 00008 | 123456 |
| Admin (Dean of Students) | 99999 00009 | 123456 |
| Guests | 99999 00001, 00002, 00003 | 123456 |

**To start again with fresh dummy data** (everything in the test version is deleted,
including photos):

```powershell
pnpm --filter @haven/api run staging -- reset
```

It asks you to type the project's address back before it deletes anything. It refuses to
run unless `apps/api/.env.staging.local` says `APP_ENV=staging`.

---

## 7. Pair the gate screen

You need the laptop or tablet that will show the gate QR, and your phone.

1. **On your phone**, open your Vercel address → **Sign in** → **Sign in with a test
   number** → `9999900009` (admin) → code `123456` → **Sign in with test number**.
2. Bottom bar **More** → **Gates**.
3. **Stand where the demo will happen** (the room or the gate) → **Set gate location to
   my current position** → allow location → it says "Gate moved to your position". The
   guest's phone must be within **200 m** of this spot to check in.
4. **Add device** → a code like `7K3Q-9A2M` and a QR appear (valid 10 minutes).
5. **On the laptop/tablet**, open `https://<your Vercel address>/gate` → type the code →
   **Pair**. The rotating QR appears.
6. Turn the laptop/tablet **landscape**, press **F11** (full screen), plug it in, and
   leave the page open. (It keeps the API awake too.)

---

## 8. Open it on a phone

1. On any phone, open your Vercel address in **Chrome** (Android) or **Safari**
   (iPhone). You'll see an orange **TEST VERSION · dummy data** strip at the top.
2. **Install it like an app:**
   - Android Chrome: sign in → **Profile** (resident) or **More** (warden) → **Install
     HAVEN**, or Chrome menu **⋮** → **Add to Home screen**.
   - iPhone Safari: **Share** (square with an arrow) → **Add to Home Screen** → **Add**.
3. Try a full visit: the phone test checklist is in `docs/PHONE-TEST-CHECKLIST.md`.

---

## 9. Second owner and 2-factor login (D-11)

Do these for **both** owners. Use an authenticator app (Google Authenticator, Microsoft
Authenticator or the one in your password manager), and save each provider's recovery
codes in the password manager.

| Provider | Turn on 2-factor | Add the second owner |
|---|---|---|
| **GitHub** | Profile picture → **Settings** → **Password and authentication** → **Enable two-factor authentication** | Repository **HAVEN** → **Settings** → **Collaborators** → **Add people** → teammate's GitHub name. (A personal repository has one owner; a collaborator can push and is enough for Phase 1. For two true owners later, move the repo to a free GitHub organization.) |
| **Supabase** | Profile picture → **Account preferences** → **Security** → **Multi-factor authentication** → add an authenticator app | Organization **HAVEN** → **Team** → **Invite** → teammate's email → role **Owner** |
| **Render** | **Account Settings** → **Two-factor authentication** → enable | Workspace → **Settings** → **Members** → **Invite** → role **Admin** |
| **Vercel** | **Account Settings** → **Authentication** → **Two-Factor Authentication** → enable | **The free Hobby plan has no team members.** Only the account owner can open the Vercel dashboard. The teammate still deploys by pushing to `main` on GitHub. Write down whose Vercel account it is. |

Nobody else gets access. If a secret ever leaks (pasted somewhere it shouldn't be), make
a new one with `node scripts/generate-secrets.mjs`, put it into Render (and the local
file, for `DATA_ENCRYPTION_KEY` / `HAVEN_API_DB_PASSWORD`, then run `staging -- migrate`
to apply the new database password) the same day.

---

## 10. Checks after deploying (Claude runs these with you)

- `https://<api>.onrender.com/health` → `{"ok":true}`
- The web address shows the security headers (CSP, HSTS, `nosniff`,
  `X-Frame-Options: DENY`).
- `https://<ref>.supabase.co/rest/v1/visits` does **not** return HAVEN data.
- Signing in with a real number is refused with the test-version message.
- The warden dashboard says **● Live**, and a check-in appears without reloading.
  If it stays on **◌ Updating every 15 s**, live updates fell back to polling (the API's
  self-test, DEC-028); everything still works, just up to 15 s slower.
- `pnpm --filter @haven/api run demo:smoke` against the deployed address (Part 4).

## What the test version doesn't do (on purpose)

No SMS (test numbers only), no Google sign-in, no Android app, no push notifications
(in-app notifications and live updates instead), no monitoring, no backups (dummy data).
Those come with the pilot (Phase 2), which is a separate deployment with its own
Supabase, Render and Vercel projects and its own secrets.

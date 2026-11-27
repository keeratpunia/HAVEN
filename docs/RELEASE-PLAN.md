# HAVEN — Release plan: from laptop demo to a real service at GH-8

## Scope change, 27 Nov 2026

The team split the release into two phases (`docs/DECISIONS.md` DEC-026). **Where
DEC-026 and this plan disagree, DEC-026 wins.**

- **Phase 1: Test version (now).**
  - Deployed from `main` with `APP_ENV=staging`, and mobile-first.
  - Dummy data only; the test OTP is on; no SMS at all.
  - Free plans only (NFR-14 = ₹0 a month): Supabase Free (Mumbai), Render Free
    (Singapore; sleeping when idle is accepted), Vercel Hobby, the free
    `*.vercel.app` / `*.onrender.com` addresses.
  - Phones use the web app / installable PWA. No APK, no web push, no monitoring.
  - The gate is an existing laptop or tablet browser.
  - Goal: show it to a hostel warden for review.
- **Phase 2: Pilot (later).** The same repository, deployed separately from a
  `production` branch, with its own Supabase project, Render service, Vercel project and
  secrets. Test OTP off, real SMS OTP, residents approved on the spot by the two owners
  after the warden's written approval. Not built now.

The milestones below (M1–M7) describe the full road to the pilot. In Phase 1 only the
parts DEC-026 names are built; the rest waits for Phase 2.

**Status:** proposal, 2026-11-27. Nothing in this document is decided. Every choice
that changes the SDD or picks a paid service is listed in **§7 Decisions you must make**
and becomes a `DEC-NNN` in `docs/DECISIONS.md` (plus an SDD addendum where it diverges,
per `CLAUDE.md` §1.3) only once you decide it.

**Target end state:**
- Guests keep using the phone browser, with no install (SDD D5).
- Residents, wardens and office staff use everything on their own phones:
  - on Android, through the HAVEN app (SDD D6);
  - on iPhone, through the web app installed to the home screen (SDD L7, L9).
- The gate stays a tablet or phone browser showing the rotating QR (SDD §0, D1).
- The service runs on fixed `https://` addresses with real Google sign-in, real SMS
  and real push. It holds real GH-8 data only after the warden's written approval
  (SDD §23.1 Q11, NFR-07).

**Read with:** `docs/NEXT-PHASE.md`, `docs/FINAL-QA-REPORT.md`,
`docs/SECURITY-AUDIT.md`, `docs/DECISIONS.md`, and SDD §8.3, §8.4, §9.5, §9.7, §15.3,
§16.4, §18, §19.4–19.6, §20, §21.4, §22, §23.

**Sources:** web sources are cited inline as `[n]` and listed in **§8 Sources**. Prices
and policies change often. Anything marked **(verify)** must be re-checked on the
provider's own page before you pay or sign up.

---

## 1. Where we are today (2026-11-27, commit `d982931`)

- **Requirements:** 142 of 159 PASS. The other 17 are 9 PARTIAL and 8 NOT TESTABLE.
  There are no FAILs (`FINAL-QA-REPORT.md`).
- **Tests:** API 886, shared 158, mobile jest 18, Playwright 31 and pgTAP 35, all green
  locally.
- **Runtime:** everything runs on one laptop. That means embedded Postgres, photos on
  local disk, console SMS, dev sign-in and a temporary `trycloudflare.com` tunnel.

## 2. Gap register: every gap between today and a real service

Each gap has an ID (`G-xx`) and the milestone that closes it. "Source" says where the
gap was found.

### 2.1 Code and configuration that does not exist yet

Found by reading the current code.

| ID | Gap | Source | Milestone |
|---|---|---|---|
| G-01 | No web app manifest, icons set, `apple-touch-icon` or service worker. The web app can't be installed as an app; `apps/mobile/public/` doesn't exist | code | M1 |
| G-02 | No web push. `lib/push.ts` returns `'unsupported'` on the web, so iPhone residents and staff get in-app banners plus SMS fallback only | code, SDD L7 | M1 (if D-03 = yes) |
| G-03 | Screens are not verified at phone widths. There are fixed widths in staff screens (e.g. `warden/approvals.tsx` 220 px card, `warden/gates.tsx` 220 px QR, `warden/visits/[id].tsx` 120 px time column). Playwright runs desktop Chromium only | code, NFR-10 | M1 |
| G-04 | No `eas.json`, Android package name, version code, or FCM credentials. The Android app has never been built | code, DEC-012 | M2 |
| G-05 | Native Google sign-in (`@react-native-google-signin/google-signin`) is not built; `GoogleSignInButton` is web only (FR-03 PARTIAL) | code, SDD §8.4 | M2 |
| G-06 | Sentry on Android is a no-op (`lib/sentry.native.ts`) | code, SA-13 | M2 |
| G-07 | `GET /v1/meta/min-app-version` and the "Please update" block are not built | SDD §18.5 | M2 |
| G-08 | No deployment config: no `vercel.json` (SA-12 headers), no Render service definition | code | M3 |
| G-09 | No `deploy-staging.yml` or `deploy-prod.yml`. `ci.yml` exists, but its pgTAP and Playwright steps have never run green on GitHub, and the Supabase CLI version isn't pinned | code, SDD §20.5, FINAL-QA | M3 |
| G-10 | No Dependabot or Renovate config (`.github/` holds only `workflows/ci.yml`) | SDD §16.4 "Dependencies" | M3 |
| G-11 | `SMS_PROVIDER=msg91` refuses to boot: `Msg91SmsSender` is not implemented (`auth/otp-service.ts`) | code, SDD §9.7 | M4 |
| G-12 | No nightly backup job (needed if production stays on Supabase Free) | SDD §18.4 | M5 |
| G-13 | `/gate/calibrate`, the staff GPS test tool §19.4 relies on, doesn't exist | SDD §19.4 | M6 (build in M1 if time) |
| G-14 | F8 step 4 map preview (FR-56 PARTIAL) and G-16 "camera blocked" screenshots are not built | FINAL-QA, NEXT-PHASE | M1 |

### 2.2 Requirements not yet proven

From `FINAL-QA-REPORT.md`, PARTIAL and NOT TESTABLE rows.

| ID | Requirement | Verdict today | What closes it | Milestone |
|---|---|---|---|---|
| G-20 | FR-03 Google sign-in | PARTIAL | Real OAuth clients (web + Android), native module | M2, M4 |
| G-21 | FR-28 / E-15 host-assisted entry | PARTIAL | R-12 on a real phone camera; native path executed | M2, M6 |
| G-22 | FR-56 set gate location | PARTIAL | Map preview (G-14) | M1 |
| G-23 | NFR-01 p95 < 800 ms server, < 2 s on 4G | NOT TESTABLE | Load test on staging + 4G phone timing | M3, M6 |
| G-24 | NFR-02 gate landing interactive < 3 s (Lighthouse, mid-range Android) | NOT TESTABLE | Lighthouse on staging, real mid-range phone | M6 |
| G-25 | NFR-03 push within 10 s p95 | NOT TESTABLE | Real Expo push to Android (and web push if D-03) | M2, M6 |
| G-26 | NFR-04 dashboard within 5 s | PARTIAL | Measured on staging with Supabase direct connection | M3, M6 |
| G-27 | NFR-05 99.5 % availability 07:00–23:00 | NOT TESTABLE | Uptime data from the pilot | M7 |
| G-28 | NFR-06 50 scans/min/gate burst | NOT TESTABLE | Load test on staging | M3 |
| G-29 | NFR-07 all §16.4 controls before real data | PARTIAL | SA-12 headers, real bucket check, two-owner + MFA process | M3, M5 |
| G-30 | NFR-09 returning guest ≤ 30 s / ≤ 4 taps; first-time ≤ 3 min | NOT TESTABLE | Timed sessions with real people | M6 |
| G-31 | NFR-10 Chrome, Safari iOS 15+, Samsung Internet 18+; Android 9+ app | PARTIAL | Real-device matrix | M1, M2, M6 |
| G-32 | NFR-11 WCAG 2.1 AA, 200 % text | PARTIAL | axe audit + 200 % text pass | M1 |
| G-33 | NFR-13 errors reach Sentry within 1 min | PARTIAL | Real Sentry projects | M4 |
| G-34 | NFR-14 ≤ ₹1,500/month | NOT TESTABLE | Real bills. See §5: **likely over budget** with Supabase Pro | M5, M7 |
| G-35 | E-16 GPS inside geofence but in a nearby room | NOT TESTABLE | Field calibration §19.4 | M6 |

### 2.3 Security items

From `SECURITY-AUDIT.md`.

| ID | Item | Milestone |
|---|---|---|
| G-40 | SA-12 web CSP / `frame-ancestors` / HSTS / `nosniff`. Proposed `vercel.json` already written up in SECURITY-AUDIT "Open items" | M3 |
| G-41 | Deployment checklist: `APP_ENV`, `TURNSTILE_SECRET`, `TRUST_PROXY_HOPS=1` (Render), `SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_TURNSTILE_SITE_KEY` per environment | M3, M4 |
| G-42 | Verify the Supabase Data API does not expose the `haven` schema (D7, §11.7) on the real projects | M3 |
| G-43 | Two Supabase owners max; MFA on GitHub, Supabase, Render, Vercel, Google Cloud (§16.4). This is a people process | M3 |
| G-44 | Secret-rotation procedure for `JWT_SECRET`, `OTP_PEPPER`, `DATA_ENCRYPTION_KEY` documented (§16.4 "Secrets") | M5 |
| G-45 | SA-18 (push-token takeover) and SA-23 (dev-tooling advisories) remain accepted. Re-check SA-23 when Expo updates | M7 |

### 2.4 People, data and sign-off

From `DECISIONS.md` Part 3 and `NEXT-PHASE.md`.

| ID | Item | Milestone |
|---|---|---|
| G-50 | §23.1 Q1–Q10, Q12 still "Pending" (visiting times, cut-offs, zones, limits, retention, office staff list) | M6 (ask in M1) |
| G-51 | §23.1 Q8 guest-room price ₹150 vs ₹200: real money, must be confirmed | M6 (ask in M1) |
| G-52 | §23.1 Q11 written approval for real data, naming the hostel administration as data owner. **Blocks the pilot** | M6 |
| G-53 | Wording sign-off: privacy notice (DEC-020), `location_denied` (DEC-022), in-app-browser prompts (DEC-023), `camera_denied` + rule refusals (DEC-025) | M6 (ask in M1) |
| G-54 | §23.2 team items: domain and who pays, gate device, Supabase Pro, iPhone share, stream owners | §6 decisions |
| G-55 | §23.3 calibration results table is empty | M6 |
| G-56 | Real GH-8 data: room list, gate coordinates, warden and office Gmail addresses, rules config v1 values | M5 |
| G-57 | NEXT-PHASE suggestion: pre-fill invited guest's name/gender. This changes FR-02 behaviour, so it needs a decision first (D-12) | M1 (if decided) |
| G-58 | User guides: guest, resident (Android + iPhone), warden, office, gate/receptionist card | M6 |

---

## 3. Milestones

Order: M1 and M3 can start in parallel. M2 needs M3's staging API for real push. M4
needs M3's domains. **Start the DLT/SMS paperwork (M4, task M4-3) and buy the domain in
week 1**, because both have lead times you can't compress (SDD §15.3, §21.4).

Each milestone ends with a demo and a commit that updates `TRACEABILITY.md` and
`FINAL-QA-REPORT.md` verdicts.

### M1: mobile-first screens and an installable web app (PWA)

**Goal:** every screen works one-handed on a 360 px Android and a 390 px iPhone. The
web app installs to the home screen on both platforms, and (if D-03) receives push
notifications there.

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M1-1 | Screen audit at 360×640, 390×844 and 768×1024 for every route in `apps/mobile/app/` (guest, resident, warden, office, gate). Fix overflow and fixed widths; staff tables become card lists below 600 px; bottom tabs on mobile stay as §13.3 says | §13.3, §13.7, NFR-10 |
| M1-2 | Touch targets ≥ 48 px, focus order, labels; automated axe scan of guest screens; 200 % text test | NFR-11 |
| M1-3 | Playwright projects for mobile device emulation (Pixel-class Chromium, iPhone-class WebKit). Keep the desktop project | NFR-10, §19.1 |
| M1-4 | Web app manifest (`name`, `short_name`, `display: standalone`, `start_url: /`, `scope: /`, theme colour from tokens, 192/512 + maskable icons), `apple-touch-icon`, iOS meta tags. Served through an Expo `public/` HTML template [1] | new (PWA) |
| M1-5 | Minimal service worker. Install and offline shell only; **never caches `/v1` API responses** (personal data, §16); versioned so an update can't get stuck. Expo warns that aggressive caching makes updates hard [1] | §16, new |
| M1-6 | Install UX. Android: an "Install HAVEN" button driven by `beforeinstallprompt` [2]. iPhone: a short "Share → Add to Home Screen" guide, because iOS has no install prompt [2]. Detect standalone mode so the guide hides once installed | new |
| M1-7 | *(only if D-03 = yes)* **Web push for installed web apps**. VAPID keys; `push_tokens` gains a kind (`expo`/`webpush`) and a subscription (migration); the worker gets a web-push sender beside Expo; the service worker shows the notification, routes taps, and calls `POST /v1/notifications/{id}/opened`; permission asked only from a button tap (required on iOS [3]) | FR-40, FR-42, §9.7, §15 |
| M1-8 | Sign-in inside the installed web app: confirm the `haven_rt` cookie and Google Identity Services work in standalone mode on iOS and Android; if the GIS popup fails in standalone, switch to GIS redirect mode | FR-03, §9.5 |
| M1-9 | Camera and GPS in standalone mode: keep the existing "tap to turn on camera" step, because iOS home-screen apps may ask for camera permission again on each launch [4][5]; no file picker anywhere | FR-24, D4, CLAUDE.md §3.7 |
| M1-10 | Build the F8 map preview (FR-56) and the G-16 help screenshots | FR-56, E-17 |
| M1-11 | *(if time)* `/gate/calibrate` staff tool (G-13), so M6 isn't blocked | §19.4 |
| M1-12 | *(only if D-12 = yes)* pre-fill guest name/gender from the invite; the 18+ tick, consent and selfie still come from the guest | FR-02, §16.3 |
| M1-13 | Send the warden the §23.1 questions and the four wording texts now, so the answers arrive by M6 | G-50..G-53 |

**What you must do by hand**
- Borrow at least one iPhone (iOS 16.4 or later; ideally the current iOS) and two
  different Android phones (one Samsung, for Samsung Internet).
- Decide D-03 (web push) and D-12 (pre-fill) before M1-7 and M1-12 start.
- Send the warden the questions in M1-13.

**How it will be verified**
- Playwright mobile-viewport projects green in CI.
- Lighthouse "installable" checks pass on the staging URL, once M3 gives one.
- A manual checklist on each real phone, with screenshots in the PR:
  1. install to home screen;
  2. sign in (guest OTP, resident Google);
  3. live camera;
  4. GPS at a test gate;
  5. if D-03, a push arrives with the app closed and the tap opens the right screen;
  6. uninstall and reinstall.
- axe report attached; 200 % text screenshots.

**Exit:** NFR-10 and NFR-11 move to PASS for the web, or have written exceptions.
FR-56 moves to PASS.

### M2: Android app (EAS build) with push, native camera, location and sign-in

**Goal:** a signed APK that residents, wardens and office staff install from a link
(SDD §8.3: "Distributed by link for the pilot; Play Store later").

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M2-1 | `eas.json` with `development`, `preview` (APK) and `production` (APK) profiles; Android `package` (e.g. `in.<domain>.haven`), `versionCode`, EAS project id | §8.3, §18.5 |
| M2-2 | Firebase project for FCM; upload FCM v1 credentials to EAS so Expo push can reach Android | FR-40..44, NFR-03 |
| M2-3 | Native Google sign-in with `@react-native-google-signin/google-signin` and its config plugin; Android OAuth client with the EAS keystore's SHA-1; web client id as the server client id; both ids in `GOOGLE_CLIENT_IDS` | FR-03, §9.5 |
| M2-4 | Run every native path on a device: `LiveCamera.native`, `QrScanner.native`, `useScanLocation.native` (refuses `mocked === true` with "Turn off fake location apps"), `react-native-sse`, `token-store.native` | FR-24, FR-28, CLAUDE.md §4 |
| M2-5 | Push end to end: permission, Android channels, token registration, tap routing, receipts job, `DeviceNotRegistered` handling; battery-optimisation guidance (§18.3 runbook) | FR-40..44, §9.7 |
| M2-6 | `@sentry/react-native` replaces the no-op | NFR-13, SA-13 |
| M2-7 | `GET /v1/meta/min-app-version` → `{ minVersion, latestApkUrl }` and the "Please update" block | §18.5 |
| M2-8 | APK download page at `https://app.<domain>/android` with install steps ("allow this source", Play Protect warning text) | §8.3 |
| M2-9 | Optional: Maestro flows on device for R-08 walk-in approval and R-12 host-assisted entry | FR-28, §19.1 |

**What you must do by hand**
- Create an Expo account (free) and an EAS project. Create a Firebase project and a
  Google Cloud Android OAuth client (free).
- **Back up the Android signing key.** EAS manages it, but losing access means
  residents must uninstall and reinstall.
- Use at least two physical Android phones, one on Android 9–11 (NFR-10: Android 9+).
- Note on distribution: Google's new developer-verification rule for sideloaded apps
  is enforced from 30 Sep 2026 only in Brazil, Indonesia, Singapore and Thailand, with
  global rollout "in 2027" and no India date announced. Its free "limited
  distribution" account covers only 20 devices [6][7]. **(verify)** before M7. If India
  is added during the pilot, sideloading the APK may need developer verification or
  the Play Store (D-09).

**How it will be verified**
- APK installed from the link on two phones.
- Google sign-in works.
- 20 timed walk-in pushes give a p95 under 10 s (NFR-03).
- Deny camera → G-16 / R-12 copy.
- A fake-location app → refused.
- Push tap opens R-08 / R-09.
- An old `versionCode` sees "Please update".

**Exit:** FR-03 PASS (Android half), FR-28 / E-15 PASS on device, NFR-03 measured.

### M3: staging and production infrastructure, CI/CD

**Goal:** `staging` and `production` exist as SDD §8.3 / §20.5 describe, and deploys
are automatic (staging) or one approved tag (production).

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M3-1 | Two Supabase projects, staging and production, in Mumbai `ap-south-1`. Apply migrations with the pinned Supabase CLI. Create the `haven_api` role (§11.7); remove `haven` from the Data API's exposed schemas; private buckets; confirm `pg_cron` jobs registered | §8.3, D7, §11.7 |
| M3-2 | Render web services (staging, production), Singapore. Health check `/ready`; `WORKER_ENABLED=true` on exactly one instance; `TRUST_PROXY_HOPS=1`; env from Render's secret store | §8.3, §20.3, SA-10 |
| M3-3 | Vercel project for the Expo web export at `app.<domain>`. `vercel.json` with SA-12 headers (CSP with `connect-src https://api.<domain>`, `frame-ancestors 'none'`, HSTS `max-age=31536000`, `nosniff`, `Referrer-Policy`) and SPA rewrites for `/i/:token` and `/g/:token` | §16.4, SA-12 |
| M3-4 | DNS: `app.` and `api.` subdomains; `COOKIE_DOMAIN=.<domain>`; `CORS_ORIGINS=https://app.<domain>` only | §16.4, §20.3 |
| M3-5 | Generate per-environment secrets (`openssl rand -base64 32`); never shared between staging and production | §16.4 |
| M3-6 | `deploy-staging.yml`: on merge to `main`, run migrations on staging, then the Render deploy hook, then Vercel, then smoke `/ready` | §20.5 |
| M3-7 | `deploy-prod.yml`: on tag `v*`, GitHub "production" environment with required reviewer, then migrations, API, web, EAS APK attached to the GitHub release; refuse to run 17:00–22:00 IST | §18.5, §20.5 |
| M3-8 | First green GitHub Actions run of pgTAP and Playwright; pin the Supabase CLI version; branch protection on `main` with required checks | FINAL-QA, §20.6 |
| M3-9 | Dependabot (weekly) for npm and GitHub Actions | §16.4 |
| M3-10 | Verify on staging: the real Supabase bucket and 120 s signed URLs (DEC-021); SSE on the direct connection (D-04); photos survive a redeploy | §9.10, FR-50 |
| M3-11 | Load test on staging: 50 scans/min burst, p95 latency | NFR-01, NFR-06 |
| M3-12 | Staging seed with fake data only; test phones allowed (DEC-018); production never seeded with demo data | §8.3, DEC-018 |

**What you must do by hand**
- **Buy the domain** (D-02).
- Create the accounts (GitHub, Supabase, Render, Vercel), each with MFA. Only two
  people hold Supabase owner access (§16.4).
- Add a payment card to Render, and to Supabase if D-04 = Pro.
- Give the CI secrets (deploy hooks, Supabase access token, Vercel token, Expo token)
  to GitHub Actions. Do it yourself; don't paste them in chat.

**How it will be verified**
- SDD §19.5 smoke test passes on staging.
- Headers scan shows CSP, HSTS and `nosniff`.
- `curl` from another origin is refused by CORS.
- `https://<project>.supabase.co/rest/v1/visits` does not return `haven` data.
- Load-test report in the PR.
- A deliberate failing migration stops the deploy.

**Exit:** NFR-01, NFR-04 and NFR-06 measured on staging. SA-12 closed. G-40..G-43
closed.

### M4: real integrations (Google sign-in, SMS, push, CAPTCHA, Sentry)

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M4-1 | Google Auth Platform. A separate Cloud project for staging and production; external audience, "In production", basic scopes only (`openid`, `email`, `profile`), which generally avoids formal verification [8] **(verify)**. Web clients with `https://app.<domain>` origins; Android clients from M2 | FR-03, FR-06, D8 |
| M4-2 | Staff invite acceptance (F11) with a real Gmail account | FR-06 |
| M4-3 | **SMS: start the paperwork in week 1.** Carry out the option chosen in D-01 (§4 compares them). For the SDD route (MSG91 + DLT): implement `Msg91SmsSender` for OTP and notifications, the `MSG91_TEMPLATES` map, and the exact §15.3 texts; whitelist the `app.<domain>` URL on DLT, because unlisted links are blocked since 1 Oct 2024 [9] | FR-01, FR-41, FR-43, §9.5, §15.3 |
| M4-4 | Expo push in production: `EXPO_ACCESS_TOKEN`, receipts job; web push VAPID keys if D-03 | §9.7, NFR-03 |
| M4-5 | Cloudflare Turnstile site keys for `app.<domain>` (and staging); `TURNSTILE_SECRET` | §16.4, SA-07 |
| M4-6 | Sentry projects (API, web, Android); alert rules from §18.2; source maps; confirm no phone numbers or photo paths reach Sentry | NFR-13, §18.2 |
| M4-7 | Confirm the dev sign-in and test phones are refused in production (`APP_ENV=production`) | SA-02, SA-24, DEC-018 |

**What you must do by hand**
- Google Cloud projects and the OAuth consent screen.
- SMS accounts and DLT registration (with the university, if D-01 picks that), plus a
  recharge.
- Cloudflare account (Turnstile) and Sentry account.

**How it will be verified**
- A real OTP is delivered within 30 s to a Jio, an Airtel, a Vi and (if available) a
  BSNL number.
- Walk-in SMS fallback arrives at 60 s when the push is not opened (FR-41).
- A test error appears in Sentry within 1 minute (NFR-13).
- The 4th OTP request from one IP shows Turnstile.
- A staff invite is accepted with a real Gmail.

**Exit:** FR-03, FR-06 acceptance and NFR-13 PASS; FR-01 / FR-41 PASS with real
delivery (or a recorded SMS-limited mode, if D-01 chooses one).

### M5: operations (backups, monitoring, kiosk gate tablet, real data setup)

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M5-1 | Backups. Either Supabase Pro daily backups (7 days), or SDD §18.4's fallback: a nightly `pg_dump` from GitHub Actions to an encrypted artifact kept 7 days (D-04) | §18.4 |
| M5-2 | **Restore drill**: restore staging from a backup, then run the §19.5 smoke test; record the time taken | §18.4 |
| M5-3 | Monitoring: UptimeRobot on `api /ready` and `app /gate` [10]; Sentry cron monitor for the worker; saved daily health SQL (§18.2); `cron.job_run_details` review | §18.2 |
| M5-4 | `docs/RUNBOOK.md` from §18.3: on-duty roster, incident log, paper-register fallback, secret-rotation procedure | §18.3, §16.4 |
| M5-5 | **Kiosk gate device.** Dedicated Android phone or tablet (D-06): Chrome → install `/gate` to home screen; Android screen pinning (free) or a kiosk browser app; always on charge; Chrome exempt from battery optimisation; Wi-Fi plus mobile data; pair (F8); second device test (E-23); 8-hour unattended run | FR-20, FR-29, FR-30, E-01, E-23 |
| M5-6 | Production setup script, with no fake data: hostel GH-8, gate(s), the real room list, super admin, warden grant (`grant-role`), rules config v1 with the warden's confirmed values | FR-55, §4, §18.3 |
| M5-7 | Data-protection pack: final privacy notice (DEC-020), processor list (Supabase, Render, Vercel, SMS provider, Google/FCM, Expo, Sentry, Cloudflare), grievance contact, retention as approved (Q10); account deletion tested in production | §16, NFR-07, NFR-08 |
| M5-8 | Access review: two Supabase owners, MFA confirmed on every account, a list of who holds what | §16.4 |

**What you must do by hand**
- Get the gate device (D-06), place it, and arrange power and Wi-Fi with the hostel.
- Collect the room list, gate position and staff Gmail addresses from the warden.

**How it will be verified**
- Restore drill log.
- A simulated outage alerts the on-duty phone.
- The gate runs 8 hours without sleeping or unpairing.
- Unplugging the gate triggers the warden's offline alert after 5 minutes (FR-29).
- The production database holds no demo rows.

### M6: field calibration, measurements, user guides, warden acceptance

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M6-1 | `/gate/calibrate` (if not done in M1) | §19.4 |
| M6-2 | GPS calibration per §19.4. Two Android phones and one iPhone; 10 fixes each at the gate, 15 m and 30 m outside, and inside the nearest rooms; choose `radius_m`; record in SDD §23.3 and `DECISIONS.md` | §19.4, E-16, TC-GEO |
| M6-3 | Measurements: NFR-02 Lighthouse on a mid-range Android on 4G; NFR-01 4G timing; NFR-03 push p95; NFR-04 dashboard 5 s; NFR-09 timed sessions with 5 real people (returning and first-time guests) | NFR-01..04, NFR-09 |
| M6-4 | Browser matrix: Chrome (Android 9+), Safari on iOS 15+ for guests (NFR-10), Samsung Internet 18+, WhatsApp/Instagram in-app browsers (E-03) | NFR-10, E-03 |
| M6-5 | User guides (one page each, plain language): guest poster at the gate; resident Android (APK install, notifications, battery settings); resident iPhone (Add to Home Screen, allow notifications); warden; office; receptionist gate-device card | §13, §18.3 |
| M6-6 | Warden acceptance: every §19.6 scenario, run with the warden on staging; signed acceptance note | §19.6 |
| M6-7 | Settle §23.1 Q1–Q12 and the four wording sign-offs; record each as "Confirmed" or "Overridden" with the date | G-50..G-53 |

**What you must do by hand**
- Book the warden and office staff.
- On-site sessions at the GH-8 gate (two people, three phones).
- Recruit 5 people for timed sessions.
- Get the written Q11 approval.

**How it will be verified**
- Calibration table filled in.
- NFR measurement report.
- Signed §19.6 acceptance.
- `DECISIONS.md` Part 3 has no "Pending" rows left for the pilot.

### M7: final QA and the v1.0 release

**Tasks**

| # | Task | Requirement IDs |
|---|---|---|
| M7-1 | Independent re-run of the FINAL-QA method on the release candidate. Every PARTIAL / NOT TESTABLE is either PASS or an accepted DEC | all |
| M7-2 | Security re-check: SA-12 live, headers scan, `pnpm audit --prod`, secrets scan of history, SA-18/SA-23 re-review | NFR-07 |
| M7-3 | Go-live checklist: Q11 approval on file, backups proven, alerts proven, paper register at the gate, on-duty roster, no deploys 17:00–22:00 | §18.4, §18.5 |
| M7-4 | Tag `v1.0.0`, run `deploy-prod`, APK on the release, §19.5 smoke test in production | §18.5, §20.5 |
| M7-5 | Two-week pilot (SDD §21); week-1 review: radius re-check from `gate_events.distance_m` (§19.4 step 5), costs against NFR-14, uptime against NFR-05 | §19.4, NFR-05, NFR-14 |
| M7-6 | `TRACEABILITY.md`, `FINAL-QA-REPORT.md` and SDD addenda updated for every decision taken in M1–M6 | CLAUDE.md §1 |

**Exit:** v1.0.0 tagged, pilot running, and the warden's sign-off on file.

---

## 4. SMS for OTP in India: the options

### 4.1 What the SDD needs from SMS

| Message (§15.3) | Why it's needed | Contains a link? |
|---|---|---|
| `HAVEN_OTP` | Guest sign-in (FR-01), resident phone verification (FR-04). **Without it no guest can sign in at all.** | No |
| `HAVEN_WALKIN` | Host fallback if push isn't opened in 60 s (FR-41) | **Yes** |
| `HAVEN_CONFIRM_LOC` | Host confirms a guest's location (F3) | **Yes** |
| `HAVEN_OVERSTAY` | Guest overstay (FR-72) | No |
| `HAVEN_DISPUTE` | Warden alert (FR-43) | **Yes** |

**The rules in India:**
- Every commercial SMS to an Indian number, OTPs included, must come from a registered
  entity, header (sender ID) and template on a DLT platform [11][12].
- Since 1 Oct 2024, messages carrying a URL that isn't whitelisted on DLT are blocked [9].
- TRAI has also ordered variable parts such as URLs to be pre-tagged in templates
  (Nov 2025) [13].

So three of the five templates can only go through **our own** DLT registration with
the `app.<domain>` URL whitelisted. A provider's ready-made OTP template covers
`HAVEN_OTP` only.

**Volume assumption** (verify in pilot week 1), used for every monthly figure below:
- 200 residents, about 800 guest visits a month;
- about 500 guest OTPs a month, plus 200 one-time resident verifications;
- about 300 notification SMS a month;
- so **about 1,000 SMS a month**.

### 4.2 Options

Rates exclude 18 % GST unless stated. ₹88 = US$1 is assumed **(verify)**.

| | A. Own DLT + MSG91 (the SDD route) | B. University as the registered entity (+ MSG91) | C. Provider's own registered OTP template | D. Firebase / Google phone auth | E. WhatsApp OTP |
|---|---|---|---|---|---|
| **What it is** | We register as Principal Entity, register the header (e.g. `HAVENX`) and the 5 templates, and send through MSG91 | Same as A, but the university (or hostel administration) is the Principal Entity and we send under its header | The provider sends **its own** approved OTP text from **its own** header; we pass the code | Google sends the SMS and verifies the code in its SDK; our API trusts a Firebase ID token | OTP as a WhatsApp authentication-template message (Meta Cloud API or a provider) |
| **Who can register** | Mainstream guidance expects a business PAN, address proof and a letter of authorisation [11][14][15]. One vendor says some operator portals accept an individual with personal PAN and Aadhaar; that is a single source **(verify on the operator portal)** [16] | Educational institutions are a recognised PE category [17]. Needs the university's PAN and documents and an authorised signatory **(verify with the university's IT or admin office)** | Anyone with an account. OTP Flow says "no KYC", same-day [18]; Message Central VerifyNow says no DLT or sender ID needed [19]. **Message Central describes its no-DLT routes as international paths** [20]: their long-term deliverability and compliance are uncertain | Google account with Blaze (pay-as-you-go) billing [21] | A Meta business portfolio. Unverified portfolios are capped at 250 unique users / 24 h; a verified display name needs business verification [22][23] |
| **Setup steps** | 1. Entity registration on an operator DLT portal (Jio/Airtel/Vi/BSNL). 2. Header. 3. Five templates (exact §15.3 text). 4. Whitelist `app.<domain>`. 5. MSG91 account; link DLT IDs. 6. Implement `Msg91SmsSender` | Same as A, done by or with the university's admin; we get API access via MSG91 under their entity | 1. Sign up. 2. Recharge. 3. New `SmsProvider` adapter for `HAVEN_OTP` only | 1. Firebase project + Blaze. 2. Firebase JS SDK and reCAPTCHA on guest login; Android SDK in the app. 3. API verifies Firebase ID tokens | 1. Meta business portfolio and WhatsApp number. 2. Business verification. 3. Authentication template approval. 4. New adapter |
| **Cost per OTP** | ₹0.15–0.25 per SMS at small volume [24][25] **(verify on MSG91's own rate card)** | Same as A | ₹0.30 (Message Central) [19], ₹0.40 (OTP Flow) [18]. Fast2SMS's no-DLT "Quick SMS" is ₹7.00 from a random number [26] (not suitable) | **US$0.07 ≈ ₹6.2 per SMS to India**; first 10 SMS a day are not billed [21][27] **(verify)** | Meta list rate ≈ ₹0.115 per authentication message to India [28][29]; providers add markup (e.g. ₹0.145 [30]) |
| **Monthly cost, ~200 users (~1,000 SMS)** | **≈ ₹300 incl. GST**, but MSG91 sells packs (first slab cited at 5,000 SMS) [25], so ≈ ₹1,500 up front that lasts months **(verify)**. One-time DLT fee ₹0–5,900, sources conflict [12][15][31] | Same as A; the DLT fee may be borne by, or already paid by, the university | OTPs only: ≈ ₹180–240 for ~600 OTPs. **No notification SMS** (3 of 5 templates have links) | ≈ ₹2,000–4,000 for ~600–900 billed OTPs. **Over the NFR-14 budget on its own** | ≈ ₹100–200 + GST. No notification SMS unless utility templates are also approved (same rate) |
| **Time to go live** | Days to weeks (SDD §15.3); a rejected KYC fee is non-refundable [15] | Weeks: depends on university paperwork, the slowest route | Same day [18][19] | 1–2 days | Days to weeks (verification + template approval) |
| **Code / SDD changes** | **None to the SDD.** Implement `Msg91SmsSender` + config (G-11) | None to the SDD; header and templates name the university's entity. Record DEC | New adapter; OTP text is the provider's, not §15.3's → DEC + SDD addendum to §15.3; FR-41/FR-43/F3 SMS parts run in §21.4's "push only, SMS fallback disabled" mode → DEC; check the provider lets us send **our** code (keeps §9.5's HMAC storage), or §9.5 changes too; a new data processor (§16) | **Large.** Replaces §9.5 guest OTP (our HMAC challenge, limits, test phones, Turnstile) with Firebase's; a new dependency against CLAUDE.md §5; FR-01, §8.4, §9.5, §12 change; notification SMS still need A or B | FR-01 says SMS → SDD change; guests without WhatsApp need a fallback; new adapter and processor; FR-41 etc. still need SMS |
| **Risks** | Personal-PAN route unproven; the rejected-KYC fee | Depends on someone at the university; slow | Small vendors; unclear routes; DPDP (guest phone numbers go to an unvetted processor) | Cost; vendor lock-in; Firebase's own abuse limits | Guests without WhatsApp; Meta verification needs a business |

### 4.3 Recommendation (for you to decide: D-01)

**B: ask the university (or the hostel administration) to be the DLT Principal Entity,
with MSG91 as the sender.**
- It is the only route that delivers all five §15.3 messages, including the three with
  links, at about ₹300 a month.
- It needs no SDD change.
- It puts the registration in the name of the body that §23.1 Q11 already makes the
  data owner.

**Run A in parallel only if the university can't act within about 3 weeks**, and only
if an operator portal confirms it accepts an individual.

**If neither is live by M7**, launch in a recorded "SMS-limited" mode:
- `HAVEN_OTP` goes through C (Message Central or OTP Flow, after asking them in
  writing which route they use);
- the notification SMS stay off, as SDD §21.4 already anticipates;
- this needs a DEC and an SDD addendum.

**Not recommended:**
- D, on cost (about ₹2,000–4,000 a month for OTPs alone, against a ₹1,500 total budget)
  and because it would rewrite §9.5;
- E as the main channel, because FR-01 is SMS and not every guest has WhatsApp.
  It's fine as a later addition.

---

## 5. iPhone users: the PWA path for residents, wardens and office staff

The SDD already plans for this: "Residents on iPhone use the web version (push less
reliable; SMS fallback covers approvals)" (L7), and "iOS app not published" (L9). This
is the evidence for what works today.

| Capability | Works on iPhone? | Conditions and limitations | Source |
|---|---|---|---|
| **Install to home screen** | Yes | Manually only: Share → Add to Home Screen. No `beforeinstallprompt`, so we can't show an install button, only a guide (M1-6). The manifest with `display: standalone` makes it open as an app, not a bookmark | [2][3] |
| **Web push** | Yes, **only for an installed home-screen web app**, iOS/iPadOS 16.4+ | In a normal Safari tab, `Notification` is undefined and push isn't available. Permission must come from a tap. Every push must show a visible notification; silent pushes lose permission. Payload ≤ 4 KB. No Apple Developer account needed; Apple's push service is used (allow `*.push.apple.com`). Badging API supported. Notification action buttons may not be supported **(verify)**, so "Approve" is a tap that opens R-08, not a button on the notification | [3][32][33] |
| **iOS 15 – 16.3** | Partly | NFR-10 promises guests Safari iOS 15+. Guest flows don't need push, so they're unaffected. A **resident** on iOS < 16.4 gets in-app updates and SMS fallback only | [3], NFR-10 |
| **Camera (live photo, QR scan)** | Yes (`getUserMedia`) | In home-screen apps iOS may ask for camera permission again on each launch (no "remember" setting reported by developers), and an old WebKit bug reports re-prompts on route changes. Keep the explicit "Turn on camera" tap; test on the current iOS **(verify on device)** | [4][5] |
| **GPS** | Yes (`navigator.geolocation`) | Needs Location Services on for Safari Websites. No evidence found of standalone-specific problems, but none of the absence either **(verify on device)**. Mock location can't be detected in a browser (SA-26, L2: accepted) | SDD L2, SA-26 |
| **Sign-in** | Expected yes | An installed web app has its own storage, so users sign in again inside it after installing. Google's popup in standalone mode must be tested; fall back to GIS redirect mode (M1-8) **(verify on device)** | — |
| **Gate device on an iPad** | Not recommended | Safari can clear script-written storage (where the gate secret lives, SA-25) for sites not used for 7 days; home-screen apps are counted separately. Prefer a dedicated Android device (D-06) | [34] |

**Bottom line:**
- The PWA path works for iPhone residents, wardens and office staff on **iOS 16.4 or
  later, once they add HAVEN to the home screen**.
- If D-03 = yes, they get real push. Without it, they rely on in-app banners and SMS
  fallback, as SDD L7 says today.
- The SMS fallback (FR-41) matters most for these users. That is one more reason to
  get the full DLT route (§4.3) rather than OTP-only.

---

## 6. Cost table: ~200-resident pilot, monthly, in ₹

₹88 = US$1 assumed **(verify)**. USD services billed to an Indian card may add a
foreign-transaction fee. Indian services add 18 % GST. Every row is **(verify)** before
you pay.

| Service | Free plan: what you get and the catch | Paid plan | ₹/month (paid) | Recommendation |
|---|---|---|---|---|
| **Supabase** (DB + Storage, Mumbai) | ₹0. Pauses after 7 days of inactivity (a daily-used production won't pause; staging might). **No backups** [35][36]. Storage quota limits apply; our photo estimate (~800 visits × 1–2 photos × ~100 KB, kept 180 days) is **≈ 1 GB steady state** (estimate: measure in pilot) | Pro US$25 per org, includes one Micro compute; extra projects ≈ US$10 each; daily backups kept 7 days [35][36] | ≈ ₹2,200 (+ ≈ ₹880 if staging is in the same paid org) | D-04 |
| **Render** (API + worker, Singapore) | ₹0, but **spins down after 15 min idle**, ~1 min to wake [37][38]. The worker and SSE must run continuously, so the free tier is **unsuitable for production** (fine for staging) | Starter ≈ US$7 [39] **(verify: Render's page lists several "Starter" prices)** | ≈ ₹620 | D-05: paid for production |
| **Vercel** (web app) | ₹0 Hobby, but **"personal or non-commercial use" only** [40][41]. A free university pilot is arguably non-commercial **(verify / ask Vercel)** | Pro US$20 per member | ≈ ₹1,760 | D-07 |
| **Domain** (`.in`) | — | ≈ ₹600–1,000 a year at renewal; promos can be lower [42][43] | ≈ ₹50–85 | D-02 |
| **SMS** | — | See §4. MSG91: ≈ ₹300 a month at ~1,000 SMS; DLT entity fee ₹0–5,900 one-time | ≈ ₹300 | D-01 |
| **Expo / EAS** (Android builds, push) | ₹0. Limited low-priority builds a month (cited as 15 Android [44] **(verify)**); push free [45]. A per-org MAU limit for push has been reported by a third party only **(verify)**; 200 users would be under it | Starter US$19 | ₹0 needed | Free |
| **Web push** (if D-03) | ₹0. Browser push services (Apple, Google) are free; we send from our own API | — | ₹0 | — |
| **Google Cloud** (OAuth) | ₹0 for sign-in with basic scopes [8] | — | ₹0 | Free |
| **Firebase** (FCM for Expo push on Android) | ₹0 (Spark plan is enough for FCM) | — | ₹0 | Free |
| **Cloudflare Turnstile** | ₹0 | — | ₹0 | Free |
| **Sentry** | ₹0 Developer plan (one user; monthly error quota) **(verify limits)** | Team ≈ US$26 | ₹0 needed | Free |
| **UptimeRobot** | ₹0: 50 monitors, **5-minute** interval; commercial use allowed per its help centre [10][46]. **SDD §18.2 says every 1 minute** | Paid tier for 1-minute checks **(verify price)** | ≈ ₹0–700 | D-08 |
| **GitHub** (repo, Actions, nightly `pg_dump`) | ₹0; private repos include a monthly Actions-minutes quota **(verify)** | — | ₹0 | Free |
| **Gate device** (one-time) | Receptionist's phone (₹0), or a spare Android phone or tablet | ≈ ₹6,000–12,000 one-time **(verify)**; kiosk app licence optional | one-time | D-06 |
| **Google Play Console** | Not needed for APK-by-link | US$25 one-time | one-time, only if D-09 | D-09 |
| **Apple Developer** | Not needed: iPhone users use the PWA; web push needs no Apple account [3] | US$99 a year | ₹0 | Not needed (SDD L9) |

**Monthly totals (₹, approximate):**

| Scenario | What it includes | ₹/month |
|---|---|---|
| **1. Minimum** | Supabase Free + nightly `pg_dump`, Render Starter (prod only), Vercel Hobby, domain, MSG91 SMS, everything else free | **≈ ₹1,000** (plus one-time DLT fee and gate device) |
| **2. Recommended for real data** | Scenario 1 + Supabase Pro (production; staging on a separate free org) | **≈ ₹3,200** |
| **3. Everything paid** | Scenario 2 + Vercel Pro + UptimeRobot paid + Sentry Team | **≈ ₹7,500–8,000** |

**NFR-14 says ≤ ₹1,500 a month "(SMS + domain + possibly Supabase Pro)".**
- At today's prices, Supabase Pro alone (≈ ₹2,200) exceeds that.
- NFR-14 also doesn't list Render, whose free tier can't run the worker.
- So only Scenario 1 meets NFR-14 as written. Choosing Scenario 2 needs NFR-14 changed
  in the SDD (D-04).

---

## 7. Decisions you must make

When you make each decision, it becomes a `DEC-NNN`. Rows marked "SDD change" also need
an SDD addendum in the same PR (`CLAUDE.md` §1.3).

| # | Decision | Options | My recommendation | SDD change? | Needed by |
|---|---|---|---|---|---|
| D-01 | SMS route | A own DLT · B university DLT · C provider template · D Firebase · E WhatsApp (§4) | **B**, with A in parallel if the university is slow; C for OTP only as a last-resort launch mode | B: no (DEC only). C, D, E: yes | Week 1 (lead time) |
| D-02 | Domain name, and who pays | e.g. `haven-gh8.in` (SDD's example) | Buy a `.in` now, paid by the team or the department; check the renewal price, not the promo | No (fills §23.2) | Week 1 |
| D-03 | Web push for the installed web app (iPhone residents and staff; also Android users before they install the APK) | Yes / No | **Yes.** It's the only way iPhone hosts get timely walk-in alerts; free; standard APIs. Needs a new `web-push` library, a `push_tokens` migration and a §9.7/§15 addendum | **Yes** (adds a push channel beside Expo; D6 unchanged) | Before M1-7 |
| D-04 | Supabase Free + nightly `pg_dump` vs Pro for production | Free (SDD §18.4 fallback) / Pro | **Pro for the pilot months if the budget allows**: daily backups, no pause risk, more storage headroom. Otherwise Free + encrypted nightly `pg_dump`, restore-drilled, and upgrade when storage passes 70 % | Pro: **yes** (NFR-14 ₹1,500 is exceeded). Free: no | M3 |
| D-05 | Render plan for production | Free / Starter | **Starter** for production (the worker, jobs and SSE must not sleep); Free for staging | **Yes**, if NFR-14 is read as the full budget (Render isn't in its list) | M3 |
| D-06 | Gate device | Receptionist's phone / spare Android phone / Android tablet / iPad | **Dedicated Android phone or tablet**, Chrome installed to the home screen, screen pinning, always on charge. Avoid iPads (storage eviction risk to the gate secret) | No (fills §23.2) | M5 |
| D-07 | Web hosting | Vercel Hobby / Vercel Pro / another static host | **Vercel Hobby**, after confirming in writing that a free university pilot is "non-commercial"; otherwise Pro. Moving off Vercel needs a DEC (§8.4) | Only if the host changes | M3 |
| D-08 | Uptime check interval | Free 5-minute / paid 1-minute | **Accept 5 minutes** for the pilot (the gate-offline job already alerts at 5 minutes, FR-29) | **Yes** (§18.2 says 1 minute) | M5 |
| D-09 | Android distribution | APK by link (SDD) / Play Console internal testing | **APK by link** for the pilot, as the SDD says; revisit if Google adds India to developer verification [6][7] | No (link). Play: no, since §22.3 already lists it as future | M2 / M7 |
| D-10 | Wardens and office staff on their phones | Same Expo app on Android, PWA on iPhone / web only | **Same as residents**: APK on Android, installed PWA on iPhone; desktop web for long sessions | No (SDD D6, §13.3) | M1 |
| D-11 | Who holds production owner access (two max), and the on-duty roster | Names | You and one named teammate; MFA on every account before M3 | No | M3 |
| D-12 | Pre-fill an invited guest's name and gender (NEXT-PHASE suggestion) | Yes / No | **Yes**, as editable pre-fill only; the 18+ tick, consent and selfie stay with the guest | **Yes** (FR-02 flow detail) | Before M1-12 |
| D-13 | Warden items to chase | §23.1 Q1–Q12, the four wording sign-offs | Send them in M1 (M1-13); **Q8 (₹150 vs ₹200) and Q11 (written real-data approval) block the pilot** | Answers update §23 and the config | M1 (ask) → M6 (settled) |

---

## 8. Sources

Accessed 2026-11-27. Vendor pages are marketing material. Treat their claims as
**(verify)** until confirmed in writing.

1. Expo, "Progressive web apps": https://docs.expo.dev/guides/progressive-web-apps/
2. web.dev, "PWA installation" (`beforeinstallprompt`, not on iOS): https://web.dev/learn/pwa/installation ; MDN, "Making PWAs installable": https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_Installable
3. WebKit, "Web Push for Web Apps on iOS and iPadOS": https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
4. WebKit bug 215884 (home-screen camera prompt on route change): https://bugs.webkit.org/show_bug.cgi?id=215884
5. Developer report, camera re-prompt per launch in iOS standalone apps: https://github.com/Luukalindgren/seeni/issues/69
6. Android Developers Blog, "Android developer verification" (June 2026): https://android-developers.googleblog.com/2026/06/android-developer-verification.html
7. Android Authority, first-wave rollout: https://www.androidauthority.com/android-sideloading-developer-verification-first-wave-rollout-3717921/ ; MediaNama, India timeline: https://www.medianama.com/2025/08/223-google-blocks-android-apk-sideloading-2026/
8. Google Cloud Help, OAuth app verification (basic-scope exception): https://support.google.com/cloud/answer/13461325 ; https://support.google.com/cloud/answer/10311615
9. TRAI press release 67/2024 (URL whitelisting from 1 Oct 2024): https://trai.gov.in/sites/default/files/PR_No.67of2024.pdf
10. UptimeRobot pricing (free: 50 monitors, 5-minute interval): https://uptimerobot.com/pricing
11. MSG91-oriented developer guide to DLT: https://startmessaging.com/blog/dlt-registration-india-sms-developer-guide-2026
12. SignOps, "SMS OTP cost in India and DLT registration": https://signops.dev/blog/sms-otp-cost-india/
13. TRAI press release 133/2025 (pre-tagging of template variables): https://trai.gov.in/sites/default/files/2025-11/PR_No.133_of_2025.PDF
14. Exotel, DLT entity registration: https://developer.exotel.com/docs/sms-support/dlt-entity-registration
15. SMSGatewayHub, DLT registration charges: https://crm.smsgatewayhub.com/knowledge-base/article/dlt-registration-charges-cost-breakdown-in-india
16. Ligicomms, DLT guide (individual route claim): https://ligicomms.in/india/dlt-sms-registration-guide
17. Gupshup, Principal Entity registration (entity categories): https://gupshup.io/dlt/principal-entity-registration
18. OTP Flow, "Send SMS without DLT registration": https://otpflow.in/send-sms-without-dlt-registration
19. Message Central, VerifyNow India: https://www.messagecentral.com/product/verify-now/overview-india
20. Message Central blog, "How to send OTP SMS without DLT": https://www.messagecentral.com/blog/how-to-send-otp-sms-without-dlt-registration
21. Google Cloud, Identity Platform pricing: https://cloud.google.com/identity-platform/pricing
22. Meta, WhatsApp messaging limits: https://developers.facebook.com/docs/whatsapp/messaging-limits
23. Clickatell Help, WhatsApp messaging limits: https://www.clickatell.com/help-center/whatsapp/general-whatsapp/what-messaging-limits-apply-to-my-whatsapp-business-account/
24. Message Central, "SMS OTP pricing in India 2026": https://www.messagecentral.com/blog/sms-otp-pricing-india
25. Unique Digital Outreach, MSG91 pricing slabs: https://uniquedigitaloutreach.in/msg91-vs-udo-sms-pricing-full-cost-comparison/
26. Fast2SMS, OTP via API without DLT: https://www.fast2sms.com/OTP-SMS-via-API-without-DLT-Registration
27. SuperTokens, Firebase Auth pricing (India US$0.07): https://supertokens.com/blog/firebase-pricing
28. Meta, WhatsApp pricing: https://developers.facebook.com/docs/whatsapp/pricing/
29. Authgear, WhatsApp API pricing 2026: https://www.authgear.com/post/whatsapp-api-pricing/
30. AiSensy pricing: https://aisensy.com/pricing
31. SMSGatewayHub, DLT registration overview: https://www.smsgatewayhub.com/dlt-registration
32. progressivewebapps.com, "Web Push on iOS & Safari": https://progressivewebapps.com/background/ios-web-push/
33. MoEngage, Safari Web Push for iOS and iPadOS: https://developers.moengage.com/hc/en-us/articles/13906923326100-Safari-Web-Push-for-iOS-and-iPadOS
34. WebKit, "Full Third-Party Cookie Blocking and More" (7-day script-writable storage cap; home-screen apps counted separately): https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
35. Supabase pricing: https://supabase.com/pricing
36. Supabase Billing FAQ: https://supabase.com/docs/guides/platform/billing-faq
37. Render, "Deploy for free" (15-minute spin-down): https://render.com/docs/free
38. Render FAQ: https://render.com/docs/faq
39. Render pricing: https://render.com/pricing
40. Vercel, Hobby plan: https://vercel.com/docs/plans/hobby
41. Vercel, Fair use policy: https://vercel.com/docs/platform/fair-use-policy
42. Cybernews, best `.in` registrars 2026: https://cybernews.com/best-domain-registrars/best-india-domain-registrars/
43. DomainIndia, `.in` price update (Sep 2025): https://www.domainindia.com/login/announcements/52
44. Expo, billing plans: https://docs.expo.dev/billing/plans/
45. Expo, push notifications FAQ (no cost): https://docs.expo.dev/push-notifications/faq/
46. UptimeRobot Help, who can use the free plan: https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan

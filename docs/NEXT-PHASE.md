# What the demo doesn't do yet — the next phase

The demo runs entirely on one laptop: a throwaway local database, a stand-in for SMS,
"dev sign-in" instead of Google, and one temporary internet tunnel for the phones.
Everything in the app is real code, tested against the design document (see
`docs/FINAL-QA-REPORT.md`: 142 of 159 requirements pass). This is what stands between
it and real use at GH-8.

## Not in this demo

| Item | Today in the demo | What the next phase needs |
|---|---|---|
| **Staging and production** | One laptop, local database, a random `trycloudflare.com` address that changes every start | A Supabase project, the API on Render and the web app on Vercel (SDD §20); fixed `https://` addresses; photo storage in Supabase's private buckets (the code is ready and tested against a stand-in, not yet against a real bucket) |
| **Real SMS** | The one-time code is fixed (`123456`) for the test numbers, and other codes print in the laptop terminal | An SMS provider (MSG91) account, with sender ID and message templates registered on India's DLT system — required by law before any SMS reaches a real phone |
| **Real Google sign-in** | Residents and staff sign in by typing their email ("dev sign-in", switched off everywhere except local) | Google Cloud OAuth client IDs for the web and Android apps |
| **Android app and push notifications** | Everything runs in the phone's browser; the resident sees new requests as an in-app banner | A signed Android build, installed on real phones, with Expo push notifications tested on them |
| **GPS at the real gate** | The gate location is whatever `demo.config.json` says, with a generous 150 m radius for indoor demos | Measure the real GH-8 gate on site (several readings, as the warden screen does), tune the radius, and test with different phones at the gate (SDD §19.4) |
| **Performance and accessibility numbers** | Not measured | Scan-to-check-in time on a mid-range Android over 4G, a load test (50 scans a minute), Safari and Samsung Internet runs, an accessibility audit (NFR-01–NFR-11) |
| **Web security headers** | Not needed locally | Content-Security-Policy and HSTS on the deployed web app (SECURITY-AUDIT SA-12) |
| **Warden acceptance** | Built from the design document | A walkthrough with the GH-8 warden and office staff, and their sign-off before any real data is entered |
| **Wording awaiting sign-off** | Proposed text in the app | Approval by the warden (and whoever handles legal/privacy) of: the privacy notice (DEC-020), the "location turned off" message (DEC-022), the in-app-browser prompts (DEC-023), and the camera-blocked and rule-refusal messages (DEC-025) |

## Also known

- Host-assisted entry (a resident scanning for a guest without a phone) works and is
  tested at the API level, but has no browser-level test yet.
- Two features from the design are not built: the map preview when the warden sets the
  gate location, and the screenshots on the "camera blocked" help screen.

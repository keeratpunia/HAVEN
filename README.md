# HAVEN — Hostel Access and Visitor Entry Network

Guest entry for a hostel: a resident invites a guest, the guest signs in on their phone,
scans a rotating QR code at the gate, and a live photo plus a GPS check let them in.
Walk-ins are approved by the resident on the spot; the warden sees everything live.

## Quick start (Windows 11)

New to the project? Do these in order:

1. **[docs/SETUP.md](docs/SETUP.md)** — install the tools, clone, install, run the tests,
   start the demo. Every command is copy-paste PowerShell.
2. **[docs/DEMO.md](docs/DEMO.md)** — the 15-minute presenter script.
3. **[docs/NEXT-PHASE.md](docs/NEXT-PHASE.md)** — what the demo doesn't do yet.

Once set up:

```powershell
pnpm demo            # everything on this laptop: http://localhost:8081
pnpm demo:tunnel     # the same, plus one public https link for phones
pnpm demo:reset      # stop leftovers and start clean
pnpm test            # unit + API tests
pnpm e2e             # browser tests (Playwright)
```

## Repository

| Folder | What's in it |
|---|---|
| `apps/api` | The API (Fastify, TypeScript, PostgreSQL) |
| `apps/mobile` | The app: guest web pages, resident, warden, office and gate screens (Expo) |
| `packages/shared` | The hostel rules engine and text shared by both |
| `supabase` | Database migrations and database tests |
| `docs` | Design document (the source of truth), decisions, QA report, setup and demo |

Engineering rules for contributors are in `CLAUDE.md`; the design document is
`docs/HAVEN — Software Design Document v3.pdf`.

<p align="center">
  <img src="public/logo.png" alt="Screensemble logo" width="128">
</p>
<h1 align="center">Screensemble Server</h1>
<p align="center">
  Signage That Takes the Stage.
  <br><em>An ensemble of screens.</em>
</p>
<p align="center">
  <a href="AI-DECLARATION.md"><img src="https://img.shields.io/badge/AI--DECLARATION-pair-blue" alt="AI-DECLARATION: pair"></a>
</p>
<p align="center">
  <a href="https://github.com/Screensemble/Screensemble-Server/releases"><img src="https://img.shields.io/github/v/release/Screensemble/Screensemble-Server" alt="Latest release"></a>
  <a href="https://github.com/Screensemble/Screensemble-Server/actions/workflows/release.yml"><img src="https://github.com/Screensemble/Screensemble-Server/actions/workflows/release.yml/badge.svg" alt="Release build"></a>
  <a href="https://github.com/Screensemble/Screensemble-Server/actions/workflows/ci.yml"><img src="https://github.com/Screensemble/Screensemble-Server/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

**One dashboard, every display.** Pair a [Screensemble Player](../Screensemble-Addon) Kodi addon once, then manage its content, playlists, and settings entirely from the server — each display dials out on a single persistent WebSocket, so it works behind NAT and firewalls with no inbound connectivity, and keeps playing its last known content when the link drops.

Designed to run fully offline on an isolated show network. No cloud account, no phone-home.

## Features

- **Fleet registry** - persistent player records with hardware-anchored identity (a reinstalled display rebinds, never duplicates), labels, online/last-seen, live status echo.
- **Per-display admin** - the player's full local admin surface, proxied over its socket: playlist ordering, enable/disable, durations, schedules, shuffle, URL items, uploads, settings, restart.
- **Media library** - every upload keeps a server-side copy, reusable across any display. Browse, push, delete.
- **Shared playlists** - named ordered groups assigned to displays. Sync pushes missing files, applies order, and can prune extras for an exact match — one playlist, any number of displays converging on it.
- **Upload queue** - browser uploads and library pushes ride a `pull_file` handshake: the display downloads over HTTP with per-file progress and SHA-256 verification. Still outbound-only.
- **Pairing** - version-gated enrollment on both sides, then an on-TV confirm before a display registers.
- **Deferred updates** - content changes queue on the display and apply at the next natural item boundary; pushes settle before flagging. Nothing cuts mid-play.
- **Per-device auth** - pairing stores a token; every hello is verified against it. Displays mint one automatically when configured manually.
- **Conductor (in progress)** - arm/go staging for synchronized multi-display performances.

## Quick start

```sh
docker run -p 8090:8080 -v screensemble-data:/app/data \
  ghcr.io/screensemble/screensemble-server
# or from source:
npm ci && PORT=8090 npm start
```

Open `http://<host>:8090/` — fleet list, per-display admin, media library, shared playlists, pairing.

Requirements: Node.js >= 20 or Docker. Registry, playlists, library, users, and staged uploads all live in the `data` volume at `/app/data` — backup is copying it.

## Sign-in & users

The dashboard and admin APIs require sign-in ([Better Auth](https://better-auth.com) — username auth backed by SQLite in `data/auth.db`; no external identity service needed).

- **First login:** user `screensemble`, password `screensemble` — a password change is forced before anything else is reachable.
- **User management:** `/users.html` (admin only) — add/delete users, reset passwords. New and reset users must set their own password at first login.
- **Displays are unaffected:** pairing requests, the player WebSocket, and media pulls keep working without a login — pulls carry the per-device pairing token.

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | Session secret (auto-generated & persisted if unset) |
| `AUTH_DEFAULT_USER` / `AUTH_DEFAULT_PASSWORD` | Seed credentials (defaults `screensemble`/`screensemble`, forced change on first login) |
| `TRIGGER_TOKEN` | Optional shared bearer token for hardware triggers |

## How it works

1. **Pair displays** - open the player's setup QR on a phone (or the server's pair page), confirm on the TV. The display registers and dials out.
2. **Feed the library** - upload media to the server's library; it stays there permanently, reusable for any display.
3. **Compose playlists** - order library items, assign displays, sync. Missing files push themselves; extras can be pruned for an exact match.
4. **Displays stay intentional** - every display keeps playing cached content through server restarts and network drops, and picks changes up at the next item boundary.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `SERVER_ROLE` | `manager` | `manager` or `controller` |

## Development

```sh
npm ci
npm run dev        # --watch reload
```

Dashboard pages are plain static files in `public/`; server modules live
in `src/` (see `AGENTS.md` for the per-file map).

## Releasing

Publish a GitHub Release tagged to match `package.json`'s `version` (e.g.
`v0.1.0`) and Actions builds and pushes
`ghcr.io/screensemble/screensemble-server` tagged `:v<ver>`,
`:<major.minor>`, and `:latest`.

## License

[MIT](LICENSE)

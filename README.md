# Screensemble Server

Self-hosted management server for Screensemble digital-signage displays.
Coordinates the [Screensemble Player](../Screensemble-Addon) Kodi addon —
fleet registry, content distribution, shared playlists, remote control —
over a single outbound WebSocket per display, so players work behind NAT
and firewalls with no inbound connectivity.

Designed to run fully offline on an isolated show network.

## Run

```bash
npm ci
PORT=8090 npm start
```

Or with Docker:

```bash
docker build -t screensemble-server .
docker run -p 8090:8080 -v screensemble-data:/app/data screensemble-server
```

The container image is published to
`ghcr.io/screensemble/screensemble-server` on each release.

Dashboard: `http://<host>:<port>/` — fleet list, per-display admin,
media library, shared playlists, pairing.

## What it does

- **Fleet registry** — persistent player records (`data/players.json`):
  hardware-anchored identity, labels, online/last-seen, status echo,
  per-device auth tokens (first-come bound, verified every connect).
- **Per-display admin** — `display.html?id=…` proxies the player's full
  local admin surface over its socket: playlist ordering, enable/disable,
  durations, schedules, shuffle, URL items, uploads, settings, system
  status, restart commands.
- **Media library** — `data/library/` keeps a server-side copy of every
  upload, reusable across displays (`library.html`).
- **Shared playlists** — named ordered groups assigned to displays; sync
  pushes missing files, applies order, and can prune extras for an exact
  match.
- **Upload queue** — browser uploads and library pushes ride a `pull_file`
  handshake: the display downloads from the server over HTTP with per-file
  progress and SHA-256 verification. Still outbound-only.
- **Pairing** — `/api/pair/*` enrollment: version gating on both sides,
  then an on-TV confirm before the display is registered.
- **Content updates are deferred** — playlist/media changes queue on the
  display and apply at the next natural item boundary; sync pushes settle
  before flagging, so nothing cuts mid-play.

## Layout

- `src/` — server modules (see `AGENTS.md` for the per-file map)
- `public/` — dashboard pages
- `data/` — runtime state (gitignored; mount a volume in Docker)

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | bind address |
| `SERVER_ROLE` | `manager` | `manager` or `controller` |

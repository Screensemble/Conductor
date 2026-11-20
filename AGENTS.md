# AGENTS.md — Screensemble Server

## What this is

Self-hosted conductor for the Screensemble synchronized multi-display signage system. Acts as **Manager** (Managed mode) or **Controller** (Controlled/performance mode) depending on deployment. Coordinates Kodi-based performer addons, ESP32 cue devices, standby profiles, schedules, productions, and the Prepare/Perform synchronization sequence.

## Tech

- Node.js >= 20, ES modules (`"type": "module"`).
- Express (HTTP API + dashboard later) and `ws` (persistent performer connections).
- Distributed via Docker (`Dockerfile`, Node 22 Alpine base).
- Designed to run fully offline on an isolated show network — never introduce a dependency that requires internet access.

## Structure

- `src/index.js` — entry point: HTTP server, Control Room + API routes, WebSocket server.
- `src/config.js` — env-driven configuration (port, host, conductor role, min client version).
- `src/performers.js` — performer WebSocket handler at `/ws/player`: hello/status/commands, request/response matching, per-device token auth (only QR-paired displays with their issued token are admitted).
- `src/registry.js` — persistent player registry (`data/players.json`).
- `src/pairing.js` — `/api/pair/{invite,request,accept,decline}` enrollment: Control Room-issued single-use code, on-TV confirm, conductor-issued device token.
- `src/uploads.js` — upload queue: staged + library pushes via `pull_file` with progress jobs.
- `src/library.js` — persistent server-side media library (`data/library/`): inventory, serving, sha256.
- `src/playlists.js` — shared playlists (`data/playlists.json`): named ordered groups assigned to displays, sync orchestration (push missing, apply order, optional prune).
- `src/cues.js` — `/api/cues/:cue_id` external cue endpoint (legacy `/api/triggers` aliases still work); conductor prepare/perform routes live in `index.js`.
- `public/` — dashboard pages: `index.html` (fleet), `display.html` (per-display admin proxied over the socket), `library.html` (media library + playlists), `pair.html`, `upload-toast.js`.
- `data/` — runtime state (registry, playlists, library, staged uploads). Gitignored; Docker `VOLUME /app/data`.

## Commands

```bash
npm install        # install dependencies
npm run dev        # run with --watch reload
npm start          # run normally
docker build -t screensemble-conductor .
docker run -p 8080:8080 screensemble-conductor
```

## Conventions

- Keep the three logical responsibilities distinct (management, playback control, synchronization) even though this is one application — spec section 2.
- Cue validation (auth, debounce, cooldown, retrigger policy) is always conductor-side; cue devices carry no show logic.
- Controlled-mode commands carry conductor timestamps; the conductor is the time authority.
- Per-device tokens for performer/cue auth; TLS supported for non-isolated deployments.

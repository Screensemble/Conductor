# AGENTS.md — Screensemble Server

## What this is

Self-hosted server for the Screensemble synchronized multi-display signage system. Acts as **Manager** (Managed mode) or **Controller** (Controlled/performance mode) depending on deployment. Coordinates Kodi-based player addons, ESP32 trigger devices, idle profiles, schedules, productions, and the Arm/Go synchronization sequence.

## Tech

- Node.js >= 20, ES modules (`"type": "module"`).
- Express (HTTP API + dashboard later) and `ws` (persistent player connections).
- Distributed via Docker (`Dockerfile`, Node 22 Alpine base).
- Designed to run fully offline on an isolated show network — never introduce a dependency that requires internet access.

## Structure

- `src/index.js` — entry point: HTTP server, dashboard + API routes, WebSocket server.
- `src/config.js` — env-driven configuration (port, host, server role, min client version).
- `src/players.js` — player WebSocket handler at `/ws/player`: hello/status/commands, request/response matching, per-device token auth (first-come binding).
- `src/registry.js` — persistent player registry (`data/players.json`).
- `src/pairing.js` — `/api/pair/{request,accept,decline}` enrollment flow with on-TV confirm.
- `src/uploads.js` — upload queue: staged + library pushes via `pull_file` with progress jobs.
- `src/library.js` — persistent server-side media library (`data/library/`): inventory, serving, sha256.
- `src/playlists.js` — shared playlists (`data/playlists.json`): named ordered groups assigned to displays, sync orchestration (push missing, apply order, optional prune).
- `src/triggers.js` — `POST /api/triggers/:trigger_id` external trigger endpoint; conductor arm/go routes live in `index.js`.
- `public/` — dashboard pages: `index.html` (fleet), `display.html` (per-display admin proxied over the socket), `library.html` (media library + playlists), `pair.html`, `upload-toast.js`.
- `data/` — runtime state (registry, playlists, library, staged uploads). Gitignored; Docker `VOLUME /app/data`.

## Commands

```bash
npm install        # install dependencies
npm run dev        # run with --watch reload
npm start          # run normally
docker build -t screensemble-server .
docker run -p 8080:8080 screensemble-server
```

## Conventions

- Keep the three logical responsibilities distinct (management, playback control, synchronization) even though this is one application — spec section 2.
- Trigger validation (auth, debounce, cooldown, retrigger policy) is always server-side; trigger devices carry no show logic.
- Controlled-mode commands carry server timestamps; the server is the time authority.
- Per-device tokens for player/trigger auth; TLS supported for non-isolated deployments.

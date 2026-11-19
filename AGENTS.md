# AGENTS.md — Screensemble Server

## What this is

Self-hosted server for the Screensemble synchronized multi-display signage system. Acts as **Manager** (Managed mode) or **Controller** (Controlled/performance mode) depending on deployment. Coordinates Kodi-based player addons, ESP32 trigger devices, idle profiles, schedules, productions, and the Arm/Go synchronization sequence.

The governing design document is `../screensemble-design-spec.md` (in the parent folder). Consult it before making architectural decisions — operating modes, Arm/Go, time sync, and offline policies are defined there.

## Tech

- Node.js >= 20, ES modules (`"type": "module"`).
- Express (HTTP API + dashboard later) and `ws` (persistent player connections).
- Distributed via Docker (`Dockerfile`, Node 22 Alpine base).
- Designed to run fully offline on an isolated show network — never introduce a dependency that requires internet access.

## Structure

- `src/index.js` — entry point: HTTP server, health check, routers, WebSocket server.
- `src/config.js` — env-driven configuration (port, host, server role).
- `src/triggers.js` — `POST /api/triggers/:trigger_id` endpoint (spec section 5.1).
- `src/players.js` — player WebSocket handler at `/ws/player`.

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

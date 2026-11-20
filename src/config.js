import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url)),
);

export const config = {
  version: pkg.version,
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8080),
  // 'manager' (Managed mode) or 'controller' (Controlled/performance mode).
  // See spec section 1, "Operating modes".
  serverRole: process.env.SERVER_ROLE ?? 'manager',
  // Identity shown to displays during pairing (GET /api/info).
  serverName: process.env.SERVER_NAME ?? 'Screensemble Conductor',
  serverOwner: process.env.SERVER_OWNER ?? '',
  serverInfo: process.env.SERVER_INFO ?? '',
  // Displays older than this are refused pairing (reported via /api/info).
  minClientVersion: process.env.MIN_CLIENT_VERSION ?? '0.0.0',
};

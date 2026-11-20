import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { admin } from 'better-auth/plugins';
import { fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { config } from './config.js';
import { registry } from './registry.js';

// Authentication via Better Auth (https://better-auth.com) — the industry
// standard option here so the security backend (password hashing, sessions,
// CSRF, rate limiting, user management) stays library-maintained instead of
// hand-rolled. Users live in a dedicated SQLite db at data/auth.db; our own
// users_meta table tracks the forced first-login password change.
const DATA = join(process.cwd(), 'data');
mkdirSync(DATA, { recursive: true });
export const authDb = new Database(join(DATA, 'auth.db'));

authDb.exec(`
  CREATE TABLE IF NOT EXISTS users_meta (
    user_id TEXT PRIMARY KEY,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
`);

// Session secret — env wins; otherwise generate once and persist so
// sessions survive restarts without committing anything to the repo.
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const p = join(DATA, 'auth_secret');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(p, s, { mode: 0o600 });
  return s;
}

export const auth = betterAuth({
  database: authDb,
  secret: loadSecret(),
  // Self-hosted on arbitrary hosts/IPs — origins can't be allowlisted ahead
  // of time, so trust the host the request arrived on (never a foreign
  // Origin header, which would also trust its callback/redirect URLs).
  trustedOrigins: (request) => {
    const host = request?.headers?.get?.('host');
    return host ? [`http://${host}`, `https://${host}`] : [];
  },
  // Session cookies are SameSite=Lax (cross-site POSTs never carry them),
  // so CSRF is already covered — disabling the Fetch-Metadata check lets
  // non-browser clients (curl, scripts, agents) call auth endpoints too.
  advanced: { disableCSRFCheck: true },
  // No self-registration — admins create accounts (POST /api/users).
  emailAndPassword: { enabled: true, disableSignUp: true },
  plugins: [username(), admin()],
  rateLimit: { enabled: true },
  user: {
    additionalFields: {
      must_change_password: {
        type: 'boolean',
        defaultValue: false,
        input: false,
      },
    },
  },
});

// First boot seeds the default admin — password change is forced at
// first login, so the shipped credential never survives into use.
const DEFAULT_USER = process.env.AUTH_DEFAULT_USER ?? 'screensemble';
const DEFAULT_PASS = process.env.AUTH_DEFAULT_PASSWORD ?? 'screensemble';

export async function seedDefaultUser() {
  // Better-auth tables are created by its migration runner, not at
  // construction — run it before touching the user table.
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const row = authDb.prepare('SELECT COUNT(*) AS n FROM user').get();
  if (row.n > 0) return;
  // Server-side createUser (no request headers) bypasses the admin-session
  // check and works with public sign-up disabled.
  const res = await auth.api.createUser({
    body: {
      email: `${DEFAULT_USER}@screensemble.local`,
      password: DEFAULT_PASS,
      name: DEFAULT_USER,
      role: 'admin',
      data: { username: DEFAULT_USER, displayUsername: DEFAULT_USER },
    },
  });
  const id = res?.user?.id;
  if (!id) return;
  authDb
    .prepare('INSERT OR REPLACE INTO users_meta (user_id, must_change_password) VALUES (?, 1)')
    .run(id);
  console.log(
    `auth: seeded default admin "${DEFAULT_USER}" — password change required at first login`,
  );
}

export function mustChange(userId) {
  return (
    authDb
      .prepare('SELECT must_change_password AS m FROM users_meta WHERE user_id = ?')
      .get(userId)?.m === 1
  );
}

export function flagChange(userId) {
  authDb
    .prepare('INSERT OR REPLACE INTO users_meta (user_id, must_change_password) VALUES (?, 1)')
    .run(userId);
}

export function clearChange(userId) {
  authDb
    .prepare('INSERT OR REPLACE INTO users_meta (user_id, must_change_password) VALUES (?, 0)')
    .run(userId);
}

export async function sessionOf(req) {
  try {
    const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return s?.user ?? null;
  } catch {
    return null;
  }
}

// Constant-time string compare — token checks must not leak prefix
// matches through response timing.
export function tokenEquals(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

function performerTokenOk(tok) {
  if (!tok) return false;
  let ok = false;
  for (const p of registry.performers.values()) {
    if (p.token && tokenEquals(p.token, tok)) ok = true;
  }
  return ok;
}

// File-pull authorization: displays fetch media over plain HTTP using the
// per-device token issued at pairing, embedded in the pull URL. Logged-in
// dashboard users may also fetch (thumbnails/previews).
export async function fileAllowed(req) {
  const t = String(req.query.token ?? '');
  if (t) return performerTokenOk(t);
  return !!(await sessionOf(req));
}

// Bearer token check for cue devices (ESP32): any registered performer
// token, or the shared CUE_TOKEN env (legacy TRIGGER_TOKEN still honored).
export function cueTokenOk(req) {
  const h = String(req.headers.authorization ?? '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const tok = bearer || String(req.query.token ?? '');
  const shared = process.env.CUE_TOKEN || process.env.TRIGGER_TOKEN;
  if (shared && tokenEquals(tok, shared)) return true;
  return performerTokenOk(tok);
}

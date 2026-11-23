// End-to-end smoke tests: boot the real server in a temp dir and exercise
// auth, pairing, display admission, and file routes over HTTP/WebSocket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import WebSocket from 'ws';

// fileURLToPath — URL.pathname yields '/C:/…' on Windows, which node
// cannot spawn.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
let proc, dir, cookie = '';

async function call(method, path, body, headers = {}) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: B, cookie, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

function hello(msg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/player`);
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'hello', product: 'screensemble-client', version: '0.3.0', ...msg,
    })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'hello_ack') resolve({ ws, ack: m });
    });
    ws.on('error', reject);
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ss-test-'));
  proc = spawn(process.execPath, [join(ROOT, 'src/index.js')], {
    cwd: dir,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  // The bootstrap seeds admin/admin behind a forced password change —
  // sign in, set a real password, then re-auth for the suite.
  await call('POST', '/api/auth/sign-in/username', { username: 'admin', password: 'admin' });
  const r = await call('POST', '/api/me/set-password', {
    current_password: 'admin', new_password: 'smoke-test-pass-1',
  });
  assert.equal(r.status, 200);
  await call('POST', '/api/auth/sign-in/username', { username: 'admin', password: 'smoke-test-pass-1' });
});

after(async () => {
  // Windows holds the child's auth.db lock briefly after kill — wait
  // for exit, then retry the cleanup instead of failing EPERM.
  if (proc) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test('public sign-up is disabled', async () => {
  const r = await fetch(`${B}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: B },
    body: JSON.stringify({ email: 'x@y.z', password: 'whatever123', name: 'x' }),
  });
  assert.notEqual(r.status, 200);
});

test('unpaired displays are rejected', async () => {
  const { ws, ack } = await hello({ hardware_id: 'deadbeef0001', token: 'guess' });
  assert.equal(ack.error, 'unauthorized');
  ws.close();
  const p = await call('GET', '/api/players');
  assert.equal(p.json.players.length, 0);
});

test('pairing requires a dashboard-issued code', async () => {
  const r = await call('POST', '/api/pair/request', {
    product: 'screensemble-client', version: '0.3.0', client_url: 'http://x', hardware_id: 'aa',
  }, { cookie: '' });
  assert.equal(r.status, 403);
});

test('QR pairing admits the display with its issued token only', async () => {
  const inv = await call('POST', '/api/pair/invite');
  assert.equal(inv.status, 200);
  const req = await call('POST', '/api/pair/request', {
    product: 'screensemble-client', version: '0.3.0', name: 'TV1',
    client_url: 'http://10.0.0.5:8282', hardware_id: 'cafe00000001',
    code: inv.json.code.slice(0, 4) + '-' + inv.json.code.slice(4),
  }, { cookie: '' });
  assert.equal(req.json.accepted, true);
  const again = await call('POST', '/api/pair/request', {
    product: 'screensemble-client', version: '0.3.0', client_url: 'http://x',
    hardware_id: 'cafe00000002', code: inv.json.code,
  }, { cookie: '' });
  assert.equal(again.status, 403, 'codes are single use');
  const acc = await call('POST', '/api/pair/accept', { pairing_id: req.json.pairing_id }, { cookie: '' });
  assert.equal(acc.json.ok, true);
  assert.equal(acc.json.player_id, 'hw-cafe00000001');

  const bad = await hello({ hardware_id: 'cafe00000001', token: 'wrong' });
  assert.equal(bad.ack.error, 'unauthorized');
  bad.ws.close();
  const good = await hello({ hardware_id: 'cafe00000001', token: acc.json.token });
  assert.equal(good.ack.player_id, 'hw-cafe00000001');

  const list = await call('GET', '/api/players');
  assert.equal(list.json.players[0].token, undefined, 'tokens are not exposed');

  // Pull URLs use the Host the display dialed, not the socket's local address.
  const up = await call('POST', '/api/library?name=a.png', 'png-bytes',
    { 'Content-Type': 'application/json' });
  assert.equal(up.status, 201);
  const pull = new Promise((res) => good.ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'pull_file') res(m);
  }));
  await call('POST', '/api/library/a.png/push', { players: ['hw-cafe00000001'] });
  const m = await pull;
  assert.ok(m.url.startsWith(`http://127.0.0.1:${PORT}/api/library/file/a.png?token=`));
  const f = await fetch(m.url);
  assert.equal(await f.text(), 'png-bytes');
  good.ws.close();
});

test('bad library names do not crash the server', async () => {
  // Raw requests — fetch() would normalize the dot segments away.
  const raw = (path) => new Promise((res, rej) => {
    request({ host: '127.0.0.1', port: PORT, path, headers: { cookie } }, (r) => {
      r.resume();
      res(r.statusCode);
    }).on('error', rej).end();
  });
  for (const n of ['..', '.', '%2e%2e', 'x.exe']) {
    assert.equal(await raw(`/api/library/file/${n}`), 404, n);
  }
  const up = await call('POST', '/api/library?name=..', 'x');
  assert.equal(up.status, 400);
  assert.equal((await fetch(`${B}/api/health`)).status, 200);
});

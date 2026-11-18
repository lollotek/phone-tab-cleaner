import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUiServer } from '../src/ui/server.js';
import { DEFAULTS, merge } from '../src/config.js';

const FILE = [
  '# Link salvati',
  '',
  '## 2026-11-14',
  '',
  '- [A](https://a.com/) — Uno. #dev #ai',
  '- [B](https://b.com/) — Due. #casa',
  '- [C](https://c.com/) — Tre. #cucina',
  '',
].join('\n');

let ui;
let base;
let file;
const silent = { info() {}, ok() {}, warn() {}, error() {}, debug() {}, verbose: false };
const fakeAdb = { devices: async () => [] };

before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pck-ui-'));
  file = path.join(dir, 'links.md');
  await fs.writeFile(file, FILE);
  const cfg = merge(DEFAULTS, { ai: { providers: { local: { baseUrl: 'http://127.0.0.1:9/v1' } } }, pc: { userDataDir: dir } });
  ui = createUiServer({ cfg, adb: fakeAdb, log: silent, file });
  await new Promise((r) => ui.server.listen(0, '127.0.0.1', r));
  const { port } = ui.server.address();
  ui.setPort(port);
  base = `http://127.0.0.1:${port}`;
});
after(() => ui.server.close());

const api = (p, { method = 'GET', body, token = ui.token, headers = {} } = {}) => fetch(base + p, {
  method,
  headers: { ...(token ? { 'x-pck-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});

test('pagina statica senza token, API solo con token', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>PhoneCleanKit<\/title>/);
  assert.equal((await api('/api/state', { token: null })).status, 401);
  assert.equal((await api('/api/state', { token: 'x'.repeat(ui.token.length) })).status, 401);
});

test('Origin di un altro sito → 403', async () => {
  const r = await api('/api/state', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal((await api('/api/state', { headers: { origin: base } })).status, 200);
});

test('state: voci con chiave, tag, sezioni', async () => {
  const s = await (await api('/api/state')).json();
  assert.equal(s.entries.length, 3);
  assert.deepEqual(s.entries[0], { key: 'https://a.com', section: '2026-11-14', title: 'A', url: 'https://a.com/', description: 'Uno.', tags: ['dev', 'ai'] });
  assert.deepEqual(s.sections, ['2026-11-14']);
  assert.equal(s.trashCount, 0);
});

test('modifica tag, conflitto di versione, eliminazione nel cestino, ripristino, annulla', async () => {
  let s = await (await api('/api/state')).json();
  const upd = await api('/api/entries/update', { method: 'POST', body: { version: s.version, key: 'https://a.com', tags: ['dev', 'Machine Learning'] } });
  assert.equal(upd.status, 200);
  const v1 = (await upd.json()).version;
  assert.match(await fs.readFile(file, 'utf8'), /Uno\. #dev #machine-learning/);

  const stale = await api('/api/entries/update', { method: 'POST', body: { version: s.version, key: 'https://b.com', description: 'x' } });
  assert.equal(stale.status, 409, 'versione vecchia → conflitto');

  const bulk = await (await api('/api/entries/tags', { method: 'POST', body: { version: v1, keys: ['https://b.com', 'https://c.com'], add: ['maker'] } })).json();
  assert.equal(bulk.changed, 2);

  const del = await (await api('/api/entries/delete', { method: 'POST', body: { version: bulk.version, keys: ['https://c.com'] } })).json();
  assert.equal(del.removed, 1);
  s = await (await api('/api/state')).json();
  assert.equal(s.entries.length, 2);
  assert.equal(s.trashCount, 1);
  const trash = await (await api('/api/trash')).json();
  assert.deepEqual(trash.entries.map((e) => e.url), ['https://c.com/']);

  const res = await (await api('/api/trash/restore', { method: 'POST', body: { version: s.version, keys: ['https://c.com'] } })).json();
  assert.equal(res.restored, 1);
  assert.equal((await (await api('/api/state')).json()).entries.length, 3);

  const undo = await api('/api/undo', { method: 'POST' });
  assert.equal(undo.status, 200);
  assert.equal((await (await api('/api/state')).json()).entries.length, 2, 'annullato il ripristino');
});

test('cestino: eliminazione definitiva', async () => {
  let s = await (await api('/api/state')).json();
  await api('/api/entries/delete', { method: 'POST', body: { version: s.version, keys: ['https://b.com'] } });
  s = await (await api('/api/state')).json();
  assert.equal(s.trashCount, 1);
  assert.equal((await api('/api/trash/purge', { method: 'POST', body: { keys: [] } })).status, 400);
  const r = await (await api('/api/trash/purge', { method: 'POST', body: { keys: ['https://b.com'] } })).json();
  assert.equal(r.purged, 1);
  assert.equal((await (await api('/api/state')).json()).trashCount, 0);
  assert.ok(!(await fs.readFile(path.join(path.dirname(file), 'links-eliminati.md'), 'utf8')).includes('b.com'));
});

test('stato: AI non raggiungibile, telefono assente, PC senza debug remoto', async () => {
  const st = await (await api('/api/status?force=1')).json();
  assert.equal(st.ai.ok, false);
  assert.equal(st.phone.ok, false);
  assert.equal(st.pc.ok, false);
});

test('operazione "check" in background con eventi SSE e blocco di una seconda operazione', async () => {
  const events = [];
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/events?token=${ui.token}`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value);
      for (const m of buf.matchAll(/event: (\w+)/g)) events.push(m[1]);
      buf = '';
      if (events.includes('end')) break;
    }
  })();

  const started = await (await api('/api/jobs', { method: 'POST', body: { type: 'check' } })).json();
  assert.equal(started.status, 'running');
  await pump;
  ctrl.abort();
  const { last } = await (await api('/api/jobs')).json();
  assert.equal(last.status, 'done');
  assert.equal(last.result.errors, 0);
  assert.ok(events.includes('start') && events.includes('end'));
  assert.equal((await api('/api/jobs', { method: 'POST', body: { type: 'boh' } })).status, 400);
});

test('telefono: elenco dispositivi e indirizzo non valido rifiutato prima di avviare', async () => {
  const ph = await (await api('/api/phone')).json();
  assert.deepEqual(ph.devices, []);
  for (const serial of ['192.168.1.2', '192.168.1.2:porta', 'a b:12', '1.2.3.4:5555; rm -rf /']) {
    const r = await api('/api/jobs', { method: 'POST', body: { type: 'sync', source: 'phone', serial } });
    assert.equal(r.status, 400, serial);
  }
  const pair = await api('/api/jobs', { method: 'POST', body: { type: 'pair', hostPort: '192.168.1.2:37000', code: '12' } });
  assert.equal(pair.status, 200, 'la validazione del codice avviene nell\'operazione');
  await new Promise((r) => setTimeout(r, 50));
  const { last } = await (await api('/api/jobs')).json();
  assert.equal(last.type, 'pair');
  assert.equal(last.status, 'error');
  assert.match(last.error, /6 cifre/);
});

test('host diverso (DNS rebinding) → 403', async () => {
  const r = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request(`${base}/api/state`, { headers: { host: 'evil.example:80', 'x-pck-token': ui.token } }, resolve);
      req.end();
    });
  });
  assert.equal(r.statusCode, 403);
  r.resume();
});

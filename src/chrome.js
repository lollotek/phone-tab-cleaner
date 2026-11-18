import { createServer } from 'node:net';
import { PckError, EXIT } from './errors.js';
import { sleep } from './util.js';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

class Devtools {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
  }

  async #get(path, { json = true } = {}) {
    const res = await fetch(this.base + path, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} su ${path}: ${(await res.text()).slice(0, 100)}`);
    return json ? res.json() : res.text();
  }

  version() {
    return this.#get('/json/version');
  }

  /** Solo le schede vere (type "page"). */
  async listTabs() {
    const targets = await this.#get('/json/list');
    return targets.filter((t) => t.type === 'page').map(({ id, title, url }) => ({ id, title, url }));
  }

  /** Risponde con testo semplice ("Target is closing"), non JSON. */
  closeTab(id) {
    return this.#get(`/json/close/${encodeURIComponent(id)}`, { json: false });
  }
}

/**
 * Apre il forward verso il socket DevTools di Chrome, esegue `fn(devtools, version)`, poi rimuove il forward.
 * Se Chrome non è in esecuzione lo avvia e riprova una volta.
 */
export async function withDevtools(adb, serial, cfg, fn, log) {
  const port = await freePort();
  await adb.run(['forward', `tcp:${port}`, `localabstract:${cfg.devtoolsSocket}`], { serial });
  try {
    const dt = new Devtools(port);
    let version;
    try {
      version = await dt.version();
    } catch {
      log?.info('DevTools non raggiungibile: avvio Chrome sul telefono…');
      await adb.run(['shell', 'am', 'start', '-n', `${cfg.chromePackage}/${cfg.chromeActivity}`], { serial });
      await sleep(3000);
      try {
        version = await dt.version();
      } catch (e) {
        throw new PckError(`Chrome DevTools non raggiungibile (${e.message}). Apri Chrome sul telefono e riprova.`, EXIT.CHROME);
      }
    }
    return await fn(dt, version);
  } finally {
    await adb.run(['forward', '--remove', `tcp:${port}`], { serial }).catch(() => {});
  }
}

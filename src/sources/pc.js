/**
 * Sorgente "pc": Chrome desktop già aperto, con il profilo normale.
 *
 * Da Chrome 144 il debug remoto del browser in uso si attiva da chrome://inspect/#remote-debugging:
 * Chrome scrive nella cartella dati il file DevToolsActivePort (riga 1: porta, riga 2: percorso WebSocket)
 * e chiede all'utente di approvare ogni connessione. Gli endpoint HTTP /json/* possono non esistere,
 * quindi si usa solo il protocollo CDP via WebSocket: Target.getTargets / Target.closeTarget.
 *
 * In alternativa (pc.browserUrl) ci si collega a un Chrome avviato con --remote-debugging-port.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PckError, EXIT } from '../errors.js';

export function defaultUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(home, '.config', 'google-chrome');
}

const ENABLE_HINT =
  'Attiva il debug remoto in Chrome: apri chrome://inspect/#remote-debugging e abilita la voce per consentire il debug remoto di questa istanza (serve Chrome 144+, aperto).';

/** Legge DevToolsActivePort → URL WebSocket del browser. */
export async function readActivePort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new PckError(`Debug remoto di Chrome non attivo (manca ${file}).\n  ${ENABLE_HINT}`, EXIT.CHROME);
    throw new PckError(`Impossibile leggere ${file}: ${e.message}`, EXIT.CHROME);
  }
  return parseActivePort(text);
}

export function parseActivePort(text) {
  const [portLine, wsPath] = text.split(/\r?\n/).map((l) => l.trim());
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0) throw new PckError('File DevToolsActivePort non valido.', EXIT.CHROME);
  return `ws://127.0.0.1:${port}${wsPath?.startsWith('/') ? wsPath : '/devtools/browser'}`;
}

async function wsUrlFromBrowserUrl(browserUrl) {
  try {
    const res = await fetch(new URL('/json/version', browserUrl), { signal: AbortSignal.timeout(5000) });
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) throw new Error('webSocketDebuggerUrl assente');
    return webSocketDebuggerUrl;
  } catch (e) {
    throw new PckError(`Chrome non raggiungibile su ${browserUrl} (${e.cause?.code || e.message}).`, EXIT.CHROME);
  }
}

/** Client CDP minimale su WebSocket (globale in Node ≥ 22). */
class CdpClient {
  #ws;
  #nextId = 0;
  #pending = new Map();

  static async connect(url, { timeoutMs = 60000, log } = {}) {
    if (typeof WebSocket === 'undefined') throw new PckError('La sorgente "pc" richiede Node.js 22 o superiore (WebSocket integrato).');
    const client = new CdpClient();
    const ws = new WebSocket(url);
    client.#ws = ws;
    // Chrome trattiene la connessione finché l'utente non la approva nella finestra di dialogo.
    const hint = setTimeout(() => log?.info('  In attesa di approvazione: conferma la richiesta di debug remoto nella finestra di Chrome…'), 1500);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`nessuna approvazione entro ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connessione rifiutata o interrotta')); }, { once: true });
        ws.addEventListener('close', (ev) => { clearTimeout(timer); reject(new Error(`connessione chiusa (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`)); }, { once: true });
      });
    } catch (e) {
      try { ws.close(); } catch { /* già chiusa */ }
      throw new PckError(`Collegamento a Chrome non riuscito: ${e.message}.\n  Se il debug remoto è attivo, approva la richiesta in Chrome; altrimenti: ${ENABLE_HINT}`, EXIT.CHROME);
    } finally {
      clearTimeout(hint);
    }
    ws.addEventListener('message', (ev) => client.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      for (const { reject } of client.#pending.values()) reject(new Error('connessione a Chrome chiusa'));
      client.#pending.clear();
    });
    return client;
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = msg.id && this.#pending.get(msg.id);
    if (!p) return; // eventi non richiesti
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else p.resolve(msg.result);
  }

  send(method, params = {}, { timeoutMs = 10000 } = {}) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method}: nessuna risposta`)); }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.#ws.close(); } catch { /* ignora */ }
  }
}

/** Solo le schede vere: niente service worker, iframe, prerender, DevTools. */
export function pagesFromTargets(targetInfos) {
  return targetInfos
    .filter((t) => t.type === 'page' && !t.subtype)
    .map(({ targetId, title, url }) => ({ id: targetId, title, url }));
}

/**
 * Apre la sorgente PC. La connessione (e quindi l'approvazione in Chrome) è una sola per tutta l'esecuzione,
 * anche se tra lettura e chiusura passano minuti (AI).
 */
export async function openPcSource({ cfg, log }) {
  const pcCfg = cfg.pc ?? {};
  const url = pcCfg.browserUrl ? await wsUrlFromBrowserUrl(pcCfg.browserUrl) : await readActivePort(pcCfg.userDataDir || defaultUserDataDir());
  log.debug(`CDP: ${url}`);
  const cdp = await CdpClient.connect(url, { timeoutMs: pcCfg.approvalTimeoutMs ?? 60000, log });
  const { product } = await cdp.send('Browser.getVersion');
  log.ok(`Collegato a Chrome sul PC (${product})`);

  const api = {
    async listTabs() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return pagesFromTargets(targetInfos);
    },
    async openTab(url) {
      await cdp.send('Target.createTarget', { url, background: true });
    },
    async closeTab(id) {
      const { success } = await cdp.send('Target.closeTarget', { targetId: id });
      if (success === false) throw new Error('Chrome ha rifiutato la chiusura');
    },
  };
  return {
    kind: 'pc',
    label: 'Chrome (PC)',
    retryHint: 'Riprova con: pck sync --source pc --close',
    withTabs: (fn) => fn(api, { Browser: product }),
    dispose: async () => cdp.close(),
  };
}

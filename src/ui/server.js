/**
 * `pck ui`: interfaccia web locale per consultare e modificare links.md e lanciare le funzioni del tool (SPEC §11.2).
 * Sicurezza: ascolto solo su 127.0.0.1, token casuale per ogni avvio (header x-pck-token, o ?token= per SSE),
 * controllo di Host e Origin contro il DNS rebinding e le richieste da altri siti.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PckError } from '../errors.js';
import { entryLines } from '../markdown.js';
import { normalizeUrl, classifyUrl } from '../url.js';
import { computeTagStats } from '../tags.js';
import { checkLinks, checkText } from '../check.js';
import { runSync } from '../sync.js';
import { runRetag } from '../retag.js';
import { openSource } from '../sources/index.js';
import {
  EXIT_CONFLICT, editTagsInText, fileVersion, moveToTrash, mutate, purgeFromTrash, readTrash, restoreFromTrash, trashPath, undoLast, updateInText,
} from '../store.js';
import { readTextIfExists } from '../util.js';
import { createJobRunner, LOCKED } from './jobs.js';
import { createStatusProvider } from './status.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_OPEN = 50;

/** Codice HTTP per un errore del tool. */
function statusFor(e) {
  if (e.exitCode === EXIT_CONFLICT) return 409;
  if (e.exitCode === LOCKED) return 423;
  if (e instanceof PckError) return 400;
  return 500;
}

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new PckError('Richiesta troppo grande.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PckError('JSON non valido.');
  }
}

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

/** Apre l'URL nel browser predefinito del sistema. */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Crea il server (senza avviarlo). Separato da startUi per i test.
 * @returns {{server: http.Server, token: string, setPort(port:number): void}}
 */
export function createUiServer({ cfg, adb, log, file }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const normalize = (u) => normalizeUrl(u, cfg.normalize);
  const jobs = createJobRunner();
  const getStatus = createStatusProvider({ adb, cfg });
  let port = 0;
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const extraExclude = () => allowedHosts();

  const assertWritable = () => {
    if (jobs.writeLocked) throw new PckError(`Operazione in corso (${jobs.current.label}): attendi che finisca.`, LOCKED);
  };
  const changed = (version) => jobs.broadcast('file', { version });

  async function state() {
    const text = (await readTextIfExists(file)) ?? '';
    const rows = entryLines(text);
    const stats = computeTagStats(rows, { topPairs: 0 });
    return {
      file,
      trashFile: trashPath(file),
      version: fileVersion(text),
      entries: rows.map(({ section, entry }) => ({ key: normalize(entry.url), section, ...entry })),
      tags: stats.tags,
      sections: [...new Set(rows.map((r) => r.section).filter(Boolean))],
      trashCount: (await readTrash(file, normalize)).length,
      ai: { provider: cfg.ai.defaultProvider },
      defaultSource: cfg.defaultSource,
    };
  }

  // ── operazioni lunghe ────────────────────────────────────────────────────────────────────────────
  const syncOpts = (b) => ({
    file,
    source: b.source === 'pc' ? 'pc' : 'phone',
    ai: b.ai ? true : undefined,
    close: Boolean(b.close),
    yes: true, // la conferma l'ha già data l'utente nella pagina, dopo l'anteprima
    extraExclude: extraExclude(),
  });

  const JOBS = {
    sync: {
      writes: true,
      label: (b) => `Sync ${b.source === 'pc' ? 'PC' : 'telefono'}${b.ai ? ' con AI' : ''}${b.close ? ' e chiusura schede' : ''}`,
      run: async (b, jlog) => {
        const r = await runSync({ cfg, adb, log: jlog, opts: syncOpts(b) });
        const text = (await readTextIfExists(file)) ?? '';
        changed(fileVersion(text));
        return { added: r.written ? r.entries?.length ?? 0 : 0, closed: r.closed?.closed ?? 0, version: fileVersion(text) };
      },
    },
    'close-preview': {
      writes: false,
      label: (b) => `Anteprima chiusura (${b.source === 'pc' ? 'PC' : 'telefono'})`,
      run: async (b, jlog) => {
        const source = await openSource(b.source === 'pc' ? 'pc' : 'phone', { adb, cfg, log: jlog, opts: {} });
        try {
          const tabs = await source.withTabs((dt) => dt.listTabs());
          const exclude = [...(cfg.exclude ?? []), ...extraExclude()];
          // Dopo il sync ogni scheda non ignorata è nel file (nuova, già presente o nel cestino): è quella che verrà chiusa.
          const keep = tabs.filter((t) => classifyUrl(t.url, { includeLocal: cfg.includeLocal, exclude }).skip);
          jlog.info(`${tabs.length} schede: ${tabs.length - keep.length} verrebbero chiuse, ${keep.length} restano aperte`);
          return { total: tabs.length, toClose: tabs.length - keep.length, keep: keep.map((t) => t.url || '(vuota)').slice(0, 20) };
        } finally {
          await source.dispose();
        }
      },
    },
    retag: {
      writes: true,
      label: (b) => `Rigenera con AI (${b.keys?.length ?? 0} voci)`,
      run: async (b, jlog) => {
        if (!Array.isArray(b.keys) || !b.keys.length) throw new PckError('Nessuna voce selezionata.');
        const r = await runRetag({ cfg, log: jlog, opts: { file, keys: new Set(b.keys), ai: b.provider || undefined } });
        const text = (await readTextIfExists(file)) ?? '';
        changed(fileVersion(text));
        return { ...r, version: fileVersion(text) };
      },
    },
    check: {
      writes: false,
      label: (b) => (b.links ? 'Controllo con verifica dei link' : 'Controllo del file'),
      run: async (b, jlog) => {
        const text = (await readTextIfExists(file)) ?? '';
        const issues = checkText(text, { normalize });
        if (b.links) issues.push(...await checkLinks(text, { cfg, log: jlog, concurrency: cfg.fetch.concurrency }));
        const byLine = new Map(entryLines(text).map((r) => [r.index + 1, normalize(r.entry.url)]));
        const withKeys = issues.map((i) => ({ ...i, key: byLine.get(i.line) ?? null }));
        const errors = issues.filter((i) => i.severity === 'errore').length;
        jlog.info(`${errors} errori · ${issues.length - errors} avvisi`);
        return { issues: withKeys, errors, warnings: issues.length - errors };
      },
    },
    open: {
      writes: false,
      label: (b) => `Apri ${b.urls?.length ?? 0} link sul ${b.source === 'pc' ? 'PC' : 'telefono'}`,
      run: async (b, jlog) => {
        const urls = (b.urls ?? []).filter((u) => /^https?:\/\//i.test(u));
        if (!urls.length) throw new PckError('Nessun link da aprire.');
        if (urls.length > MAX_OPEN) throw new PckError(`Troppi link (${urls.length}): al massimo ${MAX_OPEN} per volta.`);
        const source = await openSource(b.source === 'pc' ? 'pc' : 'phone', { adb, cfg, log: jlog, opts: {} });
        try {
          let opened = 0;
          await source.withTabs(async (dt) => {
            for (const u of urls) {
              try { await dt.openTab(u); opened++; } catch (e) { jlog.warn(`non aperto: ${u} (${e.message})`); }
            }
          });
          jlog.ok(`${opened} link aperti`);
          return { opened };
        } finally {
          await source.dispose();
        }
      },
    },
  };

  // ── API ──────────────────────────────────────────────────────────────────────────────────────────
  const API = {
    'GET /api/state': () => state(),
    'GET /api/status': (_b, url) => getStatus({ force: url.searchParams.has('force') }),
    'GET /api/jobs': () => jobs.state(),
    'POST /api/jobs': async (b) => {
      const def = JOBS[b.type];
      if (!def) throw new PckError(`Operazione sconosciuta: ${b.type}`);
      return jobs.start(b.type, def.label(b), { writes: def.writes }, (jlog) => def.run(b, jlog));
    },
    'POST /api/entries/update': async (b) => {
      assertWritable();
      const r = await mutate(file, b.version, (t) => ({ text: updateInText(t, b.key, { tags: b.tags, description: b.description }, normalize) }), { backup: cfg.backup });
      changed(r.version);
      return { version: r.version };
    },
    'POST /api/entries/tags': async (b) => {
      assertWritable();
      const r = await mutate(file, b.version, (t) => {
        const out = editTagsInText(t, b.keys ?? [], { add: b.add ?? [], remove: b.remove ?? [] }, normalize);
        return { text: out.text, result: out.changed };
      }, { backup: cfg.backup });
      changed(r.version);
      return { version: r.version, changed: r.result };
    },
    'POST /api/entries/delete': async (b) => {
      assertWritable();
      const r = await moveToTrash(file, b.version, b.keys ?? [], { normalize, backup: cfg.backup });
      changed(r.version);
      return r;
    },
    'GET /api/trash': async () => ({
      entries: (await readTrash(file, normalize)).map(({ key, section, entry }) => ({ key, section, ...entry })),
    }),
    'POST /api/trash/restore': async (b) => {
      assertWritable();
      const r = await restoreFromTrash(file, b.version, b.keys ?? [], { normalize, backup: cfg.backup });
      changed(r.version);
      return r;
    },
    'POST /api/trash/purge': async (b) => {
      assertWritable();
      if (!Array.isArray(b.keys) || !b.keys.length) throw new PckError('Nessuna voce selezionata.');
      const r = await purgeFromTrash(file, b.keys, { normalize, backup: cfg.backup });
      changed(fileVersion((await readTextIfExists(file)) ?? ''));
      return r;
    },
    'POST /api/undo': async () => {
      assertWritable();
      const r = await undoLast(file, { backup: cfg.backup });
      changed(r.version);
      return { version: r.version, restoredFrom: path.basename(r.restoredFrom) };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // DNS rebinding: si risponde solo a richieste indirizzate a 127.0.0.1/localhost con la nostra porta.
    if (!allowedHosts().includes(req.headers.host)) return json(res, 403, { error: 'Host non consentito' });

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [name, type] = STATIC[url.pathname];
      try {
        const body = await fs.readFile(path.join(PUBLIC, name));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(body);
      } catch {
        return json(res, 404, { error: 'non trovato' });
      }
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'non trovato' });

    const origin = req.headers.origin;
    if (origin && !allowedHosts().map((h) => `http://${h}`).includes(origin)) return json(res, 403, { error: 'Origine non consentita' });
    const given = req.headers['x-pck-token'] ?? url.searchParams.get('token');
    if (!given || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return json(res, 401, { error: 'Token mancante o non valido: riapri l\'indirizzo mostrato da pck ui.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') return jobs.attach(res);
    const handler = API[`${req.method} ${url.pathname}`];
    if (!handler) return json(res, 404, { error: 'non trovato' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(res, 200, await handler(body, url));
    } catch (e) {
      const code = statusFor(e);
      if (code === 500) log?.error(`API ${url.pathname}: ${e.stack ?? e.message}`);
      return json(res, code, { error: e.message });
    }
  });

  return { server, token, jobs, setPort: (p) => { port = p; } };
}

/** Avvia `pck ui`: porta da config (4317) o libera, apertura del browser con il token nel frammento dell'URL. */
export async function startUi({ cfg, adb, log, opts }) {
  const file = path.resolve(opts.file ?? cfg.defaultFile);
  const ui = createUiServer({ cfg, adb, log, file });
  const wanted = Number(opts.port ?? cfg.ui?.port ?? 4317);
  const listen = (p) => new Promise((resolve, reject) => {
    ui.server.once('error', reject);
    ui.server.listen(p, '127.0.0.1', () => { ui.server.off('error', reject); resolve(ui.server.address().port); });
  });
  let port;
  try {
    port = await listen(wanted);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    port = await listen(0);
    log.warn(`Porta ${wanted} occupata: uso la ${port}. La pagina resta comunque esclusa da sync e chiusura in questa sessione.`);
  }
  ui.setPort(port);
  // Il token sta nel frammento (#): non finisce nei log né nell'header Referer.
  const address = `http://127.0.0.1:${port}/#t=${ui.token}`;
  log.ok(`PhoneCleanKit UI: ${address}`);
  log.info(`  File: ${file}`);
  log.info('  Ctrl+C per chiudere.');
  if (opts.open !== false && cfg.ui?.open !== false) openBrowser(address);
  await new Promise((resolve) => {
    const stop = () => { ui.server.close(); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

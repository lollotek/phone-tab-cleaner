/**
 * Stato mostrato in alto nella pagina: AI, telefono, Chrome sul PC.
 * Controlli leggeri e senza effetti: nessuna connessione adb nuova, nessuna connessione CDP
 * (che farebbe comparire la richiesta di approvazione in Chrome).
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { defaultUserDataDir, parseActivePort } from '../sources/pc.js';

async function aiStatus(cfg) {
  const provider = cfg.ai.defaultProvider;
  const p = cfg.ai.providers?.[provider] ?? {};
  if (provider === 'local') {
    const base = (p.baseUrl ?? '').replace(/\/+$/, '');
    try {
      const lm = await fetch(`${new URL(base).origin}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
      if (lm.ok) {
        const loaded = (await lm.json()).data?.find((m) => m.state === 'loaded' && m.type !== 'embeddings');
        return loaded
          ? { ok: true, provider, model: p.model || loaded.id, detail: `LM Studio · contesto ${loaded.loaded_context_length ?? '?'}` }
          : { ok: false, provider, detail: 'LM Studio attivo ma nessun modello caricato' };
      }
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2000) });
      const first = res.ok ? (await res.json()).data?.find((m) => !/embed/i.test(m.id)) : null;
      return first ? { ok: true, provider, model: p.model || first.id, detail: base } : { ok: false, provider, detail: `nessun modello su ${base}` };
    } catch {
      return { ok: false, provider, detail: `server non raggiungibile (${base})` };
    }
  }
  if (provider === 'claude') {
    const has = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    return { ok: has ? true : null, provider, model: p.model, detail: has ? 'credenziali da variabile d\'ambiente' : 'nessuna variabile: vale solo se hai fatto `ant auth login`' };
  }
  if (provider === 'gemini') {
    const has = Boolean(process.env[p.apiKeyEnv ?? 'GEMINI_API_KEY']);
    return { ok: has, provider, model: p.model, detail: has ? 'chiave impostata' : `${p.apiKeyEnv ?? 'GEMINI_API_KEY'} non impostata` };
  }
  return { ok: false, provider, detail: 'provider sconosciuto' };
}

async function phoneStatus(adb, cfg) {
  try {
    const list = await adb.devices();
    const dev = list.find((d) => d.state === 'device');
    if (dev) return { ok: true, serial: dev.serial, model: dev.model, detail: dev.model ?? dev.serial };
    const off = list.find((d) => d.state === 'offline' || d.state === 'unauthorized');
    return { ok: false, detail: off ? `${off.serial}: ${off.state}` : `nessun dispositivo${cfg.lastDevice ? ` (ultimo: ${cfg.lastDevice})` : ''}` };
  } catch (e) {
    return { ok: false, detail: e.message.split('\n')[0] };
  }
}

const portOpen = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.connect({ port, host });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(800, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

async function pcStatus(cfg) {
  const pcCfg = cfg.pc ?? {};
  if (pcCfg.browserUrl) {
    try {
      const r = await fetch(new URL('/json/version', pcCfg.browserUrl), { signal: AbortSignal.timeout(1500) });
      return { ok: r.ok, detail: pcCfg.browserUrl };
    } catch {
      return { ok: false, detail: `non raggiungibile (${pcCfg.browserUrl})` };
    }
  }
  const dir = pcCfg.userDataDir || defaultUserDataDir();
  let text;
  try {
    text = await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return { ok: false, detail: 'debug remoto non attivo (chrome://inspect/#remote-debugging)' };
  }
  const port = Number(new URL(parseActivePort(text)).port);
  return (await portOpen(port))
    ? { ok: true, detail: `debug remoto attivo (porta ${port}); a ogni collegamento Chrome chiede l'approvazione` }
    : { ok: false, detail: 'Chrome chiuso o debug remoto disattivato' };
}

/** Stato complessivo, con cache breve (la pagina lo richiede periodicamente). */
export function createStatusProvider({ adb, cfg, ttlMs = 8000 }) {
  let cache = null;
  let at = 0;
  let pending = null;
  return async function getStatus({ force = false } = {}) {
    if (!force && cache && Date.now() - at < ttlMs) return cache;
    pending ??= Promise.all([aiStatus(cfg), phoneStatus(adb, cfg), pcStatus(cfg)])
      .then(([ai, phone, pc]) => { cache = { ai, phone, pc, checkedAt: new Date().toISOString() }; at = Date.now(); return cache; })
      .finally(() => { pending = null; });
    return pending;
  };
}

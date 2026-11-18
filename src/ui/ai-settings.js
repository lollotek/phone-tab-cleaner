/**
 * Impostazioni AI modificabili dall'interfaccia: lettura, validazione, salvataggio nel config (lo stesso della CLI).
 * Le chiavi API non passano mai di qui: si leggono solo dalle variabili d'ambiente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_CONFIG, USER_CONFIG, merge } from '../config.js';
import { PckError } from '../errors.js';
import { PROVIDERS } from '../tagger/ai/index.js';

const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt'];
const REASONING = ['none', 'low', 'medium', 'high'];
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const SUGGESTIONS = {
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  gemini: ['gemini-flash-latest', 'gemini-pro-latest'],
};

/** File in cui verrebbe salvata una modifica (stessa logica di saveConfigPatch). */
export const configTarget = () => (fs.existsSync(path.resolve(LOCAL_CONFIG)) ? path.resolve(LOCAL_CONFIG) : USER_CONFIG);

export function aiSettingsView(cfg) {
  const p = cfg.ai.providers ?? {};
  const keyEnv = p.gemini?.apiKeyEnv ?? 'GEMINI_API_KEY';
  return {
    defaultProvider: cfg.ai.defaultProvider,
    language: cfg.description?.language ?? 'it',
    providers: {
      local: { baseUrl: p.local?.baseUrl ?? '', model: p.local?.model ?? '', batchSize: p.local?.batchSize ?? 5, reasoningEffort: p.local?.reasoningEffort === undefined ? 'none' : (p.local.reasoningEffort ?? '') },
      claude: { model: p.claude?.model ?? '', batchSize: p.claude?.batchSize ?? 20, effort: p.claude?.effort ?? 'low' },
      gemini: { model: p.gemini?.model ?? '', batchSize: p.gemini?.batchSize ?? 20, apiKeyEnv: keyEnv },
    },
    credentials: {
      claude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      gemini: Boolean(process.env[keyEnv]),
    },
    options: { providers: PROVIDERS, languages: LANGS, reasoning: REASONING, effort: EFFORT, suggestions: SUGGESTIONS },
    configFile: configTarget(),
  };
}

const str = (v, max = 120) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new PckError(`Valore troppo lungo: ${s.slice(0, 30)}…`);
  return s;
};
const batch = (v, def) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new PckError('La dimensione dei lotti va da 1 a 50.');
  return n;
};

/**
 * Valida le impostazioni inviate dalla pagina.
 * @returns {object} patch di config ({ ai: {...}, description: { language } })
 */
export function sanitizeAiSettings(body, cfg) {
  const prov = body.defaultProvider ?? cfg.ai.defaultProvider;
  if (!PROVIDERS.includes(prov)) throw new PckError(`Provider sconosciuto: ${prov}`);
  const language = body.language ?? cfg.description?.language ?? 'it';
  if (!LANGS.includes(language)) throw new PckError(`Lingua non supportata: ${language}`);
  const p = body.providers ?? {};
  const cur = cfg.ai.providers ?? {};

  const local = {};
  if (p.local) {
    const baseUrl = str(p.local.baseUrl ?? cur.local?.baseUrl, 300);
    let u;
    try { u = new URL(baseUrl); } catch { throw new PckError('Indirizzo del server locale non valido (es. http://localhost:1234/v1).'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new PckError('Il server locale deve essere http:// o https://.');
    const re = p.local.reasoningEffort ?? 'none';
    if (re !== '' && re !== null && !REASONING.includes(re)) throw new PckError(`Valore di ragionamento non valido: ${re}`);
    Object.assign(local, {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model: str(p.local.model) || null,
      batchSize: batch(p.local.batchSize, cur.local?.batchSize ?? 5),
      reasoningEffort: re === '' ? null : re,
    });
  }
  const claude = {};
  if (p.claude) {
    const effort = p.claude.effort ?? cur.claude?.effort ?? 'low';
    if (!EFFORT.includes(effort)) throw new PckError(`Effort non valido: ${effort}`);
    Object.assign(claude, { model: str(p.claude.model) || cur.claude?.model, batchSize: batch(p.claude.batchSize, cur.claude?.batchSize ?? 20), effort });
  }
  const gemini = {};
  if (p.gemini) {
    const env = str(p.gemini.apiKeyEnv) || 'GEMINI_API_KEY';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(env)) throw new PckError('Nome della variabile per la chiave non valido (es. GEMINI_API_KEY).');
    Object.assign(gemini, { model: str(p.gemini.model) || cur.gemini?.model, batchSize: batch(p.gemini.batchSize, cur.gemini?.batchSize ?? 20), apiKeyEnv: env });
  }
  const providers = {};
  if (Object.keys(local).length) providers.local = local;
  if (Object.keys(claude).length) providers.claude = claude;
  if (Object.keys(gemini).length) providers.gemini = gemini;
  return { ai: { defaultProvider: prov, providers }, description: { language } };
}

/** Applica una patch al config in memoria (lo stesso oggetto usato dal server e dallo stato). */
export function applyToConfig(cfg, patch) {
  cfg.ai = merge(cfg.ai, patch.ai);
  cfg.description = merge(cfg.description, patch.description);
  return cfg;
}

/** Modelli disponibili su un server compatibile OpenAI (LM Studio indica anche quello caricato). */
export async function listLocalModels(baseUrl) {
  let base;
  try { base = new URL(baseUrl).href.replace(/\/+$/, ''); } catch { throw new PckError('Indirizzo del server non valido.'); }
  try {
    const lm = await fetch(`${new URL(base).origin}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
    if (lm.ok) {
      return (await lm.json()).data
        ?.filter((m) => m.type !== 'embeddings')
        .map((m) => ({ id: m.id, loaded: m.state === 'loaded', context: m.loaded_context_length ?? null })) ?? [];
    }
  } catch { /* non è LM Studio */ }
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()).data ?? []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, loaded: null, context: null }));
  } catch (e) {
    throw new PckError(`Server non raggiungibile su ${base} (${e.cause?.code || e.message}).`);
  }
}

/** Config temporaneo con le impostazioni del modulo (per "Prova" senza salvare). */
export const withSettings = (cfg, patch) => merge(cfg, patch);

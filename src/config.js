import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PckError } from './errors.js';

export const USER_DIR = path.join(os.homedir(), '.pck');
export const USER_CONFIG = path.join(USER_DIR, 'config.json');
export const LOCAL_CONFIG = 'pck.config.json';

export const DEFAULTS = {
  adbPath: 'D:\\programmi\\scrcpy-win64-v3.3.4\\adb.exe',
  defaultFile: './links.md',
  // Prima di ogni modifica di links.md: copia in <cartella del file>/<dir>, conservando le ultime `keep`.
  backup: { dir: '.pck-backup', keep: 10 },
  lastDevice: null,
  chromePackage: 'com.android.chrome',
  chromeActivity: 'com.google.android.apps.chrome.Main',
  devtoolsSocket: 'chrome_devtools_remote',
  includeLocal: false,
  writeCleanUrls: true,
  // Siti mai salvati né chiusi (app web da tenere aperte). "host" vale anche per i sottodomini;
  // "host/percorso" limita a un prefisso del percorso (es. "gemini.google.com/app").
  exclude: [
    'web.whatsapp.com',
    'web.telegram.org',
    'mail.google.com',
    'calendar.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'teams.microsoft.com',
    'meet.google.com',
    // La pagina di `pck ui` (porta predefinita): mai salvata né chiusa, anche con --include-local.
    '127.0.0.1:4317',
    'localhost:4317',
  ],
  ui: { port: 4317, open: true },
  defaultSource: 'phone',
  pc: {
    // Cartella dati di Chrome (dove compare DevToolsActivePort); null = percorso standard del sistema.
    userDataDir: null,
    // In alternativa: Chrome avviato con --remote-debugging-port, es. "http://127.0.0.1:9222".
    browserUrl: null,
    approvalTimeoutMs: 60000,
  },
  fetch: {
    timeoutMs: 8000,
    concurrency: 5,
    maxBytes: 524288,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  },
  normalize: {
    stripParams: [
      'utm_*', 'gad_*', 'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid', 'twclid', 'ttclid',
      'mc_cid', 'mc_eid', 'igshid', 'igsh', 'si', 'ref', 'ref_src', '_ga', '_gl', 'srsltid',
    ],
    keepHashRoutes: true,
  },
  description: { maxLength: 160, language: 'it' },
  ai: {
    defaultProvider: 'local',
    excerptChars: 1200,
    // Indicazioni personali aggiunte al prompt: cercato in cartella corrente, poi in ~/.pck/.
    instructionsFile: 'pck.prompt.md',
    providers: {
      // reasoningEffort: "none" disattiva il ragionamento dei modelli "thinking" (null = non inviare il parametro).
      local: { baseUrl: 'http://localhost:1234/v1', model: null, batchSize: 5, structured: 'json_schema', timeoutMs: 300000, reasoningEffort: 'none' },
      claude: { model: 'claude-haiku-5-5', batchSize: 20, effort: 'low' },
      gemini: { model: 'gemini-flash-latest', apiKeyEnv: 'GEMINI_API_KEY', batchSize: 20 },
    },
  },
  tagRules: {
    maxTags: 4,
    fallbackTag: 'da-smistare',
    searchTag: 'ricerca',
    domains: {
      'github.com': ['dev'],
      'gitlab.com': ['dev'],
      'codeberg.org': ['dev'],
      'stackoverflow.com': ['dev'],
      'npmjs.com': ['dev'],
      'arxiv.org': ['articolo-scientifico'],
      'cardboardtemplates.com': ['papercraft'],
      'youtube.com': ['video'],
      'youtu.be': ['video'],
      'facebook.com': ['social'],
      'instagram.com': ['social'],
      'reddit.com': ['forum'],
      'giallozafferano.it': ['cucina'],
      'amazon.it': ['shopping'],
      'ikea.com': ['casa'],
      'leroymerlin.it': ['casa', 'shopping'],
      'printables.com': ['stampa-3d'],
      'thingiverse.com': ['stampa-3d'],
      'makerworld.com': ['stampa-3d'],
    },
    keywords: {
      ricetta: ['cucina'],
      ricette: ['cucina'],
      'three.js': ['3d'],
      threejs: ['3d'],
      blender: ['3d'],
      '3d': ['3d'],
      'stampa 3d': ['stampa-3d'],
      '3d printing': ['stampa-3d'],
      cnc: ['cnc'],
      papercraft: ['papercraft'],
      'paper craft': ['papercraft'],
      cardboard: ['papercraft'],
      cartone: ['papercraft'],
      cartoncino: ['papercraft'],
      origami: ['papercraft'],
      emulator: ['giochi', 'emulazione'],
      emulatore: ['giochi', 'emulazione'],
      game: ['giochi'],
      games: ['giochi'],
      gioco: ['giochi'],
      'pixel art': ['pixel-art'],
      'claude code': ['ai'],
      llm: ['ai'],
      'home assistant': ['domotica'],
      fibra: ['internet'],
      biglietti: ['eventi'],
      tickets: ['eventi'],
    },
    // Tag rinominati/sinonimi: chi produce il valore a sinistra (regole o AI) ottiene quello a destra.
    aliases: { js: 'javascript', ml: 'machine-learning', paper: 'papercraft', 'paper-craft': 'papercraft' },
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function merge(a, b) {
  if (b === undefined) return a;
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
    return out;
  }
  return b;
}

function readJson(p) {
  try {
    // Su Windows editor e PowerShell salvano spesso con BOM UTF-8, che JSON.parse non accetta.
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new PckError(`Config non valido (${p}): ${e.message}`);
  }
}

/** Precedenza: default < ~/.pck/config.json < ./pck.config.json < variabili d'ambiente (le opzioni CLI vengono applicate dal chiamante). */
export function loadConfig() {
  let cfg = merge(DEFAULTS, readJson(USER_CONFIG) ?? {});
  cfg = merge(cfg, readJson(path.resolve(LOCAL_CONFIG)) ?? {});
  if (process.env.PCK_ADB_PATH) cfg.adbPath = process.env.PCK_ADB_PATH;
  return cfg;
}

/**
 * Salva una modifica di configurazione dove l'utente la tiene già: ./pck.config.json se esiste,
 * altrimenti ~/.pck/config.json. @returns {string} percorso del file scritto
 */
export function saveConfigPatch(patch) {
  const local = path.resolve(LOCAL_CONFIG);
  if (fs.existsSync(local)) {
    const cur = readJson(local) ?? {};
    fs.writeFileSync(local, `${JSON.stringify(merge(cur, patch), null, 2)}\n`, 'utf8');
    return local;
  }
  saveUserConfig(patch);
  return USER_CONFIG;
}

export function saveUserConfig(patch) {
  const cur = readJson(USER_CONFIG) ?? {};
  fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
  fs.writeFileSync(USER_CONFIG, `${JSON.stringify(merge(cur, patch), null, 2)}\n`, 'utf8');
}

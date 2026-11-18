/**
 * `pck check`: controllo di `links.md` in sola lettura (SPEC §11.1-D).
 * Errori (codice d'uscita 1): righe malformate, URL non validi, URL doppi, link morti (--links).
 * Avvisi: voci senza tag o senza descrizione, tag non in kebab-case, link non verificabili.
 */
import path from 'node:path';
import pc from 'picocolors';
import { entryLines, looksLikeBrokenEntry, rawTrailingTags } from './markdown.js';
import { normalizeUrl } from './url.js';
import { slugTag } from './tagger/rules.js';
import { PckError, EXIT } from './errors.js';
import { mapLimit, readTextIfExists } from './util.js';

/** Suggerimento di comando per ogni tipo di problema. */
const HINTS = {
  'senza-descrizione': 'pck retag --empty',
  'senza-tag': 'pck retag --all --url <…>  oppure aggiungili a mano',
  'tag-non-valido': 'pck tags rename <tag> <nuovo>',
  'url-doppio': 'tieni una sola delle righe',
};

const LABELS = {
  'riga-malformata': 'Righe che sembrano voci ma non rispettano il formato',
  'url-non-valido': 'URL non validi',
  'url-doppio': 'URL doppi',
  'link-morto': 'Link morti',
  'senza-tag': 'Voci senza tag',
  'senza-descrizione': 'Voci senza descrizione',
  'tag-non-valido': 'Tag non in kebab-case',
  'non-verificabile': 'Link non verificabili',
};

/**
 * Controlli sul testo del file (nessuna rete).
 * @returns {{severity:'errore'|'avviso', kind:string, line:number, message:string, url?:string}[]} line = numero di riga (1-based)
 */
export function checkText(text, { normalize }) {
  const issues = [];
  const add = (severity, kind, line, message, url) => issues.push({ severity, kind, line, message, ...(url ? { url } : {}) });

  text.split(/\r?\n/).forEach((l, i) => {
    if (looksLikeBrokenEntry(l)) add('errore', 'riga-malformata', i + 1, l.trim().slice(0, 120));
  });

  const firstSeen = new Map();
  for (const { index, line, entry } of entryLines(text)) {
    const n = index + 1;
    let valid = true;
    try {
      const u = new URL(entry.url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('schema');
    } catch {
      valid = false;
      add('errore', 'url-non-valido', n, entry.url, entry.url);
    }
    if (valid) {
      const key = normalize(entry.url);
      if (firstSeen.has(key)) add('errore', 'url-doppio', n, `uguale alla riga ${firstSeen.get(key)}: ${entry.url}`, entry.url);
      else firstSeen.set(key, n);
    }
    if (!entry.tags.length) add('avviso', 'senza-tag', n, entry.title || entry.url, entry.url);
    if (!entry.description) add('avviso', 'senza-descrizione', n, entry.title || entry.url, entry.url);
    for (const t of rawTrailingTags(line)) {
      const slug = slugTag(t);
      if (slug !== t) add('avviso', 'tag-non-valido', n, `#${t}${slug ? ` (suggerito: #${slug})` : ''}`, entry.url);
    }
  }
  return issues;
}

/**
 * Verifica che i link rispondano. Morto: HTTP 404/410 o dominio inesistente.
 * Non verificabile: siti che bloccano i bot (401/403/429), errori del server, timeout, altri errori di rete.
 */
export async function checkLink(url, { timeoutMs = 8000, userAgent } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': userAgent, accept: 'text/html,*/*;q=0.5' },
    });
    res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return { status: 'morto', detail: `HTTP ${res.status}` };
    if (res.ok) return { status: 'ok', detail: `HTTP ${res.status}` };
    return { status: 'non-verificabile', detail: `HTTP ${res.status}` };
  } catch (e) {
    const code = e.cause?.code;
    // NXDOMAIN può anche essere temporaneo (dominio scaduto, problema del registrar): lo si dice nel messaggio.
    if (code === 'ENOTFOUND') return { status: 'morto', detail: 'dominio non trovato (DNS)' };
    return { status: 'non-verificabile', detail: e.name === 'TimeoutError' ? 'timeout' : code || e.cause?.message || e.message };
  }
}

export async function checkLinks(text, { cfg, log, concurrency }) {
  const rows = entryLines(text).filter(({ entry }) => /^https?:\/\//i.test(entry.url));
  const issues = [];
  let done = 0;
  await mapLimit(rows, concurrency, async ({ index, entry }) => {
    const r = await checkLink(entry.url, cfg.fetch);
    if (r.status === 'morto') issues.push({ severity: 'errore', kind: 'link-morto', line: index + 1, message: `${r.detail}: ${entry.url}`, url: entry.url });
    else if (r.status === 'non-verificabile') issues.push({ severity: 'avviso', kind: 'non-verificabile', line: index + 1, message: `${r.detail}: ${entry.url}`, url: entry.url });
    if (process.stderr.isTTY) process.stderr.write(`\r  link ${++done}/${rows.length}`);
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  log.ok(`Link verificati: ${rows.length}`);
  return issues.sort((a, b) => a.line - b.line);
}

export async function runCheck({ cfg, log, opts }) {
  const file = path.resolve(opts.file ?? cfg.defaultFile);
  const text = await readTextIfExists(file);
  if (text === null) throw new PckError(`File non trovato: ${file}`, EXIT.FILE);
  const normalize = (u) => normalizeUrl(u, cfg.normalize);

  const entries = entryLines(text).length;
  const issues = checkText(text, { normalize });
  if (opts.links) issues.push(...await checkLinks(text, { cfg, log, concurrency: Number(opts.concurrency ?? cfg.fetch.concurrency) }));

  const errors = issues.filter((i) => i.severity === 'errore').length;
  const warnings = issues.length - errors;
  if (errors) process.exitCode = EXIT.GENERIC;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ file, entries, errors, warnings, issues }, null, 2)}\n`);
    return { errors, warnings, issues };
  }

  const out = (s = '') => process.stdout.write(`${s}\n`);
  const max = Number(opts.max ?? 10);
  for (const kind of Object.keys(LABELS)) {
    const list = issues.filter((i) => i.kind === kind);
    if (!list.length) continue;
    const color = list[0].severity === 'errore' ? pc.red : pc.yellow;
    out(color(`${list[0].severity === 'errore' ? '✖' : '⚠'} ${LABELS[kind]}: ${list.length}`));
    for (const i of list.slice(0, max)) out(`    riga ${String(i.line).padStart(4)}  ${i.message}`);
    if (list.length > max) out(pc.dim(`    … e altre ${list.length - max} (--max ${list.length} per vederle tutte)`));
    if (HINTS[kind]) out(pc.dim(`    → ${HINTS[kind]}`));
  }
  const summary = `${path.basename(file)}: ${entries} voci · ${errors} errori · ${warnings} avvisi${opts.links ? '' : ' (link non verificati: --links)'}`;
  if (!issues.length) log.ok(summary);
  else log.info(`\n${summary}`);
  return { errors, warnings, issues };
}

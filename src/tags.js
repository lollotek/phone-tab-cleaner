/**
 * `pck tags`: statistiche, rinomina, accorpamento e rimozione di tag nel file (SPEC §11.1-C).
 * Le modifiche toccano solo i tag finali delle righe interessate; rinomina e accorpamento
 * aggiungono un alias nel config, così regole e AI non ricreano il vecchio nome.
 */
import path from 'node:path';
import pc from 'picocolors';
import { entryLines, replaceLines, replaceTrailingTags } from './markdown.js';
import { saveConfigPatch } from './config.js';
import { loadInstructions } from './describe.js';
import { slugTag } from './tagger/rules.js';
import { PckError, EXIT } from './errors.js';
import { readTextIfExists, shortPath, writeAtomic } from './util.js';

/** Statistiche dei tag sulle voci del file. */
export function computeTagStats(rows, { topPairs = 10 } = {}) {
  const counts = new Map();
  const pairs = new Map();
  let untagged = 0;
  for (const { entry } of rows) {
    if (!entry.tags.length) untagged++;
    for (const t of entry.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const uniq = [...new Set(entry.tags)].sort();
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const k = `${uniq[i]}+${uniq[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    entries: rows.length,
    tags: sorted.map(([tag, count]) => ({ tag, count })),
    singletons: sorted.filter(([, n]) => n === 1).map(([t]) => t),
    untagged,
    pairs: [...pairs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topPairs).map(([pair, count]) => ({ pair, count })),
  };
}

/**
 * Applica una mappa di tag al testo: vecchio → nuovo (rinomina/accorpamento) oppure vecchio → null (rimozione).
 * @returns {{text:string, changes:{index:number,before:string,after:string}[], untaggedAfter:number}}
 */
export function applyTagMapping(text, mapping) {
  const replacements = new Map();
  const changes = [];
  let untaggedAfter = 0;
  for (const { index, line, entry } of entryLines(text)) {
    if (!entry.tags.some((t) => mapping.has(t))) continue;
    const next = [];
    for (const t of entry.tags) {
      const m = mapping.has(t) ? mapping.get(t) : t;
      if (m && !next.includes(m)) next.push(m);
    }
    const after = replaceTrailingTags(line, next);
    if (after === line) continue;
    if (!next.length) untaggedAfter++;
    replacements.set(index, after);
    changes.push({ index, before: line, after });
  }
  return { text: changes.length ? replaceLines(text, replacements) : text, changes, untaggedAfter };
}

/**
 * Modifica di config per una rinomina/accorpamento: alias vecchio → nuovo, alias esistenti che puntavano
 * al vecchio nome riportati sul nuovo, e tag riservati (ripiego/ricerche) aggiornati se rinominati.
 */
export function buildConfigPatch(mapping, tagRules) {
  const aliases = {};
  const patch = {};
  const current = Object.fromEntries(Object.entries(tagRules.aliases ?? {}).map(([k, v]) => [slugTag(k), slugTag(v)]));
  for (const [from, to] of mapping) {
    if (!to) continue;
    aliases[from] = to;
    for (const [k, v] of Object.entries(current)) if (v === from) aliases[k] = to;
    if (slugTag(tagRules.fallbackTag ?? '') === from) patch.fallbackTag = to;
    if (slugTag(tagRules.searchTag ?? '') === from) patch.searchTag = to;
  }
  // Un alias verso se stesso non serve (es. si rinomina di nuovo un tag al nome originale).
  for (const [k, v] of Object.entries(aliases)) if (k === v) delete aliases[k];
  if (Object.keys(aliases).length) patch.aliases = aliases;
  return Object.keys(patch).length ? { tagRules: patch } : null;
}

async function loadFile(cfg, opts) {
  const file = path.resolve(opts.file ?? cfg.defaultFile);
  const text = await readTextIfExists(file);
  if (text === null) throw new PckError(`File non trovato: ${file}`, EXIT.FILE);
  return { file, text };
}

export async function showTagStats({ cfg, opts }) {
  const { file, text } = await loadFile(cfg, opts);
  const stats = computeTagStats(entryLines(text));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ file, ...stats }, null, 2)}\n`);
    return stats;
  }
  const out = (s = '') => process.stdout.write(`${s}\n`);
  out(`${path.basename(file)}: ${stats.entries} voci · ${stats.tags.length} tag · ${stats.untagged} senza tag\n`);
  const max = stats.tags[0]?.count ?? 1;
  const width = Math.max(...stats.tags.map((t) => t.tag.length), 3);
  for (const { tag, count } of stats.tags) {
    out(`  ${`#${tag}`.padEnd(width + 2)} ${String(count).padStart(4)}  ${pc.cyan('█'.repeat(Math.max(1, Math.round((count / max) * 30))))}`);
  }
  if (stats.singletons.length) out(`\nUsati una sola volta: ${stats.singletons.map((t) => `#${t}`).join(' ')}`);
  if (stats.pairs.length) out(`Coppie più frequenti: ${stats.pairs.map((p) => `${p.pair} (${p.count})`).join(' · ')}`);
  return stats;
}

/**
 * Rinomina / accorpa / rimuove.
 * @param {Map<string,string|null>} mapping
 */
async function applyAndSave(mapping, { cfg, log, opts }, label) {
  const { file, text } = await loadFile(cfg, opts);
  const present = new Set(entryLines(text).flatMap((r) => r.entry.tags));
  const missing = [...mapping.keys()].filter((t) => !present.has(t));
  if (missing.length === mapping.size) throw new PckError(`Tag non trovato nel file: ${missing.map((t) => `#${t}`).join(' ')}`);
  missing.forEach((t) => log.warn(`#${t} non compare nel file`));

  const { text: next, changes, untaggedAfter } = applyTagMapping(text, mapping);
  const show = opts.dryRun || log.verbose;
  if (show) for (const c of changes) process.stdout.write(`${pc.red(`- ${c.before}`)}\n${pc.green(`+ ${c.after}`)}\n\n`);
  const patch = buildConfigPatch(mapping, cfg.tagRules);

  if (opts.dryRun) {
    log.info(pc.yellow(`[dry-run] ${label}: ${changes.length} voci cambierebbero; file e config non modificati`));
    if (patch) log.info(`  Config: ${JSON.stringify(patch.tagRules)}`);
    return { changed: 0, wouldChange: changes.length, patch };
  }
  const saved = changes.length ? await writeAtomic(file, next, { backup: cfg.backup }) : null;
  log.ok(`${label}: ${changes.length} voci aggiornate in ${path.basename(file)}`);
  if (saved) log.info(`  Backup: ${shortPath(saved)}`);
  if (untaggedAfter) log.warn(`${untaggedAfter} voci sono rimaste senza tag (pck retag --all --url … per assegnarne di nuovi)`);
  if (patch) {
    const where = saveConfigPatch(patch);
    log.ok(`Alias salvati in ${shortPath(where)}: regole e AI non useranno più il vecchio nome`);
  }
  // Le indicazioni personali sono testo libero: si segnala soltanto se citano il vecchio tag.
  const instr = await loadInstructions(cfg.ai.instructionsFile);
  const cited = [...mapping.keys()].filter((t) => new RegExp(`#${t}(?![\\p{L}\\p{N}_-])`, 'iu').test(instr?.text ?? ''));
  if (cited.length) log.warn(`${shortPath(instr.file)} cita ancora ${cited.map((t) => `#${t}`).join(' ')}: aggiornalo a mano`);
  return { changed: changes.length, patch };
}

export function renameTag(oldTag, newTag, ctx) {
  const from = slugTag(oldTag);
  const to = slugTag(newTag);
  if (!from || !to) throw new PckError('Nome di tag non valido.');
  if (from === to) throw new PckError('Il nuovo nome coincide con il vecchio.');
  return applyAndSave(new Map([[from, to]]), ctx, `#${from} → #${to}`);
}

export function mergeTags(tags, into, ctx) {
  const to = slugTag(into ?? '');
  if (!to) throw new PckError('Indica il tag di destinazione con --into <tag>.');
  const from = [...new Set(tags.map(slugTag))].filter((t) => t && t !== to);
  if (!from.length) throw new PckError('Indica almeno un tag da accorpare diverso dalla destinazione.');
  return applyAndSave(new Map(from.map((t) => [t, to])), ctx, `${from.map((t) => `#${t}`).join(' + ')} → #${to}`);
}

export function removeTags(tags, ctx) {
  const list = [...new Set(tags.map(slugTag))].filter(Boolean);
  if (!list.length) throw new PckError('Indica il tag da rimuovere.');
  return applyAndSave(new Map(list.map((t) => [t, null])), ctx, `rimozione di ${list.map((t) => `#${t}`).join(' ')}`);
}

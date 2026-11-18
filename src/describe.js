/**
 * Descrizione e tag dei link: parti comuni a `sync` e `retag`.
 * - fetchAll: scarica i metadati delle pagine
 * - describeWithAi: descrizione + tag con il provider AI (vocabolario, tag riservati, indicazioni personali)
 */
import path from 'node:path';
import { USER_DIR } from './config.js';
import { PckError } from './errors.js';
import { fetchMetadata } from './metadata.js';
import { slugTag } from './tagger/rules.js';
import { createProvider, enrichWithAi, tagsInInstructions } from './tagger/ai/index.js';
import { cleanText, mapLimit, readTextIfExists, truncate } from './util.js';

/**
 * File di indicazioni per l'AI: percorso esplicito (--instructions / ai.instructionsFile), cercato
 * nella cartella corrente e poi in ~/.pck/. Un percorso indicato esplicitamente ma inesistente è un errore.
 */
export async function loadInstructions(name, { explicit = false } = {}) {
  if (!name) return null;
  const candidates = path.isAbsolute(name) ? [name] : [path.resolve(name), path.join(USER_DIR, path.basename(name))];
  for (const file of candidates) {
    const text = await readTextIfExists(file);
    if (text !== null) return { file, text };
  }
  if (explicit) throw new PckError(`File di indicazioni non trovato: ${name}`);
  return null;
}

/** Tag "di servizio" che l'AI non deve assegnare (ripiego e pagine di ricerca). */
export const reservedTags = (cfg) => [cfg.tagRules.fallbackTag, cfg.tagRules.searchTag].filter(Boolean).map(slugTag);

/** Scarica i metadati (it.meta) per gli elementi indicati; restituisce quanti non sono disponibili. */
export async function fetchAll(items, { cfg, opts, log }) {
  let failed = 0;
  let done = 0;
  await mapLimit(items, Number(opts.concurrency ?? cfg.fetch.concurrency), async (it) => {
    it.meta = await fetchMetadata(it.url, cfg.fetch);
    if (!it.meta.ok) {
      failed++;
      log.debug(`metadati non disponibili (${it.meta.error}): ${it.url}`);
    }
    if (process.stderr.isTTY) process.stderr.write(`\r  metadati ${++done}/${items.length}`);
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  log.ok(`Metadati scaricati (${items.length - failed}/${items.length}${failed ? `, ${failed} non disponibili` : ''})`);
  return failed;
}

/** Descrizione dai metadati, scartata se non aggiunge nulla al titolo. */
export function metaDescription(meta, title, maxLength) {
  const d = cleanText(meta?.description ?? '');
  if (!d || (title ?? '').toLowerCase().includes(d.toLowerCase())) return '';
  return truncate(d, maxLength);
}

/**
 * Descrizione e tag con l'AI.
 * @param {{url:string,title:string,meta?:object}[]} items
 * @param {Map<string,number>} fileTags vocabolario del file
 * @returns {Promise<Map<object,{description:string,tags:string[]}>>} solo gli elementi riusciti
 */
export async function describeWithAi(items, { cfg, opts, log, fileTags }) {
  const name = opts.ai === true || opts.ai === undefined ? cfg.ai.defaultProvider : opts.ai;
  const provider = await createProvider(name, cfg.ai, { model: opts.model });
  const pcfg = cfg.ai.providers[name] ?? {};

  // Vocabolario: tag del file + tag previsti dalle regole (come suggerimenti), per coerenza fin dal primo uso.
  // I suggerimenti passano dagli alias, così un tag rinominato con `pck tags rename` non viene riproposto.
  const aliasOf = Object.fromEntries(Object.entries(cfg.tagRules.aliases ?? {}).map(([k, v]) => [slugTag(k), slugTag(v)]));
  const vocabulary = new Map(fileTags);
  for (const list of [...Object.values(cfg.tagRules.domains ?? {}), ...Object.values(cfg.tagRules.keywords ?? {})]) {
    for (const raw of list) {
      const t = aliasOf[slugTag(raw)] ?? slugTag(raw);
      if (!vocabulary.has(t)) vocabulary.set(t, 0);
    }
  }
  // Indicazioni personali per l'AI (es. "se c'è cosplay aggiungi #cosplay"): file di testo libero.
  const instr = await loadInstructions(opts.instructions ?? cfg.ai.instructionsFile, { explicit: Boolean(opts.instructions) });
  if (instr) {
    log.info(`  Indicazioni AI: ${instr.file}`);
    for (const t of tagsInInstructions(instr.text)) if (!vocabulary.has(t)) vocabulary.set(t, 0);
  }
  // Il ripiego e il tag delle ricerche non vanno proposti (l'AI scambierebbe "ricerca" per "ricerca scientifica").
  const reserved = reservedTags(cfg);
  reserved.forEach((t) => vocabulary.delete(t));

  log.info(`  AI: ${provider.name} · modello ${provider.model} · ${items.length} link in lotti da ${pcfg.batchSize ?? 10}`);
  const t0 = Date.now();
  const raw = await enrichWithAi(
    items.map((it) => ({ ref: it, url: it.url, title: it.title, description: it.meta?.description, keywords: it.meta?.keywords, excerpt: it.meta?.excerpt })),
    {
      provider,
      vocabulary,
      language: opts.lang ?? cfg.description.language,
      maxTags: cfg.tagRules.maxTags,
      maxLength: cfg.description.maxLength,
      batchSize: Number(pcfg.batchSize ?? 10),
      excerptChars: cfg.ai.excerptChars,
      aliases: cfg.tagRules.aliases,
      instructions: instr?.text,
      log,
    },
  );
  const results = new Map([...raw].map(([k, v]) => [k.ref, { ...v, tags: v.tags.filter((t) => !reserved.includes(t)) }]));
  log.ok(`AI: ${results.size}/${items.length} link elaborati in ${Math.round((Date.now() - t0) / 1000)} s${results.size < items.length ? ` (${items.length - results.size} senza risultato)` : ''}`);
  return results;
}

import path from 'node:path';
import pc from 'picocolors';
import { openSource } from './sources/index.js';
import { classifyUrl, cleanUrl, normalizeUrl, titleFromUrl } from './url.js';
import { parseLinksFile, appendSection, renderSection } from './markdown.js';
import { fetchMetadata } from './metadata.js';
import { assignTags, slugTag } from './tagger/rules.js';
import { createProvider, enrichWithAi, tagsInInstructions } from './tagger/ai/index.js';
import { USER_DIR } from './config.js';
import { closeSavedTabs } from './close.js';
import { PckError } from './errors.js';

/**
 * File di indicazioni per l'AI: percorso esplicito (--instructions / ai.instructionsFile), cercato
 * nella cartella corrente e poi in ~/.pck/. Un percorso indicato esplicitamente ma inesistente è un errore.
 */
async function loadInstructions(name, { explicit = false } = {}) {
  if (!name) return null;
  const candidates = path.isAbsolute(name) ? [name] : [path.resolve(name), path.join(USER_DIR, path.basename(name))];
  for (const file of candidates) {
    const text = await readTextIfExists(file);
    if (text !== null) return { file, text };
  }
  if (explicit) throw new PckError(`File di indicazioni non trovato: ${name}`);
  return null;
}
import { cleanText, decodeEntities, formatHeading, mapLimit, readTextIfExists, truncate, writeAtomic } from './util.js';

const GENERIC_TITLES = new Set(['google image result', 'risultato immagine google', 'cerca con google', 'google search', 'untitled', 'senza titolo', 'home', 'loading…', 'loading...']);

function isGenericTitle(title, host) {
  const t = title.toLowerCase().trim();
  return !t || t === host || t === `www.${host}` || /^https?:\/\//.test(t) || GENERIC_TITLES.has(t);
}

/** Pulizie specifiche per sito: "GitHub - owner/repo: desc · GitHub" → "owner/repo: desc". */
const tidyTitle = (t) => t.replace(/^GitHub - /, '').replace(/ · GitHub$/, '').trim();

function chooseTitle(it) {
  const host = new URL(it.url).hostname.replace(/^www\./, '');
  if (it.search?.q && isGenericTitle(it.tabTitle, host)) return `Ricerca ${it.search.engine}: ${it.search.q}`;
  if (!it.unwrapped && !isGenericTitle(it.tabTitle, host)) return tidyTitle(it.tabTitle);
  const fromMeta = [it.meta?.ogTitle, it.meta?.title].find((t) => t && !isGenericTitle(t, host));
  return tidyTitle(fromMeta || titleFromUrl(it.url));
}

function chooseDescription(it, title, maxLength) {
  if (it.search) return it.search.q ? `Ricerca web su ${it.search.engine}: "${it.search.q}".` : `Ricerca web su ${it.search.engine}.`;
  const d = cleanText(it.meta?.description ?? '');
  // Descrizioni che non aggiungono nulla al titolo (es. "RoughcutMYOG", "FindMyWeb").
  if (!d || title.toLowerCase().includes(d.toLowerCase())) return '';
  return truncate(d, maxLength);
}

/** Pipeline completa di `pck sync` (SPEC §6). La sorgente (telefono o PC) viene sempre rilasciata alla fine. */
export async function runSync(ctx) {
  const state = {};
  try {
    return await pipeline(ctx, state);
  } finally {
    await state.source?.dispose();
  }
}

async function pipeline({ cfg, adb, log, opts }, state) {
  const file = path.resolve(opts.file ?? cfg.defaultFile);
  const normalize = (u) => normalizeUrl(u, cfg.normalize);

  const existing = await readTextIfExists(file);
  const parsed = parseLinksFile(existing ?? '', normalize);
  if (existing !== null) log.ok(`File ${path.basename(file)}: ${parsed.entries.length} voci, ${parsed.tags.size} tag`);
  else if (!opts.urls) log.info(`File ${file} non presente: verrà creato.`);

  let tabs;
  let source;
  if (opts.urls) {
    // `pck describe`: URL passati a mano, nessun telefono.
    tabs = opts.urls.map((url) => ({ id: null, title: '', url }));
  } else {
    source = await openSource(opts.source ?? cfg.defaultSource, { adb, cfg, log, opts });
    state.source = source;
    tabs = await source.withTabs((dt) => dt.listTabs());
    log.ok(`${source.label}: ${tabs.length} schede`);
  }

  const stats = { present: 0, dupSession: 0, skipped: {}, fetchErr: 0 };
  const seen = new Set();
  const items = [];
  for (const tab of tabs) {
    const c = classifyUrl(tab.url, { includeLocal: opts.includeLocal ?? cfg.includeLocal, exclude: cfg.exclude });
    if (c.skip) {
      stats.skipped[c.skip] = (stats.skipped[c.skip] ?? 0) + 1;
      log.debug(`ignorata (${c.skip}): ${tab.url}`);
      continue;
    }
    const key = normalize(c.url);
    // In `describe` si elaborano anche i link già presenti (serve per provare regole e AI).
    if (parsed.keys.has(key) && !opts.urls) { stats.present++; continue; }
    if (seen.has(key)) { stats.dupSession++; log.debug(`doppione: ${tab.url}`); continue; }
    seen.add(key);
    items.push({ tabId: tab.id, tabUrl: tab.url, url: c.url, key, search: c.search, unwrapped: c.unwrapped, tabTitle: cleanText(decodeEntities(tab.title ?? '')) });
  }

  const skippedTot = Object.values(stats.skipped).reduce((a, b) => a + b, 0);
  const skippedDetail = Object.entries(stats.skipped).map(([k, v]) => `${v} ${k}`).join(', ');
  log.info(`  • ${items.length} nuove · ${stats.present} già presenti nel file · ${stats.dupSession} doppie tra le schede · ${skippedTot} ignorate${skippedTot ? ` (${skippedDetail})` : ''}`);

  // `--close`: dopo la scrittura (o in anteprima), chiude le schede il cui URL è nel file.
  const maybeClose = async (keys) => {
    if (!opts.close || !source) return undefined;
    try {
      return await closeSavedTabs({ source, cfg, log, keys, normalize, opts });
    } catch (e) {
      log.error(`File salvato, ma chiusura delle schede non riuscita: ${e.message}`);
      log.info(`  ${source.retryHint}`);
      process.exitCode = e.exitCode ?? 1;
      return undefined;
    }
  };

  if (!items.length) {
    log.ok('Nessun link nuovo: file invariato.');
    const closed = await maybeClose(parsed.keys);
    return { file, items, stats, written: false, closed };
  }

  if (opts.fetch !== false) {
    const toFetch = items.filter((i) => !i.search);
    let done = 0;
    await mapLimit(toFetch, Number(opts.concurrency ?? cfg.fetch.concurrency), async (it) => {
      it.meta = await fetchMetadata(it.url, cfg.fetch);
      if (!it.meta.ok) {
        stats.fetchErr++;
        log.debug(`metadati non disponibili (${it.meta.error}): ${it.url}`);
      }
      if (process.stderr.isTTY) process.stderr.write(`\r  metadati ${++done}/${toFetch.length}`);
    });
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    log.ok(`Metadati scaricati (${toFetch.length - stats.fetchErr}/${toFetch.length}${stats.fetchErr ? `, ${stats.fetchErr} non disponibili → senza descrizione` : ''})`);
  }

  for (const it of items) {
    it.title = chooseTitle(it);
    it.ruleDescription = chooseDescription(it, it.title, cfg.description.maxLength);
  }

  // ── AI (opzionale): descrizione + tag; i link senza risultato usano le regole ──
  let aiResults = new Map();
  if (opts.ai) {
    const name = opts.ai === true ? cfg.ai.defaultProvider : opts.ai;
    const provider = await createProvider(name, cfg.ai, { model: opts.model });
    const pcfg = cfg.ai.providers[name] ?? {};
    const aiItems = items.filter((i) => !i.search);
    // Vocabolario: tag del file + tag previsti dalle regole (come suggerimenti), per coerenza fin dal primo uso.
    const vocabulary = new Map(parsed.tags);
    for (const list of [...Object.values(cfg.tagRules.domains ?? {}), ...Object.values(cfg.tagRules.keywords ?? {})]) {
      for (const t of list) if (!vocabulary.has(t)) vocabulary.set(t, 0);
    }
    // Tag "di servizio": il ripiego e quello delle pagine di ricerca (che l'AI scambierebbe per "ricerca scientifica").
    const reserved = [cfg.tagRules.fallbackTag, cfg.tagRules.searchTag].filter(Boolean).map(slugTag);
    // Indicazioni personali per l'AI (es. "se c'è cosplay aggiungi #cosplay"): file di testo libero.
    const instr = await loadInstructions(opts.instructions ?? cfg.ai.instructionsFile, { explicit: Boolean(opts.instructions) });
    if (instr) {
      log.info(`  Indicazioni AI: ${instr.file}`);
      for (const t of tagsInInstructions(instr.text)) if (!vocabulary.has(t)) vocabulary.set(t, 0);
    }
    reserved.forEach((t) => vocabulary.delete(t));
    log.info(`  AI: ${provider.name} · modello ${provider.model} · ${aiItems.length} link in lotti da ${pcfg.batchSize ?? 10}`);
    const t0 = Date.now();
    aiResults = await enrichWithAi(
      aiItems.map((it) => ({ ref: it, url: it.url, title: it.title, description: it.meta?.description, keywords: it.meta?.keywords, excerpt: it.meta?.excerpt })),
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
    aiResults = new Map([...aiResults].map(([k, v]) => [k.ref, { ...v, tags: v.tags.filter((t) => !reserved.includes(t)) }]));
    log.ok(`AI: ${aiResults.size}/${aiItems.length} link elaborati in ${Math.round((Date.now() - t0) / 1000)} s${aiResults.size < aiItems.length ? ` (${aiItems.length - aiResults.size} con regole)` : ''}`);
  }

  const newTags = new Set();
  const entries = items.map((it) => {
    const { title } = it;
    const ai = aiResults.get(it);
    const description = ai?.description || it.ruleDescription;
    const tags = ai?.tags.length
      ? ai.tags
      : assignTags({ url: it.url, title, description, keywords: it.meta?.keywords, search: it.search }, { rules: cfg.tagRules, vocabulary: parsed.tags });
    tags.filter((t) => !parsed.tags.has(t)).forEach((t) => newTags.add(t));
    const url = cfg.writeCleanUrls ? cleanUrl(it.url, cfg.normalize) : it.url;
    return { title, url, description, tags, tabId: it.tabId };
  });

  const heading = formatHeading(new Date());
  let savedKeys;
  if (opts.dryRun) {
    process.stdout.write(`\n${renderSection(heading, entries)}`);
    log.info(pc.yellow(`\n[dry-run] ${entries.length} voci NON scritte in ${file}`));
    savedKeys = new Set([...parsed.keys, ...items.map((i) => i.key)]);
  } else {
    await writeAtomic(file, appendSection(existing ?? '', heading, entries), { backup: existing !== null });
    log.ok(`Scritte ${entries.length} voci in ${path.basename(file)} (sezione "${heading}")`);
    // Fonte di verità per la chiusura: il file come è stato effettivamente scritto.
    savedKeys = parseLinksFile((await readTextIfExists(file)) ?? '', normalize).keys;
  }
  if (newTags.size) log.info(`  Tag nuovi: ${[...newTags].map((t) => `#${t}`).join(' ')}`);

  const closed = await maybeClose(savedKeys);
  return { file, items, entries, stats, written: !opts.dryRun, closed };
}

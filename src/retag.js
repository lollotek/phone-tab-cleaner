/**
 * `pck retag`: rigenera descrizione e tag di voci già presenti nel file (SPEC §11.1-B).
 * Titolo e URL restano invariati; si riscrivono solo le righe scelte, con backup e anteprima.
 */
import path from 'node:path';
import pc from 'picocolors';
import { entryLines, parseLinksFile, renderEntry, replaceLines } from './markdown.js';
import { classifyUrl, normalizeUrl } from './url.js';
import { assignTags, slugTag } from './tagger/rules.js';
import { describeWithAi, fetchAll, metaDescription } from './describe.js';
import { isLangMismatch } from './lang.js';
import { PckError, EXIT } from './errors.js';
import { readTextIfExists, shortPath, writeAtomic } from './util.js';

/**
 * Sceglie le voci da rigenerare.
 * Ambito (in AND): section, url. Problemi (in OR): tags, empty, langMismatch; oppure all.
 * Le pagine di ricerca sono escluse: la loro descrizione viene dalla query, per scelta.
 */
export function selectForRetag(rows, { tags = [], empty = false, langMismatch = false, all = false, section, url, lang = 'it' }) {
  const wanted = tags.map(slugTag);
  return rows.filter(({ section: sec, entry: e }) => {
    if (section && !(sec ?? '').toLowerCase().startsWith(section.toLowerCase())) return false;
    if (url && !e.url.toLowerCase().includes(url.toLowerCase())) return false;
    if (classifyUrl(e.url).search) return false;
    if (all) return true;
    return (wanted.length && e.tags.some((t) => wanted.includes(t)))
      || (empty && !e.description)
      || (langMismatch && isLangMismatch(e.description, lang));
  });
}

export async function runRetag({ cfg, log, opts }) {
  const file = path.resolve(opts.file ?? cfg.defaultFile);
  const text = await readTextIfExists(file);
  if (text === null) throw new PckError(`File non trovato: ${file}`, EXIT.FILE);
  const normalize = (u) => normalizeUrl(u, cfg.normalize);
  const parsed = parseLinksFile(text, normalize);
  const lang = opts.lang ?? cfg.description.language;

  const filters = { tags: opts.tag ?? [], empty: Boolean(opts.empty), langMismatch: Boolean(opts.langMismatch), all: Boolean(opts.all), section: opts.section, url: opts.url, lang };
  if (!filters.tags.length && !filters.empty && !filters.langMismatch && !filters.all) {
    throw new PckError('Indica quali voci rigenerare: --tag <tag>, --empty, --lang-mismatch oppure --all (eventualmente con --section / --url).');
  }
  const rows = selectForRetag(entryLines(text), filters);
  log.ok(`File ${path.basename(file)}: ${parsed.entries.length} voci, ${rows.length} da rigenerare`);
  if (!rows.length) return { changed: 0, selected: 0 };
  if (opts.limit) rows.splice(Number(opts.limit));

  const items = rows.map((r) => ({ row: r, url: r.entry.url, title: r.entry.title }));
  if (opts.fetch !== false) await fetchAll(items, { cfg, opts, log });

  const useAi = opts.ai !== false;
  const ai = useAi ? await describeWithAi(items, { cfg, opts, log, fileTags: parsed.tags }) : new Map();

  const replacements = new Map();
  const changes = [];
  for (const it of items) {
    const old = it.row.entry;
    let description;
    let tags;
    if (useAi) {
      const r = ai.get(it);
      if (!r) continue; // AI non riuscita: la voce resta com'è
      description = r.description || old.description;
      tags = r.tags.length ? r.tags : old.tags;
    } else {
      description = metaDescription(it.meta, old.title, cfg.description.maxLength) || old.description;
      tags = assignTags({ url: old.url, title: old.title, description, keywords: it.meta?.keywords }, { rules: cfg.tagRules, vocabulary: parsed.tags });
    }
    const line = renderEntry({ title: old.title, url: old.url, description, tags });
    if (line === it.row.line) continue;
    replacements.set(it.row.index, line);
    changes.push({ before: it.row.line, after: line, old, tags, description });
  }

  const show = opts.dryRun || log.verbose;
  for (const c of changes) {
    if (show) {
      process.stdout.write(`${pc.red(`- ${c.before}`)}\n${pc.green(`+ ${c.after}`)}\n\n`);
    }
  }
  if (!changes.length) {
    log.ok('Nessuna voce cambiata.');
    return { changed: 0, selected: rows.length };
  }
  if (opts.dryRun) {
    log.info(pc.yellow(`[dry-run] ${changes.length}/${rows.length} voci cambierebbero; file non modificato`));
    return { changed: 0, selected: rows.length, wouldChange: changes.length };
  }
  const saved = await writeAtomic(file, replaceLines(text, replacements), { backup: cfg.backup });
  log.ok(`Aggiornate ${changes.length}/${rows.length} voci in ${path.basename(file)}`);
  if (saved) log.info(`  Backup: ${shortPath(saved)}`);
  return { changed: changes.length, selected: rows.length };
}

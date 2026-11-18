/**
 * Operazioni sulle voci di links.md identificate per URL normalizzato (SPEC §11.2), usate da `pck ui`.
 * - funzioni pure sul testo (testabili): deleteFromText, updateInText, editTagsInText, appendLinesSection
 * - mutate(): lettura → controllo versione → modifica → scrittura atomica con backup
 * Il cestino è un file accanto a links.md (links-eliminati.md) con lo stesso formato.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { entryLines, FILE_HEADER, parseLinksFile, renderEntry, replaceLines, replaceTrailingTags } from './markdown.js';
import { slugTag } from './tagger/rules.js';
import { PckError, EXIT } from './errors.js';
import { formatHeading, readTextIfExists, writeAtomic } from './util.js';

export const EXIT_CONFLICT = 9;

/** Versione del contenuto: cambia a ogni modifica del file, da chiunque sia fatta. */
export const fileVersion = (text) => crypto.createHash('sha1').update(text ?? '').digest('hex').slice(0, 16);

/** links.md → links-eliminati.md (stessa cartella). */
export function trashPath(file) {
  const ext = path.extname(file) || '.md';
  return path.join(path.dirname(file), `${path.basename(file, ext)}-eliminati${ext}`);
}

/** Voci del testo con la chiave normalizzata. */
export function keyedRows(text, normalize) {
  return entryLines(text).map((r) => ({ ...r, key: normalize(r.entry.url) }));
}

function pick(text, keys, normalize) {
  const wanted = new Set(keys);
  return keyedRows(text, normalize).filter((r) => wanted.has(r.key));
}

/** Toglie righe (per indice) e, se una sezione resta vuota, anche la sua intestazione. */
function dropLines(text, indexes) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const drop = new Set(indexes);
  const lines = text.split(/\r?\n/).filter((_, i) => !drop.has(i));
  // Sezioni rimaste senza contenuto: intestazione seguita solo da righe vuote fino alla prossima sezione o alla fine.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || /^##?\s/.test(lines[j])) {
        i = j - 1; // salta intestazione e righe vuote
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`);
}

/** Aggiunge righe già formattate in una nuova sezione in fondo al testo (per cestino e ripristino). */
export function appendLinesSection(text, heading, lines) {
  let base = text && text.trim() ? text : FILE_HEADER;
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  base = base.replace(/\s*$/, eol);
  return `${base}${eol}## ${heading}${eol}${eol}${lines.join(eol)}${eol}`;
}

/** Elimina le voci indicate. @returns {{text, removed: {line, entry, key, section}[]}} */
export function deleteFromText(text, keys, normalize) {
  const rows = pick(text, keys, normalize);
  return { text: rows.length ? dropLines(text, rows.map((r) => r.index)) : text, removed: rows };
}

/** Modifica tag e/o descrizione di una voce, lasciando invariati titolo e URL. */
export function updateInText(text, key, { tags, description }, normalize) {
  const [row] = pick(text, [key], normalize);
  if (!row) throw new PckError('Voce non trovata: forse è stata modificata o eliminata altrove. Ricarica.', EXIT_CONFLICT);
  const nextTags = tags ? [...new Set(tags.map(slugTag).filter(Boolean))] : row.entry.tags;
  const line = description === undefined
    ? replaceTrailingTags(row.line, nextTags)
    : renderEntry({ title: row.entry.title, url: row.entry.url, description, tags: nextTags });
  return replaceLines(text, new Map([[row.index, line]]));
}

/** Aggiunge e/o toglie tag su più voci. @returns {{text, changed:number}} */
export function editTagsInText(text, keys, { add = [], remove = [] }, normalize) {
  const plus = add.map(slugTag).filter(Boolean);
  const minus = new Set(remove.map(slugTag).filter(Boolean));
  const replacements = new Map();
  for (const row of pick(text, keys, normalize)) {
    const next = [...new Set([...row.entry.tags.filter((t) => !minus.has(t)), ...plus])];
    const line = replaceTrailingTags(row.line, next);
    if (line !== row.line) replacements.set(row.index, line);
  }
  return { text: replacements.size ? replaceLines(text, replacements) : text, changed: replacements.size };
}

/**
 * Legge il file, verifica che la versione sia quella vista dal chiamante, applica `fn(text)` e scrive.
 * @param {string|undefined} expected versione attesa (undefined = nessun controllo)
 * @returns {Promise<{version:string, result:any}>}
 */
export async function mutate(file, expected, fn, { backup } = {}) {
  const text = (await readTextIfExists(file)) ?? '';
  if (expected && fileVersion(text) !== expected) {
    throw new PckError(`${path.basename(file)} è stato modificato nel frattempo: ricarica la pagina.`, EXIT_CONFLICT);
  }
  const { text: next, result } = await fn(text);
  if (next !== text) await writeAtomic(file, next, { backup });
  return { version: fileVersion(next), result };
}

/** Sposta le voci nel cestino: prima scrive il cestino, poi le toglie dal file (al peggio restano in entrambi). */
export async function moveToTrash(file, version, keys, { normalize, backup }) {
  const text = (await readTextIfExists(file)) ?? '';
  if (version && fileVersion(text) !== version) throw new PckError(`${path.basename(file)} è stato modificato nel frattempo: ricarica la pagina.`, EXIT_CONFLICT);
  const { removed } = deleteFromText(text, keys, normalize);
  if (!removed.length) return { version: fileVersion(text), removed: 0 };
  const trash = trashPath(file);
  const trashText = (await readTextIfExists(trash)) ?? '# Link eliminati\n';
  await writeAtomic(trash, appendLinesSection(trashText, `Eliminati ${formatHeading(new Date())}`, removed.map((r) => r.line)), { backup });
  const res = await mutate(file, version, (t) => ({ text: deleteFromText(t, keys, normalize).text }), { backup });
  return { version: res.version, removed: removed.length };
}

/** Riporta voci dal cestino nel file (in una sezione "Ripristinati …"); salta quelle già presenti. */
export async function restoreFromTrash(file, version, keys, { normalize, backup }) {
  const trash = trashPath(file);
  const trashText = (await readTextIfExists(trash)) ?? '';
  const rows = pick(trashText, keys, normalize);
  if (!rows.length) return { version: fileVersion((await readTextIfExists(file)) ?? ''), restored: 0 };
  const res = await mutate(file, version, (text) => {
    const present = parseLinksFile(text, normalize).keys;
    const lines = [];
    const seen = new Set();
    for (const r of rows) if (!present.has(r.key) && !seen.has(r.key)) { seen.add(r.key); lines.push(r.line); }
    return { text: lines.length ? appendLinesSection(text, `Ripristinati ${formatHeading(new Date())}`, lines) : text, result: lines.length };
  }, { backup });
  await writeAtomic(trash, deleteFromText(trashText, keys, normalize).text, { backup });
  return { version: res.version, restored: res.result };
}

/**
 * Annulla l'ultima modifica: rimette il backup più recente al posto del file.
 * Lo stato attuale viene a sua volta salvato come backup, quindi un secondo "annulla" ripete la modifica.
 */
export async function undoLast(file, { backup }) {
  const { listBackups } = await import('./backup.js');
  const list = await listBackups(file, backup);
  const last = list.at(-1);
  if (!last) throw new PckError('Nessun backup da ripristinare.');
  const previous = await readTextIfExists(last);
  await writeAtomic(file, previous, { backup });
  return { version: fileVersion(previous), restoredFrom: last };
}

/**
 * Elimina definitivamente voci dal cestino (resta solo il backup in .pck-backup).
 * Da quel momento sync le tratta come link mai visti: se la scheda è ancora aperta, verrebbe salvata di nuovo.
 */
export async function purgeFromTrash(file, keys, { normalize, backup }) {
  const trash = trashPath(file);
  const trashText = await readTextIfExists(trash);
  if (trashText === null) return { purged: 0 };
  const { text, removed } = deleteFromText(trashText, keys, normalize);
  if (removed.length) await writeAtomic(trash, text, { backup });
  return { purged: removed.length };
}

/** Voci del cestino non più presenti nel file principale (quelle ripristinate o re-importate non si mostrano). */
export async function readTrash(file, normalize) {
  const text = (await readTextIfExists(file)) ?? '';
  const present = parseLinksFile(text, normalize).keys;
  const trashText = (await readTextIfExists(trashPath(file))) ?? '';
  return keyedRows(trashText, normalize).filter((r) => !present.has(r.key));
}

/** Chiavi del cestino, per sync e --close (una voce eliminata non va risalvata). */
export async function trashKeys(file, normalize) {
  const t = await readTextIfExists(trashPath(file));
  return t ? parseLinksFile(t, normalize).keys : new Set();
}

export { EXIT };

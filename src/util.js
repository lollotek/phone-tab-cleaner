import fs from 'node:fs/promises';
import path from 'node:path';
import { PckError, EXIT } from './errors.js';
import { backupFile } from './backup.js';

/** Percorso breve per i messaggi: relativo alla cartella corrente se ci sta dentro. */
export const shortPath = (p) => {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Esegue `fn` su `items` con al massimo `limit` operazioni in parallelo, mantenendo l'ordine. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€' };

export function decodeEntities(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Spazi/a-capo compressi in un singolo spazio. */
export const cleanText = (s = '') => s.replace(/\s+/g, ' ').trim();

/** Tronca su confine di parola aggiungendo "…". */
export function truncate(s, max) {
  if (!s || s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

export async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new PckError(`Impossibile leggere ${file}: ${e.message}`, EXIT.FILE);
  }
}

/**
 * Scrittura atomica: backup a rotazione dell'originale (se `backup` è un oggetto {dir, keep}), file temporaneo, rename.
 * @returns {Promise<string|null>} percorso del backup creato
 */
export async function writeAtomic(file, text, { backup } = {}) {
  try {
    const saved = backup ? await backupFile(file, backup) : null;
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, file);
    return saved;
  } catch (e) {
    throw new PckError(`Impossibile scrivere ${file}: ${e.message}`, EXIT.FILE);
  }
}

export function formatHeading(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

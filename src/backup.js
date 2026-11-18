/**
 * Backup a rotazione del file dei link (SPEC §11.1-A).
 * Prima di ogni scrittura: copia in <cartella del file>/.pck-backup/<nome>-AAAAMMGG-HHMMSS[-n].md,
 * poi si tengono solo gli ultimi `keep` backup di quel file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Nome dei backup di un file: "links.md" → "links-…md". */
function parts(file) {
  const ext = path.extname(file);
  return { base: path.basename(file, ext), ext: ext || '.md' };
}

/** Backup esistenti di `file`, dal più vecchio al più recente. */
export async function listBackups(file, { dir = '.pck-backup' } = {}) {
  const folder = path.resolve(path.dirname(file), dir);
  const { base, ext } = parts(file);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}(?:-\\d+)?${ext.replace('.', '\\.')}$`);
  let names;
  try {
    names = await fs.readdir(folder);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  // L'ordine alfabetico coincide con quello cronologico (data nel nome, suffisso -n per lo stesso secondo).
  return names
    .filter((n) => re.test(n))
    .sort((a, b) => a.replace(/(-\d{6})(?=\.)/, '$1-0').localeCompare(b.replace(/(-\d{6})(?=\.)/, '$1-0'), 'en', { numeric: true }))
    .map((n) => path.join(folder, n));
}

/**
 * Crea il backup di `file` (se esiste) e rimuove quelli in eccesso.
 * @returns {Promise<string|null>} percorso del backup creato, null se il file non esisteva
 */
export async function backupFile(file, { dir = '.pck-backup', keep = 10, now = new Date() } = {}) {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const folder = path.resolve(path.dirname(file), dir);
  await fs.mkdir(folder, { recursive: true });
  const { base, ext } = parts(file);
  let target = path.join(folder, `${base}-${stamp(now)}${ext}`);
  for (let n = 2; await exists(target); n++) target = path.join(folder, `${base}-${stamp(now)}-${n}${ext}`);
  await fs.copyFile(file, target);

  const all = await listBackups(file, { dir });
  const excess = all.length - Math.max(1, keep);
  for (const old of all.slice(0, Math.max(0, excess))) await fs.rm(old, { force: true });
  return target;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

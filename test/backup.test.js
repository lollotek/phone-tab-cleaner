import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupFile, listBackups, stamp } from '../src/backup.js';
import { writeAtomic } from '../src/util.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pck-backup-'));
}

test('stamp', () => {
  assert.equal(stamp(new Date(2026, 10, 18, 9, 5, 7)), '20261118-090507');
});

test('backup: file inesistente → nessun backup', async () => {
  const dir = await tmpDir();
  assert.equal(await backupFile(path.join(dir, 'links.md')), null);
});

test('backup a rotazione: conserva gli ultimi N, contenuti corretti, stesso secondo', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'links.md');
  const now = new Date(2026, 10, 18, 10, 0, 0);
  for (let v = 1; v <= 5; v++) {
    await fs.writeFile(file, `versione ${v}`);
    // v1-v3 nello stesso secondo (suffisso -2, -3), poi secondi diversi
    await backupFile(file, { keep: 3, now: v <= 3 ? now : new Date(2026, 10, 18, 10, 0, v) });
  }
  const list = await listBackups(file);
  assert.equal(list.length, 3);
  const contents = await Promise.all(list.map((p) => fs.readFile(p, 'utf8')));
  assert.deepEqual(contents, ['versione 3', 'versione 4', 'versione 5'], 'restano i più recenti, in ordine');
  assert.match(path.basename(list[0]), /^links-20261118-100000-3\.md$/);
  assert.ok(list.every((p) => path.dirname(p) === path.join(dir, '.pck-backup')));
});

test('i backup di file diversi non si mescolano', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'links.md'), 'a');
  await fs.writeFile(path.join(dir, 'links-pc.md'), 'b');
  await backupFile(path.join(dir, 'links.md'), { keep: 1 });
  await backupFile(path.join(dir, 'links-pc.md'), { keep: 1 });
  assert.equal((await listBackups(path.join(dir, 'links.md'))).length, 1);
  assert.equal((await listBackups(path.join(dir, 'links-pc.md'))).length, 1);
});

test('writeAtomic con backup: originale salvato, nuovo contenuto scritto', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'links.md');
  await fs.writeFile(file, 'vecchio');
  const saved = await writeAtomic(file, 'nuovo', { backup: { dir: '.pck-backup', keep: 10 } });
  assert.equal(await fs.readFile(file, 'utf8'), 'nuovo');
  assert.equal(await fs.readFile(saved, 'utf8'), 'vecchio');
  assert.equal(await writeAtomic(path.join(dir, 'altro.md'), 'x', { backup: { keep: 10 } }), null, 'file nuovo: niente backup');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendLinesSection, deleteFromText, editTagsInText, fileVersion, moveToTrash, mutate, readTrash,
  restoreFromTrash, trashKeys, trashPath, undoLast, updateInText,
} from '../src/store.js';
import { classifyUrl, normalizeUrl } from '../src/url.js';
import { DEFAULTS } from '../src/config.js';

const normalize = (u) => normalizeUrl(u, DEFAULTS.normalize);
const K = (u) => normalize(u);
const backup = { dir: '.pck-backup', keep: 10 };

const FILE = [
  '# Link salvati',
  '',
  '## 2026-11-14',
  '',
  '- [A](https://a.com/) — Uno. #dev #ai',
  '- [B](https://b.com/) — Due. #casa',
  '',
  '## 2026-11-17',
  '',
  '- [C](https://c.com/) — Tre. #cucina',
  '',
].join('\n');

test('deleteFromText: toglie le righe e le sezioni rimaste vuote', () => {
  const { text, removed } = deleteFromText(FILE, [K('https://c.com/')], normalize);
  assert.equal(removed.length, 1);
  assert.ok(!text.includes('## 2026-11-17'), 'sezione vuota rimossa');
  assert.ok(text.includes('- [B](https://b.com/) — Due. #casa'));
  const one = deleteFromText(FILE, [K('https://www.a.com')], normalize).text;
  assert.ok(one.includes('## 2026-11-14') && !one.includes('[A]'), 'chiave normalizzata, sezione non vuota resta');
});

test('updateInText: tag, descrizione, voce inesistente', () => {
  const t1 = updateInText(FILE, K('https://a.com/'), { tags: ['Machine Learning', 'dev'] }, normalize);
  assert.match(t1, /- \[A\]\(https:\/\/a\.com\/\) — Uno\. #machine-learning #dev/);
  const t2 = updateInText(FILE, K('https://b.com/'), { description: 'Nuova #descrizione' }, normalize);
  assert.match(t2, /- \[B\]\(https:\/\/b\.com\/\) — Nuova descrizione #casa/);
  assert.throws(() => updateInText(FILE, K('https://zzz.com/'), { tags: [] }, normalize), /non trovata/);
});

test('editTagsInText: aggiunta e rimozione in blocco', () => {
  const { text, changed } = editTagsInText(FILE, [K('https://a.com/'), K('https://b.com/')], { add: ['Maker'], remove: ['ai'] }, normalize);
  assert.equal(changed, 2);
  assert.match(text, /Uno\. #dev #maker$/m);
  assert.match(text, /Due\. #casa #maker$/m);
});

test('appendLinesSection mantiene gli a capo', () => {
  const out = appendLinesSection('# T\r\n\r\nx\r\n', 'S', ['- [a](https://a.com)']);
  assert.equal(out, '# T\r\n\r\nx\r\n\r\n## S\r\n\r\n- [a](https://a.com)\r\n');
});

test('cestino: sposta, legge, ripristina; versione e conflitti', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pck-store-'));
  const file = path.join(dir, 'links.md');
  await fs.writeFile(file, FILE);
  const v0 = fileVersion(FILE);

  await assert.rejects(moveToTrash(file, 'versione-vecchia', [K('https://a.com/')], { normalize, backup }), /modificato nel frattempo/);

  const del = await moveToTrash(file, v0, [K('https://a.com/'), K('https://c.com/')], { normalize, backup });
  assert.equal(del.removed, 2);
  assert.equal(path.basename(trashPath(file)), 'links-eliminati.md');
  assert.deepEqual([...await trashKeys(file, normalize)].sort(), [K('https://a.com/'), K('https://c.com/')].sort());
  assert.equal((await readTrash(file, normalize)).length, 2);

  const res = await restoreFromTrash(file, del.version, [K('https://a.com/')], { normalize, backup });
  assert.equal(res.restored, 1);
  const now = await fs.readFile(file, 'utf8');
  assert.match(now, /## Ripristinati .*\n\n- \[A\]\(https:\/\/a\.com\/\) — Uno\. #dev #ai/);
  assert.deepEqual((await readTrash(file, normalize)).map((r) => r.entry.url), ['https://c.com/']);
  assert.equal(res.version, fileVersion(now));

  // annulla: torna allo stato prima del ripristino
  await undoLast(file, { backup });
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('[A]'));
});

test('mutate: nessuna scrittura se il testo non cambia', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pck-store-'));
  const file = path.join(dir, 'links.md');
  await fs.writeFile(file, FILE);
  const r = await mutate(file, fileVersion(FILE), (t) => ({ text: t, result: 0 }), { backup });
  assert.equal(r.version, fileVersion(FILE));
  await assert.rejects(fs.readdir(path.join(dir, '.pck-backup')), /ENOENT/);
});

test('esclusione host:porta (pagina di pck ui)', () => {
  const ex = DEFAULTS.exclude;
  assert.deepEqual(classifyUrl('http://127.0.0.1:4317/#token=x', { includeLocal: true, exclude: ex }), { skip: 'escluso' });
  assert.deepEqual(classifyUrl('http://localhost:4317/', { includeLocal: true, exclude: ex }), { skip: 'escluso' });
  assert.equal(classifyUrl('http://127.0.0.1:5173/', { includeLocal: true, exclude: ex }).skip, undefined, 'altre porte locali restano incluse con --include-local');
  assert.deepEqual(classifyUrl('http://127.0.0.1:5000/', { includeLocal: true, exclude: ['127.0.0.1:5000'] }), { skip: 'escluso' });
});

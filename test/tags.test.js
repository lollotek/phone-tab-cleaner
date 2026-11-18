import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTagMapping, buildConfigPatch, computeTagStats } from '../src/tags.js';
import { entryLines } from '../src/markdown.js';

const FILE = [
  '# Link salvati',
  '',
  '## 2026-11-14',
  '',
  '- [A](https://a.com/) — Uno. #dev #ai',
  '- [B](https://b.com/#sezione) — Due. #informazioni #casa',
  '- [C](https://c.com/) — Tre. #informazioni',
  '* [D](https://d.com/) — scritta a mano #paper',
  '- [E](https://e.com/) — Senza tag',
  'Testo libero con #informazioni che non è una voce.',
].join('\n');

test('computeTagStats', () => {
  const s = computeTagStats(entryLines(FILE));
  assert.equal(s.entries, 5);
  assert.equal(s.untagged, 1);
  assert.deepEqual(s.tags[0], { tag: 'informazioni', count: 2 });
  assert.deepEqual(s.singletons, ['ai', 'casa', 'dev', 'paper']);
  assert.deepEqual(s.pairs.map((p) => p.pair), ['ai+dev', 'casa+informazioni']);
});

test('rename: solo i tag finali delle voci, testo libero e frammenti intatti', () => {
  const { text, changes } = applyTagMapping(FILE, new Map([['informazioni', 'info']]));
  assert.equal(changes.length, 2);
  assert.match(text, /- \[B\]\(https:\/\/b\.com\/#sezione\) — Due\. #info #casa/);
  assert.match(text, /Testo libero con #informazioni che non è una voce\./);
  assert.equal(text.split('\n').length, FILE.split('\n').length);
});

test('merge in un tag già presente sulla stessa voce: niente doppioni', () => {
  const { text } = applyTagMapping(FILE, new Map([['ai', 'dev']]));
  assert.match(text, /— Uno\. #dev$/m);
});

test('remove: la voce può restare senza tag (contata)', () => {
  const { text, changes, untaggedAfter } = applyTagMapping(FILE, new Map([['informazioni', null]]));
  assert.equal(changes.length, 2);
  assert.equal(untaggedAfter, 1);
  assert.match(text, /^- \[C\]\(https:\/\/c\.com\/\) — Tre\.$/m);
  assert.match(text, /^\* \[D\]\(https:\/\/d\.com\/\) — scritta a mano #paper$/m, 'riga a mano non toccata');
});

test('buildConfigPatch: alias, alias esistenti riportati, tag riservati', () => {
  const rules = { aliases: { paper: 'papercraft', 'paper-craft': 'papercraft' }, fallbackTag: 'da-smistare', searchTag: 'ricerca' };
  assert.deepEqual(buildConfigPatch(new Map([['papercraft', 'carta']]), rules), {
    tagRules: { aliases: { papercraft: 'carta', paper: 'carta', 'paper-craft': 'carta' } },
  });
  assert.deepEqual(buildConfigPatch(new Map([['ricerca', 'cerca']]), rules), {
    tagRules: { searchTag: 'cerca', aliases: { ricerca: 'cerca' } },
  });
  assert.equal(buildConfigPatch(new Map([['x', null]]), rules), null, 'la rimozione non crea alias');
});

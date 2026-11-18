import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinksFile, renderEntry, appendSection, FILE_HEADER } from '../src/markdown.js';
import { normalizeUrl } from '../src/url.js';
import { DEFAULTS } from '../src/config.js';

const norm = (u) => normalizeUrl(u, DEFAULTS.normalize);

const SAMPLE = `# Link salvati

Note scritte a mano: vedi anche https://example.org/manuale.

## 2026-11-02 09:10

- [Node.js — Docs](https://nodejs.org/docs/latest/api/) — Documentazione delle API. #dev #nodejs
- [Carbonara](https://example.com/carbonara?utm_source=x) — Ricetta tradizionale. #cucina
* [Senza tag](https://a.com/b)
- [Solo tag](https://c.com) #dev
`;

test('parse: voci, tag e chiavi', () => {
  const p = parseLinksFile(SAMPLE, norm);
  assert.equal(p.entries.length, 4);
  assert.deepEqual(p.entries[0], { title: 'Node.js — Docs', url: 'https://nodejs.org/docs/latest/api/', description: 'Documentazione delle API.', tags: ['dev', 'nodejs'] });
  assert.equal(p.entries[2].description, '');
  assert.deepEqual(p.entries[3].tags, ['dev']);
  assert.equal(p.tags.get('dev'), 2);
  assert.equal(p.tags.get('cucina'), 1);
  assert.ok(p.keys.has(norm('https://example.com/carbonara')));
  assert.ok(p.keys.has(norm('https://example.org/manuale')), 'URL nel testo libero');
});

test('render → parse è stabile', () => {
  const e = { title: 'Titolo [strano]', url: 'https://w.org/wiki/Foo_(bar)', description: 'Testo con #hashtag finto\nsu due righe', tags: ['dev', 'stampa-3d'] };
  const line = renderEntry(e);
  assert.equal(line, '- [Titolo strano](https://w.org/wiki/Foo_%28bar%29) — Testo con hashtag finto su due righe #dev #stampa-3d');
  const p = parseLinksFile(line, norm);
  assert.deepEqual(p.entries[0].tags, ['dev', 'stampa-3d']);
  assert.ok(p.keys.has(norm(e.url)));
});

test('appendSection su file vuoto e su file esistente', () => {
  const entries = [{ title: 'A', url: 'https://a.com', description: '', tags: [] }];
  assert.equal(appendSection('', '2026-11-14 18:00', entries), `${FILE_HEADER}\n## 2026-11-14 18:00\n\n- [A](https://a.com)\n`);
  const out = appendSection(SAMPLE, 'X', entries);
  assert.ok(out.startsWith(SAMPLE.trimEnd()));
  assert.ok(out.endsWith('\n## X\n\n- [A](https://a.com)\n'));
});

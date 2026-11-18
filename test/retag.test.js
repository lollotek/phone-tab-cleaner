import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, isLangMismatch } from '../src/lang.js';
import { entryLines, replaceLines, replaceTrailingTags } from '../src/markdown.js';
import { selectForRetag } from '../src/retag.js';

const FILE = [
  '# Link salvati',
  '',
  'Nota a mano: https://example.org/manuale',
  '',
  '## 2026-11-14 13:01',
  '',
  '- [Puck](https://github.com/puckeditor/puck) — The visual editor for React, with drag and drop for your app. #dev',
  '- [Plinky](https://plinky12.com/) #da-smistare',
  '- [Ricerca DuckDuckGo: ikea kallax](https://duckduckgo.com/?q=ikea+kallax) — Ricerca web su DuckDuckGo: "ikea kallax". #ricerca',
  '',
  '## 2026-11-17 15:21',
  '',
  '- [Fast](https://fast.com/) — Strumento per misurare la velocità della connessione internet. #internet',
  '* [Scritta a mano](https://a.com/x) — senza tag',
].join('\r\n');

test('detectLang / isLangMismatch', () => {
  assert.equal(detectLang('The visual editor for React, with drag and drop for your app.'), 'en');
  assert.equal(detectLang('Strumento per misurare la velocità della connessione internet.'), 'it');
  assert.equal(detectLang('FindMyWeb'), null, 'troppo corta');
  assert.ok(isLangMismatch('The visual editor for React, with drag and drop for your app.', 'it'));
  assert.ok(!isLangMismatch('', 'it'));
});

test('entryLines: indici, sezioni e campi', () => {
  const rows = entryLines(FILE);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.section), ['2026-11-14 13:01', '2026-11-14 13:01', '2026-11-14 13:01', '2026-11-17 15:21', '2026-11-17 15:21']);
  assert.equal(rows[0].index, 6);
  assert.deepEqual(rows[1].entry, { title: 'Plinky', url: 'https://plinky12.com/', description: '', tags: ['da-smistare'] });
});

test('selectForRetag: problemi in OR, ambito in AND, ricerche escluse', () => {
  const rows = entryLines(FILE);
  const urls = (f) => selectForRetag(rows, f).map((r) => r.entry.url);
  assert.deepEqual(urls({ tags: ['da-smistare'] }), ['https://plinky12.com/']);
  assert.deepEqual(urls({ empty: true }), ['https://plinky12.com/']);
  assert.deepEqual(urls({ langMismatch: true }), ['https://github.com/puckeditor/puck']);
  assert.deepEqual(urls({ tags: ['da-smistare'], langMismatch: true }), ['https://github.com/puckeditor/puck', 'https://plinky12.com/']);
  assert.deepEqual(urls({ all: true, section: '2026-11-17' }), ['https://fast.com/', 'https://a.com/x']);
  assert.deepEqual(urls({ all: true, url: 'github' }), ['https://github.com/puckeditor/puck']);
  assert.ok(!urls({ all: true }).some((u) => u.includes('duckduckgo')), 'le ricerche non si rigenerano');
});

test('replaceLines mantiene CRLF e tocca solo le righe indicate', () => {
  const out = replaceLines(FILE, new Map([[7, '- [Plinky](https://plinky12.com/) — Sintetizzatore. #musica']]));
  const a = FILE.split('\r\n');
  const b = out.split('\r\n');
  assert.equal(b.length, a.length);
  assert.deepEqual(b.filter((l, i) => l !== a[i]), ['- [Plinky](https://plinky12.com/) — Sintetizzatore. #musica']);
});

test('replaceTrailingTags: cambia solo i tag, anche su righe scritte a mano', () => {
  assert.equal(replaceTrailingTags('- [Fast](https://fast.com/) — Velocità. #internet', ['rete', 'strumenti']), '- [Fast](https://fast.com/) — Velocità. #rete #strumenti');
  assert.equal(replaceTrailingTags('* [Scritta a mano](https://a.com/x) — senza tag', ['dev']), '* [Scritta a mano](https://a.com/x) — senza tag #dev');
  assert.equal(replaceTrailingTags('- [A](https://a.com/#frag) — x #dev', []), '- [A](https://a.com/#frag) — x', 'il frammento dell\'URL non è un tag');
  assert.equal(replaceTrailingTags('testo qualsiasi #x', ['y']), 'testo qualsiasi #x', 'righe non-voce invariate');
});

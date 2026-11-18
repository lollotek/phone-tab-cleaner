import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkLink, checkText } from '../src/check.js';
import { normalizeUrl } from '../src/url.js';
import { DEFAULTS } from '../src/config.js';

const normalize = (u) => normalizeUrl(u, DEFAULTS.normalize);

const FILE = [
  '# Link salvati',                                                          // 1
  '',                                                                        // 2
  'Testo libero con https://example.org/nota e un #hashtag qualsiasi.',      // 3
  '## 2026-11-14',                                                           // 4
  '- [A](https://a.com/x?utm_source=ig) — Uno. #dev',                       // 5
  '- [B](https://www.a.com/x/) — Doppione di A. #dev',                      // 6
  '- [C](https://c.com/) #Stampa_3D',                                        // 7
  '- [D](https://d.com/) — Senza tag',                                       // 8
  '- [E](ftp://e.com/file) — Schema non http. #dev',                         // 9
  '- [F senza chiusura](https://f.com/ — rotta #dev',                        // 10
  '- Link scritto male: https://g.com',                                      // 11
  '- semplice elenco puntato senza link',                                    // 12
  '- [H](https://h.com/#sezione) — Frammento, non tag. #dev',               // 13
].join('\n');

test('checkText: tutti i tipi di problema, con numero di riga', () => {
  const issues = checkText(FILE, { normalize });
  const by = (kind) => issues.filter((i) => i.kind === kind).map((i) => i.line);
  assert.deepEqual(by('riga-malformata'), [10, 11]);
  assert.deepEqual(by('url-doppio'), [6]);
  assert.match(issues.find((i) => i.kind === 'url-doppio').message, /riga 5/);
  assert.deepEqual(by('url-non-valido'), [9]);
  assert.deepEqual(by('senza-tag'), [8]);
  assert.deepEqual(by('senza-descrizione'), [7]);
  assert.deepEqual(by('tag-non-valido'), [7]);
  assert.match(issues.find((i) => i.kind === 'tag-non-valido').message, /#Stampa_3D \(suggerito: #stampa-3d\)/);
  assert.ok(!issues.some((i) => [3, 12, 13].includes(i.line)), 'testo libero, elenchi semplici e frammenti non sono problemi');
  assert.deepEqual([...new Set(issues.filter((i) => i.severity === 'errore').map((i) => i.kind))].sort(), ['riga-malformata', 'url-doppio', 'url-non-valido']);
});

test('checkText: file pulito → nessun problema', () => {
  assert.deepEqual(checkText('# Link\n\n## X\n\n- [A](https://a.com/) — Uno. #dev\n', { normalize }), []);
});

test('checkLink: ok, morto, non verificabile, dominio inesistente', async () => {
  const server = http.createServer((req, res) => {
    const code = { '/ok': 200, '/gone': 410, '/missing': 404, '/blocked': 403, '/error': 500 }[req.url] ?? 200;
    res.writeHead(code).end('x');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await checkLink(`${base}/ok`)).status, 'ok');
    assert.equal((await checkLink(`${base}/gone`)).status, 'morto');
    assert.equal((await checkLink(`${base}/missing`)).status, 'morto');
    assert.equal((await checkLink(`${base}/blocked`)).status, 'non-verificabile');
    assert.equal((await checkLink(`${base}/error`)).status, 'non-verificabile');
  } finally {
    server.close();
  }
  const dns = await checkLink('https://dominio-inesistente-pck-test.invalid/');
  assert.deepEqual(dns, { status: 'morto', detail: 'dominio non trovato (DNS)' });
});

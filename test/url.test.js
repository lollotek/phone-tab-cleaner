import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, cleanUrl, normalizeUrl, isPrivateHost, titleFromUrl } from '../src/url.js';
import { DEFAULTS } from '../src/config.js';

const n = (u) => normalizeUrl(u, DEFAULTS.normalize);

test('rimuove parametri di tracciamento', () => {
  assert.equal(
    n('https://needle.tools/?utm_source=ig&utm_medium=social&fbclid=ABC&gad_source=1'),
    'https://needle.tools',
  );
  assert.equal(n('https://a.com/p?id=3&utm_x=1&gclid=z'), 'https://a.com/p?id=3');
});

test('frammento, www, slash finale, ordine parametri', () => {
  assert.equal(n('https://fibra.iliad.it/subscribe-fibra/#modal-call-me-back'), n('https://fibra.iliad.it/subscribe-fibra/'));
  assert.equal(n('https://www.hi3d.ai/'), n('https://hi3d.ai'));
  assert.equal(n('https://a.com/x?b=2&a=1'), n('https://a.com/x?a=1&b=2'));
  assert.equal(n('HTTPS://A.COM/Path'), 'https://a.com/Path');
});

test('mantiene le route hash (#/ e #!)', () => {
  assert.equal(n('https://app.com/#/inbox'), 'https://app.com#/inbox');
  assert.notEqual(n('https://app.com/#/a'), n('https://app.com/#/b'));
});

test('parentesi codificate e no', () => {
  assert.equal(n('https://en.wikipedia.org/wiki/Foo_(bar)'), n('https://en.wikipedia.org/wiki/Foo_%28bar%29'));
});

test('classifica: schemi non http e host locali', () => {
  assert.deepEqual(classifyUrl('chrome://newtab/'), { skip: 'schema' });
  assert.deepEqual(classifyUrl('about:blank'), { skip: 'schema' });
  assert.deepEqual(classifyUrl('http://192.168.1.9:5173/'), { skip: 'locale' });
  assert.equal(classifyUrl('http://192.168.1.9:5173/', { includeLocal: true }).url, 'http://192.168.1.9:5173/');
  assert.equal(classifyUrl('https://steam-racers.example.workers.dev/').skip, undefined);
});

test('siti esclusi: host, sottodomini e prefisso di percorso', () => {
  const exclude = ['web.whatsapp.com', 'google.com/maps', 'gemini.google.com/app'];
  assert.deepEqual(classifyUrl('https://web.whatsapp.com/', { exclude }), { skip: 'escluso' });
  assert.deepEqual(classifyUrl('https://gemini.google.com/app/e27db57?hl=it', { exclude }), { skip: 'escluso' });
  assert.deepEqual(classifyUrl('https://www.google.com/maps/place/x', { exclude }), { skip: 'escluso' });
  assert.equal(classifyUrl('https://www.google.com/mapsearch', { exclude }).skip, undefined, 'prefisso solo su segmento intero');
  assert.equal(classifyUrl('https://gemini.google.com/', { exclude }).skip, undefined);
  assert.equal(classifyUrl('https://whatsapp.com/', { exclude }).skip, undefined, 'il dominio padre non è escluso');
  assert.deepEqual(classifyUrl('https://mail.google.com/mail/u/0/', { exclude: DEFAULTS.exclude }), { skip: 'escluso' });
});

test('isPrivateHost', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.5', 'nas.local', '[::1]']) assert.ok(isPrivateHost(h), h);
  for (const h of ['172.32.0.1', '8.8.8.8', 'example.com']) assert.ok(!isPrivateHost(h), h);
});

test('Google Immagini → pagina di origine', () => {
  const c = classifyUrl('https://www.google.com/imgres?imgurl=https://x/y.jpg&imgrefurl=https://www.pinterest.com/linda/pallet/&docid=1');
  assert.equal(c.url, 'https://www.pinterest.com/linda/pallet/');
  assert.equal(c.unwrapped, true);
});

test('cleanUrl toglie solo il tracciamento', () => {
  assert.equal(cleanUrl('https://a.com/p?id=3&fbclid=X&utm_source=ig#sez', DEFAULTS.normalize), 'https://a.com/p?id=3#sez');
  assert.equal(cleanUrl('https://lteitaly.it/map.php#17/45.58/9.10', DEFAULTS.normalize), 'https://lteitaly.it/map.php#17/45.58/9.10');
});

test('titleFromUrl', () => {
  assert.equal(titleFromUrl('https://www.printables.com/model/1881849-digital-eyes-project'), 'Digital eyes project — printables.com');
  assert.equal(titleFromUrl('https://www.pinterest.com/linda9999/pallet-nightstand/'), 'Pallet nightstand — pinterest.com');
  assert.equal(titleFromUrl('https://plinky12.com/'), 'plinky12.com');
});

test('riconosce le pagine di ricerca', () => {
  assert.deepEqual(classifyUrl('https://duckduckgo.com/?q=ikea+kallax&t=euandroid').search, { engine: 'DuckDuckGo', q: 'ikea kallax' });
  assert.equal(classifyUrl('https://www.google.com/search?q=&udm=2').search.engine, 'Google');
  assert.equal(classifyUrl('https://github.com/search?q=x').search, null);
});

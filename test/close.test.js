import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTabsToClose } from '../src/close.js';
import { normalizeUrl } from '../src/url.js';
import { DEFAULTS } from '../src/config.js';

const normalize = (u) => normalizeUrl(u, DEFAULTS.normalize);
const keys = new Set([
  'https://github.com/puckeditor/puck',
  'https://fibra.iliad.it/subscribe-fibra',
  'https://duckduckgo.com/?ia=web&q=ikea+kallax&t=euandroid',
  'https://www.pinterest.com/linda9999/pallet-nightstand/',
].map(normalize));

const tab = (id, url) => ({ id, title: id, url });

test('chiude solo le schede il cui URL è nel file', () => {
  const tabs = [
    tab('a', 'https://github.com/puckeditor/puck?utm_source=x'), // tracciamento → stessa chiave
    tab('b', 'https://fibra.iliad.it/subscribe-fibra/#modal-call-me-back'), // doppione con frammento
    tab('c', 'https://fibra.iliad.it/subscribe-fibra/'),
    tab('d', 'https://duckduckgo.com/?q=ikea+kallax&t=euandroid&ia=web'), // ricerca salvata
    tab('e', 'https://example.com/nuova'), // non nel file (es. aperta durante il sync)
    tab('f', 'http://192.168.1.9:5173/'), // locale: mai chiusa
    tab('g', ''), // vuota: mai chiusa
    tab('h', 'chrome://newtab/'),
    tab('i', 'https://www.google.com/imgres?imgurl=x&imgrefurl=https://www.pinterest.com/linda9999/pallet-nightstand/'), // salvata come pagina d'origine
  ];
  const { close, keep } = selectTabsToClose(tabs, keys, { normalize });
  assert.deepEqual(close.map((t) => t.id), ['a', 'b', 'c', 'd', 'i']);
  assert.deepEqual(keep.map((t) => t.id), ['e', 'f', 'g', 'h']);
});

test('un sito escluso non si chiude anche se è nel file', () => {
  const k = new Set([normalize('https://web.whatsapp.com/')]);
  const tabs = [tab('w', 'https://web.whatsapp.com/')];
  assert.equal(selectTabsToClose(tabs, k, { normalize, exclude: ['web.whatsapp.com'] }).close.length, 0);
});

test('un URL locale salvato con --include-local si chiude solo con lo stesso flag', () => {
  const k = new Set([normalize('http://192.168.1.9:5173/')]);
  const tabs = [tab('x', 'http://192.168.1.9:5173/')];
  assert.equal(selectTabsToClose(tabs, k, { normalize }).close.length, 0);
  assert.equal(selectTabsToClose(tabs, k, { normalize, includeLocal: true }).close.length, 1);
});

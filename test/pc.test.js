import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActivePort, pagesFromTargets } from '../src/sources/pc.js';

test('DevToolsActivePort: porta + percorso WebSocket', () => {
  assert.equal(parseActivePort('53210\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:53210/devtools/browser/abc-123');
  assert.equal(parseActivePort('9222\r\n'), 'ws://127.0.0.1:9222/devtools/browser');
  assert.throws(() => parseActivePort('ciao\n/x'));
});

test('solo le schede vere tra i target CDP', () => {
  const infos = [
    { targetId: '1', type: 'page', title: 'A', url: 'https://a.com' },
    { targetId: '2', type: 'page', subtype: 'prerender', title: 'P', url: 'https://p.com' },
    { targetId: '3', type: 'service_worker', title: 'SW', url: 'https://a.com/sw.js' },
    { targetId: '4', type: 'tab', title: 'A', url: 'https://a.com' },
    { targetId: '5', type: 'iframe', title: 'I', url: 'https://i.com' },
    { targetId: '6', type: 'page', title: 'Nuova scheda', url: 'chrome://newtab/' },
  ];
  assert.deepEqual(pagesFromTargets(infos), [
    { id: '1', title: 'A', url: 'https://a.com' },
    { id: '6', title: 'Nuova scheda', url: 'chrome://newtab/' }, // filtrata poi da classifyUrl (schema)
  ]);
});

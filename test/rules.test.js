import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTags, slugTag } from '../src/tagger/rules.js';
import { DEFAULTS } from '../src/config.js';

const rules = DEFAULTS.tagRules;

test('slugTag', () => {
  assert.equal(slugTag('Machine Learning'), 'machine-learning');
  assert.equal(slugTag('Città'), 'citta');
});

test('regole dominio e parole chiave', () => {
  const t = assignTags({ url: 'https://github.com/x/threejs-grass', title: 'Grass shader for Three.js' }, { rules });
  assert.deepEqual(t, ['dev', '3d']);
});

test('vocabolario del file e alias', () => {
  const vocabulary = new Map([['javascript', 3], ['viaggi', 2], ['ai', 5]]);
  const t = assignTags({ url: 'https://blog.example/post', title: 'Viaggi in treno e JS moderno', description: 'Un post ai margini' }, { rules, vocabulary });
  assert.ok(t.includes('viaggi'));
  assert.ok(t.includes('javascript'), 'alias js → javascript');
  assert.ok(!t.includes('ai'), 'tag corti non abbinati dal vocabolario');
});

test('papercraft: dominio, parole chiave e alias "paper"', () => {
  assert.deepEqual(assignTags({ url: 'https://cardboardtemplates.com/', title: 'Templates' }, { rules }), ['papercraft']);
  assert.deepEqual(assignTags({ url: 'https://x.it/', title: 'Maschera in cartone fai da te' }, { rules }), ['papercraft']);
  assert.deepEqual(assignTags({ url: 'https://arxiv.org/abs/1', title: 'A paper' }, { rules }), ['articolo-scientifico']);
  const vocabulary = new Map([['paper', 2]]);
  assert.ok(!assignTags({ url: 'https://x.it/', title: 'Paper models' }, { rules, vocabulary }).includes('paper'));
});

test('ricerca, fallback e limite', () => {
  assert.deepEqual(assignTags({ url: 'https://duckduckgo.com/?q=x', title: 'x', search: { engine: 'DuckDuckGo', q: 'x' } }, { rules }), ['ricerca']);
  assert.deepEqual(assignTags({ url: 'https://zzz.example/', title: 'Niente' }, { rules }), ['da-smistare']);
  const many = assignTags({ url: 'https://github.com/a', title: 'game emulator three.js cnc blender ricetta' }, { rules });
  assert.equal(many.length, rules.maxTags);
});

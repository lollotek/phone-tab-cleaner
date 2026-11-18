import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildUserPrompt, parseJsonLoose, validateResponse, languageName, tagsInInstructions } from '../src/tagger/ai/prompt.js';
import { enrichWithAi, isSizeError } from '../src/tagger/ai/index.js';

const opts = { maxTags: 3, maxLength: 60, aliases: { js: 'javascript' } };
const silent = { debug() {}, warn() {}, info() {} };

test('parseJsonLoose: think, fence e testo attorno', () => {
  assert.deepEqual(parseJsonLoose('<think>bla {x}</think>\n```json\n{"items":[]}\n```'), { items: [] });
  assert.deepEqual(parseJsonLoose('Ecco: {"items":[{"i":0}]} fine'), { items: [{ i: 0 }] });
  assert.throws(() => parseJsonLoose('niente json'));
});

test('validateResponse: normalizza tag, scarta indici non validi, tronca', () => {
  const r = validateResponse(
    { items: [
      { i: 0, description: '"Una descrizione molto lunga che supera di parecchio il limite di sessanta caratteri"', tags: ['#Stampa 3D', 'JS', 'stampa-3d', 'a', 'b'] },
      { i: 0, description: 'duplicato', tags: [] },
      { i: 7, description: 'fuori range', tags: [] },
      { i: '1', description: 'ok', tags: ['gio1', 'mp3', 'stampa-3d'] },
    ] },
    2,
    opts,
  );
  assert.equal(r.size, 2);
  assert.deepEqual(r.get(0).tags, ['stampa-3d', 'javascript', 'a']);
  assert.ok(r.get(0).description.length <= 60);
  assert.ok(!r.get(0).description.startsWith('"'));
  assert.equal(r.get(1).description, 'ok');
  assert.deepEqual(r.get(1).tags, ['stampa-3d'], 'tag con cifre finali scartati');
  assert.throws(() => validateResponse({ foo: 1 }, 1, opts));
});

test('buildUserPrompt: vocabolario ordinato e campi opzionali', () => {
  const p = buildUserPrompt([{ url: 'https://a.com', title: 'A', excerpt: 'x'.repeat(50) }], new Map([['dev', 3], ['cucina', 0], ['ai', 5]]), { excerptChars: 20 });
  assert.match(p, /Tag esistenti: ai \(5\), dev \(3\), cucina/);
  assert.ok(!p.includes('descrizione_pagina'));
  assert.match(p, /"testo": "x+…"/);
});

test('indicazioni personali: commenti tolti, tag estratti, testo nel prompt', () => {
  const text = '<!-- nota con #ignorato -->\n- Se c\'è cosplay aggiungi #cosplay e #Maker.\n- Prezzo #1? no';
  assert.deepEqual(tagsInInstructions(text), ['cosplay', 'maker'], 'numeri come "#1" non sono tag');
  const sys = buildSystemPrompt({ language: 'it', maxTags: 4, maxLength: 160, instructions: text });
  assert.match(sys, /Indicazioni dell'utente[^\n]*\n- Se c'è cosplay aggiungi #cosplay/);
  assert.ok(!sys.includes('ignorato'));
  assert.ok(!buildSystemPrompt({ language: 'it', maxTags: 4, maxLength: 160 }).includes('Indicazioni'));
});

test('enrichWithAi: lotto troppo grande → diviso a metà, poi senza testo, poi regole', async () => {
  const items = [1, 2, 3, 4].map((n) => ({ url: `https://s${n}.com`, title: `T${n}`, excerpt: `testo ${n}` }));
  const calls = [];
  const provider = {
    name: 'fake',
    async complete({ user, maxOutputTokens }) {
      const n = (user.match(/"i":/g) ?? []).length;
      calls.push({ n, testo: user.includes('"testo"'), maxOutputTokens });
      // T3 è "pesante": fa sforare il contesto finché c'è il testo della pagina; T4 non entra mai.
      if (user.includes('"T4"') || (user.includes('"T3"') && user.includes('"testo"')) || n > 2) {
        throw new Error('HTTP 400: Context size has been exceeded.');
      }
      return JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ i, description: 'ok', tags: ['x'] })) });
    },
  };
  const warns = [];
  const res = await enrichWithAi(items, { provider, vocabulary: new Map(), language: 'it', ...opts, batchSize: 4, excerptChars: 100, log: { ...silent, warn: (m) => warns.push(m) } });
  assert.deepEqual(items.map((it) => res.has(it)), [true, true, true, false]);
  assert.equal(calls[0].n, 4);
  assert.ok(calls.some((c) => c.n === 1 && !c.testo), 'singolo link riprovato senza testo');
  assert.equal(calls.filter((c) => c.n === 4).length, 1, 'un errore di contesto non ripete lo stesso lotto');
  assert.equal(calls[0].maxOutputTokens, 250 * 4 + 300);
  assert.equal(warns.length, 1, 'solo T4 finisce alle regole');
});

test('isSizeError', () => {
  assert.ok(isSizeError(new Error('Context size has been exceeded.')));
  assert.ok(isSizeError(new Error('risposta troncata (contesto o max_tokens insufficienti)')));
  assert.ok(!isSizeError(new Error('HTTP 500: model crashed')));
});

test('languageName', () => {
  assert.equal(languageName('it'), 'italiano');
  assert.equal(languageName('en'), 'inglese');
});

test('enrichWithAi: lotti, riuso del vocabolario, ripiego su errore', async () => {
  const items = [1, 2, 3, 4, 5].map((n) => ({ url: `https://s${n}.com`, title: `T${n}` }));
  const prompts = [];
  let call = 0;
  const provider = {
    name: 'fake',
    async complete({ user }) {
      prompts.push(user);
      call++;
      if (call === 2 || call === 3) throw new Error('boom'); // 2° lotto fallisce entrambi i tentativi
      const n = (user.match(/"i":/g) ?? []).length;
      return JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ i, description: `d${call}-${i}`, tags: ['nuovo-tag'] })) });
    },
  };
  const res = await enrichWithAi(items, { provider, vocabulary: new Map(), language: 'it', ...opts, batchSize: 2, log: silent });
  assert.equal(res.size, 3, 'lotto 1 (2) + lotto 3 (1); lotto 2 fallito');
  assert.equal(res.get(items[0]).description, 'd1-0');
  assert.ok(!res.has(items[2]));
  assert.match(prompts.at(-1), /nuovo-tag \(2\)/, 'tag creati nei lotti precedenti finiscono nel vocabolario');
});

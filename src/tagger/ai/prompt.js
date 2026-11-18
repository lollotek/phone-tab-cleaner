/** Prompt, schema e validazione comuni a tutti i provider AI (SDK §6.3). */
import { cleanText, truncate } from '../../util.js';
import { slugTag } from '../rules.js';

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['i', 'description', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export function languageName(code) {
  try {
    return new Intl.DisplayNames(['it'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Toglie i commenti HTML (<!-- … -->) dal file di indicazioni, così si possono lasciare note per sé. */
export const cleanInstructions = (text = '') => text.replace(/<!--[\s\S]*?-->/g, '').trim();

/** Tag citati nelle indicazioni (#maker, #cosplay…): entrano nel vocabolario anche se il file dei link non li ha ancora. */
export const tagsInInstructions = (text = '') =>
  [...new Set([...cleanInstructions(text).matchAll(/(?:^|[\s(,"'])#([\p{L}\p{N}_-]+)/gu)].map(([, t]) => slugTag(t)).filter((t) => /\p{L}/u.test(t)))];

export function buildSystemPrompt({ language, maxTags, maxLength, instructions }) {
  const lang = languageName(language);
  const extra = cleanInstructions(instructions);
  return [
    'Catalogo link salvati dalle schede del browser di un utente.',
    `Per ogni link scrivi una descrizione e da 1 a ${maxTags} tag.`,
    '',
    'Descrizione:',
    `- una sola frase in ${lang}, al massimo ${maxLength} caratteri, anche se la pagina è in un'altra lingua;`,
    '- dice di cosa tratta la pagina (prodotto, articolo, progetto, ricetta, evento…), senza ripetere il titolo e senza frasi promozionali;',
    "- usa solo le informazioni fornite (titolo, URL, metadati, testo); se sono scarse, descrivi solo quello che si deduce con certezza.",
    '',
    'Tag:',
    '- usa di preferenza i tag già esistenti elencati dall\'utente, sono il vocabolario del suo archivio;',
    '- crea un tag nuovo solo se nessuno di quelli esistenti è adatto;',
    `- tag in ${lang}, minuscoli, kebab-case (es. stampa-3d), senza "#", generici abbastanza da essere riusati;`,
    '- niente tag che ripetono solo il nome del sito.',
    ...(extra
      ? [
        '',
        `Indicazioni dell'utente (hanno la precedenza sulle regole generali; i tag che indicano vanno contati nel limite di ${maxTags}):`,
        extra,
      ]
      : []),
    '',
    'Rispondi solo con JSON: {"items":[{"i":<numero del link>,"description":"…","tags":["…"]}]}, un elemento per ogni link ricevuto.',
  ].join('\n');
}

/**
 * @param {{url,title,description?,keywords?,excerpt?}[]} batch
 * @param {Map<string,number>} vocabulary tag → numero di utilizzi (0 = suggerito dalle regole)
 */
export function buildUserPrompt(batch, vocabulary, { excerptChars = 1200 } = {}) {
  const vocab = [...vocabulary.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([t, n]) => (n > 0 ? `${t} (${n})` : t))
    .join(', ');
  // Ogni campo ha un tetto: un solo link "pesante" (titolo o meta enormi) non deve far sforare il contesto del modello.
  const links = batch.map((it, i) => {
    const o = { i, url: truncate(it.url, 300), titolo: truncate(it.title ?? '', 200) };
    if (it.description) o.descrizione_pagina = truncate(cleanText(it.description), 400);
    if (it.keywords?.length) o.parole_chiave = truncate(it.keywords.slice(0, 10).join(', '), 200);
    if (it.excerpt && excerptChars > 0) o.testo = truncate(it.excerpt, excerptChars);
    return o;
  });
  return `Tag esistenti: ${vocab || '(nessuno)'}\n\nLink:\n${JSON.stringify(links, null, 1)}`;
}

/** Estrae il JSON anche da risposte "sporche" (blocchi <think>, ```json, testo attorno). */
export function parseJsonLoose(text) {
  const t = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('risposta senza JSON');
  }
}

/**
 * Valida la risposta del modello.
 * @returns {Map<number,{description:string,tags:string[]}>} indice nel lotto → risultato (gli elementi non validi mancano)
 */
export function validateResponse(data, batchLength, { maxTags, maxLength, aliases = {} }) {
  const list = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(list)) throw new Error('campo "items" mancante');
  const aliasMap = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [slugTag(k), slugTag(v)]));
  const out = new Map();
  for (const el of list) {
    const i = Number(el?.i);
    if (!Number.isInteger(i) || i < 0 || i >= batchLength || out.has(i)) continue;
    const description = truncate(cleanText(String(el.description ?? '')).replace(/^["“]|["”]$/g, ''), maxLength);
    const tags = [];
    for (const raw of Array.isArray(el.tags) ? el.tags : []) {
      let t = slugTag(String(raw).replace(/^#/, ''));
      t = aliasMap[t] ?? t;
      // Scarta tag vuoti, troppo lunghi o "storpiati" con cifre finali (es. "gio1"); "stampa-3d" resta valido.
      if (t && t.length <= 40 && !/^\p{L}+\d+$/u.test(t) && !tags.includes(t)) tags.push(t);
    }
    out.set(i, { description, tags: tags.slice(0, maxTags) });
  }
  return out;
}

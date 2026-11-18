/** Assegnazione dei tag a regole (SPEC §6.3, modalità di default). */

const fold = (s = '') => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const tokens = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** "Machine Learning" → "machine-learning" */
export const slugTag = (s) => tokens(s).join('-');

/** Testo "a gettoni" separati da spazi, per cercare sequenze di parole intere. */
const haystackOf = (parts) => ` ${parts.flatMap(tokens).join(' ')} `;
const containsPhrase = (hay, phrase) => {
  const t = tokens(phrase);
  return t.length > 0 && hay.includes(` ${t.join(' ')} `);
};

/**
 * @param {{url:string,title?:string,description?:string,keywords?:string[],search?:object|null}} item
 * @param {{rules:object, vocabulary?:Map<string,number>}} ctx
 * @returns {string[]}
 */
export function assignTags(item, { rules, vocabulary = new Map() }) {
  const aliases = Object.fromEntries(Object.entries(rules.aliases ?? {}).map(([k, v]) => [slugTag(k), slugTag(v)]));
  const out = [];
  const add = (t) => {
    let s = slugTag(t);
    s = aliases[s] ?? s;
    if (s && !out.includes(s)) out.push(s);
  };

  const u = new URL(item.url);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  if (item.search && rules.searchTag) add(rules.searchTag);

  for (const [domain, tags] of Object.entries(rules.domains ?? {})) {
    const d = domain.toLowerCase().replace(/^www\./, '');
    if (host === d || host.endsWith(`.${d}`)) tags.forEach(add);
  }

  const hay = haystackOf([
    item.title ?? '',
    item.description ?? '',
    ...(item.keywords ?? []),
    decodeURIComponentSafe(u.pathname).replace(/[-_/]+/g, ' '),
  ]);

  for (const [kw, tags] of Object.entries(rules.keywords ?? {})) {
    if (containsPhrase(hay, kw)) tags.forEach(add);
  }

  // Tag già usati nel file (i più frequenti prima). I nomi corti (<3) si ignorano per evitare falsi positivi
  // ("ai" è anche una preposizione); gli alias invece sono configurati a mano e valgono sempre.
  const byUse = [...vocabulary.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  for (const tag of byUse) {
    const names = [
      ...(tag.replace(/-/g, '').length >= 3 ? [tag] : []),
      ...Object.entries(aliases).filter(([, v]) => v === tag).map(([k]) => k),
    ];
    if (names.some((n) => containsPhrase(hay, n.replace(/-/g, ' ')))) add(tag);
  }

  const max = rules.maxTags ?? 4;
  const result = out.slice(0, max);
  if (!result.length && rules.fallbackTag) result.push(slugTag(rules.fallbackTag));
  return result;
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

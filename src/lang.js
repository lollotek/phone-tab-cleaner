/**
 * Riconoscimento grossolano della lingua di una frase breve (italiano / inglese), tramite parole frequenti.
 * Serve solo per `retag --lang-mismatch`: trovare descrizioni rimaste nella lingua della pagina.
 */
const STOPWORDS = {
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'di', 'del', 'della', 'dei', 'delle', 'e', 'è', 'per', 'con', 'che', 'in', 'su', 'da', 'al', 'alla', 'nel', 'nella', 'non', 'come', 'più', 'sono', 'tra', 'ai', 'agli', 'dal', 'dalla'],
  en: ['the', 'a', 'an', 'of', 'and', 'is', 'are', 'for', 'with', 'to', 'in', 'on', 'by', 'your', 'you', 'that', 'this', 'from', 'it', 'its', 'or', 'be', 'can', 'at', 'as', 'our', 'we', 'how', 'more', 'all'],
};

/** @returns {'it'|'en'|null} null se il testo è troppo corto o ambiguo */
export function detectLang(text = '') {
  const words = text.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  if (words.length < 4) return null;
  const score = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length]));
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (best[1] < 2 || best[1] === second[1]) return null;
  return best[0];
}

/** true se la descrizione è riconoscibilmente in una lingua diversa da `lang` (solo it/en sono riconosciute). */
export function isLangMismatch(text, lang) {
  const found = detectLang(text);
  return Boolean(found && found !== lang);
}

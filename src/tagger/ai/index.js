import { buildSystemPrompt, buildUserPrompt, parseJsonLoose, RESPONSE_SCHEMA, validateResponse } from './prompt.js';

export { createProvider, PROVIDERS } from './providers.js';
export { tagsInInstructions } from './prompt.js';

/** Errori che dipendono dalla dimensione del lotto (contesto pieno, risposta troncata): si risolvono dividendolo. */
export const isSizeError = (e) => /context|troncat|too long|maximum.*token|length/i.test(e?.message ?? '');

/**
 * Genera descrizione e tag con un provider AI, a lotti.
 * Il vocabolario viene arricchito lotto per lotto, così i tag nuovi vengono riusati nei lotti successivi.
 * Se un lotto non entra nel contesto del modello viene diviso a metà (fino al singolo link, poi senza testo della pagina).
 * I link per cui l'AI fallisce comunque non compaiono nel risultato: il chiamante usa le regole come ripiego.
 *
 * @param {object[]} items  {url,title,description?,keywords?,excerpt?}
 * @returns {Promise<Map<object,{description:string,tags:string[]}>>}
 */
export async function enrichWithAi(items, { provider, vocabulary, language, maxTags, maxLength, batchSize, excerptChars, aliases, instructions, log }) {
  const vocab = new Map(vocabulary);
  const system = buildSystemPrompt({ language, maxTags, maxLength, instructions });
  const results = new Map();
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  /** Un tentativo su un lotto: risultati validati oppure eccezione. */
  async function attempt(batch, { excerpt, strict }) {
    const user = buildUserPrompt(batch, vocab, { excerptChars: excerpt });
    const text = await provider.complete({
      system,
      user: strict ? `${user}\n\nATTENZIONE: rispondi esclusivamente con il JSON richiesto, senza altro testo.` : user,
      schema: RESPONSE_SCHEMA,
      // Abbondante anche per modelli che "ragionano" prima di rispondere (i token di ragionamento contano).
      maxOutputTokens: 250 * batch.length + 300,
    });
    return validateResponse(parseJsonLoose(text), batch.length, { maxTags, maxLength, aliases });
  }

  /** Elabora un lotto; in caso di errore di dimensione lo divide. Restituisce i link rimasti senza risultato. */
  async function run(batch, label, excerpt = excerptChars) {
    let lastError;
    for (const strict of [false, true]) {
      try {
        const t0 = Date.now();
        const parsed = await attempt(batch, { excerpt, strict });
        log.debug(`${label}: ${parsed.size}/${batch.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        for (const [i, r] of parsed) {
          results.set(batch[i], r);
          for (const t of r.tags) vocab.set(t, (vocab.get(t) ?? 0) + 1);
        }
        return batch.filter((_, i) => !parsed.has(i));
      } catch (e) {
        if (e.exitCode) throw e; // errori di configurazione: inutile riprovare
        lastError = e;
        log.debug(`${label}${strict ? ' (2° tentativo)' : ''}: ${e.message}`);
        if (isSizeError(e)) break; // ripetere lo stesso lotto non serve
      }
    }
    if (isSizeError(lastError)) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        log.debug(`${label}: lotto troppo grande per il modello → diviso in ${mid} + ${batch.length - mid}`);
        return [...(await run(batch.slice(0, mid), `${label}a`, excerpt)), ...(await run(batch.slice(mid), `${label}b`, excerpt))];
      }
      if (excerpt > 0) {
        log.debug(`${label}: riprovo senza il testo della pagina`);
        return run(batch, `${label}-`, 0);
      }
    }
    log.warn(`${label}: ${lastError.message.slice(0, 200)} → regole per ${batch.length} link`);
    return batch;
  }

  for (const [n, batch] of batches.entries()) {
    const label = `AI lotto ${n + 1}/${batches.length}`;
    if (process.stderr.isTTY) process.stderr.write(`\r  ${label}…`);
    await run(batch, label);
  }
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  return results;
}

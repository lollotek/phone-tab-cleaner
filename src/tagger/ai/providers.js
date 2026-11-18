/**
 * Provider AI intercambiabili. Ognuno espone:
 *   name, model, complete({ system, user, schema }) → testo della risposta (JSON).
 */
import { PckError } from '../../errors.js';

async function importOptional(pkg) {
  try {
    return await import(pkg);
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') throw new PckError(`Pacchetto "${pkg}" non installato: esegui  npm install ${pkg}`);
    throw e;
  }
}

// ── Locale: endpoint compatibile OpenAI (LM Studio, Ollama, llama.cpp) ──────────────────────────
async function detectLocalModel(base) {
  // LM Studio: /api/v0/models indica quale modello è caricato.
  try {
    const res = await fetch(`${new URL(base).origin}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const loaded = (await res.json()).data?.find((m) => m.state === 'loaded' && m.type !== 'embeddings');
      if (loaded) return loaded.id;
    }
  } catch { /* non è LM Studio */ }
  const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} su /models`);
  const first = (await res.json()).data?.find((m) => !/embed/i.test(m.id));
  if (!first) throw new Error('nessun modello disponibile');
  return first.id;
}

async function createLocal(cfg, model) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  try {
    model ||= cfg.model || (await detectLocalModel(base));
  } catch (e) {
    throw new PckError(`Server AI locale non raggiungibile su ${base} (${e.cause?.code || e.message}). Avvia LM Studio/Ollama o imposta ai.providers.local.baseUrl.`);
  }
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  // Modelli che "ragionano" (es. gemma 4 con thinking): per descrivere link non serve, e il ragionamento
  // riempie il contesto. "none" lo disattiva su LM Studio; null = parametro non inviato.
  let reasoningEffort = cfg.reasoningEffort === undefined ? 'none' : cfg.reasoningEffort;
  const post = (body) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 300000),
  });
  return {
    name: 'local',
    model,
    async complete({ system, user, schema, maxOutputTokens }) {
      const body = {
        model,
        temperature: 0.2,
        // Tetto alla risposta: evita che un modello "in loop" riempia tutto il contesto.
        ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      if (cfg.structured === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'links', strict: true, schema } };
      else if (cfg.structured === 'json_object') body.response_format = { type: 'json_object' };
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;
      let res = await post(body);
      if (res.status === 400 && reasoningEffort) {
        const text = await res.text();
        if (!/reasoning/i.test(text)) throw new Error(`HTTP 400: ${text.slice(0, 300)}`);
        // Server che non conosce il parametro: lo si toglie per il resto dell'esecuzione.
        reasoningEffort = null;
        delete body.reasoning_effort;
        res = await post(body);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      if (json.choices?.[0]?.finish_reason === 'length') throw new Error('risposta troncata (contesto o max_tokens insufficienti): riduci batchSize');
      return json.choices?.[0]?.message?.content ?? '';
    },
  };
}

// ── Claude (Anthropic API) ───────────────────────────────────────────────────────────────────────
async function createClaude(cfg, model) {
  const { default: Anthropic } = await importOptional('@anthropic-ai/sdk');
  // Credenziali risolte dall'SDK: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN o profilo `ant auth login`.
  const client = new Anthropic();
  model ||= cfg.model;
  return {
    name: 'claude',
    model,
    async complete({ system, user, schema }) {
      let r;
      try {
        r = await client.messages.create({
          model,
          max_tokens: 16000,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { effort: cfg.effort ?? 'low', format: { type: 'json_schema', schema } },
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new PckError('Claude: credenziali mancanti o non valide (imposta ANTHROPIC_API_KEY).');
        throw e;
      }
      if (r.stop_reason === 'refusal') throw new Error(`richiesta rifiutata (${r.stop_details?.category ?? 'n/d'})`);
      if (r.stop_reason === 'max_tokens') throw new Error('risposta troncata: riduci batchSize');
      return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}

// ── Gemini (Google GenAI) ────────────────────────────────────────────────────────────────────────
async function createGemini(cfg, model) {
  const { GoogleGenAI } = await importOptional('@google/genai');
  const apiKey = process.env[cfg.apiKeyEnv ?? 'GEMINI_API_KEY'];
  if (!apiKey) throw new PckError(`Gemini: variabile ${cfg.apiKeyEnv ?? 'GEMINI_API_KEY'} non impostata.`);
  const ai = new GoogleGenAI({ apiKey });
  model ||= cfg.model;
  return {
    name: 'gemini',
    model,
    async complete({ system, user, schema }) {
      const r = await ai.models.generateContent({
        model,
        contents: user,
        config: { systemInstruction: system, temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema },
      });
      return r.text ?? '';
    },
  };
}

const FACTORIES = { local: createLocal, claude: createClaude, gemini: createGemini };
export const PROVIDERS = Object.keys(FACTORIES);

export async function createProvider(name, aiCfg, { model } = {}) {
  const factory = FACTORIES[name];
  if (!factory) throw new PckError(`Provider AI sconosciuto "${name}". Disponibili: ${PROVIDERS.join(', ')}.`);
  return factory(aiCfg.providers?.[name] ?? {}, model);
}

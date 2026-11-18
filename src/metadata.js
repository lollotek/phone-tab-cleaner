import { parse } from 'node-html-parser';
import { cleanText, decodeEntities } from './util.js';

async function readLimited(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(size, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, buf.length - off);
    buf.set(part, off);
    off += part.length;
    if (off >= buf.length) break;
  }
  return buf;
}

function decode(bytes, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const txt = (s) => (s ? cleanText(decodeEntities(s)) : '');

/** Estrae titolo, descrizione e segnali per i tag da un documento HTML. */
export function extractMetadata(html) {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const meta = {};
  const tags = [];
  for (const el of root.querySelectorAll('meta')) {
    const key = (el.getAttribute('property') || el.getAttribute('name') || el.getAttribute('itemprop') || '').toLowerCase();
    const content = el.getAttribute('content');
    if (!key || !content) continue;
    if (key === 'article:tag') tags.push(txt(content));
    else meta[key] ??= txt(content);
  }
  const keywords = [
    ...(meta.keywords ? meta.keywords.split(/[,;]/) : []),
    ...tags,
  ].map((k) => k.trim()).filter(Boolean);

  // Testo principale della pagina (per l'AI): si tolgono le parti di contorno.
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;
  main.querySelectorAll('script,style,noscript,svg,nav,footer,header,form,aside,iframe').forEach((n) => n.remove());
  const excerpt = cleanText(main.text).slice(0, 4000);

  return {
    excerpt,
    title: txt(root.querySelector('title')?.text),
    ogTitle: meta['og:title'] || meta['twitter:title'] || '',
    description: meta['og:description'] || meta.description || meta['twitter:description'] || '',
    siteName: meta['og:site_name'] || '',
    keywords,
  };
}

/** Scarica la pagina (limitata in tempo e dimensione) ed estrae i metadati. Non lancia mai. */
export async function fetchMetadata(url, { timeoutMs = 8000, maxBytes = 524288, userAgent } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
      },
    });
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { ok: false, error: `HTTP ${res.status}` };
    }
    if (!/html|xml/i.test(ct)) {
      res.body?.cancel().catch(() => {});
      return { ok: false, error: `contenuto ${ct.split(';')[0] || 'sconosciuto'}` };
    }
    const html = decode(await readLimited(res, maxBytes), ct);
    return { ok: true, finalUrl: res.url, ...extractMetadata(html) };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message };
  }
}

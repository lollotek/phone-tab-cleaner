/** Filtro, "srotolamento" e normalizzazione degli URL (SPEC §6.1). */

const HTTP = new Set(['http:', 'https:']);

export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

const isGoogle = (host) => /(^|\.)google\.[a-z.]+$/.test(host);

/** Riconosce le pagine di ricerca: { engine, q } oppure null. */
export function detectSearch(u) {
  const host = u.hostname.replace(/^www\./, '');
  const q = (name) => u.searchParams.get(name)?.trim() ?? '';
  if (host === 'duckduckgo.com' && u.searchParams.has('q')) return { engine: 'DuckDuckGo', q: q('q') };
  if (isGoogle(host) && u.pathname === '/search') return { engine: 'Google', q: q('q') };
  if (host === 'bing.com' && u.pathname === '/search') return { engine: 'Bing', q: q('q') };
  if (host === 'ecosia.org' && u.pathname === '/search') return { engine: 'Ecosia', q: q('q') };
  if (host.endsWith('search.yahoo.com')) return { engine: 'Yahoo', q: q('p') };
  return null;
}

/**
 * Siti esclusi (mai salvati né chiusi). Ogni voce è "host" (vale anche per i sottodomini)
 * oppure "host/percorso" (prefisso del percorso), es. "web.whatsapp.com", "gemini.google.com/app".
 */
export function isExcluded(u, patterns = []) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = u.pathname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return patterns.some((p) => {
    const [hp, ...rest] = p.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/');
    // "host:porta" (es. la pagina di `pck ui` su 127.0.0.1:4317) vale solo per quella porta.
    const [ph, pp] = hp.split(':');
    if (pp && pp !== port) return false;
    const prefix = rest.length ? `/${rest.join('/')}` : '';
    const hostOk = host === ph || host.endsWith(`.${ph}`);
    return hostOk && (!prefix || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  });
}

/**
 * Decide cosa fare di un URL di scheda.
 * @returns {{skip: 'vuota'|'schema'|'locale'|'escluso'|'invalido'} | {url: string, search: {engine,q}|null, unwrapped: boolean}}
 */
export function classifyUrl(raw, { includeLocal = false, exclude = [] } = {}) {
  if (!raw || !raw.trim()) return { skip: 'vuota' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { skip: 'invalido' };
  }
  if (!HTTP.has(u.protocol)) return { skip: 'schema' };
  if (!includeLocal && isPrivateHost(u.hostname)) return { skip: 'locale' };
  if (isExcluded(u, exclude)) return { skip: 'escluso' };

  // Google Immagini: si salva la pagina d'origine dell'immagine.
  if (isGoogle(u.hostname) && u.pathname === '/imgres') {
    const ref = u.searchParams.get('imgrefurl');
    try {
      const target = new URL(ref);
      if (HTTP.has(target.protocol)) return { url: target.href, search: null, unwrapped: true };
    } catch { /* resta l'URL originale */ }
  }

  return { url: u.href, search: detectSearch(u), unwrapped: false };
}

function paramMatcher(patterns) {
  const exact = new Set();
  const prefixes = [];
  for (const p of patterns) {
    const l = p.toLowerCase();
    if (l.endsWith('*')) prefixes.push(l.slice(0, -1));
    else exact.add(l);
  }
  return (k) => {
    const l = k.toLowerCase();
    return exact.has(l) || prefixes.some((p) => l.startsWith(p));
  };
}

const matcherCache = new WeakMap();
function trackingMatcher(stripParams) {
  let m = matcherCache.get(stripParams);
  if (!m) matcherCache.set(stripParams, (m = paramMatcher(stripParams)));
  return m;
}

/** URL da scrivere nel file: tolti solo i parametri di tracciamento, tutto il resto invariato. */
export function cleanUrl(raw, { stripParams = [] } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const isTracking = trackingMatcher(stripParams);
  const keys = [...new Set([...u.searchParams.keys()])].filter(isTracking);
  if (!keys.length) return raw;
  keys.forEach((k) => u.searchParams.delete(k));
  return u.href;
}

/** Titolo di ripiego dall'URL: ultimo segmento del path "umanizzato" + dominio. */
export function titleFromUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/^\d+[-_]/, '')
      .replace(/[-_+]+/g, ' ')
      .trim();
    if (!seg || /^\d+$/.test(seg)) return host;
    return `${seg.charAt(0).toUpperCase()}${seg.slice(1)} — ${host}`;
  } catch {
    return raw;
  }
}

/** Chiave di confronto per i doppioni (non viene mai scritta nel file). */
export function normalizeUrl(raw, { stripParams = [], keepHashRoutes = true } = {}) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  if (!HTTP.has(u.protocol)) return u.href;

  const isTracking = trackingMatcher(stripParams);

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port ? `:${u.port}` : '';
  let path = u.pathname.replace(/%28/gi, '(').replace(/%29/gi, ')').replace(/\/+$/, '');
  if (path === '/') path = '';
  const params = [...u.searchParams]
    .filter(([k]) => !isTracking(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const qs = new URLSearchParams(params).toString();
  const hash = keepHashRoutes && /^#[!/]/.test(u.hash) ? u.hash : '';
  return `${u.protocol}//${host}${port}${path}${qs ? `?${qs}` : ''}${hash}`;
}

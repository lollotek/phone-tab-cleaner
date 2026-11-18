/** Lettura e scrittura del file dei link (SPEC §5). */

export const FILE_HEADER = '# Link salvati\n';

const ENTRY_RE = /^\s*[-*+]\s+\[(?<title>[^\]]*)\]\((?<url>[^)\s]+)\)(?<rest>.*)$/u;
const TRAILING_TAGS_RE = /((?:\s+#[\p{L}\p{N}_/-]+)+)\s*$/u;
const TAG_RE = /#([\p{L}\p{N}_/-]+)/gu;
const BARE_URL_RE = /https?:\/\/[^\s<>()\]]+/g;

/**
 * @param {string} text contenuto del file
 * @param {(url:string)=>string} normalize funzione chiave per i doppioni
 * @returns {{keys:Set<string>, tags:Map<string,number>, entries:{title,url,description,tags}[]}}
 */
export function parseLinksFile(text, normalize) {
  const keys = new Set();
  const tags = new Map();
  const entries = [];

  for (const line of text.split(/\r?\n/)) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      let rest = m.groups.rest;
      const lineTags = [];
      const t = TRAILING_TAGS_RE.exec(rest);
      if (t) {
        for (const [, tag] of t[1].matchAll(TAG_RE)) lineTags.push(tag.toLowerCase());
        rest = rest.slice(0, t.index);
      }
      const description = rest.replace(/^\s*(?:—|–|-|:)\s*/, '').trim();
      entries.push({ title: m.groups.title, url: m.groups.url, description, tags: lineTags });
      keys.add(normalize(m.groups.url));
      for (const tag of lineTags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    // Qualsiasi altro URL nel file (anche scritto a mano) conta per i doppioni.
    for (const [u] of line.matchAll(BARE_URL_RE)) keys.add(normalize(u.replace(/[.,;:!?'"]+$/, '')));
  }
  return { keys, tags, entries };
}

const safeTitle = (s) => s.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
const safeUrl = (s) => s.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
// Un "#parola" dentro la descrizione verrebbe riletto come tag: lo si neutralizza.
const safeDescription = (s) => s.replace(/\s+/g, ' ').replace(/(^|\s)#(?=[\p{L}\p{N}])/gu, '$1').trim();

export function renderEntry({ title, url, description, tags = [] }) {
  let line = `- [${safeTitle(title) || url}](${safeUrl(url)})`;
  const d = description && safeDescription(description);
  if (d) line += ` — ${d}`;
  if (tags.length) line += ` ${tags.map((t) => `#${t}`).join(' ')}`;
  return line;
}

export function renderSection(heading, entries) {
  return `## ${heading}\n\n${entries.map(renderEntry).join('\n')}\n`;
}

/** Aggiunge una sezione in fondo al file, senza toccare il resto. */
export function appendSection(text, heading, entries) {
  let base = text && text.trim() ? text : FILE_HEADER;
  base = base.replace(/\s*$/, '\n');
  return `${base}\n${renderSection(heading, entries)}`;
}

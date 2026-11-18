/** Chiusura delle schede già salvate nel file (SPEC §6.5, `--close`). */
import readline from 'node:readline/promises';
import pc from 'picocolors';
import { classifyUrl } from './url.js';
import { cleanText, decodeEntities } from './util.js';

/**
 * Divide le schede tra da chiudere (URL presente nel file) e da lasciare aperte.
 * Le schede ignorate dal sync (chrome://, URL vuoti, IP locali…) non vengono mai chiuse.
 */
export function selectTabsToClose(tabs, keys, { normalize, includeLocal = false, exclude = [] }) {
  const close = [];
  const keep = [];
  for (const t of tabs) {
    const c = classifyUrl(t.url, { includeLocal, exclude });
    if (!c.skip && keys.has(normalize(c.url))) close.push(t);
    else keep.push(t);
  }
  return { close, keep };
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(s|si|sì|y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Rilegge le schede dalla sorgente (possono essere cambiate durante il sync) e chiude quelle salvate.
 * @param {Set<string>} keys chiavi normalizzate degli URL presenti nel file
 */
export async function closeSavedTabs({ source, cfg, log, keys, normalize, opts }) {
  const where = source.kind === 'pc' ? 'in Chrome sul PC' : 'sul telefono';
  return source.withTabs(async (dt) => {
    const tabs = await dt.listTabs();
    const { close, keep } = selectTabsToClose(tabs, keys, { normalize, includeLocal: opts.includeLocal ?? cfg.includeLocal, exclude: opts.exclude ?? cfg.exclude });
    if (!close.length) {
      log.ok('Nessuna scheda da chiudere.');
      return { closed: 0, failed: 0, kept: keep.length };
    }
    log.info(`  ${close.length} schede salvate da chiudere · ${keep.length} restano aperte`);
    for (const t of close) log.debug(`  chiudo: ${cleanText(decodeEntities(t.title ?? '')) || t.url}`);
    for (const t of keep) log.debug(`  resta:  ${t.url || '(vuota)'}`);

    if (opts.dryRun) {
      log.info(pc.yellow(`[dry-run] ${close.length} schede NON chiuse`));
      return { closed: 0, failed: 0, kept: keep.length, dryRun: true };
    }
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        log.warn('Conferma non possibile senza terminale interattivo: nessuna scheda chiusa (usa --yes).');
        return { closed: 0, failed: 0, kept: tabs.length, cancelled: true };
      }
      if (!(await confirm(`? Chiudere ${close.length} schede ${where}? (s/N) `))) {
        log.info('Chiusura annullata.');
        return { closed: 0, failed: 0, kept: tabs.length, cancelled: true };
      }
    }

    let closed = 0;
    const failed = [];
    for (const t of close) {
      try {
        await dt.closeTab(t.id);
        closed++;
      } catch (e) {
        failed.push(`${t.url} (${e.message})`);
      }
    }
    log.ok(`${closed} schede chiuse ${where}`);
    if (source.kind === 'phone') log.info('  Nota: le "schede inattive" di Chrome non sono visibili al tool; ripristinale in Chrome per includerle.');
    failed.forEach((f) => log.warn(`non chiusa: ${f}`));
    return { closed, failed: failed.length, kept: keep.length };
  });
}

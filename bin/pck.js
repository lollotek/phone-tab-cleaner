#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { Adb, resolveDevice } from '../src/adb.js';
import { openSource } from '../src/sources/index.js';
import { loadConfig, USER_CONFIG, LOCAL_CONFIG } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { runSync } from '../src/sync.js';
import { runRetag } from '../src/retag.js';
import { mergeTags, removeTags, renameTag, showTagStats } from '../src/tags.js';
import { runCheck } from '../src/check.js';
import { startUi } from '../src/ui/server.js';
import { PROVIDERS } from '../src/tagger/ai/index.js';
import { cleanText, decodeEntities } from '../src/util.js';

const pkg = createRequire(import.meta.url)('../package.json');
const program = new Command();

program
  .name('pck')
  .description('PhoneCleanKit — salva le schede Chrome del telefono in un file Markdown')
  .version(pkg.version)
  .option('--source <phone|pc>', 'da dove leggere le schede: phone (adb) o pc (Chrome locale); default da config')
  .option('-s, --serial <id>', 'dispositivo adb (es. 192.168.1.2:41401)')
  .option('--adb <path>', 'percorso di adb.exe')
  .option('-v, --verbose', 'log dettagliato');

function context() {
  const o = program.opts();
  const cfg = loadConfig();
  if (o.adb) cfg.adbPath = o.adb;
  const log = createLogger(o.verbose);
  return { cfg, log, adb: new Adb(cfg.adbPath, log), global: o };
}

const action = (fn) => async (...args) => {
  let log = createLogger(program.opts().verbose);
  try {
    // Anche gli errori di configurazione (es. JSON non valido) devono arrivare come messaggio, non come stack trace.
    const ctx = context();
    log = ctx.log;
    await fn(ctx, ...args);
  } catch (e) {
    log.error(e.message);
    if (log.verbose && !e.exitCode) log.debug(e.stack);
    process.exitCode = e.exitCode ?? 1;
  }
};

program
  .command('pair <hostPort> <code>')
  .description('abbina il telefono (Debug wireless → Abbina dispositivo con codice)')
  .action(action(async ({ adb, log }, hostPort, code) => {
    const out = await adb.pair(hostPort, code);
    if (!/success/i.test(out)) throw Object.assign(new Error(`Abbinamento fallito: ${out}`), { exitCode: 2 });
    log.ok(out);
    log.info('Ora collega con: pck connect <ip:porta>  (la porta di connessione è diversa da quella di abbinamento)');
  }));

program
  .command('connect [hostPort]')
  .description('connette il telefono (senza argomenti: mDNS o ultimo indirizzo usato)')
  .action(action(async ({ adb, cfg, log, global }, hostPort) => {
    const dev = await resolveDevice(adb, cfg, { serial: hostPort ?? global.serial }, log);
    log.ok(`Connesso a ${dev.serial}${dev.model ? ` (${dev.model})` : ''}`);
  }));

/** Apre la sorgente scelta (--source), esegue fn e la rilascia. */
async function withSource({ adb, cfg, log, global }, fn) {
  const source = await openSource(global.source ?? cfg.defaultSource, { adb, cfg, log, opts: { serial: global.serial } });
  try {
    return await source.withTabs((dt, version) => fn(dt, version, source));
  } finally {
    await source.dispose();
  }
}

program
  .command('status')
  .description('mostra sorgente, versione di Chrome e numero di schede')
  .action(action(async (ctx) => {
    await withSource(ctx, async (dt, version) => {
      ctx.log.ok(`Browser: ${version.Browser}`);
      ctx.log.ok(`Schede aperte: ${(await dt.listTabs()).length}`);
    });
  }));

program
  .command('tabs')
  .description('elenca le schede aperte (solo lettura)')
  .option('--json', 'output JSON')
  .action(action(async (ctx, opts) => {
    const { log } = ctx;
    const tabs = await withSource(ctx, (dt) => dt.listTabs());
    const clean = tabs.map((t) => ({ ...t, title: cleanText(decodeEntities(t.title ?? '')) }));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
      return;
    }
    clean.forEach((t, i) => process.stdout.write(`${String(i + 1).padStart(3)}. ${t.title || '(senza titolo)'}\n     ${t.url}\n`));
    log.info(`\n${clean.length} schede`);
  }));

program
  .command('sync')
  .description('salva le schede nuove nel file Markdown')
  .option('-f, --file <path>', 'file markdown di destinazione (default: config defaultFile)')
  .option('--no-fetch', 'non scaricare le pagine (niente descrizioni)')
  .option('--dry-run', 'mostra le voci senza scrivere il file (e senza chiudere schede)')
  .option('--close', 'dopo il salvataggio chiude (telefono o PC) le schede presenti nel file')
  .option('-y, --yes', 'non chiedere conferma per --close')
  .option('--include-local', 'includi URL locali (localhost, IP privati)')
  .option('--concurrency <n>', 'download paralleli dei metadati')
  .option('--ai [provider]', 'descrizioni e tag con un LLM: local | claude | gemini (default da config)')
  .option('--model <nome>', 'modello del provider AI')
  .option('--lang <codice>', 'lingua delle descrizioni (default: it)')
  .option('--instructions <file>', 'indicazioni personali per l\'AI (default: pck.prompt.md)')
  .action(action(async ({ adb, cfg, log, global }, opts) => {
    await runSync({ cfg, adb, log, opts: { ...opts, serial: global.serial, source: global.source } });
  }));

program
  .command('describe <url...>')
  .description('anteprima di descrizione e tag per URL dati a mano (senza telefono, non scrive nulla)')
  .option('-f, --file <path>', 'file markdown usato come riferimento per tag e doppioni')
  .option('--ai [provider]', 'local | claude | gemini')
  .option('--model <nome>', 'modello del provider AI')
  .option('--lang <codice>', 'lingua delle descrizioni')
  .option('--instructions <file>', 'indicazioni personali per l\'AI (default: pck.prompt.md)')
  .option('--include-local', 'includi URL locali')
  .action(action(async ({ adb, cfg, log }, urls, opts) => {
    // `--ai [provider]` può "mangiarsi" il primo URL (es. `describe --ai https://…`): lo si restituisce alla lista.
    if (typeof opts.ai === 'string' && !PROVIDERS.includes(opts.ai)) {
      urls.unshift(opts.ai);
      opts.ai = true;
    }
    await runSync({ cfg, adb, log, opts: { ...opts, urls, dryRun: true } });
  }));

const collect = (v, acc) => [...acc, ...v.split(',').map((s) => s.trim()).filter(Boolean)];

program
  .command('retag')
  .description('rigenera descrizione e tag di voci già presenti nel file (titolo e URL invariati)')
  .option('-f, --file <path>', 'file markdown (default: config defaultFile)')
  .option('--tag <tag>', 'voci con questo tag (ripetibile o separato da virgole)', collect, [])
  .option('--empty', 'voci senza descrizione')
  .option('--lang-mismatch', 'voci con la descrizione in un\'altra lingua (riconosce italiano/inglese)')
  .option('--all', 'tutte le voci (nell\'ambito di --section / --url)')
  .option('--section <titolo>', 'solo la sezione indicata (es. "2026-11-14")')
  .option('--url <testo>', 'solo le voci il cui URL contiene il testo')
  .option('--limit <n>', 'al massimo n voci')
  .option('--ai [provider]', 'provider AI: local | claude | gemini (default da config)')
  .option('--no-ai', 'usa solo le regole (metadati + tagRules)')
  .option('--model <nome>', 'modello del provider AI')
  .option('--lang <codice>', 'lingua delle descrizioni (default: it)')
  .option('--instructions <file>', 'indicazioni personali per l\'AI (default: pck.prompt.md)')
  .option('--no-fetch', 'non scaricare le pagine (solo titolo e URL)')
  .option('--dry-run', 'mostra prima/dopo senza modificare il file')
  .action(action(async ({ cfg, log }, opts) => {
    await runRetag({ cfg, log, opts });
  }));

const tags = program.command('tags').description('statistiche e gestione dei tag del file (rename, merge, remove)');

tags
  .command('stats', { isDefault: true })
  .description('utilizzi per tag, tag usati una sola volta, coppie frequenti')
  .option('-f, --file <path>', 'file markdown (default: config defaultFile)')
  .option('--json', 'output JSON')
  .action(action(async ({ cfg, log }, opts) => {
    await showTagStats({ cfg, log, opts });
  }));

tags
  .command('rename <vecchio> <nuovo>')
  .description('rinomina un tag nel file e aggiunge l\'alias vecchio → nuovo nel config (se il nuovo esiste già, li accorpa)')
  .option('-f, --file <path>', 'file markdown')
  .option('--dry-run', 'mostra prima/dopo senza modificare file e config')
  .action(action(async (ctx, from, to, opts) => {
    await renameTag(from, to, { ...ctx, opts });
  }));

tags
  .command('merge <tag...>')
  .description('accorpa più tag in uno (--into), con alias nel config')
  .requiredOption('--into <tag>', 'tag di destinazione')
  .option('-f, --file <path>', 'file markdown')
  .option('--dry-run', 'mostra prima/dopo senza modificare file e config')
  .action(action(async (ctx, list, opts) => {
    await mergeTags(list, opts.into, { ...ctx, opts });
  }));

tags
  .command('remove <tag...>')
  .description('toglie uno o più tag da tutte le voci')
  .option('-f, --file <path>', 'file markdown')
  .option('--dry-run', 'mostra prima/dopo senza modificare il file')
  .action(action(async (ctx, list, opts) => {
    await removeTags(list, { ...ctx, opts });
  }));

program
  .command('check')
  .description('controlla links.md (sola lettura): righe malformate, URL doppi o non validi, voci senza tag/descrizione')
  .option('-f, --file <path>', 'file markdown (default: config defaultFile)')
  .option('--links', 'verifica anche i link morti (una richiesta per voce)')
  .option('--concurrency <n>', 'richieste parallele con --links')
  .option('--max <n>', 'righe mostrate per tipo di problema (default 10)')
  .option('--json', 'output JSON')
  .action(action(async ({ cfg, log }, opts) => {
    await runCheck({ cfg, log, opts });
  }));

program
  .command('ui')
  .description('interfaccia web locale: elenco, ricerca, modifica dei tag, cestino e funzioni del tool')
  .option('-f, --file <path>', 'file markdown (default: config defaultFile)')
  .option('--port <n>', 'porta (default 4317, esclusa da sync e chiusura)')
  .option('--no-open', 'non aprire il browser')
  .action(action(async ({ cfg, adb, log }, opts) => {
    await startUi({ cfg, adb, log, opts });
  }));

program
  .command('config-path')
  .description('mostra dove vengono letti/salvati i file di configurazione')
  .action(action(async () => {
    process.stdout.write(`utente: ${USER_CONFIG}\nprogetto: ${LOCAL_CONFIG} (cartella corrente)\n`);
  }));

program.parseAsync();

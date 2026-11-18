import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline/promises';
import { PckError, EXIT } from './errors.js';
import { saveUserConfig } from './config.js';

const exec = promisify(execFile);
const isHostPort = (s) => /^[\w.-]+:\d+$/.test(s);

export class Adb {
  constructor(adbPath, log) {
    this.path = adbPath;
    this.log = log;
  }

  async run(args, { serial, timeout = 20000 } = {}) {
    const full = serial ? ['-s', serial, ...args] : args;
    this.log?.debug(`$ adb ${full.join(' ')}`);
    try {
      const { stdout } = await exec(this.path, full, { windowsHide: true, timeout });
      return stdout.trim();
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new PckError(`adb non trovato in "${this.path}". Imposta "adbPath" in pck.config.json, la variabile PCK_ADB_PATH o l'opzione --adb.`, EXIT.DEVICE);
      }
      const detail = e.killed ? `nessuna risposta entro ${Math.round(timeout / 1000)} s` : (e.stderr || e.stdout || e.message).trim();
      throw new PckError(`adb ${full.join(' ')} fallito: ${detail}`, EXIT.DEVICE);
    }
  }

  pair(hostPort, code) {
    return this.run(['pair', hostPort, code], { timeout: 30000 });
  }

  async connect(hostPort) {
    let out;
    try {
      out = await this.run(['connect', hostPort], { timeout: 30000 });
    } catch (e) {
      out = e.message;
    }
    out = out.replace(/^cannot connect to [^:]+:\d+:\s*/i, '');
    return { ok: /connected to/i.test(out) && !/cannot|failed/i.test(out), out };
  }

  /** @returns {Promise<{serial:string,state:string,model?:string}[]>} */
  async devices() {
    const out = await this.run(['devices', '-l']);
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        const model = /model:(\S+)/.exec(l)?.[1]?.replace(/_/g, ' ');
        return { serial, state, model };
      });
  }

  /** Servizi adb wireless annunciati via mDNS (porta di connessione). */
  async mdnsConnectServices() {
    const out = await this.run(['mdns', 'services']).catch(() => '');
    return out
      .split(/\r?\n/)
      .filter((l) => l.includes('_adb-tls-connect._tcp'))
      .map((l) => /(\d{1,3}(?:\.\d{1,3}){3}:\d+)/.exec(l)?.[1])
      .filter(Boolean);
  }
}

async function choose(devices) {
  if (!process.stdin.isTTY) {
    throw new PckError(`Più dispositivi collegati (${devices.map((d) => d.serial).join(', ')}): specifica --serial.`, EXIT.DEVICE);
  }
  devices.forEach((d, i) => process.stderr.write(`  ${i + 1}) ${d.serial}${d.model ? ` (${d.model})` : ''}\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const n = Number(await rl.question('Quale dispositivo? '));
    if (!devices[n - 1]) throw new PckError('Scelta non valida.', EXIT.DEVICE);
    return devices[n - 1];
  } finally {
    rl.close();
  }
}

/**
 * Lo stesso telefono può comparire più volte (ip:porta e nome mDNS "adb-XXXX._adb-tls-connect._tcp").
 * Si raggruppa per numero di serie hardware, preferendo l'ultimo indirizzo usato, poi un ip:porta.
 */
async function uniqueDevices(adb, list, lastDevice) {
  if (list.length < 2) return list;
  const groups = new Map();
  for (const d of list) {
    // `adb get-serialno` restituisce il nome del trasporto: serve la proprietà di sistema.
    const hw = (await adb.run(['shell', 'getprop', 'ro.serialno'], { serial: d.serial }).catch(() => '')) || d.serial;
    groups.set(hw, [...(groups.get(hw) ?? []), d]);
  }
  const rank = (d) => (d.serial === lastDevice ? 0 : isHostPort(d.serial) ? 1 : 2);
  return [...groups.values()].map((g) => g.sort((a, b) => rank(a) - rank(b))[0]);
}

function remember(serial) {
  if (isHostPort(serial)) {
    try { saveUserConfig({ lastDevice: serial }); } catch { /* non bloccante */ }
  }
}

/**
 * Trova il dispositivo da usare: --serial → unico collegato → scelta → mDNS → ultimo indirizzo.
 * @returns {Promise<{serial:string, model?:string}>}
 */
export async function resolveDevice(adb, cfg, { serial } = {}, log) {
  const ready = async () => (await adb.devices()).filter((d) => d.state === 'device');

  if (serial) {
    if (isHostPort(serial)) {
      const r = await adb.connect(serial);
      if (!r.ok) throw new PckError(`Connessione a ${serial} fallita: ${r.out}\nControlla IP e porta in "Debug wireless" (la porta cambia a ogni riattivazione).`, EXIT.DEVICE);
      remember(serial);
    }
    const dev = (await ready()).find((d) => d.serial === serial);
    if (!dev) throw new PckError(`Dispositivo ${serial} non disponibile.`, EXIT.DEVICE);
    return dev;
  }

  let list = await uniqueDevices(adb, await ready(), cfg.lastDevice);
  if (list.length === 1) return list[0];
  if (list.length > 1) return choose(list);

  const unauthorized = (await adb.devices()).find((d) => d.state === 'unauthorized');
  if (unauthorized) throw new PckError(`${unauthorized.serial} non autorizzato: accetta la richiesta sul telefono.`, EXIT.DEVICE);

  const candidates = [...new Set([...(await adb.mdnsConnectServices()), cfg.lastDevice].filter(Boolean))];
  for (const hp of candidates) {
    log?.debug(`Provo ${hp}…`);
    const r = await adb.connect(hp);
    if (r.ok) {
      remember(hp);
      list = await ready();
      const dev = list.find((d) => d.serial === hp) ?? list[0];
      if (dev) return dev;
    }
  }

  const offline = (await adb.devices()).filter((d) => d.state === 'offline').map((d) => d.serial);
  const why = [
    candidates.length ? `  Provati senza successo: ${candidates.join(', ')}` : '',
    offline.length ? `  Stato "offline": ${offline.join(', ')} → il telefono ha chiuso la connessione (schermo in standby o debug wireless disattivato); la porta sarà cambiata.` : '',
  ].filter(Boolean).join('\n');
  throw new PckError(
    `Nessun dispositivo collegato.${why ? `\n${why}` : ''}\n` +
      '  1. Sul telefono: Opzioni sviluppatore → Debug wireless (attivo, schermo acceso)\n' +
      '  2. Prima volta: pck pair <ip:porta-abbinamento> <codice>\n' +
      '  3. Poi:         pck connect <ip:porta>   (oppure --serial <ip:porta>)',
    EXIT.DEVICE,
  );
}

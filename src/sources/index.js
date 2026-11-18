/**
 * Sorgenti di schede. Ognuna espone:
 *   kind, label, retryHint
 *   withTabs(fn)  → fn({ listTabs(), closeTab(id) }, version)
 *   dispose()
 */
import { resolveDevice } from '../adb.js';
import { withDevtools } from '../chrome.js';
import { PckError } from '../errors.js';
import { openPcSource } from './pc.js';

export const SOURCES = ['phone', 'pc'];

async function openPhoneSource({ adb, cfg, log, opts }) {
  const dev = await resolveDevice(adb, cfg, opts, log);
  log.ok(`Connesso a ${dev.serial}${dev.model ? ` (${dev.model})` : ''}`);
  return {
    kind: 'phone',
    label: 'Chrome (telefono)',
    retryHint: 'Riconnetti il telefono e riprova con: pck sync --close (i link già salvati non vengono riscritti)',
    withTabs: (fn) => withDevtools(adb, dev.serial, cfg, fn, log),
    dispose: async () => {},
  };
}

export async function openSource(kind, ctx) {
  if (kind === 'phone') return openPhoneSource(ctx);
  if (kind === 'pc') return openPcSource(ctx);
  throw new PckError(`Sorgente sconosciuta "${kind}". Disponibili: ${SOURCES.join(', ')}.`);
}

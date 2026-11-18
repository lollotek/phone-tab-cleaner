#!/usr/bin/env node
// Spike M0: connette il telefono via adb wireless e stampa le schede aperte di Chrome.
// Uso: node scripts/spike-tabs.mjs [ip:porta] [--json]
//   env PCK_ADB_PATH per un adb diverso da quello di default.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

const run = promisify(execFile);
const ADB = process.env.PCK_ADB_PATH ?? 'D:\\programmi\\scrcpy-win64-v3.3.4\\adb.exe';
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? '192.168.1.2:39271';
const asJson = args.includes('--json');

const adb = async (...a) => (await run(ADB, a, { windowsHide: true })).stdout.trim();

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${path}`);
  return res.json();
}

async function main() {
  const out = await adb('connect', target);
  console.error(`adb connect: ${out}`);
  if (!/connected to/.test(out)) process.exit(2);

  const port = await freePort();
  await adb('-s', target, 'forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote');
  try {
    let version;
    try {
      version = await getJson(port, '/json/version');
    } catch {
      console.error('Socket DevTools non disponibile: avvio Chrome e riprovo...');
      await adb('-s', target, 'shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
      await new Promise((r) => setTimeout(r, 3000));
      version = await getJson(port, '/json/version');
    }
    console.error(`Browser: ${version.Browser} (${version['Android-Package'] ?? '?'})`);

    const targets = await getJson(port, '/json/list');
    const pages = targets.filter((t) => t.type === 'page');
    if (asJson) {
      console.log(JSON.stringify(pages, null, 2));
    } else {
      pages.forEach((p, i) => console.log(`${String(i + 1).padStart(3)}. ${p.title || '(senza titolo)'}\n     ${p.url}`));
      const types = targets.reduce((m, t) => ((m[t.type] = (m[t.type] ?? 0) + 1), m), {});
      console.error(`\nTotale target: ${targets.length} ${JSON.stringify(types)} · schede (page): ${pages.length}`);
    }
  } finally {
    await adb('-s', target, 'forward', '--remove', `tcp:${port}`).catch(() => {});
  }
}

main().catch((e) => {
  console.error(`Errore: ${e.message}`);
  process.exit(1);
});

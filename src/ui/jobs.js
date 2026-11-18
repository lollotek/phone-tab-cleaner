/**
 * Operazioni lunghe avviate dalla pagina (sync, rigenera, controlla, apri): una alla volta,
 * con il log trasmesso in tempo reale ai client collegati via Server-Sent Events.
 */
import { PckError } from '../errors.js';

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s).replace(ANSI, '');

export const LOCKED = 10; // codice per "operazione in corso" (HTTP 423)

export function createJobRunner() {
  const clients = new Set();
  let current = null;
  let last = null;
  let seq = 0;

  const send = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };

  /** Logger compatibile con quello della CLI, che inoltra le righe alla pagina. */
  function jobLogger(job) {
    const push = (level) => (text) => {
      const line = { level, text: strip(text), at: Date.now() };
      job.log.push(line);
      if (job.log.length > 2000) job.log.shift();
      send('log', { id: job.id, ...line });
    };
    return { verbose: false, info: push('info'), ok: push('ok'), warn: push('warn'), error: push('error'), debug: () => {} };
  }

  const snapshot = (j) => j && { id: j.id, type: j.type, label: j.label, writes: j.writes, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, result: j.result, error: j.error, log: j.log };

  return {
    get current() { return current; },
    /** true se è in corso un'operazione che scrive links.md: le modifiche dalla pagina vanno respinte. */
    get writeLocked() { return Boolean(current?.writes); },
    state: () => ({ current: snapshot(current), last: snapshot(last) }),

    start(type, label, { writes = false } = {}, fn) {
      if (current) throw new PckError(`Operazione già in corso: ${current.label}`, LOCKED);
      const job = { id: ++seq, type, label, writes, status: 'running', startedAt: Date.now(), log: [] };
      current = job;
      send('start', snapshot(job));
      const log = jobLogger(job);
      const prevExit = process.exitCode;
      Promise.resolve()
        .then(() => fn(log))
        .then((result) => { job.status = 'done'; job.result = result ?? null; })
        .catch((e) => { job.status = 'error'; job.error = strip(e.message); log.error(e.message); })
        .finally(() => {
          process.exitCode = prevExit; // i comandi CLI riusati possono impostarlo
          job.endedAt = Date.now();
          last = job;
          current = null;
          send('end', snapshot(job));
        });
      return snapshot(job);
    },

    /** Collega una risposta HTTP come client SSE. */
    attach(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ current: snapshot(current) })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      res.on('close', () => { clearInterval(ping); clients.delete(res); });
    },

    /** Notifica generica (es. file cambiato), così le altre schede del browser si aggiornano. */
    broadcast: send,
  };
}

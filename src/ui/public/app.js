// PhoneCleanKit UI — nessuna dipendenza esterna. Tutto il testo dal file passa da esc() prima di finire nell'HTML.

// ── token e API ───────────────────────────────────────────────────────────────────────────────────────
const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromHash) {
  try { sessionStorage.setItem('pck-token', fromHash); } catch { /* sessione privata */ }
  history.replaceState(null, '', location.pathname); // il token non resta nella barra degli indirizzi
}
let TOKEN = fromHash;
try { TOKEN ??= sessionStorage.getItem('pck-token'); } catch { /* ignora */ }
// Indirizzo riaperto nella stessa scheda (cambia solo il #): il browser non ricarica, lo facciamo noi col nuovo token.
window.addEventListener('hashchange', () => {
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  if (t) { try { sessionStorage.setItem('pck-token', t); } catch { /* ignora */ } location.replace(location.pathname); }
});

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-pck-token': TOKEN ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

// ── stato ─────────────────────────────────────────────────────────────────────────────────────────────
const S = {
  data: null,            // risposta di /api/state
  selected: new Set(),   // chiavi selezionate
  editing: null,         // { key, field: 'tags'|'description' }
  view: 'list',          // 'list' | 'trash'
  trash: [],
  issues: null,          // Map chiave → problemi (dopo "Controlla")
  job: null,
  waiters: new Map(),    // id operazione → { resolve, reject }
  ended: new Map(),      // id operazione → stato finale (l'evento "end" può arrivare prima della risposta di avvio)
  staleFile: false,      // il file è cambiato mentre si modificava una riga
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).join('-');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isHttp = (u) => /^https?:\/\//i.test(u);

const ICONS = {
  tags: '<path d="M3 8V4a1 1 0 0 1 1-1h4l9 9-5 5-9-9Z"/><circle cx="7" cy="7" r="1.3"/>',
  edit: '<path d="M4 16v4h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
  ai: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6 6 2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7"/><path d="M4 4v4.7h4.7"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ── notifiche e dialoghi ──────────────────────────────────────────────────────────────────────────────
function toast(msg, { error = false, action, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.append(b);
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? ms * 2 : ms);
}

function handleError(e) {
  if (e.status === 401) return toast('Sessione non valida: riapri l\'indirizzo mostrato nel terminale da pck ui.', { error: true, ms: 15000 });
  if (e.status === 409) { toast('Il file è stato modificato altrove: ho ricaricato l\'elenco.', { error: true }); return load(); }
  toast(e.message, { error: true, ms: 8000 });
}

/**
 * Dialogo modale. `validate(form)` può restituire un messaggio d'errore: il dialogo resta aperto e lo mostra.
 * @returns {Promise<FormData|null>} null se annullato
 */
function dialog({ title, html, ok = 'OK', danger = false, onOpen, validate }) {
  const dlg = $('#dlg');
  const form = $('#dlg-form');
  const err = $('#dlg-error');
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = html;
  err.hidden = true;
  const okBtn = $('#dlg-ok');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'danger' : 'primary';
  dlg.returnValue = '';
  const onSubmit = (ev) => {
    if (ev.submitter?.value !== 'ok' || !validate) return;
    const msg = validate(form);
    if (msg) { ev.preventDefault(); err.textContent = msg; err.hidden = false; }
  };
  const clearErr = () => { err.hidden = true; };
  form.addEventListener('submit', onSubmit);
  form.addEventListener('input', clearErr);
  dlg.showModal();
  onOpen?.(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('input', clearErr);
      resolve(dlg.returnValue === 'ok' ? new FormData(form) : null);
    }, { once: true });
  });
}

/** Mostra l'esito di un'azione dentro un dialogo aperto (es. "Verifica connessione"). */
function setRes(el, ok, text) {
  el.className = `res ${ok ? 'ok' : 'bad'}`;
  el.textContent = text;
}

// ── caricamento ───────────────────────────────────────────────────────────────────────────────────────
async function load() {
  try {
    S.data = await api('/api/state');
    S.staleFile = false;
    const keys = new Set(S.data.entries.map((e) => e.key));
    for (const k of S.selected) if (!keys.has(k) && S.view === 'list') S.selected.delete(k);
    if (S.view === 'trash') S.trash = (await api('/api/trash')).entries;
    renderAll();
  } catch (e) {
    handleError(e);
  }
}

async function loadStatus(force = false) {
  try {
    const st = await api(`/api/status${force ? '?force=1' : ''}`);
    const set = (id, s, label) => {
      const el = $(id);
      el.className = `pill ${s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'unk'}`;
      el.textContent = label;
      el.title = s.detail ?? '';
    };
    set('#st-ai', st.ai, st.ai.ok ? `AI · ${st.ai.model ?? st.ai.provider}` : `AI ${st.ai.provider} · non pronta`);
    set('#st-phone', st.phone, st.phone.ok ? `Telefono · ${st.phone.model ?? st.phone.serial}` : 'Telefono offline');
    set('#st-pc', st.pc, st.pc.ok ? 'Chrome PC · pronto' : 'Chrome PC · non attivo');
    $('#opt-ai').title = st.ai.ok ? `Usa ${st.ai.provider} (${st.ai.model ?? ''})` : `AI non pronta: ${st.ai.detail ?? ''}`;
  } catch (e) {
    if (e.status === 401) handleError(e);
  }
}

// ── filtro ────────────────────────────────────────────────────────────────────────────────────────────
function parseQuery(q) {
  const inc = [];
  const exc = [];
  const words = [];
  const notWords = [];
  for (const raw of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('-#')) exc.push(slug(raw.slice(2)));
    else if (raw.startsWith('#')) inc.push(slug(raw.slice(1)));
    else if (raw.startsWith('-') && raw.length > 1) notWords.push(raw.slice(1));
    else words.push(raw);
  }
  return { inc, exc, words, notWords };
}

function visibleEntries() {
  const list = S.view === 'trash' ? S.trash : (S.data?.entries ?? []);
  const { inc, exc, words, notWords } = parseQuery($('#q').value);
  const section = $('#f-section').value;
  const onlyProblems = S.view === 'list' && S.issues && $('#f-problems').checked;
  return list.filter((e) => {
    if (section && e.section !== section) return false;
    if (onlyProblems && !S.issues.has(e.key)) return false;
    if (inc.some((t) => !e.tags.includes(t))) return false;
    if (exc.some((t) => e.tags.includes(t))) return false;
    const hay = `${e.title} ${e.url} ${e.description}`.toLowerCase();
    return words.every((w) => hay.includes(w)) && !notWords.some((w) => hay.includes(w));
  });
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderTagbar();
  renderList();
  renderBulk();
}

function renderHeader() {
  const d = S.data;
  if (!d) return;
  const name = d.file.split(/[\\/]/).pop();
  $('#fileinfo').textContent = `${name} · ${d.entries.length} voci · ${d.tags.length} tag`;
  $('#btn-trash').textContent = S.view === 'trash' ? '← Torna all\'elenco' : `Cestino (${d.trashCount})`;
  $('#btn-trash').setAttribute('aria-pressed', String(S.view === 'trash'));
  const sel = $('#f-section');
  const current = sel.value;
  const sections = S.view === 'trash' ? [...new Set(S.trash.map((e) => e.section).filter(Boolean))] : d.sections;
  sel.innerHTML = `<option value="">Tutte le sezioni</option>${sections.map((s) => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;
  $('#f-problems-wrap').hidden = !(S.issues && S.view === 'list');
  if (S.issues) $('#f-problems-n').textContent = `(${S.issues.size})`;
}

function renderTagbar() {
  if (!S.data) return;
  const { inc, exc } = parseQuery($('#q').value);
  const counts = new Map();
  const source = S.view === 'trash' ? S.trash : S.data.entries;
  for (const e of source) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  $('#tagbar').innerHTML = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `<span class="chip${inc.includes(t) ? ' on' : ''}${exc.includes(t) ? ' off' : ''}" data-tag="${esc(t)}" title="Clic: filtra · Alt+clic: escludi">#${esc(t)} <span class="n">${n}</span></span>`)
    .join('');
}

const ISSUE_LABELS = {
  'riga-malformata': 'riga malformata', 'url-non-valido': 'URL non valido', 'url-doppio': 'doppione', 'link-morto': 'link morto',
  'senza-tag': 'senza tag', 'senza-descrizione': 'senza descrizione', 'tag-non-valido': 'tag non valido', 'non-verificabile': 'non verificabile',
};

function rowHtml(e) {
  const trash = S.view === 'trash';
  const sel = S.selected.has(e.key);
  const ed = S.editing?.key === e.key ? S.editing.field : null;
  const title = isHttp(e.url)
    ? `<a class="t" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || e.url)}</a>`
    : `<span class="t">${esc(e.title || e.url)}</span>`;
  const desc = ed === 'description'
    ? `<div class="edit"><textarea data-edit-input="description" aria-label="Descrizione">${esc(e.description)}</textarea><button class="primary" data-save>Salva</button><button class="ghost" data-cancel>Annulla</button></div>`
    : `<div class="d${e.description ? '' : ' empty'}">${esc(e.description || 'Nessuna descrizione')}</div>`;
  const tags = ed === 'tags'
    ? `<div class="edit"><input type="text" data-edit-input="tags" value="${esc(e.tags.map((t) => `#${t}`).join(' '))}" aria-label="Tag (separati da spazi)" autocomplete="off"><button class="primary" data-save>Salva</button><button class="ghost" data-cancel>Annulla</button><div class="sugg" data-sugg></div></div>`
    : `<div class="tags">${e.tags.map((t) => `<span class="chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}</div>`;
  const issues = !trash && S.issues?.get(e.key);
  const issueHtml = issues ? `<div class="issues">${issues.map((i) => `<span class="issue${i.severity === 'errore' ? ' err' : ''}" title="${esc(i.message)}">${esc(ISSUE_LABELS[i.kind] ?? i.kind)}</span>`).join('')}</div>` : '';
  const acts = trash
    ? `<button class="ib" data-row="restore" title="Ripristina nell'elenco" aria-label="Ripristina">${icon('restore')}</button>`
      + `<button class="ib danger" data-row="purge" title="Elimina definitivamente" aria-label="Elimina definitivamente">${icon('trash')}</button>`
    : `<button class="ib" data-row="tags" title="Modifica tag" aria-label="Modifica tag">${icon('tags')}</button>`
      + `<button class="ib" data-row="description" title="Modifica descrizione" aria-label="Modifica descrizione">${icon('edit')}</button>`
      + `<button class="ib" data-row="retag" title="Rigenera descrizione e tag con l'AI" aria-label="Rigenera con AI">${icon('ai')}</button>`
      + `<button class="ib" data-row="open-phone" title="Apri sul telefono" aria-label="Apri sul telefono">${icon('phone')}</button>`
      + `<button class="ib" data-row="open-pc" title="Apri in Chrome sul PC" aria-label="Apri sul PC">${icon('pc')}</button>`
      + `<button class="ib danger" data-row="delete" title="Sposta nel cestino" aria-label="Elimina">${icon('trash')}</button>`;
  return `<div class="row${sel ? ' sel' : ''}" data-key="${esc(e.key)}">
    <input type="checkbox" data-sel ${sel ? 'checked' : ''} aria-label="Seleziona ${esc(e.title)}">
    <div class="body">${title}<span class="host">${esc(hostOf(e.url))}</span>${e.section ? `<span class="sec">${esc(e.section)}</span>` : ''}${desc}${tags}${issueHtml}</div>
    <div class="acts">${acts}</div>
  </div>`;
}

function renderList() {
  if (!S.data) return;
  const vis = visibleEntries();
  const total = S.view === 'trash' ? S.trash.length : S.data.entries.length;
  $('#count').textContent = `${vis.length} di ${total}${S.view === 'trash' ? ' nel cestino' : ''}`;
  $('#sel-all').checked = vis.length > 0 && vis.every((e) => S.selected.has(e.key));
  $('#list').innerHTML = vis.length
    ? vis.map(rowHtml).join('')
    : `<div class="empty-state">${S.view === 'trash' ? 'Il cestino è vuoto.' : total ? 'Nessuna voce corrisponde alla ricerca.' : 'Il file non ha ancora voci: usa Sync telefono o Sync PC.'}</div>`;
  const input = $('[data-edit-input]');
  if (input) {
    input.focus();
    if (input.dataset.editInput === 'tags') { input.setSelectionRange(input.value.length, input.value.length); renderSuggestions(input); }
  }
}

function renderBulk() {
  const n = S.selected.size;
  $('#bulk').classList.toggle('empty', n === 0);
  $('#bulk-n').textContent = n ? `${n} selezionat${n === 1 ? 'a' : 'e'}` : 'Nessuna selezione';
  $('#bulk-list-actions').hidden = S.view === 'trash';
  $('#bulk-trash-actions').hidden = S.view !== 'trash';
}

/** Suggerimenti per l'ultimo tag che si sta scrivendo (dal vocabolario del file). */
function renderSuggestions(input) {
  const box = input.parentElement.querySelector('[data-sugg]');
  if (!box) return;
  const typed = input.value.split(/\s+/);
  const last = slug((typed.at(-1) ?? '').replace(/^#/, ''));
  const used = new Set(typed.map((t) => slug(t.replace(/^#/, ''))));
  const list = S.data.tags.map((t) => t.tag).filter((t) => !used.has(t) && (!last || t.includes(last))).slice(0, 12);
  box.innerHTML = list.map((t) => `<span class="chip" data-sugg-tag="${esc(t)}">#${esc(t)}</span>`).join('');
}

const parseTags = (s) => [...new Set(s.split(/[\s,]+/).map((t) => slug(t.replace(/^#/, ''))).filter(Boolean))];

// ── operazioni lunghe ─────────────────────────────────────────────────────────────────────────────────
function showJob(job, { done = false } = {}) {
  const box = $('#job');
  box.hidden = false;
  box.classList.toggle('done', done && job.status === 'done');
  box.classList.toggle('err', done && job.status === 'error');
  $('#job-label').textContent = done ? `${job.label} · ${job.status === 'done' ? 'completata' : 'errore'}` : job.label;
  const lines = job.log ?? [];
  $('#job-log').textContent = lines.map((l) => `${l.level === 'error' ? '✖ ' : l.level === 'warn' ? '⚠ ' : l.level === 'ok' ? '✔ ' : ''}${l.text}`).join('\n');
  $('#job-last').textContent = job.error ?? lines.at(-1)?.text ?? '';
  const pre = $('#job-log');
  pre.scrollTop = pre.scrollHeight;
  document.querySelectorAll('.toolbar button[data-act]').forEach((b) => { b.disabled = !done && b.dataset.act !== 'trash'; });
}

/** Avvia un'operazione e attende la fine. @returns {Promise<object>} risultato */
async function runJob(params) {
  const job = await api('/api/jobs', params);
  // Operazioni brevi possono finire (evento "end") prima che arrivi questa risposta.
  const ended = S.ended.get(job.id);
  if (ended) {
    if (ended.status === 'done') return ended.result ?? {};
    throw new Error(ended.error ?? 'Operazione non riuscita');
  }
  if (S.job?.id !== job.id) { S.job = { ...job, log: [] }; showJob(S.job); }
  return new Promise((resolve, reject) => S.waiters.set(job.id, { resolve, reject }));
}

function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN ?? '')}`);
  es.addEventListener('hello', (ev) => {
    const { current } = JSON.parse(ev.data);
    if (current) { S.job = current; showJob(current); }
  });
  es.addEventListener('start', (ev) => {
    const job = JSON.parse(ev.data);
    if (S.ended.has(job.id)) return;
    if (!S.job || S.job.id !== job.id) { S.job = { ...job, log: [] }; showJob(S.job); }
  });
  es.addEventListener('log', (ev) => {
    const line = JSON.parse(ev.data);
    if (S.job?.id === line.id) { S.job.log.push(line); showJob(S.job); }
  });
  es.addEventListener('end', (ev) => {
    const job = JSON.parse(ev.data);
    S.job = job;
    S.ended.set(job.id, job);
    if (S.ended.size > 50) S.ended.delete(S.ended.keys().next().value);
    showJob(job, { done: true });
    const w = S.waiters.get(job.id);
    S.waiters.delete(job.id);
    if (job.status === 'done') w?.resolve(job.result ?? {});
    else if (w) w.reject(new Error(job.error ?? 'Operazione non riuscita'));
    loadStatus(true);
  });
  es.addEventListener('file', (ev) => {
    const { version } = JSON.parse(ev.data);
    if (!S.data || version === S.data.version) return;
    if (S.editing) { S.staleFile = true; toast('Il file è cambiato: salva o annulla la modifica, poi l\'elenco si aggiorna.'); } else load();
  });
  es.onerror = () => { /* EventSource riprova da solo */ };
}

// ── azioni ────────────────────────────────────────────────────────────────────────────────────────────
const entryByKey = (k) => (S.view === 'trash' ? S.trash : S.data.entries).find((e) => e.key === k);

const splitHostPort = (s) => {
  const i = (s ?? '').lastIndexOf(':');
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : ['', ''];
};

/** Finestra "Sync telefono": IP e porta (precompilati), verifica connessione, opzioni, primo abbinamento. */
async function phoneSync() {
  let info;
  try { info = await api('/api/phone'); } catch (e) { return handleError(e); }
  const connected = info.devices.find((d) => d.state === 'device' && /:\d+$/.test(d.serial));
  const [ip, port] = splitHostPort(connected?.serial ?? info.lastDevice ?? '');
  const devs = info.devices.length
    ? info.devices.map((d) => `<button type="button" class="small" data-dev="${esc(d.serial)}" title="Usa questo indirizzo">${esc(d.serial)} · ${esc(d.state)}${d.model ? ` · ${esc(d.model)}` : ''}</button>`).join('')
    : `<span class="hint">${esc(info.error ?? 'nessun dispositivo')}</span>`;
  const fd = await dialog({
    title: 'Sync telefono',
    ok: 'Sincronizza',
    html: `<div class="form">
      <label class="k" for="ph-ip">IP</label>
      <input type="text" id="ph-ip" name="ip" value="${esc(ip)}" placeholder="192.168.1.2" autocomplete="off">
      <label class="k" for="ph-port">Porta</label>
      <div class="inline"><input type="number" id="ph-port" name="port" value="${esc(port)}" min="1" max="65535" style="width:120px">
        <button type="button" id="ph-test">Verifica connessione</button><span id="ph-res" class="res"></span></div>
      <span class="hint full">Li trovi sul telefono in Opzioni sviluppatore → Debug wireless ("Indirizzo IP e porta"). La porta cambia a ogni attivazione. Lasciali vuoti per usare il dispositivo già collegato o l'ultimo indirizzo.</span>
      <label class="k">Visti da adb</label><div class="inline">${devs}</div>
      <label class="k">Opzioni</label>
      <div class="inline"><label class="opt"><input type="checkbox" name="ai" ${$('#opt-ai').checked ? 'checked' : ''}> con AI</label>
        <label class="opt"><input type="checkbox" name="close" ${$('#opt-close').checked ? 'checked' : ''}> chiudi schede salvate</label></div>
      <details class="box full"><summary>Primo abbinamento (solo la prima volta)</summary>
        <p class="hint">Sul telefono: Debug wireless → "Abbina dispositivo con codice di accoppiamento". Usa la porta e il codice mostrati lì: la porta di abbinamento è diversa da quella di connessione.</p>
        <div class="inline"><input type="number" id="pair-port" placeholder="porta abbinamento" style="width:160px">
          <input type="text" id="pair-code" placeholder="codice (6 cifre)" inputmode="numeric" maxlength="6" style="width:150px" autocomplete="off">
          <button type="button" id="pair-btn">Abbina</button><span id="pair-res" class="res"></span></div>
      </details>
    </div>`,
    validate: (form) => {
      const i = form.elements.ip.value.trim();
      const p = form.elements.port.value.trim();
      if (!i && !p) return null;
      if (!i || !p) return 'Indica sia IP sia porta, oppure lasciali vuoti entrambi.';
      if (!/^[A-Za-z0-9.-]+$/.test(i)) return 'IP non valido.';
      if (!(Number(p) >= 1 && Number(p) <= 65535)) return 'Porta non valida (1-65535).';
      return null;
    },
    onOpen: (d) => {
      const ipEl = d.querySelector('#ph-ip');
      const portEl = d.querySelector('#ph-port');
      d.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => {
        const [i, p] = splitHostPort(b.dataset.dev);
        if (i) { ipEl.value = i; portEl.value = p; }
      }));
      d.querySelector('#ph-test').addEventListener('click', async () => {
        const res = d.querySelector('#ph-res');
        const serial = ipEl.value.trim() && portEl.value.trim() ? `${ipEl.value.trim()}:${portEl.value.trim()}` : undefined;
        setRes(res, true, 'Verifico…');
        try {
          const r = await runJob({ type: 'connect', serial });
          setRes(res, true, `Connesso: ${r.model ?? r.serial}`);
          const [i, p] = splitHostPort(r.serial);
          if (i && !serial) { ipEl.value = i; portEl.value = p; }
        } catch (e) { setRes(res, false, e.message.split('\n')[0]); }
        loadStatus(true);
      });
      d.querySelector('#pair-btn').addEventListener('click', async () => {
        const res = d.querySelector('#pair-res');
        const pport = d.querySelector('#pair-port').value.trim();
        const code = d.querySelector('#pair-code').value.trim();
        if (!ipEl.value.trim() || !pport || !/^\d{6}$/.test(code)) return setRes(res, false, 'Servono IP (sopra), porta di abbinamento e codice di 6 cifre.');
        setRes(res, true, 'Abbino…');
        try {
          await runJob({ type: 'pair', hostPort: `${ipEl.value.trim()}:${pport}`, code });
          setRes(res, true, 'Abbinato: ora indica la porta di connessione e verifica.');
        } catch (e) { setRes(res, false, e.message.split('\n')[0]); }
      });
    },
  });
  if (!fd) return;
  const i = String(fd.get('ip') ?? '').trim();
  const p = String(fd.get('port') ?? '').trim();
  await syncFrom('phone', { serial: i && p ? `${i}:${p}` : undefined, ai: fd.get('ai') === 'on', close: fd.get('close') === 'on' });
}

async function syncFrom(source, { serial, ai = $('#opt-ai').checked, close = $('#opt-close').checked } = {}) {
  try {
    if (close) {
      const p = await runJob({ type: 'close-preview', source, serial });
      const keep = p.keep?.length ? `<p class="muted">Restano aperte:</p><ul>${p.keep.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : '';
      const ok = await dialog({
        title: `Chiudere ${p.toClose} schede ${source === 'pc' ? 'in Chrome sul PC' : 'sul telefono'}?`,
        html: `<p>Prima vengono salvate in ${esc(S.data.file.split(/[\\/]/).pop())} (${ai ? 'con' : 'senza'} AI), poi le schede salvate si chiudono. Le trovi comunque in "Schede chiuse di recente" di Chrome.</p>${keep}${source === 'pc' ? '<p class="muted">Chrome chiederà di nuovo di approvare il collegamento.</p>' : ''}`,
        ok: `Salva e chiudi ${p.toClose}`,
        danger: true,
      });
      if (!ok) return;
    }
    const r = await runJob({ type: 'sync', source, serial, ai, close });
    toast(`${r.added} link nuovi salvati${close ? ` · ${r.closed} schede chiuse` : ''}`);
    await load();
  } catch (e) {
    if (e instanceof ApiError) handleError(e); else toast(e.message, { error: true, ms: 8000 });
  }
}

async function check(links) {
  try {
    const r = await runJob({ type: 'check', links });
    S.issues = new Map();
    for (const i of r.issues) if (i.key) S.issues.set(i.key, [...(S.issues.get(i.key) ?? []), i]);
    $('#f-problems').checked = S.issues.size > 0;
    toast(r.issues.length ? `${r.errors} errori · ${r.warnings} avvisi` : 'Nessun problema trovato');
    renderAll();
  } catch (e) {
    e instanceof ApiError ? handleError(e) : toast(e.message, { error: true });
  }
}

async function retag(keys) {
  if (!keys.length) return;
  try {
    const r = await runJob({ type: 'retag', keys });
    toast(`${r.changed ?? 0} voci aggiornate dall'AI`);
    await load();
  } catch (e) {
    e instanceof ApiError ? handleError(e) : toast(e.message, { error: true, ms: 8000 });
  }
}

async function openOn(source, keys) {
  const urls = keys.map(entryByKey).filter(Boolean).map((e) => e.url).filter(isHttp);
  if (!urls.length) return;
  if (urls.length > 5 && !(await dialog({ title: `Aprire ${urls.length} link ${source === 'pc' ? 'sul PC' : 'sul telefono'}?`, html: '<p>Ogni link diventa una nuova scheda di Chrome.</p>', ok: 'Apri' }))) return;
  try {
    const r = await runJob({ type: 'open', source, urls });
    toast(`${r.opened} link aperti ${source === 'pc' ? 'sul PC' : 'sul telefono'}`);
  } catch (e) {
    e instanceof ApiError ? handleError(e) : toast(e.message, { error: true, ms: 8000 });
  }
}

async function remove(keys) {
  if (!keys.length) return;
  if (keys.length > 1 && !(await dialog({ title: `Spostare ${keys.length} voci nel cestino?`, html: '<p>Le ritrovi nel Cestino e puoi ripristinarle. Sync non le salverà di nuovo.</p>', ok: 'Sposta nel cestino', danger: true }))) return;
  try {
    const r = await api('/api/entries/delete', { version: S.data.version, keys });
    keys.forEach((k) => S.selected.delete(k));
    await load();
    toast(`${r.removed} voc${r.removed === 1 ? 'e spostata' : 'i spostate'} nel cestino`, { action: { label: 'Ripristina', run: () => restore(keys) } });
  } catch (e) { handleError(e); }
}

async function restore(keys) {
  try {
    const r = await api('/api/trash/restore', { version: S.data.version, keys });
    keys.forEach((k) => S.selected.delete(k));
    await load();
    toast(`${r.restored} voc${r.restored === 1 ? 'e ripristinata' : 'i ripristinate'}`);
  } catch (e) { handleError(e); }
}

async function purge(keys) {
  if (!keys.length) return;
  const ok = await dialog({
    title: keys.length === 1 ? 'Eliminare definitivamente questa voce?' : `Eliminare definitivamente ${keys.length} voci?`,
    html: '<p>Spariscono anche dal cestino. Resta solo una copia nei backup (.pck-backup).</p><p class="muted">Attenzione: se la scheda è ancora aperta sul telefono o sul PC, il prossimo sync la salverà di nuovo come link nuovo.</p>',
    ok: 'Elimina definitivamente',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('/api/trash/purge', { keys });
    keys.forEach((k) => S.selected.delete(k));
    await load();
    toast(`${r.purged} voc${r.purged === 1 ? 'e eliminata' : 'i eliminate'} definitivamente`);
  } catch (e) { handleError(e); }
}

async function saveEdit() {
  const input = $('[data-edit-input]');
  if (!input || !S.editing) return;
  const { key, field } = S.editing;
  const body = { version: S.data.version, key };
  if (field === 'tags') body.tags = parseTags(input.value);
  else body.description = input.value.replace(/\s+/g, ' ').trim();
  try {
    await api('/api/entries/update', body);
    S.editing = null;
    await load();
  } catch (e) { handleError(e); }
}

async function bulkTags(mode) {
  const keys = [...S.selected];
  if (mode === 'add') {
    const datalist = S.data.tags.map((t) => `<option value="#${esc(t.tag)}">`).join('');
    const fd = await dialog({
      title: `Aggiungi tag a ${keys.length} voci`,
      html: `<input type="text" name="tags" list="dl-tags" placeholder="#maker #stampa-3d" style="width:100%" autocomplete="off"><datalist id="dl-tags">${datalist}</datalist>`,
      ok: 'Aggiungi',
      onOpen: (d) => d.querySelector('input').focus(),
    });
    const add = fd ? parseTags(fd.get('tags') ?? '') : [];
    if (!add.length) return;
    try {
      const r = await api('/api/entries/tags', { version: S.data.version, keys, add });
      await load();
      toast(`Tag aggiunti a ${r.changed} voci`);
    } catch (e) { handleError(e); }
  } else {
    const present = new Map();
    for (const k of keys) for (const t of entryByKey(k)?.tags ?? []) present.set(t, (present.get(t) ?? 0) + 1);
    if (!present.size) return toast('Le voci selezionate non hanno tag');
    const fd = await dialog({
      title: `Togli tag da ${keys.length} voci`,
      html: `<div class="checks">${[...present].sort((a, b) => b[1] - a[1]).map(([t, n]) => `<label class="opt"><input type="checkbox" name="t" value="${esc(t)}"> #${esc(t)} <span class="muted">${n}</span></label>`).join('')}</div>`,
      ok: 'Togli',
      danger: true,
    });
    const remove = fd ? fd.getAll('t') : [];
    if (!remove.length) return;
    try {
      const r = await api('/api/entries/tags', { version: S.data.version, keys, remove });
      await load();
      toast(`Tag tolti da ${r.changed} voci`);
    } catch (e) { handleError(e); }
  }
}

async function undo() {
  const ok = await dialog({ title: 'Annullare l\'ultima modifica?', html: '<p>Il file torna com\'era prima dell\'ultima scrittura (dal backup più recente). Lo stato attuale viene salvato a sua volta come backup, quindi un secondo "Annulla" ripete la modifica.</p>', ok: 'Annulla modifica' });
  if (!ok) return;
  try {
    const r = await api('/api/undo', {});
    await load();
    toast(`Ripristinato da ${r.restoredFrom}`);
  } catch (e) { handleError(e); }
}

async function toggleTrash() {
  S.view = S.view === 'trash' ? 'list' : 'trash';
  S.selected.clear();
  S.editing = null;
  $('#f-section').value = '';
  await load();
}

// ── eventi ────────────────────────────────────────────────────────────────────────────────────────────
document.addEventListener('click', (ev) => {
  const t = ev.target;
  const act = t.closest('[data-act]')?.dataset.act;
  if (act) {
    ({
      'sync-phone': () => phoneSync(), 'sync-pc': () => syncFrom('pc'), check: () => check(false), 'check-links': () => check(true),
      undo, trash: toggleTrash,
    })[act]?.();
    return;
  }
  const chip = t.closest('[data-tag]');
  if (chip && !t.closest('.edit')) {
    const tag = chip.dataset.tag;
    const q = $('#q');
    const parts = q.value.split(/\s+/).filter(Boolean).filter((p) => p !== `#${tag}` && p !== `-#${tag}`);
    const was = q.value.split(/\s+/).find((p) => p === `#${tag}` || p === `-#${tag}`);
    const want = ev.altKey ? `-#${tag}` : `#${tag}`;
    if (was !== want) parts.push(want);
    q.value = parts.join(' ');
    renderTagbar(); renderList(); return;
  }
  const sugg = t.closest('[data-sugg-tag]');
  if (sugg) {
    const input = $('[data-edit-input="tags"]');
    const parts = input.value.split(/\s+/).filter(Boolean);
    if (parts.length && !input.value.endsWith(' ')) parts.pop();
    parts.push(`#${sugg.dataset.suggTag}`);
    input.value = `${parts.join(' ')} `;
    input.focus(); renderSuggestions(input); return;
  }
  if (t.closest('[data-save]')) return void saveEdit();
  if (t.closest('[data-cancel]')) { S.editing = null; if (S.staleFile) load(); else renderList(); return; }

  const rowBtn = t.closest('[data-row]');
  if (rowBtn) {
    const key = rowBtn.closest('.row').dataset.key;
    const a = rowBtn.dataset.row;
    if (a === 'tags' || a === 'description') { S.editing = S.editing?.key === key && S.editing.field === a ? null : { key, field: a }; renderList(); }
    else if (a === 'delete') remove([key]);
    else if (a === 'restore') restore([key]);
    else if (a === 'purge') purge([key]);
    else if (a === 'retag') retag([key]);
    else if (a === 'open-phone') openOn('phone', [key]);
    else if (a === 'open-pc') openOn('pc', [key]);
    return;
  }
  const bulk = t.closest('[data-bulk]')?.dataset.bulk;
  if (bulk) {
    const keys = [...S.selected];
    ({
      'add-tag': () => bulkTags('add'), 'remove-tag': () => bulkTags('remove'), retag: () => retag(keys),
      'open-phone': () => openOn('phone', keys), 'open-pc': () => openOn('pc', keys), delete: () => remove(keys),
      restore: () => restore(keys), purge: () => purge(keys), clear:() => { S.selected.clear(); renderList(); renderBulk(); },
    })[bulk]?.();
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.matches('[data-sel]')) {
    const key = t.closest('.row').dataset.key;
    t.checked ? S.selected.add(key) : S.selected.delete(key);
    t.closest('.row').classList.toggle('sel', t.checked);
    $('#sel-all').checked = visibleEntries().every((e) => S.selected.has(e.key));
    renderBulk();
  } else if (t.id === 'sel-all') {
    for (const e of visibleEntries()) t.checked ? S.selected.add(e.key) : S.selected.delete(e.key);
    renderList(); renderBulk();
  } else if (t.id === 'f-section' || t.id === 'f-problems') {
    renderList();
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'q') { renderTagbar(); renderList(); }
  if (ev.target.matches('[data-edit-input="tags"]')) renderSuggestions(ev.target);
});

document.addEventListener('keydown', (ev) => {
  const inEdit = ev.target.matches?.('[data-edit-input]');
  if (inEdit && ev.key === 'Escape') { S.editing = null; renderList(); return; }
  if (inEdit && ev.key === 'Enter' && (ev.target.tagName === 'INPUT' || ev.ctrlKey)) { ev.preventDefault(); saveEdit(); return; }
  if (ev.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { ev.preventDefault(); $('#q').focus(); }
});

$('#job-toggle').addEventListener('click', () => {
  const pre = $('#job-log');
  pre.hidden = !pre.hidden;
  $('#job-toggle').setAttribute('aria-expanded', String(!pre.hidden));
});

// ── avvio ─────────────────────────────────────────────────────────────────────────────────────────────
if (!TOKEN) {
  $('#list').innerHTML = '<div class="empty-state">Apri questa pagina dall\'indirizzo mostrato nel terminale da <code>pck ui</code> (contiene il token di accesso).</div>';
} else {
  load();
  loadStatus();
  connectEvents();
  setInterval(() => loadStatus(), 15000);
  api('/api/jobs').then(({ current }) => { if (current) { S.job = current; showJob(current); } }).catch(() => {});
}

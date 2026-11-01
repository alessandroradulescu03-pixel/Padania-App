/* =====================================================
   PadaniaTuning Check-in · v3
   Tutto resta salvato sul telefono (localStorage):
   lista, check-in, orari e note sopravvivono alla chiusura.
   ===================================================== */

/* ─── PASSWORD ───
   Nel codice c'è solo l'impronta SHA-256, non la password in chiaro.
   Per cambiarla: calcola lo SHA-256 della nuova password e incollalo qui. */
const PW_HASH = '3fc13c35bdb2d6f9146fcd93304ba3c2143d5d017268e17a939f0d315728c8a2';

const K_LIST  = 'pt3_list';
const K_STATE = 'pt3_state';
const K_SET   = 'pt3_settings';
const PAGE    = 60;

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ─── STATO ─── */
let list     = null;                 // { name, loadedAt, headers, rows:[{k,c,added}] }
let state    = { in: {}, notes: {} };  // in: {key: timestamp}, notes: {key: testo}
let settings = { wake: true, sound: true };
let cols     = { nome: 0, cognome: 1, info: [] };
let filter   = 'all';
let sortMode = 'list';
let shown    = PAGE;
let lastAction = null;
let wakeLock = null;

/* ─── STORAGE SICURO ─── */
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { console.error(e); toast('Errore nel salvataggio sul telefono!', 'err'); return false; }
}
const saveState = () => save(K_STATE, state);
const saveList  = () => save(K_LIST, list);

/* ─── UTILS ─── */
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const esc  = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtTime = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const pad = n => String(n).padStart(2, '0');
const dateTag = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

function hash(str) {               // djb2: chiave stabile per riga
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ─── COLONNE: riconosce Nome / Cognome / info utili ─── */
function detectColumns(headers) {
  const h = headers.map(norm);
  let nome    = h.findIndex(x => /^(nome|name|first ?name)\b/.test(x) && !/cognome/.test(x));
  let cognome = h.findIndex(x => /(cognome|surname|last ?name)/.test(x));
  const full  = h.findIndex(x => /(nominativo|nome e cognome|nome completo|full ?name)/.test(x));
  if (full >= 0 && nome < 0) { nome = full; cognome = -1; }
  if (nome < 0 && cognome < 0) { nome = 0; cognome = headers.length > 1 ? 1 : -1; }
  if (nome < 0) { nome = cognome; cognome = -1; }

  const skip = new Set([nome, cognome]);
  const priority = /(targa|auto|modello|veicolo|macchina|marca|categoria|tipo|biglietto|pass|ticket|club|team)/;
  const rest = h.map((x, i) => i).filter(i => !skip.has(i) && !/(timestamp|data|privacy|consenso|accetto)/.test(h[i]));
  const info = [...rest.filter(i => priority.test(h[i])), ...rest.filter(i => !priority.test(h[i]))];
  return { nome, cognome, info };
}

function prepare() {
  if (!list) return;
  cols = detectColumns(list.headers);
  list.rows.forEach(r => {
    r._name = personName(r);
    r._first = norm(r.c[cols.nome]); r._last = cols.cognome >= 0 ? norm(r.c[cols.cognome]) : '';
    r._search = norm(r.c.join(' '));
    r._initials = norm(r._name).split(' ').filter(Boolean).map(w => w[0]).join('');
    r._sub = cols.info.map(i => String(r.c[i] ?? '').trim()).filter(Boolean).slice(0, 3).join(' · ');
  });
}
function personName(r) {
  const n = String(r.c[cols.nome] ?? '').trim();
  const c = cols.cognome >= 0 ? String(r.c[cols.cognome] ?? '').trim() : '';
  return (n + ' ' + c).trim() || '(senza nome)';
}
function initials(name) {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase() || '?';
}

/* =====================================================
   LOGIN
   ===================================================== */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function isAuthed() { try { return sessionStorage.getItem('ptAuthed') === '1'; } catch { return false; } }
function showAuth(show) {
  $('#auth').classList.toggle('hide', !show);
  if (show) setTimeout(() => $('#authInput').focus(), 350);
  else requestWake();
}
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#authInput');
  let ok = false;
  try { ok = (await sha256(input.value)) === PW_HASH; }
  catch { $('#authError').textContent = "Apri l'app dal link https per accedere."; return; }
  if (ok) {
    try { sessionStorage.setItem('ptAuthed', '1'); } catch {}
    input.value = ''; $('#authError').textContent = '';
    showAuth(false);
  } else {
    $('#authError').textContent = 'Password errata, riprova.';
    const card = $('#authForm'); card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 400);
    input.select();
  }
});
$('#pwToggle').addEventListener('click', () => {
  const i = $('#authInput'); i.type = i.type === 'password' ? 'text' : 'password'; i.focus();
});

/* =====================================================
   NAVIGAZIONE
   ===================================================== */
function showPage(p) {
  $$('.page').forEach(el => el.hidden = el.id !== 'page-' + p);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === p));
  window.scrollTo({ top: 0 });
  if (p === 'stats') renderStats();
}
$$('.tab').forEach(t => t.addEventListener('click', () => showPage(t.dataset.page)));

/* =====================================================
   CARICAMENTO LISTA
   ===================================================== */
$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (typeof XLSX === 'undefined') { toast('Libreria Excel non caricata: serve connessione al primo avvio', 'err'); return; }

  if (list && list.rows.length) {
    const r = await modal({
      title: 'Sostituire la lista?',
      text: `Carichi "${file.name}" al posto di quella attuale. I check-in delle persone presenti in entrambe le liste restano salvati.`,
      ok: 'Sostituisci'
    });
    if (!r.ok) return;
  }

  try {
    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const raw  = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    if (!raw || raw.length < 2) { toast('File vuoto: servono intestazione + almeno un iscritto', 'err'); return; }

    const headers = raw[0].map(h => String(h ?? '').trim());
    const width = Math.max(...raw.map(r => r.length));
    while (headers.length < width) headers.push('Colonna ' + (headers.length + 1));

    const seen = {};
    const rows = [];
    const oldIndexMap = {};                     // per migrare i dati della vecchia versione
    raw.slice(1).forEach((r, i) => {
      const c = headers.map((_, j) => String(r[j] ?? '').trim());
      if (!c.some(Boolean)) return;
      let k = hash(c.map(norm).join('␟'));
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] > 1) k += '-' + seen[k];
      oldIndexMap[i + 1] = k;
      rows.push({ k, c });
    });

    // tiene anche le persone aggiunte in loco nella lista precedente
    const added = list ? list.rows.filter(r => r.added) : [];
    list = { name: file.name, loadedAt: Date.now(), headers, rows: [...rows, ...added] };
    prepare();
    saveList();
    migrateOld(oldIndexMap);

    const kept = list.rows.filter(r => state.in[r.k]).length;
    shown = PAGE; lastAction = null;
    renderAll();
    toast(`${rows.length} iscritti caricati${kept ? ` · ${kept} check-in mantenuti` : ''}`);
  } catch (err) {
    console.error(err);
    toast('File non valido o danneggiato', 'err');
  }
});

/* Importa i check-in salvati dalla versione precedente dell'app (una volta sola) */
function migrateOld(map) {
  try {
    const oldIn = JSON.parse(localStorage.getItem('checkboxState') || 'null');
    if (!oldIn || Object.keys(state.in).length) return;
    const oldT = JSON.parse(localStorage.getItem('timestampState') || '{}');
    const oldN = JSON.parse(localStorage.getItem('notesState') || '{}');
    let n = 0;
    Object.keys(oldIn).forEach(id => { const k = map[id]; if (k) { state.in[k] = oldT[id] || Date.now(); n++; } });
    Object.keys(oldN).forEach(id => { const k = map[id]; if (k) state.notes[k] = oldN[id]; });
    saveState();
    ['checkboxState', 'timestampState', 'notesState'].forEach(x => localStorage.removeItem(x));
    if (n) setTimeout(() => toast(`${n} check-in recuperati dalla versione precedente`), 3000);
  } catch {}
}

/* =====================================================
   RENDER
   ===================================================== */
function counts() {
  const tot = list ? list.rows.length : 0;
  const inN = list ? list.rows.filter(r => state.in[r.k]).length : 0;
  return { tot, inN, wait: tot - inN, pct: tot ? Math.round(inN / tot * 100) : 0 };
}

function renderAll() {
  const has = !!(list && list.rows.length);
  $('#welcome').hidden = has;
  $('#dash').hidden = !has;
  $('#listName').textContent = has ? `${list.name.replace(/\.(xlsx|xls|csv)$/i, '')}` : 'Nessuna lista';
  renderCounts();
  if (has) renderList();
}

function renderCounts() {
  const c = counts();
  $('#chipIn').textContent = c.inN; $('#chipTot').textContent = c.tot;
  $('#countIn').textContent = c.inN; $('#countIn2').textContent = c.inN;
  $('#countTot').textContent = c.tot; $('#countWait').textContent = c.wait;
  $('#countPct').textContent = c.pct + '%';
  $('#ring').style.setProperty('--p', c.pct);
  $('#barFill').style.width = c.pct + '%';
  $('#fAll').textContent = c.tot; $('#fYes').textContent = c.inN; $('#fNo').textContent = c.wait;
  $('#scanIn').textContent = c.inN; $('#scanTot').textContent = c.tot;
  $('#undoBtn').hidden = !lastAction;
}

function matches(r, q, tokens) {
  if (!q) return true;
  if (tokens.every(t => r._search.includes(t))) return true;
  return q.length >= 2 && /^[a-z]+$/.test(q) && r._initials.startsWith(q);
}

function filteredRows() {
  const q = norm($('#searchInput').value);
  const tokens = q.split(' ').filter(Boolean);
  let rows = list.rows.filter(r => {
    if (filter === 'yes' && !state.in[r.k]) return false;
    if (filter === 'no' && state.in[r.k]) return false;
    return matches(r, q, tokens);
  });
  if (sortMode === 'az')     rows = [...rows].sort((a, b) => (a._last || a._first).localeCompare(b._last || b._first) || a._first.localeCompare(b._first));
  if (sortMode === 'recent') rows = [...rows].sort((a, b) => (state.in[b.k] || 0) - (state.in[a.k] || 0));
  return { rows, tokens };
}

function highlight(text, tokens) {
  let out = esc(text);
  if (!tokens.length) return out;
  const n = norm(text);
  // evidenzia solo se il testo normalizzato ha la stessa lunghezza (niente accenti strani)
  if (n.length !== text.length) return out;
  const marks = new Array(text.length).fill(false);
  tokens.forEach(t => { let i = n.indexOf(t); while (i >= 0) { for (let j = i; j < i + t.length; j++) marks[j] = true; i = n.indexOf(t, i + 1); } });
  out = ''; let open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

function personHTML(r, tokens = []) {
  const ts = state.in[r.k];
  const note = state.notes[r.k];
  return `<li class="person${ts ? ' in' : ''}" data-k="${esc(r.k)}">
    <div class="avatar">${esc(initials(r._name))}</div>
    <div class="p-main">
      <div class="p-name">${highlight(r._name, tokens)}</div>
      ${r._sub ? `<div class="p-sub">${highlight(r._sub, tokens)}</div>` : ''}
      ${(ts || note || r.added) ? `<div class="p-tags">
        ${ts ? `<span class="tag ok">✓ Entrato ${fmtTime(ts)}</span>` : ''}
        ${r.added ? `<span class="tag new">In loco</span>` : ''}
        ${note ? `<span class="tag note">📝 ${esc(note)}</span>` : ''}
      </div>` : ''}
    </div>
    <button class="note-btn${note ? ' has' : ''}" data-act="note" aria-label="Nota">📝</button>
    <button class="check" data-act="check" aria-label="${ts ? 'Annulla ingresso' : 'Registra ingresso'}">✓</button>
  </li>`;
}

function renderList() {
  const { rows, tokens } = filteredRows();
  const ul = $('#people');
  if (!rows.length) {
    const q = $('#searchInput').value.trim();
    ul.innerHTML = `<li class="empty"><b>${q ? '🔍' : filter === 'no' ? '🎉' : '—'}</b>${
      q ? `Nessuno trovato per “${esc(q)}”` : filter === 'no' ? 'Sono entrati tutti!' : 'Ancora nessun ingresso'}</li>`;
  } else {
    ul.innerHTML = rows.slice(0, shown).map(r => personHTML(r, tokens)).join('');
  }
  $('#moreBtn').hidden = rows.length <= shown;
  $('#moreBtn').textContent = `Mostra altri (${rows.length - shown})`;
  $('#resultInfo').textContent = `${rows.length} ${rows.length === 1 ? 'persona' : 'persone'}`;
}

function refreshItem(k, flash) {
  const li = $(`.person[data-k="${CSS.escape(k)}"]`);
  const r = list.rows.find(x => x.k === k);
  if (!li || !r) return;
  const tokens = norm($('#searchInput').value).split(' ').filter(Boolean);
  li.outerHTML = personHTML(r, tokens);
  if (flash) { const n = $(`.person[data-k="${CSS.escape(k)}"]`); n?.classList.add('flash'); }
}

/* =====================================================
   CHECK-IN
   ===================================================== */
function setIn(k, value, ts = Date.now()) {
  lastAction = { k, prev: state.in[k] || null };
  if (value) state.in[k] = ts; else delete state.in[k];
  saveState();
}

async function toggle(k) {
  const r = list.rows.find(x => x.k === k);
  if (!r) return;
  if (state.in[k]) {
    const res = await modal({ title: 'Annullare ingresso?', text: `${r._name} risulta entrato alle ${fmtTime(state.in[k])}.`, ok: 'Sì, annulla', danger: true, cancel: 'Indietro' });
    if (!res.ok) return;
    setIn(k, false);
    toast(`Ingresso annullato: ${r._name}`, 'warn');
  } else {
    setIn(k, true);
    feedback('ok');
    toast(`✓ Entrato: ${r._name}`, '', 'Annulla', undo);
  }
  refreshItem(k, !!state.in[k]);
  renderCounts();

  // se l'elemento non rientra più nel filtro, o si stava cercando, aggiorna la lista
  const search = $('#searchInput').value.trim();
  if (filter !== 'all' || sortMode === 'recent' || search) {
    setTimeout(() => {
      if (search && state.in[k]) { $('#searchInput').value = ''; $('#searchClear').hidden = true; }
      renderList();
    }, 900);
  }
}

function undo() {
  if (!lastAction) return;
  const { k, prev } = lastAction;
  if (prev) state.in[k] = prev; else delete state.in[k];
  saveState();
  lastAction = null;
  renderCounts(); renderList();
  toast('Operazione annullata', 'warn');
}
$('#undoBtn').addEventListener('click', undo);

$('#people').addEventListener('click', e => {
  const li = e.target.closest('.person');
  if (!li) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'note') editNote(li.dataset.k);
  else toggle(li.dataset.k);
});

async function editNote(k) {
  const r = list.rows.find(x => x.k === k);
  const res = await modal({
    title: 'Nota', text: r._name,
    body: `<label class="field"><textarea id="noteText" rows="3" placeholder="Es. pagamento da verificare, pass VIP…">${esc(state.notes[k] || '')}</textarea></label>`,
    ok: 'Salva', focus: '#noteText'
  });
  if (!res.ok) return;
  const v = $('#noteText').value.trim();
  if (v) state.notes[k] = v; else delete state.notes[k];
  saveState();
  refreshItem(k);
  toast(v ? 'Nota salvata' : 'Nota rimossa');
}

/* ─── AGGIUNGI IN LOCO ─── */
$('#addBtn').addEventListener('click', async () => {
  const twoFields = cols.cognome >= 0;
  const res = await modal({
    title: 'Aggiungi partecipante', text: 'Per chi si iscrive direttamente all\'ingresso.',
    body: `
      <label class="field"><span>${esc(list.headers[cols.nome] || 'Nome')}</span><input id="addNome" autocomplete="off"></label>
      ${twoFields ? `<label class="field"><span>${esc(list.headers[cols.cognome] || 'Cognome')}</span><input id="addCognome" autocomplete="off"></label>` : ''}
      ${cols.info[0] !== undefined ? `<label class="field"><span>${esc(list.headers[cols.info[0]])} (facoltativo)</span><input id="addInfo" autocomplete="off"></label>` : ''}
      <label class="field"><span>Nota (facoltativa)</span><input id="addNote" autocomplete="off"></label>`,
    ok: 'Aggiungi ed entra', focus: '#addNome'
  });
  if (!res.ok) return;
  const nome = $('#addNome').value.trim();
  const cognome = twoFields ? $('#addCognome').value.trim() : '';
  if (!nome && !cognome) { toast('Inserisci almeno il nome', 'err'); return; }
  const c = list.headers.map(() => '');
  c[cols.nome] = nome;
  if (twoFields) c[cols.cognome] = cognome;
  const info = $('#addInfo')?.value.trim();
  if (info) c[cols.info[0]] = info;
  const k = 'add-' + Date.now().toString(36);
  list.rows.push({ k, c, added: true });
  prepare(); saveList();
  const note = $('#addNote').value.trim();
  if (note) state.notes[k] = note;
  setIn(k, true);
  feedback('ok');
  renderAll();
  toast(`✓ Aggiunto ed entrato: ${(nome + ' ' + cognome).trim()}`);
});

/* ─── RICERCA, FILTRI, ORDINAMENTO ─── */
let searchTimer;
$('#searchInput').addEventListener('input', () => {
  $('#searchClear').hidden = !$('#searchInput').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { shown = PAGE; renderList(); }, 80);
});
$('#searchClear').addEventListener('click', () => {
  $('#searchInput').value = ''; $('#searchClear').hidden = true;
  shown = PAGE; renderList(); $('#searchInput').focus();
});
$$('.seg').forEach(b => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  $$('.seg').forEach(x => x.classList.toggle('active', x === b));
  shown = PAGE; renderList();
}));
$('#moreBtn').addEventListener('click', () => { shown += PAGE; renderList(); });

const SORTS = { list: 'Ordine lista', az: 'Cognome A→Z', recent: 'Ultimi entrati' };
$('#sortBtn').addEventListener('click', async () => {
  const res = await modal({
    title: 'Ordina per',
    body: `<div class="opts">${Object.entries(SORTS).map(([k, v]) => `<button class="opt${k === sortMode ? ' active' : ''}" data-sort="${k}">${v}</button>`).join('')}</div>`,
    single: true, ok: 'Chiudi', onBody: body => body.addEventListener('click', e => {
      const b = e.target.closest('[data-sort]'); if (!b) return;
      sortMode = b.dataset.sort; closeModal(true);
    })
  });
  $('#sortLabel').textContent = SORTS[sortMode].replace('Ordine ', '');
  shown = PAGE; renderList();
});

/* sticky bar: aggiunge un bordo quando si "aggancia" in alto */
window.addEventListener('scroll', () => {
  const t = $('#stickyTools');
  if (t && !$('#dash').hidden) t.classList.toggle('stuck', t.getBoundingClientRect().top <= 0.5);
}, { passive: true });

/* =====================================================
   SCANNER QR (resta aperto: più persone di fila)
   ===================================================== */
let qr = null, lastCode = '', lastCodeAt = 0, busyUntil = 0;

$('#scanBtn').addEventListener('click', openScanner);
$('#scanClose').addEventListener('click', closeScanner);

async function openScanner() {
  if (typeof Html5Qrcode === 'undefined') { toast('Scanner non disponibile: serve connessione al primo avvio', 'err'); return; }
  $('#scanner').hidden = false;
  setScanResult('', 'In attesa di un codice…');
  renderCounts();
  try {
    qr = new Html5Qrcode('reader', { verbose: false });
    await qr.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.62); return { width: s, height: s }; } },
      onScan, () => {}
    );
  } catch (err) {
    console.error(err);
    setScanResult('bad', '<b>Fotocamera non disponibile</b>Controlla i permessi della fotocamera nelle impostazioni.', '📷');
  }
}

async function closeScanner() {
  try { if (qr && qr.isScanning) await qr.stop(); qr?.clear(); } catch (e) { console.error(e); }
  qr = null;
  $('#scanner').hidden = true;
  renderList();
}

function onScan(text) {
  const now = Date.now();
  if (now < busyUntil) return;
  if (text === lastCode && now - lastCodeAt < 4000) return;   // stesso codice appena letto
  lastCode = text; lastCodeAt = now; busyUntil = now + 1500;

  const t = norm(text);
  const r = list?.rows.find(x => x.k === text || x.c.some(c => c && norm(c) === t));
  if (!r) {
    feedback('bad');
    setScanResult('bad', `<b>Non trovato</b>${esc(text.length > 40 ? text.slice(0, 40) + '…' : text)}`, '✕');
    return;
  }
  if (state.in[r.k]) {
    feedback('warn');
    setScanResult('warn', `<b>${esc(r._name)}</b>Già entrato alle ${fmtTime(state.in[r.k])}`, '⚠️');
    return;
  }
  setIn(r.k, true);
  feedback('ok');
  setScanResult('ok', `<b>${esc(r._name)}</b>${r._sub ? esc(r._sub) : 'Ingresso registrato'}`, '✓');
  renderCounts();
}

function setScanResult(cls, html, ico = '') {
  const el = $('#scanResult');
  el.className = 'scan-result ' + cls;
  el.innerHTML = (ico ? `<span class="ico">${ico}</span>` : '') + `<span>${html}</span>`;
}

/* ─── SUONO + VIBRAZIONE ─── */
let audioCtx;
function feedback(type) {
  if (!settings.sound) return;
  try {
    navigator.vibrate?.(type === 'ok' ? 60 : [80, 60, 80]);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = type === 'ok' ? [[880, 0], [1320, 0.09]] : type === 'warn' ? [[520, 0], [520, 0.14]] : [[200, 0]];
    tones.forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type === 'bad' ? 'square' : 'sine'; o.frequency.value = f;
      const t0 = audioCtx.currentTime + d, len = type === 'bad' ? 0.3 : 0.1;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + len + 0.02);
    });
  } catch {}
}

/* =====================================================
   STATISTICHE
   ===================================================== */
function renderStats() {
  const c = counts();
  $('#sTot').textContent = c.tot; $('#sIn').textContent = c.inN; $('#sWait').textContent = c.wait; $('#sPct').textContent = c.pct + '%';

  const entries = list ? list.rows.filter(r => state.in[r.k]).map(r => ({ r, t: state.in[r.k] })).sort((a, b) => a.t - b.t) : [];
  $('#sFirst').textContent = entries.length ? fmtTime(entries[0].t) : '—';
  $('#sLast').textContent  = entries.length ? fmtTime(entries[entries.length - 1].t) : '—';

  const buckets = {};
  entries.forEach(({ t }) => { const d = new Date(t); const k = `${pad(d.getHours())}:${pad(Math.floor(d.getMinutes() / 15) * 15)}`; buckets[k] = (buckets[k] || 0) + 1; });
  const keys = Object.keys(buckets).sort();
  const max = keys.length ? Math.max(...keys.map(k => buckets[k])) : 1;
  const peak = keys.reduce((b, k) => (!b || buckets[k] > buckets[b] ? k : b), null);
  $('#sPeak').textContent = peak ? `${peak} · ${buckets[peak]}` : '—';

  if (entries.length > 1) {
    const span = (entries[entries.length - 1].t - entries[0].t) / 60000;
    $('#sRate').textContent = span >= 10 ? `~${Math.round(entries.length / span * 60)} / ora` : '—';
  } else $('#sRate').textContent = '—';

  $('#chart').innerHTML = keys.length
    ? keys.map(k => `<div class="col"><span class="v">${buckets[k]}</span><div class="b${k === peak ? ' peak' : ''}" style="height:${Math.max(3, Math.round(buckets[k] / max * 100))}%"></div><span class="l">${k}</span></div>`).join('')
    : '<p class="muted">Nessun ingresso registrato ancora.</p>';

  const recent = entries.slice(-8).reverse();
  $('#recent').innerHTML = recent.length
    ? recent.map(({ r, t }) => `<li><span>${esc(r._name)}</span><time>${fmtTime(t)}</time></li>`).join('')
    : '<li class="muted">—</li>';

  $('#sNotes').textContent = list ? list.rows.filter(r => state.notes[r.k]).length : 0;
  $('#sAdded').textContent = list ? list.rows.filter(r => r.added).length : 0;
}

/* =====================================================
   STRUMENTI
   ===================================================== */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (b && ACTIONS[b.dataset.action]) ACTIONS[b.dataset.action]();
});

const ACTIONS = {
  export: () => exportExcel(false),
  exportWaiting: () => exportExcel(true),
  backup() {
    if (!list) return toast('Niente da salvare: carica prima una lista', 'err');
    const data = { app: 'pt-checkin', v: 3, savedAt: Date.now(), list: { ...list, rows: list.rows.map(({ k, c, added }) => ({ k, c, added })) }, state };
    saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `Padania_backup_${dateTag()}.json`);
    toast('Backup creato 💾');
  },
  restore: () => $('#restoreInput').click(),
  async resetCheckins() {
    const r = await modal({ title: 'Azzerare i check-in?', text: 'Tutti gli ingressi e le note verranno cancellati. La lista resta. Non si può annullare.', ok: 'Azzera', danger: true });
    if (!r.ok) return;
    state = { in: {}, notes: {} }; saveState(); lastAction = null; renderAll();
    toast('Check-in azzerati', 'warn');
  },
  async clearAll() {
    const r = await modal({ title: 'Cancellare tutto?', text: 'Lista, check-in e note verranno rimossi da questo telefono. Fai prima un backup se ti serve.', ok: 'Cancella tutto', danger: true });
    if (!r.ok) return;
    list = null; state = { in: {}, notes: {} };
    localStorage.removeItem(K_LIST); saveState(); lastAction = null;
    renderAll(); showPage('checkin');
    toast('Dati cancellati', 'warn');
  },
  logout() { try { sessionStorage.removeItem('ptAuthed'); } catch {} showAuth(true); }
};

$('#restoreInput').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'pt-checkin' || !data.list) throw new Error('formato');
    const r = await modal({ title: 'Ripristinare il backup?', text: `Backup del ${new Date(data.savedAt).toLocaleString('it-IT')}. Sostituisce i dati attuali su questo telefono.`, ok: 'Ripristina' });
    if (!r.ok) return;
    list = data.list; state = data.state || { in: {}, notes: {} };
    state.in = state.in || {}; state.notes = state.notes || {};
    prepare(); saveList(); saveState(); lastAction = null; shown = PAGE;
    renderAll(); showPage('checkin');
    toast('Backup ripristinato ♻️');
  } catch (err) {
    console.error(err);
    toast('File di backup non valido', 'err');
  }
});

function exportExcel(onlyWaiting) {
  if (!list) return toast('Nessuna lista da esportare', 'err');
  if (typeof XLSX === 'undefined') return toast('Libreria Excel non caricata', 'err');
  const rows = list.rows.filter(r => !onlyWaiting || !state.in[r.k]);
  const aoa = [[...list.headers, 'Entrato', 'Ora ingresso', 'Note', 'Aggiunto in loco']];
  rows.forEach(r => aoa.push([...r.c, state.in[r.k] ? 'SI' : 'NO', state.in[r.k] ? fmtTime(state.in[r.k]) : '', state.notes[r.k] || '', r.added ? 'SI' : '']));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((_, i) => ({ wch: Math.min(40, Math.max(10, ...aoa.slice(0, 200).map(r => String(r[i] ?? '').length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, onlyWaiting ? 'Assenti' : 'Check-in');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `Padania_${onlyWaiting ? 'assenti' : 'checkin'}_${dateTag()}.xlsx`);
  toast(onlyWaiting ? `Esportati ${rows.length} assenti` : 'Excel esportato 📊');
}

/* Su telefono usa il menu Condividi (Salva su File, WhatsApp, Mail…), su computer scarica */
async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (matchMedia('(pointer:coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ─── IMPOSTAZIONI ─── */
function applySettings() {
  $('#wakeToggle').checked = settings.wake;
  $('#soundToggle').checked = settings.sound;
}
$('#wakeToggle').addEventListener('change', e => { settings.wake = e.target.checked; save(K_SET, settings); settings.wake ? requestWake() : releaseWake(); });
$('#soundToggle').addEventListener('change', e => { settings.sound = e.target.checked; save(K_SET, settings); if (settings.sound) feedback('ok'); });

async function requestWake() {
  if (!settings.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isAuthed()) requestWake(); });

/* =====================================================
   MODALE + TOAST
   ===================================================== */
let modalResolve = null;
function modal({ title, text = '', body = '', ok = 'OK', cancel = 'Annulla', danger = false, single = false, focus, onBody }) {
  $('#mTitle').textContent = title;
  $('#mText').textContent = text;
  $('#mBody').innerHTML = body;
  const okBtn = $('#mOk');
  okBtn.textContent = ok;
  okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-chrome');
  $('#mCancel').textContent = cancel;
  $('#mCancel').hidden = single;
  $('.sheet-actions').classList.toggle('single', single);
  if (single) { okBtn.className = 'btn btn-ghost'; }
  $('#toast').className = '';
  $('#modal').hidden = false;
  onBody?.($('#mBody'));
  if (focus) setTimeout(() => $(focus)?.focus(), 250);
  return new Promise(res => { modalResolve = res; });
}
function closeModal(ok) {
  $('#modal').hidden = true;
  const r = modalResolve; modalResolve = null;
  r?.({ ok });
}
$('#mOk').addEventListener('click', () => closeModal(true));
$('#mCancel').addEventListener('click', () => closeModal(false));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(false); });
document.addEventListener('keydown', e => {
  if ($('#modal').hidden) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && list) { e.preventDefault(); showPage('checkin'); $('#searchInput').focus(); }
    if (e.key === 'Escape' && !$('#scanner').hidden) closeScanner();
    return;
  }
  if (e.key === 'Escape') closeModal(false);
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); closeModal(true); }
});

let toastTimer;
function toast(msg, type = '', actionLabel, actionFn) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (actionLabel ? ` <button class="toast-act">${esc(actionLabel)}</button>` : '');
  t.className = 'show ' + type;
  t.style.pointerEvents = actionLabel ? 'auto' : 'none';
  if (actionLabel) t.querySelector('.toast-act').onclick = () => { t.className = ''; actionFn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; t.style.pointerEvents = 'none'; }, actionLabel ? 4500 : 2600);
}

/* =====================================================
   AVVIO
   ===================================================== */
list     = load(K_LIST, null);
state    = load(K_STATE, { in: {}, notes: {} });
state.in = state.in || {}; state.notes = state.notes || {};
settings = { ...settings, ...load(K_SET, {}) };
prepare();
applySettings();
renderAll();
showAuth(!isAuthed());

function hideSplash() {
  const s = $('#splash'); if (!s) return; s.classList.add('hide'); setTimeout(() => s.remove(), 400);
}
window.addEventListener('load', () => setTimeout(hideSplash, 350));
setTimeout(hideSplash, 2500);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

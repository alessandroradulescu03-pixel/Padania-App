/* =====================================================
   PadaniaTuning Check-in · v4
   - Funziona offline: tutto resta salvato sul telefono
   - Se collegato allo script Google del sito: scarica gli
     iscritti e sincronizza i check-in tra più telefoni
   ===================================================== */

/* ─── PASSWORD ───
   Nel codice c'è solo l'impronta SHA-256, non la password in chiaro.
   La stessa password fa da "chiave staff" per lo script Google
   (proprietà CHIAVE_STAFF): se la cambi, cambiala in tutti e due i posti. */
const PW_HASH = '3fc13c35bdb2d6f9146fcd93304ba3c2143d5d017268e17a939f0d315728c8a2';

/* ─── PASSWORD ADMIN ───
   Serve solo per l'indirizzo dello script Google:
   lo staff usa l'app normalmente ma non può rompere il collegamento.
   Anche qui c'è solo l'impronta SHA-256, non la password in chiaro. */
const ADMIN_HASH = 'c906338955e9bd5977af6f0888dc965dd856300b59ac77883ec6fe0d25600adb';

/* Script Google delle iscrizioni (lo stesso di assets/js/config.js del sito) */
const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbweHwQuH_P4cblhQDbDnI6Ri86qSEqwWyMSCgTRZJ3yFjr5KV_0Q8NpHRUUOVoqZTrjug/exec';

const K_LIST = 'pt4_list', K_RECS = 'pt4_recs', K_QUEUE = 'pt4_queue', K_SET = 'pt4_settings', K_KEY = 'pt4_key';
/* Versione dell'app: AUMENTALA a ogni modifica, così i telefoni si accorgono dell'aggiornamento */
const APP_VERSION = '4.4';
const PAGE = 60;
const SYNC_EVERY = 2500;          // ogni 2,5 s chiede "è cambiato qualcosa?" (risposta leggerissima)

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ─── STATO ───
   recs[k] = { t: primo ingresso, o: uscito alle (0 = dentro), n: nota, v: veicolo,
               l: storico [[ts,'i'|'o']], u: ultima modifica, d: telefono, a: {c:[...]} se aggiunto in loco } */
let list = null;          // { name, source, loadedAt, headers, rows:[{k,c,added}] }
let recs = {};
let queue = {};
let settings = { wake: true, sound: true, big: false, sync: false, url: DEFAULT_SCRIPT_URL, device: '', capacity: 0 };
let cols = { nome: 0, cognome: -1, info: [], cat: -1, key: [] };
let dups = {};            // k -> motivo
let dupGroups = [];
let filter = 'all', sortMode = 'list', shown = PAGE;
let lastAction = null, wakeLock = null;
let sync = { busy: false, last: 0, error: '', timer: null, rev: '' };

/* ─── STORAGE ─── */
function load(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { console.error(e); toast('Errore nel salvataggio sul telefono!', 'err'); return false; }
}
const saveList = () => save(K_LIST, list && { ...list, rows: list.rows.filter(r => !r.added).map(({ k, c }) => ({ k, c })) });
const saveRecs = () => { save(K_RECS, recs); save(K_QUEUE, queue); };
const saveSettings = () => save(K_SET, settings);
const staffKey = () => { try { return localStorage.getItem(K_KEY) || ''; } catch { return ''; } };

/* ─── UTILS ─── */
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const compact = s => norm(s).replace(/[\s\-.]/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtTime = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const pad = n => String(n).padStart(2, '0');
const dateTag = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };
function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); }
const rowByKey = k => list?.rows.find(r => r.k === k);
const operator = () => settings.device || '';
const needsOperator = () => !settings.device || /^Telefono [A-Z0-9]{3}$/.test(settings.device);
const who = (e, x) => (e && e[2]) || (x && x.d) || '';
function lastEntry(x, type) { const l = (x?.l || []).filter(e => e[1] === type); return l[l.length - 1]; }

/* ─── STATO PERSONA ─── */
const rec = k => recs[k];
const everIn = k => !!(recs[k] && recs[k].t);
const isInside = k => !!(recs[k] && recs[k].t && !recs[k].o);
const isOut = k => !!(recs[k] && recs[k].t && recs[k].o);

/* =====================================================
   COLONNE
   ===================================================== */
function detectColumns(headers) {
  const h = headers.map(norm);
  const find = re => h.findIndex(x => re.test(x));
  let nome = h.findIndex(x => /^(nome|name|first ?name)\b/.test(x) && !/cognome/.test(x));
  let cognome = find(/(cognome|surname|last ?name)/);
  const full = find(/(nominativo|nome e cognome|nome completo|full ?name)/);
  if (full >= 0 && nome < 0) { nome = full; cognome = -1; }
  if (nome < 0 && cognome < 0) { nome = 0; cognome = headers.length > 1 ? 1 : -1; }
  if (nome < 0) { nome = cognome; cognome = -1; }

  const cat = find(/^(stato|status|categoria|tipo|pass|ticket|biglietto)$/);
  const skip = new Set([nome, cognome, cat]);
  const boring = /(timestamp|data invio|^data$|privacy|consenso|accetto|^evento$|^foto|modifiche|come ci conosce|n\.? ?veicoli)/;
  const priority = /(veicolo|targa|auto|modello|macchina|marca|club|team)/;
  const rest = h.map((x, i) => i).filter(i => !skip.has(i) && !boring.test(h[i]));
  const info = [...rest.filter(i => priority.test(h[i])), ...rest.filter(i => !priority.test(h[i]))];

  // colonne che identificano la persona in modo stabile (non cambiano se lo staff modifica lo Stato)
  const id = find(/^(id|codice|code|n\.? ?iscrizione|numero iscrizione)$/);
  let key = [];
  if (id >= 0) key = [id];
  else {
    key = [nome, cognome, find(/^e-?mail/), find(/(telefono|cellulare|phone)/), find(/^targa ?1?$/)].filter(i => i >= 0);
    key = [...new Set(key)];
    if (key.length < 2) key = headers.map((_, i) => i).filter(i => i !== cat);
  }
  return { nome, cognome, info, cat, key };
}

function buildRows(headers, raw) {
  cols = detectColumns(headers);
  const seen = {}, rows = [];
  raw.forEach(r => {
    const c = headers.map((_, j) => String(r[j] ?? '').trim());
    if (!c.some(Boolean)) return;
    let k = 'p' + hash(cols.key.map(i => compact(c[i])).join('␟'));
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] > 1) k += '-' + seen[k];
    rows.push({ k, c });
  });
  return rows;
}

/* aggiunge alla lista le persone registrate in loco (anche da altri telefoni) */
function mergeAdded() {
  if (!list) return false;
  let changed = false;
  Object.entries(recs).forEach(([k, r]) => {
    if (r.a && r.a.c && !rowByKey(k)) {
      const c = list.headers.map((_, i) => String(r.a.c[i] ?? ''));
      list.rows.push({ k, c, added: true }); changed = true;
    }
  });
  return changed;
}

function prepare() {
  if (!list) return;
  cols = detectColumns(list.headers);
  const targaCols = list.headers.map((h, i) => /targa/.test(norm(h)) ? i : -1).filter(i => i >= 0);
  list.rows.forEach(r => {
    const n = String(r.c[cols.nome] ?? '').trim();
    const cg = cols.cognome >= 0 ? String(r.c[cols.cognome] ?? '').trim() : '';
    r._name = (n + ' ' + cg).trim() || '(senza nome)';
    r._first = norm(n); r._last = norm(cg);
    r._search = norm(r.c.join(' '));
    r._compact = r.c.map(compact);
    r._initials = norm(r._name).split(' ').filter(Boolean).map(w => w[0]).join('');
    r._sub = cols.info.map(i => String(r.c[i] ?? '').trim()).filter(Boolean).slice(0, 3).join(' · ');
    r._cat = cols.cat >= 0 ? String(r.c[cols.cat] ?? '').trim() : '';
    r._plates = targaCols.map(i => compact(r.c[i])).filter(x => x.length >= 4);
  });
  findDups();
}

function initials(name) { const w = name.split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase() || '?'; }
function catClass(v) {
  const n = norm(v);
  if (!n) return '';
  if (/(scartat|rifiutat|annullat|bloccat|^no$)/.test(n)) return 'bad';
  if (/(valutare|attesa|pending|sospes)/.test(n)) return 'warn';
  if (/(selezionat|confermat|approvat|accettat|vip|staff|ok|^si$)/.test(n)) return 'good';
  return '';
}

/* ─── DOPPIONI ─── */
function findDups() {
  dups = {}; dupGroups = [];
  if (!list) return;
  const h = list.headers.map(norm);
  const emailC = h.findIndex(x => /^e-?mail/.test(x));
  const telC = h.findIndex(x => /(telefono|cellulare|phone)/.test(x));
  const maps = { mail: {}, tel: {}, targa: {} };
  list.rows.forEach(r => {
    if (emailC >= 0) { const e = norm(r.c[emailC]); if (e.includes('@')) (maps.mail[e] ||= []).push(r); }
    if (telC >= 0) { const t = String(r.c[telC]).replace(/\D/g, '').replace(/^0039|^39(?=\d{9,})/, ''); if (t.length >= 6) (maps.tel[t] ||= []).push(r); }
    [...new Set(r._plates)].forEach(p => (maps.targa[p] ||= []).push(r));
  });
  const labels = { mail: 'Stessa email', tel: 'Stesso telefono', targa: 'Stessa targa' };
  const seenGroup = new Set();
  Object.entries(maps).forEach(([type, m]) => Object.entries(m).forEach(([val, rows]) => {
    const uniq = [...new Map(rows.map(r => [r.k, r])).values()];
    if (uniq.length < 2) return;
    const sig = uniq.map(r => r.k).sort().join('|');
    if (seenGroup.has(sig)) return;
    seenGroup.add(sig);
    dupGroups.push({ type: labels[type], val, rows: uniq });
    uniq.forEach(r => { dups[r.k] = dups[r.k] || labels[type]; });
  }));
}

/* =====================================================
   LOGIN
   ===================================================== */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function isAuthed() { try { return sessionStorage.getItem('ptAuthed') === '1'; } catch { return false; } }
function showAuth(show, afterPassword) {
  $('#auth').classList.toggle('hide', !show);
  if (show) { renderBioBtn(); if (!bioReady()) setTimeout(() => $('#authInput').focus(), 350); }
  else {
    requestWake(); startSync();
    setTimeout(async () => {
      if (needsOperator()) await askOperator();
      if (afterPassword) await offerBio();
    }, 400);
  }
}
function unlock(afterPassword) {
  try { sessionStorage.setItem('ptAuthed', '1'); } catch {}
  $('#authInput').value = ''; $('#authError').textContent = '';
  showAuth(false, afterPassword);
}

/* ─── FACE ID / IMPRONTA (passkey del telefono) ───
   Dopo il primo accesso con password si può attivare lo sblocco biometrico:
   il telefono crea una passkey locale e da lì basta Face ID / Touch ID / impronta. */
const K_BIO = 'pt4_bio';
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const bioId = () => { try { return localStorage.getItem(K_BIO) || ''; } catch { return ''; } };
const bioReady = () => !!(bioId() && staffKey() && window.PublicKeyCredential);
async function bioAvailable() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}
const bioName = () => /iPhone|iPad|Mac/.test(navigator.userAgent) ? 'Face ID' : 'impronta';

async function bioEnable() {
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32),
      rp: { name: 'PadaniaTuning Check-in' },
      user: { id: rand(16), name: settings.device || 'staff', displayName: 'Staff PadaniaTuning · ' + (settings.device || '') },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000
    } });
    localStorage.setItem(K_BIO, b64(cred.rawId));
    renderBioSetting();
    toast(`${bioName()} attivato ✓`);
    return true;
  } catch (e) {
    console.error(e);
    if (e.name !== 'NotAllowedError') toast(`${bioName()} non disponibile su questo telefono`, 'err');
    return false;
  }
}
async function bioLogin() {
  if (!bioReady()) return;
  try {
    await navigator.credentials.get({ publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: unb64(bioId()) }],
      userVerification: 'required', timeout: 60000
    } });
    unlock(false);
  } catch (e) {
    console.error(e);
    $('#authError').textContent = e.name === 'NotAllowedError' ? 'Annullato. Riprova o usa la password.' : `${bioName()} non riuscito: usa la password.`;
  }
}
function bioDisable() { try { localStorage.removeItem(K_BIO); } catch {} renderBioSetting(); renderBioBtn(); }
function renderBioBtn() {
  const b = $('#bioBtn');
  b.hidden = !bioReady();
  b.innerHTML = `${bioName() === 'Face ID' ? '🙂' : '👆'} Entra con ${bioName()}`;
  $('#pwOr').hidden = b.hidden;
}
async function renderBioSetting() {
  const row = $('#bioRow');
  row.hidden = !(await bioAvailable());
  $('#bioToggle').checked = !!bioId();
  $('#bioLabel').textContent = `Accesso con ${bioName()}`;
}
async function offerBio() {
  if (bioId() || !(await bioAvailable())) return;
  try { if (localStorage.getItem('pt4_bio_no')) return; } catch {}
  const res = await modal({ title: `${bioName() === 'Face ID' ? '🙂' : '👆'} Usare ${bioName()}?`, text: `Le prossime volte potrai entrare con ${bioName()} invece di scrivere la password.`, ok: 'Attiva', cancel: 'No grazie' });
  if (res.ok) await bioEnable();
  else try { localStorage.setItem('pt4_bio_no', '1'); } catch {}
}
$('#bioBtn').addEventListener('click', bioLogin);
$('#bioToggle').addEventListener('change', async e => {
  if (e.target.checked) { if (!(await bioEnable())) e.target.checked = false; }
  else { bioDisable(); toast(`${bioName()} disattivato`); }
});
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#authInput');
  let ok = false;
  try { ok = (await sha256(input.value)) === PW_HASH; }
  catch { $('#authError').textContent = "Apri l'app dal link https per accedere."; return; }
  if (ok) {
    try { localStorage.setItem(K_KEY, input.value); } catch {}
    unlock(true);
  } else {
    $('#authError').textContent = 'Password errata, riprova.';
    const card = $('#authForm'); card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 400);
    input.select();
  }
});
$('#pwToggle').addEventListener('click', () => { const i = $('#authInput'); i.type = i.type === 'password' ? 'text' : 'password'; i.focus(); });

/* chiede la password admin (una volta per sessione) */
async function requireAdmin() {
  try { if (sessionStorage.getItem('ptAdmin') === '1') return true; } catch {}
  const res = await modal({
    title: '🔒 Solo amministratore', text: 'Questa impostazione può essere modificata solo dall\'amministratore.',
    body: `<label class="field"><input id="adminPw" type="password" placeholder="Password admin" autocomplete="off"></label>`,
    ok: 'Sblocca', focus: '#adminPw'
  });
  if (!res.ok) return false;
  let ok = false;
  try { ok = (await sha256($('#adminPw').value)) === ADMIN_HASH; } catch {}
  if (!ok) { feedback('bad'); toast('Password admin errata', 'err'); return false; }
  try { sessionStorage.setItem('ptAdmin', '1'); } catch {}
  return true;
}

/* nome di chi usa il telefono: firma ogni ingresso/uscita */
async function askOperator(force) {
  const res = await modal({
    title: 'Come ti chiami?', text: 'Il tuo nome compare su ogni ingresso e uscita che registri, così si sa chi ha fatto entrare chi.',
    body: `<label class="field"><input id="opName" value="${needsOperator() ? '' : esc(settings.device)}" maxlength="24" placeholder="Es. Ale, Marco, Cancello 1…" autocomplete="off" autocapitalize="words"></label>`,
    ok: 'Salva', cancel: force ? 'Annulla' : 'Dopo', focus: '#opName'
  });
  if (!res.ok) return;
  const v = $('#opName').value.trim();
  if (!v) { toast('Scrivi un nome', 'err'); return askOperator(force); }
  settings.device = v; saveSettings(); renderOnline();
  toast(`Ciao ${v} 👋`);
}

/* =====================================================
   NAVIGAZIONE
   ===================================================== */
function showPage(p) {
  $$('.page').forEach(el => el.hidden = el.id !== 'page-' + p);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === p));
  window.scrollTo({ top: 0 });
  if (p === 'stats') renderStats();
  if (p === 'tools') renderOnline();
}
$$('.tab').forEach(t => t.addEventListener('click', () => showPage(t.dataset.page)));

/* =====================================================
   CARICAMENTO LISTA (file / online)
   ===================================================== */
function setList(name, source, headers, raw, keepUndo) {
  headers = headers.map(h => String(h ?? '').trim());
  const width = Math.max(headers.length, ...raw.map(r => r.length));
  while (headers.length < width) headers.push('Colonna ' + (headers.length + 1));
  const rows = buildRows(headers, raw);
  list = { name, source, loadedAt: Date.now(), headers, rows };
  mergeAdded();
  prepare();
  saveList();
  if (!keepUndo) { shown = PAGE; lastAction = null; }
  renderAll();
  return rows.length;
}

$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (typeof XLSX === 'undefined') { toast('Libreria Excel non caricata: serve connessione al primo avvio', 'err'); return; }
  if (list && list.rows.length) {
    const r = await modal({ title: 'Sostituire la lista?', text: `Carichi "${file.name}" al posto di quella attuale. I check-in delle persone presenti in entrambe restano.`, ok: 'Sostituisci' });
    if (!r.ok) return;
  }
  try {
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    if (!raw || raw.length < 2) { toast('File vuoto: servono intestazione + almeno un iscritto', 'err'); return; }
    const n = setList(file.name.replace(/\.(xlsx|xls|csv)$/i, ''), 'file', raw[0], raw.slice(1));
    const kept = list.rows.filter(r => everIn(r.k)).length;
    toast(`${n} iscritti caricati${kept ? ` · ${kept} già entrati` : ''}`);
  } catch (err) { console.error(err); toast('File non valido o danneggiato', 'err'); }
});

async function loadOnline(silent) {
  if (!settings.url) { if (!silent) toast('Manca l\'indirizzo dello script', 'err'); return; }
  if (!silent) toast('Scarico gli iscritti…');
  try {
    const res = await api({ action: 'list' });
    if (!res.rows) throw new Error('Risposta senza iscritti');
    const before = list ? list.rows.length : 0;
    const n = setList(res.name || 'Iscrizioni', 'online', res.headers, res.rows, silent);
    if (!settings.sync) { settings.sync = true; saveSettings(); startSync(); }
    syncNow();
    if (!silent) toast(`🌐 ${n} iscritti scaricati dal sito`);
    else if (n > before && before) toast(`🌐 ${n - before} nuovi iscritti`);
  } catch (err) {
    console.error(err);
    if (!silent) toast(apiErrorText(err), 'err');
    else if (list) list.loadedAt = Date.now();   // riprova tra 5 minuti
  }
}

/* =====================================================
   SINCRONIZZAZIONE (script Google)
   ===================================================== */
async function api(body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(settings.url, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, key: staffKey() })
    });
    const data = await resp.json();
    if (data.auth === false) throw Object.assign(new Error('auth'), { auth: true });
    if (!data.ok) throw new Error(data.error || 'Errore script');
    return data;
  } finally { clearTimeout(t); }
}
function apiErrorText(err) {
  if (err.auth) return 'Password non accettata dallo script Google (CHIAVE_STAFF)';
  if (!navigator.onLine) return 'Nessuna connessione internet';
  if (err.name === 'AbortError') return 'Lo script non risponde, riprova';
  if (/azione sconosciuta|CHIAVE_STAFF/i.test(err.message)) return 'Lo script Google va aggiornato: vedi ISTRUZIONI';
  return 'Collegamento non riuscito: ' + err.message;
}

function startSync() {
  clearInterval(sync.timer);
  if (!settings.sync || !isAuthed()) { renderSyncPill(); return; }
  sync.timer = setInterval(() => {
    if (document.visibilityState !== 'visible' || sync.busy) return;
    // la lista iscritti si riaggiorna da sola ogni 5 minuti (nuove iscrizioni / cambi di Stato)
    if (list?.source === 'online' && Date.now() - list.loadedAt > 5 * 60000 && $('#modal').hidden && $('#scanner').hidden) loadOnline(true);
    else syncNow();
  }, SYNC_EVERY);
  if (list?.source === 'online' && Date.now() - list.loadedAt > 60000) loadOnline(true); else syncNow();
}

let syncSoon;
function scheduleSync() { if (!settings.sync) return renderSyncPill(); clearTimeout(syncSoon); syncSoon = setTimeout(syncNow, 300); renderSyncPill(); }

async function syncNow(manual) {
  if (!settings.sync || sync.busy) { if (manual && !settings.sync) toast('Attiva prima "Sincronizza tra telefoni"', 'warn'); return; }
  if (!navigator.onLine) { sync.error = 'offline'; renderSyncPill(); if (manual) toast('Nessuna connessione: i dati verranno inviati appena torna', 'warn'); return; }
  sync.busy = true; renderSyncPill();
  const sent = Object.keys(queue).map(k => ({ k, r: recs[k], name: rowByKey(k)?._name || recs[k]?.a?.name || '' })).filter(o => o.r);
  try {
    const res = await api({ action: 'sync', ops: sent, rev: sent.length ? '' : sync.rev });
    if (res.rev) sync.rev = res.rev;
    if (res.same) { sync.last = Date.now(); sync.error = ''; return; }
    sent.forEach(o => { if (recs[o.k] && recs[o.k].u === o.r.u) delete queue[o.k]; });
    let changed = false;
    Object.entries(res.recs || {}).forEach(([k, r]) => {
      if (!r || queue[k]) return;
      if (!recs[k] || (r.u || 0) > (recs[k].u || 0)) { recs[k] = r; changed = true; }
    });
    if (mergeAdded()) { prepare(); changed = true; }
    saveRecs();
    sync.last = Date.now(); sync.error = '';
    if (changed) { renderCounts(); renderListSoft(); }
    if (manual) toast('Sincronizzato ✓');
  } catch (err) {
    console.error(err);
    sync.error = err.auth ? 'auth' : 'err';
    if (manual) toast(apiErrorText(err), 'err');
  } finally {
    sync.busy = false; renderSyncPill(); renderOnline();
  }
}
window.addEventListener('online', () => { renderSyncPill(); syncNow(); });
window.addEventListener('offline', renderSyncPill);

function renderSyncPill() {
  const pill = $('#syncPill');
  if (!settings.sync) { pill.hidden = true; return; }
  pill.hidden = false;
  const pending = Object.keys(queue).length;
  let cls = 'ok', txt = 'Live';
  if (!navigator.onLine || sync.error === 'offline') { cls = 'bad'; txt = 'Offline'; }
  else if (sync.error) { cls = 'bad'; txt = 'Errore'; }
  else if (pending) { cls = 'warn'; txt = `${pending} da inviare`; }
  if (pending && cls === 'bad') txt += ` · ${pending}`;
  pill.className = 'sync-pill ' + cls;
  pill.textContent = txt;
}

function renderOnline() {
  const pending = Object.keys(queue).length;
  const dot = $('#onlineDot');
  let title = 'Non collegato', sub = 'Check-in salvati solo su questo telefono', cls = '';
  if (settings.sync) {
    if (sync.error === 'auth') { title = 'Password non accettata'; sub = 'Controlla CHIAVE_STAFF nello script Google'; cls = 'bad'; }
    else if (!navigator.onLine || sync.error === 'offline') { title = 'Offline'; sub = pending ? `${pending} modifiche da inviare appena torna la rete` : 'Riprovo appena torna la rete'; cls = 'bad'; }
    else if (sync.error) { title = 'Errore di collegamento'; sub = 'Lo script potrebbe non essere aggiornato'; cls = 'bad'; }
    else { title = 'Collegato · sincronizzazione attiva'; sub = pending ? `${pending} modifiche in invio…` : 'Tutti i telefoni vedono gli stessi check-in'; cls = 'ok'; }
  }
  dot.className = cls; $('#onlineTitle').textContent = title; $('#onlineSub').textContent = sub;
  $('#syncToggle').checked = settings.sync;
  $('#lastSyncTxt').textContent = sync.last ? `Ultima: ${fmtTime(sync.last)}` : 'Mai sincronizzato';
  $('#deviceTxt').textContent = settings.device;
}

/* =====================================================
   RENDER
   ===================================================== */
function counts() {
  const rows = list ? list.rows : [];
  const tot = rows.length;
  let inN = 0, inside = 0, out = 0;
  rows.forEach(r => { if (everIn(r.k)) { inN++; isInside(r.k) ? inside++ : out++; } });
  return { tot, inN, inside, out, wait: tot - inN, pct: tot ? Math.round(inN / tot * 100) : 0 };
}

function renderAll() {
  const has = !!(list && list.rows.length);
  $('#welcome').hidden = has;
  $('#dash').hidden = !has;
  $('#listName').textContent = has ? list.name : 'Nessuna lista';
  renderCounts();
  renderSyncPill();
  if (has) renderList();
}

function renderCounts() {
  const c = counts();
  $('#chipIn').textContent = c.inside; $('#chipTot').textContent = c.tot;
  $('#countIn').textContent = c.inN; $('#countTot').textContent = c.tot;
  $('#countInside').textContent = c.inside; $('#countOut').textContent = c.out; $('#outWrap').hidden = !c.out;
  $('#countWait').textContent = c.wait;
  $('#countPct').textContent = c.pct + '%';
  $('#ring').style.setProperty('--p', c.pct);
  $('#barFill').style.width = c.pct + '%';
  $('#fAll').textContent = c.tot; $('#fYes').textContent = c.inN; $('#fNo').textContent = c.wait;
  $('#scanIn').textContent = c.inside; $('#scanTot').textContent = c.tot;
  $('#undoBtn').hidden = !lastAction;
  const nd = dupGroups.length;
  $('#dupBanner').hidden = !nd;
  $('#dupBanner').innerHTML = `👯 <b>${nd} ${nd === 1 ? 'possibile doppione' : 'possibili doppioni'}</b> nella lista · Vedi`;
  renderCap();
}

/* ─── CAPIENZA ───
   Conta chi è DENTRO ORA. Avvisi: 75% quasi al completo, 90% ultimi posti, 100% raggiunta. */
let capLevel = -1;
function capInfo() {
  const cap = +settings.capacity || 0;
  if (!cap) return null;
  const inside = counts().inside, p = inside / cap;
  return { cap, inside, left: Math.max(0, cap - inside), level: p >= 1 ? 3 : p >= 0.9 ? 2 : p >= 0.75 ? 1 : 0 };
}
function renderCap() {
  const ci = capInfo();
  const banners = [$('#capBanner'), $('#scanCap')];
  if (!ci) { $('#capRow').hidden = true; banners.forEach(b => b.hidden = true); capLevel = -1; return; }
  $('#capRow').hidden = false;
  $('#capRow').className = 'cap-row lvl' + ci.level;
  $('#capTxt2').textContent = `${ci.inside} / ${ci.cap}`;
  $('#capFill').style.width = Math.min(100, ci.inside / ci.cap * 100) + '%';
  const msg = ['',
    `⚠️ <b>Quasi al completo</b> · ${ci.inside} su ${ci.cap} posti occupati`,
    `🟠 <b>Ultimi posti</b> · ne ${ci.left === 1 ? 'resta 1' : 'restano ' + ci.left}`,
    `⛔ <b>Capienza raggiunta</b> · ${ci.inside} dentro su ${ci.cap}`][ci.level];
  banners.forEach(b => { b.hidden = !ci.level; b.className = 'cap-banner lvl' + ci.level; b.innerHTML = msg; });
  if (capLevel >= 0 && ci.level > capLevel) {          // appena superata una soglia
    setTimeout(() => feedback(ci.level === 3 ? 'bad' : 'warn'), 350);
    toast(msg.replace(/<[^>]+>/g, ''), ci.level === 3 ? 'err' : 'warn');
  }
  capLevel = ci.level;
}
async function confirmCap() {
  const ci = capInfo();
  if (!ci || ci.inside < ci.cap) return true;
  const res = await modal({ title: '⛔ Capienza raggiunta', text: `Dentro ci sono già ${ci.inside} persone su ${ci.cap}. Far entrare comunque?`, ok: 'Fai entrare', danger: true, cancel: 'Indietro' });
  return res.ok;
}

function matches(r, q, tokens) {
  if (!q) return true;
  if (tokens.every(t => r._search.includes(t))) return true;
  const qc = q.replace(/[\s\-.]/g, '');
  if (qc.length >= 3 && r._compact.some(c => c.includes(qc))) return true;
  return q.length >= 2 && /^[a-z]+$/.test(q) && r._initials.startsWith(q);
}

function filteredRows() {
  const q = norm($('#searchInput').value);
  const tokens = q.split(' ').filter(Boolean);
  let rows = list.rows.filter(r => {
    if (filter === 'yes' && !everIn(r.k)) return false;
    if (filter === 'no' && everIn(r.k)) return false;
    return matches(r, q, tokens);
  });
  const lastMove = k => { const r = recs[k]; return r ? Math.max(r.t || 0, r.o || 0) : 0; };
  if (sortMode === 'az') rows = [...rows].sort((a, b) => (a._last || a._first).localeCompare(b._last || b._first) || a._first.localeCompare(b._first));
  if (sortMode === 'recent') rows = [...rows].sort((a, b) => lastMove(b.k) - lastMove(a.k));
  if (sortMode === 'cat') rows = [...rows].sort((a, b) => a._cat.localeCompare(b._cat));
  return { rows, tokens };
}

function highlight(text, tokens) {
  if (!tokens.length) return esc(text);
  const n = norm(text);
  if (n.length !== text.length) return esc(text);
  const marks = new Array(text.length).fill(false);
  tokens.forEach(t => { let i = n.indexOf(t); while (i >= 0) { for (let j = i; j < i + t.length; j++) marks[j] = true; i = n.indexOf(t, i + 1); } });
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

function personHTML(r, tokens = []) {
  const x = recs[r.k] || {};
  const inside = isInside(r.k), out = isOut(r.k);
  const cc = catClass(r._cat);
  const tags = [
    inside ? `<span class="tag ok">✓ Dentro dalle ${fmtTime(lastIn(x))}${byTxt(lastEntry(x, 'i'), x)}</span>` : '',
    out ? `<span class="tag out">↗ Uscito ${fmtTime(x.o)}${byTxt(lastEntry(x, 'o'), x)}</span>` : '',
    r._cat ? `<span class="tag cat ${cc}">${esc(r._cat)}</span>` : '',
    r.added ? `<span class="tag new">In loco</span>` : '',
    dups[r.k] ? `<span class="tag dup">👯 Doppione?</span>` : '',
    x.n ? `<span class="tag note">📝 ${esc(x.n)}</span>` : ''
  ].join('');
  return `<li class="person${inside ? ' in' : ''}${out ? ' out' : ''}${cc === 'bad' ? ' flag-bad' : ''}" data-k="${esc(r.k)}">
    <div class="avatar">${esc(initials(r._name))}</div>
    <div class="p-main">
      <div class="p-name">${highlight(r._name, tokens)}</div>
      ${r._sub ? `<div class="p-sub">${highlight(r._sub, tokens)}</div>` : ''}
      ${tags ? `<div class="p-tags">${tags}</div>` : ''}
    </div>
    <button class="check" data-act="check" aria-label="${inside ? 'Uscita o annulla' : out ? 'Rientro' : 'Registra ingresso'}">${out ? '↩' : '✓'}</button>
  </li>`;
}
function byTxt(e, x) { const w = who(e, x); return w ? ` · ${esc(w)}` : ''; }
function lastIn(x) { const ins = (x.l || []).filter(e => e[1] === 'i'); return ins.length ? ins[ins.length - 1][0] : x.t; }

function renderList() {
  const { rows, tokens } = filteredRows();
  const ul = $('#people');
  if (!rows.length) {
    const q = $('#searchInput').value.trim();
    ul.innerHTML = `<li class="empty"><b>${q ? '🔍' : filter === 'no' ? '🎉' : '—'}</b>${q ? `Nessuno trovato per “${esc(q)}”` : filter === 'no' ? 'Sono entrati tutti!' : 'Ancora nessun ingresso'}</li>`;
  } else ul.innerHTML = rows.slice(0, shown).map(r => personHTML(r, tokens)).join('');
  $('#moreBtn').hidden = rows.length <= shown;
  $('#moreBtn').textContent = `Mostra altri (${rows.length - shown})`;
  $('#resultInfo').textContent = `${rows.length} ${rows.length === 1 ? 'persona' : 'persone'}`;
}
/* aggiornamento dalla sincronizzazione: non disturba se c'è una finestra aperta */
function renderListSoft() { if (!$('#dash').hidden && $('#modal').hidden) renderList(); else if ($('#modal').hidden) renderAll(); }

function refreshItem(k, flash) {
  const li = $(`.person[data-k="${CSS.escape(k)}"]`);
  const r = rowByKey(k);
  if (!li || !r) return;
  li.outerHTML = personHTML(r, norm($('#searchInput').value).split(' ').filter(Boolean));
  if (flash) $(`.person[data-k="${CSS.escape(k)}"]`)?.classList.add('flash');
}

/* =====================================================
   AZIONI SU UNA PERSONA
   ===================================================== */
function touch(k, r) {
  lastAction = { k, prev: recs[k] ? JSON.parse(JSON.stringify(recs[k])) : null };
  r.u = Date.now(); r.d = settings.device;
  r.nm = rowByKey(k)?._name || r.a?.name || r.nm || '';   // nome, serve allo schermo live
  recs[k] = r; queue[k] = 1;
  saveRecs(); scheduleSync();
}
const base = k => JSON.parse(JSON.stringify(recs[k] || { t: 0, o: 0, n: '', v: '', l: [] }));

function doIn(k, via) {
  const r = base(k), now = Date.now();
  if (!r.t) r.t = now;
  r.o = 0; (r.l ||= []).push([now, 'i', operator()]);
  if (via) r.v = via;
  touch(k, r);
}
function doOut(k) { const r = base(k), now = Date.now(); r.o = now; (r.l ||= []).push([now, 'o', operator()]); touch(k, r); }
function doCancel(k) { const r = base(k); r.t = 0; r.o = 0; r.v = ''; (r.l ||= []).push([Date.now(), 'x', operator()]); touch(k, r); }
function doNote(k, text) { const r = base(k); r.n = text; touch(k, r); }

function undo() {
  if (!lastAction) return;
  const { k, prev } = lastAction;
  const r = prev || { t: 0, o: 0, n: '', v: '', l: [] };
  r.u = Date.now(); r.d = settings.device;
  recs[k] = r; queue[k] = 1; saveRecs(); scheduleSync();
  lastAction = null;
  renderCounts(); renderList();
  toast('Operazione annullata', 'warn');
}
$('#undoBtn').addEventListener('click', undo);

/* chiede conferma se lo Stato non è "selezionato" */
async function confirmCat(r) {
  const cc = catClass(r._cat);
  if (!r._cat || cc === 'good' || cc === '') return true;
  const res = await modal({ title: cc === 'bad' ? '⛔ Attenzione' : '⚠️ Attenzione', text: `${r._name} ha stato “${r._cat}”. Registrare comunque l'ingresso?`, ok: 'Fai entrare', danger: cc === 'bad', cancel: 'Indietro' });
  return res.ok;
}

async function quickAction(k) {
  const r = rowByKey(k);
  if (!r) return;
  if (isInside(k)) {
    const res = await choose(r._name, `Dentro dalle ${fmtTime(lastIn(recs[k]))}${who(lastEntry(recs[k], 'i'), recs[k]) ? ' · fatto entrare da ' + who(lastEntry(recs[k], 'i'), recs[k]) : ''}`, [
      { id: 'out', label: '↗ Segna uscita' },
      { id: 'cancel', label: '✕ Annulla ingresso (errore)', cls: 'danger' }
    ]);
    if (res === 'out') { doOut(k); toast(`↗ Uscito: ${r._name}`, '', 'Annulla', undo); }
    else if (res === 'cancel') { doCancel(k); toast(`Ingresso annullato: ${r._name}`, 'warn', 'Annulla', undo); }
    else return;
  } else {
    const wasOut = isOut(k);
    if (!(await confirmCap())) return;
    if (!wasOut && !(await confirmCat(r))) return;
    doIn(k);
    feedback('ok');
    toast(`${wasOut ? '↩ Rientrato' : '✓ Entrato'}: ${r._name}`, '', 'Annulla', undo);
  }
  afterChange(k);
}

function afterChange(k) {
  refreshItem(k, isInside(k));
  renderCounts();
  const search = $('#searchInput').value.trim();
  if (filter !== 'all' || sortMode === 'recent' || search) {
    setTimeout(() => {
      if (search && isInside(k)) { $('#searchInput').value = ''; $('#searchClear').hidden = true; }
      renderList();
    }, 900);
  }
}

$('#people').addEventListener('click', e => {
  const li = e.target.closest('.person');
  if (!li) return;
  if (e.target.closest('[data-act=check]')) quickAction(li.dataset.k);
  else openDetail(li.dataset.k);
});

/* ─── SCHEDA DETTAGLIO ─── */
function fieldValue(h, v) {
  const n = norm(h); const s = String(v);
  if (/^https?:\/\//.test(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener">Apri ↗</a>`;
  if (/e-?mail/.test(n) && s.includes('@')) return `<a href="mailto:${esc(s)}">${esc(s)}</a>`;
  if (/(telefono|cellulare|phone)/.test(n)) return `<a href="tel:${esc(s.replace(/[^\d+]/g, ''))}">${esc(s)}</a>`;
  if (/instagram/.test(n)) { const u = s.replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/.*/, ''); return `<a href="https://instagram.com/${esc(u)}" target="_blank" rel="noopener">@${esc(u)}</a>`; }
  return esc(s);
}

async function openDetail(k) {
  const r = rowByKey(k); if (!r) return;
  const x = recs[k] || {};
  const inside = isInside(k), out = isOut(k);
  const status = inside ? `<span class="tag ok">✓ Dentro dalle ${fmtTime(lastIn(x))}${byTxt(lastEntry(x, 'i'), x)}</span>` : out ? `<span class="tag out">↗ Uscito alle ${fmtTime(x.o)}${byTxt(lastEntry(x, 'o'), x)}</span>` : '<span class="tag">Non ancora entrato</span>';
  const fields = list.headers.map((h, i) => [h, r.c[i]]).filter(([, v]) => String(v).trim());
  const log = (x.l || []).slice().reverse().map(e => `<li><span>${e[1] === 'i' ? '✓ Entrata' : e[1] === 'o' ? '↗ Uscita' : '✕ Annullato'}${who(e, x) ? ` <small class="by">da ${esc(who(e, x))}</small>` : ''}</span><time class="${e[1] === 'o' ? 'o' : e[1] === 'x' ? 'x' : ''}">${fmtTime(e[0])}</time></li>`).join('');
  const btns = inside
    ? `<button class="btn btn-dark" data-d="out">↗ Segna uscita</button><button class="btn btn-ghost danger-txt" data-d="cancel">Annulla ingresso</button>`
    : `<button class="btn btn-chrome" data-d="in">${out ? '↩ Rientro' : '✓ Registra ingresso'}</button>`;
  const res = await modal({
    title: r._name, text: '',
    body: `<div class="detail">
      <div class="p-tags">${status}${r._cat ? `<span class="tag cat ${catClass(r._cat)}">${esc(r._cat)}</span>` : ''}${r.added ? '<span class="tag new">In loco</span>' : ''}${dups[k] ? `<span class="tag dup">👯 ${esc(dups[k])}</span>` : ''}</div>
      ${x.v ? `<div class="d-via">Entrato con: <b>${esc(x.v)}</b></div>` : ''}
      <dl>${fields.map(([h, v]) => `<dt>${esc(h)}</dt><dd>${fieldValue(h, v)}</dd>`).join('')}</dl>
      <div class="d-note"><span>Nota</span><p>${x.n ? esc(x.n) : '<i>Nessuna nota</i>'}</p><button class="link-btn" data-d="note">✏️ ${x.n ? 'Modifica' : 'Aggiungi'} nota</button></div>
      ${log ? `<div class="d-log"><span>Storico</span><ul class="recent">${log}</ul></div>` : ''}
      <div class="d-actions">${btns}</div>
    </div>`,
    single: true, ok: 'Chiudi',
    onBody: b => b.addEventListener('click', e => { const d = e.target.closest('[data-d]'); if (d) closeModal(d.dataset.d); })
  });
  const v = res.value;
  if (v === 'in') { if (!(await confirmCap())) return; if (!out && !(await confirmCat(r))) return; doIn(k); feedback('ok'); toast(`${out ? '↩ Rientrato' : '✓ Entrato'}: ${r._name}`, '', 'Annulla', undo); afterChange(k); }
  if (v === 'out') { doOut(k); toast(`↗ Uscito: ${r._name}`, '', 'Annulla', undo); afterChange(k); }
  if (v === 'cancel') { doCancel(k); toast(`Ingresso annullato: ${r._name}`, 'warn', 'Annulla', undo); afterChange(k); }
  if (v === 'note') editNote(k);
}

async function editNote(k) {
  const r = rowByKey(k);
  const res = await modal({
    title: 'Nota', text: r._name,
    body: `<label class="field"><textarea id="noteText" rows="3" placeholder="Es. pagamento da verificare, pass VIP…">${esc(recs[k]?.n || '')}</textarea></label>`,
    ok: 'Salva', focus: '#noteText'
  });
  if (!res.ok) return;
  const v = $('#noteText').value.trim();
  doNote(k, v);
  refreshItem(k);
  toast(v ? 'Nota salvata' : 'Nota rimossa');
}

/* ─── AGGIUNGI IN LOCO ─── */
$('#addBtn').addEventListener('click', async () => {
  const two = cols.cognome >= 0;
  const infoCol = cols.info[0];
  const res = await modal({
    title: 'Aggiungi partecipante', text: 'Per chi si iscrive direttamente all\'ingresso.',
    body: `
      <label class="field"><span>${esc(list.headers[cols.nome] || 'Nome')}</span><input id="addNome" autocomplete="off"></label>
      ${two ? `<label class="field"><span>${esc(list.headers[cols.cognome])}</span><input id="addCognome" autocomplete="off"></label>` : ''}
      ${infoCol !== undefined ? `<label class="field"><span>${esc(list.headers[infoCol])} (facoltativo)</span><input id="addInfo" autocomplete="off"></label>` : ''}
      <label class="field"><span>Nota (facoltativa)</span><input id="addNote" autocomplete="off"></label>`,
    ok: 'Aggiungi ed entra', focus: '#addNome'
  });
  if (!res.ok) return;
  const nome = $('#addNome').value.trim(), cognome = two ? $('#addCognome').value.trim() : '';
  if (!nome && !cognome) { toast('Inserisci almeno il nome', 'err'); return; }
  const c = list.headers.map(() => '');
  c[cols.nome] = nome; if (two) c[cols.cognome] = cognome;
  const info = $('#addInfo')?.value.trim(); if (info) c[infoCol] = info;
  if (cols.cat >= 0) c[cols.cat] = 'In loco';
  const k = 'add-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const now = Date.now();
  recs[k] = { t: 0, o: 0, n: '', v: '', l: [], a: { c, name: (nome + ' ' + cognome).trim() } };
  mergeAdded(); prepare();
  const r = base(k); r.t = now; r.l = [[now, 'i', operator()]]; r.n = $('#addNote').value.trim();
  touch(k, r);
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
$('#searchClear').addEventListener('click', () => { $('#searchInput').value = ''; $('#searchClear').hidden = true; shown = PAGE; renderList(); $('#searchInput').focus(); });
$$('.seg').forEach(b => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  $$('.seg').forEach(x => x.classList.toggle('active', x === b));
  shown = PAGE; renderList();
}));
$('#moreBtn').addEventListener('click', () => { shown += PAGE; renderList(); });

$('#sortBtn').addEventListener('click', async () => {
  const opts = [{ id: 'list', label: 'Ordine lista' }, { id: 'az', label: 'Cognome A→Z' }, { id: 'recent', label: 'Ultimi movimenti' }];
  if (cols.cat >= 0) opts.push({ id: 'cat', label: list.headers[cols.cat] });
  const v = await choose('Ordina per', '', opts.map(o => ({ ...o, active: o.id === sortMode })));
  if (!v) return;
  sortMode = v;
  $('#sortLabel').textContent = opts.find(o => o.id === v).label.replace('Ordine ', '');
  shown = PAGE; renderList();
});

window.addEventListener('scroll', () => {
  const t = $('#stickyTools');
  if (t && !$('#dash').hidden) t.classList.toggle('stuck', t.getBoundingClientRect().top <= 0.5);
}, { passive: true });

/* ─── RICERCA VOCALE ───
   Su iPhone, se il permesso viene negato, a volte non arriva l'evento di fine:
   per questo il pulsante si spegne da solo su errore, dopo un silenzio o al massimo dopo 12 secondi. */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const mic = $('#micBtn');
  mic.hidden = false;
  let rec = null, stopTimer = null, silenceTimer = null;
  const micOff = () => {
    clearTimeout(stopTimer); clearTimeout(silenceTimer);
    mic.classList.remove('on');
    const r = rec; rec = null;
    if (r) { r.onend = r.onerror = r.onresult = null; try { r.abort(); } catch {} }
  };
  mic.addEventListener('click', () => {
    if (rec) { micOff(); return; }
    rec = new SR(); rec.lang = 'it-IT'; rec.interimResults = true; rec.maxAlternatives = 1;
    mic.classList.add('on');
    stopTimer = setTimeout(micOff, 12000);
    rec.onresult = e => {
      const txt = [...e.results].map(x => x[0].transcript).join(' ').replace(/[.,!?]/g, '').trim();
      $('#searchInput').value = txt; $('#searchClear').hidden = !txt;
      shown = PAGE; renderList();
      clearTimeout(silenceTimer); silenceTimer = setTimeout(micOff, 1800);   // 1,8 s di silenzio = fine
      if (e.results[e.results.length - 1].isFinal) setTimeout(micOff, 300);
    };
    rec.onerror = e => {
      micOff();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microfono non autorizzato: puoi attivarlo nelle impostazioni del telefono', 'err');
      else if (e.error === 'no-speech') toast('Non ho sentito niente, riprova', 'warn');
    };
    rec.onend = micOff;
    try { rec.start(); } catch { micOff(); }
  });
}

/* =====================================================
   SCANNER QR
   ===================================================== */
let qr = null, lastCode = '', lastCodeAt = 0, busyUntil = 0;
$('#scanBtn').addEventListener('click', openScanner);
$('#scanClose').addEventListener('click', closeScanner);

async function openScanner() {
  if (typeof Html5Qrcode === 'undefined') { toast('Scanner non disponibile: serve connessione al primo avvio', 'err'); return; }
  $('#toast').className = '';
  $('#scanner').hidden = false;
  setScanResult('', 'In attesa di un codice…');
  renderCounts();
  clearTimeout(camIdle);
  // fotocamera rimasta in pausa: riparte subito, senza chiedere di nuovo il permesso
  try { if (qr && qr.getState && qr.getState() === 3) { qr.resume(); return; } } catch (e) { console.error(e); qr = null; }
  try {
    qr = new Html5Qrcode('reader', { verbose: false });
    await qr.start({ facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.62); return { width: s, height: s }; } },
      onScan, () => {});
  } catch (err) {
    console.error(err);
    setScanResult('bad', '<b>Fotocamera non disponibile</b>Controlla i permessi della fotocamera nelle impostazioni.', '📷');
  }
}
/* chiudendo lo scanner la fotocamera va in pausa per 3 minuti: se lo riapri non richiede il permesso */
let camIdle = null;
async function stopCamera() {
  clearTimeout(camIdle);
  try { if (qr && (qr.isScanning || qr.getState?.() === 3)) await qr.stop(); qr?.clear(); } catch (e) { console.error(e); }
  qr = null;
}
async function closeScanner() {
  $('#scanner').hidden = true; renderList();
  try { if (qr && qr.isScanning) { qr.pause(true); camIdle = setTimeout(stopCamera, 3 * 60000); return; } } catch (e) { console.error(e); }
  stopCamera();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && $('#scanner').hidden) stopCamera(); });

/* trova la persona e, se il codice è una targa, il veicolo corrispondente */
function findByCode(text) {
  const t = norm(text), tc = compact(text);
  for (const r of list?.rows || []) {
    if (r.k === text) return { r };
    for (let i = 0; i < r.c.length; i++) {
      const c = r.c[i];
      if (!c) continue;
      if (norm(c) === t || (tc.length >= 4 && compact(c) === tc)) return { r, via: vehicleFor(r, i) };
    }
  }
  return null;
}
function vehicleFor(r, i) {
  const h = norm(list.headers[i]);
  const m = h.match(/^targa ?(\d*)$/);
  if (!m) return '';
  const vc = list.headers.findIndex(x => norm(x) === ('veicolo ' + m[1]).trim() || (!m[1] && /^(veicolo|auto|modello)$/.test(norm(x))));
  return [vc >= 0 ? r.c[vc] : '', r.c[i]].filter(Boolean).join(' · ');
}

function onScan(text) {
  const now = Date.now();
  if (now < busyUntil) return;
  if (text === lastCode && now - lastCodeAt < 4000) return;
  lastCode = text; lastCodeAt = now; busyUntil = now + 1500;
  scanActions([]);

  const found = findByCode(text);
  if (!found) { feedback('bad'); setScanResult('bad', `<b>Non trovato</b>${esc(text.length > 40 ? text.slice(0, 40) + '…' : text)}`, '✕'); return; }
  const { r, via } = found;
  const sub = via || r._sub || '';

  if (isInside(r.k)) {
    feedback('warn');
    setScanResult('warn', `<b>${esc(r._name)}</b>Già dentro dalle ${fmtTime(lastIn(recs[r.k]))}${who(lastEntry(recs[r.k], 'i'), recs[r.k]) ? ' · fatto entrare da ' + esc(who(lastEntry(recs[r.k], 'i'), recs[r.k])) : ''}`, '⚠️');
    scanActions([{ label: '↗ Segna uscita', fn: () => { doOut(r.k); setScanResult('', `<b>${esc(r._name)}</b>Uscita registrata`, '↗'); renderCounts(); } }]);
    return;
  }
  admitScan(r, via, sub, false, false);
}
/* fa entrare dallo scanner, controllando capienza e Stato */
function admitScan(r, via, sub, skipCap, skipCat) {
  const wasOut = isOut(r.k);
  const ci = capInfo();
  if (!skipCap && ci && ci.inside >= ci.cap) {
    feedback('bad');
    setScanResult('bad', `<b>${esc(r._name)}</b>Capienza raggiunta: ${ci.inside} dentro su ${ci.cap}`, '⛔');
    scanActions([{ label: 'Fai entrare comunque', fn: () => admitScan(r, via, sub, true, skipCat) }]);
    return;
  }
  const cc = catClass(r._cat);
  if (!wasOut && !skipCat && r._cat && (cc === 'bad' || cc === 'warn')) {
    feedback(cc === 'bad' ? 'bad' : 'warn');
    setScanResult(cc === 'bad' ? 'bad' : 'warn', `<b>${esc(r._name)}</b>Stato: ${esc(r._cat)} · ${esc(sub)}`, cc === 'bad' ? '⛔' : '⚠️');
    scanActions([{ label: 'Fai entrare comunque', fn: () => admitScan(r, via, sub, true, true) }]);
    return;
  }
  doIn(r.k, via); feedback('ok');
  setScanResult('ok', `<b>${esc(r._name)}</b>${wasOut ? 'Rientrato · ' : ''}${esc(sub || 'Ingresso registrato')}`, wasOut ? '↩' : '✓');
  renderCounts();
}
function setScanResult(cls, html, ico = '') {
  const el = $('#scanResult');
  el.className = 'scan-result ' + cls;
  el.innerHTML = (ico ? `<span class="ico">${ico}</span>` : '') + `<span>${html}</span>`;
}
function scanActions(acts) {
  const box = $('#scanActions');
  box.innerHTML = '';
  acts.forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn btn-dark btn-block'; b.textContent = a.label;
    b.onclick = () => { box.innerHTML = ''; a.fn(); };
    box.appendChild(b);
  });
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
function statsData() {
  const c = counts();
  const entries = list ? list.rows.filter(r => everIn(r.k)).map(r => ({ r, t: recs[r.k].t })).sort((a, b) => a.t - b.t) : [];
  const buckets = {};
  entries.forEach(({ t }) => { const d = new Date(t); const k = `${pad(d.getHours())}:${pad(Math.floor(d.getMinutes() / 15) * 15)}`; buckets[k] = (buckets[k] || 0) + 1; });
  const keys = Object.keys(buckets).sort();
  const peak = keys.reduce((b, k) => (!b || buckets[k] > buckets[b] ? k : b), null);
  let rate = null;
  if (entries.length > 1) { const span = (entries[entries.length - 1].t - entries[0].t) / 60000; if (span >= 10) rate = Math.round(entries.length / span * 60); }
  const cats = {};
  if (cols.cat >= 0 && list) list.rows.forEach(r => { const v = r._cat || '—'; cats[v] ||= { tot: 0, in: 0 }; cats[v].tot++; if (everIn(r.k)) cats[v].in++; });
  const moves = [];
  const ops = {};
  if (list) list.rows.forEach(r => (recs[r.k]?.l || []).forEach(e => {
    moves.push({ r, t: e[0], ty: e[1], by: who(e, recs[r.k]) });
    if (e[1] === 'i') { const w = who(e, recs[r.k]) || '—'; ops[w] = (ops[w] || 0) + 1; }
  }));
  moves.sort((a, b) => b.t - a.t);
  return { c, entries, buckets, keys, peak, rate, cats, moves, ops,
    first: entries.length ? entries[0].t : null, last: entries.length ? entries[entries.length - 1].t : null,
    notes: list ? list.rows.filter(r => recs[r.k]?.n).length : 0, added: list ? list.rows.filter(r => r.added).length : 0 };
}

function renderStats() {
  const s = statsData(), c = s.c;
  $('#sTot').textContent = c.tot; $('#sIn').textContent = c.inN; $('#sInside').textContent = c.inside;
  $('#sWait').textContent = c.wait; $('#sPct').textContent = c.pct + '%'; $('#sOut').textContent = c.out;
  $('#sFirst').textContent = s.first ? fmtTime(s.first) : '—';
  $('#sLast').textContent = s.last ? fmtTime(s.last) : '—';
  $('#sPeak').textContent = s.peak ? `${s.peak} · ${s.buckets[s.peak]}` : '—';
  $('#sRate').textContent = s.rate ? `~${s.rate} / ora` : '—';
  const max = s.keys.length ? Math.max(...s.keys.map(k => s.buckets[k])) : 1;
  $('#chart').innerHTML = s.keys.length
    ? s.keys.map(k => `<div class="col"><span class="v">${s.buckets[k]}</span><div class="b${k === s.peak ? ' peak' : ''}" style="height:${Math.max(3, Math.round(s.buckets[k] / max * 100))}%"></div><span class="l">${k}</span></div>`).join('')
    : '<p class="muted">Nessun ingresso registrato ancora.</p>';
  const catEntries = Object.entries(s.cats).sort((a, b) => b[1].tot - a[1].tot);
  $('#catCard').hidden = !catEntries.length;
  if (catEntries.length) {
    $('#catTitle').textContent = 'PER ' + list.headers[cols.cat].toUpperCase();
    $('#catList').innerHTML = catEntries.map(([v, x]) => `<li><span class="tag cat ${catClass(v)}">${esc(v)}</span><span class="cat-bar"><i style="width:${x.tot ? Math.round(x.in / x.tot * 100) : 0}%"></i></span><b>${x.in}/${x.tot}</b></li>`).join('');
  }
  $('#recent').innerHTML = s.moves.length
    ? s.moves.slice(0, 12).map(m => `<li><span>${m.ty === 'i' ? '✓' : m.ty === 'o' ? '↗' : '✕'} ${esc(m.r._name)}${m.by ? ` <small class="by">da ${esc(m.by)}</small>` : ''}</span><time class="${m.ty === 'o' ? 'o' : m.ty === 'x' ? 'x' : ''}">${fmtTime(m.t)}</time></li>`).join('')
    : '<li class="muted">—</li>';
  $('#sNotes').textContent = s.notes; $('#sAdded').textContent = s.added;
  const opE = Object.entries(s.ops).sort((a, b) => b[1] - a[1]);
  $('#opCard').hidden = !opE.length;
  const opMax = opE.length ? opE[0][1] : 1;
  $('#opList').innerHTML = opE.map(([w, n]) => `<li><span class="op-name">${esc(w)}</span><span class="cat-bar"><i style="width:${Math.round(n / opMax * 100)}%"></i></span><b>${n}</b></li>`).join('');
}

/* =====================================================
   STRUMENTI
   ===================================================== */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (b && ACTIONS[b.dataset.action]) ACTIONS[b.dataset.action]();
});

const ACTIONS = {
  loadOnline: () => loadOnline(false),
  syncNow: () => syncNow(true),
  export: () => exportExcel(false),
  exportWaiting: () => exportExcel(true),
  pdf: () => exportPDF(),
  async showDups() {
    if (!list) return toast('Carica prima una lista', 'err');
    if (!dupGroups.length) return toast('Nessun doppione trovato 👍');
    await modal({
      title: dupGroups.length === 1 ? '1 possibile doppione' : `${dupGroups.length} possibili doppioni`, text: 'Persone con stessa email, telefono o targa. Controlla prima di farle entrare.',
      body: `<div class="dup-list">${dupGroups.map(g => `<div class="dup-g"><div class="dup-h">${esc(g.type)} · <b>${esc(g.val)}</b></div>${g.rows.map(r => `<div class="dup-r">${esc(r._name)}${everIn(r.k) ? ' <span class="tag ok">entrato</span>' : ''}</div>`).join('')}</div>`).join('')}</div>`,
      single: true, ok: 'Chiudi'
    });
  },
  backup() {
    if (!list) return toast('Niente da salvare: carica prima una lista', 'err');
    const data = { app: 'pt-checkin', v: 4, savedAt: Date.now(), list: { ...list, rows: list.rows.filter(r => !r.added).map(({ k, c }) => ({ k, c })) }, recs };
    saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `Padania_backup_${dateTag()}.json`);
    toast('Backup creato 💾');
  },
  restore: () => $('#restoreInput').click(),
  async resetCheckins() {
    const r = await modal({ title: 'Azzerare i check-in?', text: settings.sync ? 'Cancella ingressi, uscite e note su TUTTI i telefoni collegati. Non si può annullare.' : 'Tutti gli ingressi e le note verranno cancellati. La lista resta. Non si può annullare.', ok: 'Azzera', danger: true });
    if (!r.ok) return;
    const now = Date.now();
    Object.keys(recs).forEach(k => { recs[k] = { t: 0, o: 0, n: '', v: '', l: [], a: recs[k].a, u: now, d: settings.device }; queue[k] = 1; });
    saveRecs(); scheduleSync(); lastAction = null; renderAll();
    toast('Check-in azzerati', 'warn');
  },
  async clearAll() {
    const r = await modal({ title: 'Cancellare i dati dal telefono?', text: 'Lista, check-in e note vengono rimossi da questo telefono. Il Foglio Google non viene toccato.', ok: 'Cancella', danger: true });
    if (!r.ok) return;
    list = null; recs = {}; queue = {}; dups = {}; dupGroups = [];
    localStorage.removeItem(K_LIST); saveRecs(); lastAction = null;
    renderAll(); showPage('checkin');
    toast('Dati cancellati', 'warn');
  },
  logout() { try { sessionStorage.removeItem('ptAuthed'); sessionStorage.removeItem('ptAdmin'); } catch {} clearInterval(sync.timer); showAuth(true); },
  deviceName: () => askOperator(true),
  updateApp: () => checkUpdate(true),
  forceUpdate: () => updateApp(),
  async capacity() {
    const res = await modal({ title: 'Capienza massima', text: 'Quante persone possono stare dentro insieme? L\'app avvisa al 75% (quasi al completo), al 90% (ultimi posti) e al 100%. Lascia vuoto o 0 per disattivare.',
      body: `<label class="field"><input id="capIn" type="number" inputmode="numeric" min="0" value="${settings.capacity || ''}" placeholder="Es. 100"></label>`, ok: 'Salva', focus: '#capIn' });
    if (!res.ok) return;
    settings.capacity = Math.max(0, parseInt($('#capIn').value, 10) || 0); saveSettings();
    capLevel = -1; applySettings(); renderCounts();
    toast(settings.capacity ? `Capienza impostata: ${settings.capacity}` : 'Avviso capienza disattivato');
  },
  screen: () => window.open('schermo.html' + (settings.capacity ? '?cap=' + settings.capacity : ''), '_blank'),
  async scriptUrl() {
    if (!(await requireAdmin())) return;
    const res = await modal({ title: 'Indirizzo script', text: 'L\'URL dell\'app web Google (finisce con /exec). È lo stesso di assets/js/config.js del sito.',
      body: `<label class="field"><textarea id="urlTxt" rows="3">${esc(settings.url)}</textarea></label><button class="link-btn" id="urlReset" type="button">Ripristina predefinito</button>`, ok: 'Salva',
      onBody: b => b.querySelector('#urlReset').onclick = () => { $('#urlTxt').value = DEFAULT_SCRIPT_URL; } });
    if (!res.ok) return;
    const u = $('#urlTxt').value.trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)) return toast('Indirizzo non valido', 'err');
    settings.url = u; saveSettings(); toast('Indirizzo salvato'); syncNow(true);
  }
};

$('#restoreInput').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'pt-checkin' || !data.list) throw new Error('formato');
    const r = await modal({ title: 'Ripristinare il backup?', text: `Backup del ${new Date(data.savedAt).toLocaleString('it-IT')}. Sostituisce i dati attuali su questo telefono.`, ok: 'Ripristina' });
    if (!r.ok) return;
    list = { ...data.list, rows: data.list.rows.filter(x => !x.added) };
    if (data.recs) recs = data.recs;
    else if (data.state) {      // backup della versione 3
      recs = {};
      const now = Date.now();
      Object.entries(data.state.in || {}).forEach(([k, t]) => { recs[k] = { t, o: 0, n: '', v: '', l: [[t, 'i']], u: now }; });
      Object.entries(data.state.notes || {}).forEach(([k, n]) => { recs[k] = { ...(recs[k] || { t: 0, o: 0, v: '', l: [] }), n, u: now }; });
    }
    Object.keys(recs).forEach(k => { queue[k] = 1; });
    mergeAdded(); prepare(); saveList(); saveRecs(); scheduleSync();
    lastAction = null; shown = PAGE;
    renderAll(); showPage('checkin');
    toast('Backup ripristinato ♻️');
  } catch (err) { console.error(err); toast('File di backup non valido', 'err'); }
});

/* ─── EXPORT EXCEL ─── */
function exportExcel(onlyWaiting) {
  if (!list) return toast('Nessuna lista da esportare', 'err');
  if (typeof XLSX === 'undefined') return toast('Libreria Excel non caricata', 'err');
  const rows = list.rows.filter(r => !onlyWaiting || !everIn(r.k));
  const aoa = [[...list.headers, 'Entrato', 'Primo ingresso', 'Fatto entrare da', 'Dentro ora', 'Ultima uscita', 'Uscita registrata da', 'Entrato con', 'Note', 'Aggiunto in loco', 'Storico']];
  rows.forEach(r => {
    const x = recs[r.k] || {};
    const firstIn = (x.l || []).find(e => e[1] === 'i'), lastOut = lastEntry(x, 'o');
    const storico = (x.l || []).map(e => `${fmtTime(e[0])} ${e[1] === 'i' ? 'entrata' : e[1] === 'o' ? 'uscita' : 'annullato'}${who(e, x) ? ' (' + who(e, x) + ')' : ''}`).join(' · ');
    aoa.push([...r.c, x.t ? 'SI' : 'NO', x.t ? fmtTime(x.t) : '', x.t ? who(firstIn, x) : '', isInside(r.k) ? 'SI' : (x.t ? 'NO' : ''),
      x.o ? fmtTime(x.o) : '', x.o ? who(lastOut, x) : '', x.v || '', x.n || '', r.added ? 'SI' : '', storico]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((_, i) => ({ wch: Math.min(40, Math.max(10, ...aoa.slice(0, 200).map(r => String(r[i] ?? '').length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, onlyWaiting ? 'Assenti' : 'Check-in');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Padania_${onlyWaiting ? 'assenti' : 'checkin'}_${dateTag()}.xlsx`);
  toast(onlyWaiting ? `Esportati ${rows.length} assenti` : 'Excel esportato 📊');
}

/* ─── RIEPILOGO PDF ─── */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
async function exportPDF() {
  if (!list) return toast('Carica prima una lista', 'err');
  try { if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'); }
  catch { return toast('Libreria PDF non disponibile: serve connessione', 'err'); }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const s = statsData(), c = s.c;
  const W = 210, M = 16;
  let y = 0;
  const newPage = () => { doc.addPage(); y = 18; };
  const need = h => { if (y + h > 280) newPage(); };

  // intestazione
  doc.setFillColor(12, 12, 14); doc.rect(0, 0, W, 36, 'F');
  try { const img = await fetch('./assets/logo.png').then(r => r.blob()).then(b => new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); })); doc.addImage(img, 'PNG', M, 6, 24, 24); } catch {}
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
  doc.text('PADANIA TUNING', M + 30, 17);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(190, 192, 196);
  doc.text(`Riepilogo check-in · ${list.name}`, M + 30, 24);
  doc.text(`Generato il ${new Date().toLocaleString('it-IT')}`, M + 30, 30);
  y = 48;

  // numeri
  const boxes = [['Iscritti', c.tot], ['Entrati', c.inN], ['Dentro ora', c.inside], ['Attesi', c.wait], ['% ingressi', c.pct + '%'], ['Usciti', c.out],
    ['Primo ingresso', s.first ? fmtTime(s.first) : '-'], ['Ultimo ingresso', s.last ? fmtTime(s.last) : '-']];
  const bw = (W - M * 2 - 9) / 4;
  boxes.forEach(([l, v], i) => {
    const x = M + (i % 4) * (bw + 3), yy = y + Math.floor(i / 4) * 24;
    doc.setDrawColor(220, 222, 226); doc.roundedRect(x, yy, bw, 20, 2, 2);
    doc.setFontSize(8); doc.setTextColor(120, 122, 128); doc.text(l.toUpperCase(), x + 4, yy + 6);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 17, 20); doc.text(String(v), x + 4, yy + 15); doc.setFont('helvetica', 'normal');
  });
  y += 54;

  // grafico
  if (s.keys.length) {
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 17, 20); doc.text('Ingressi ogni 15 minuti', M, y); doc.setFont('helvetica', 'normal');
    y += 4;
    const ch = 40, max = Math.max(...s.keys.map(k => s.buckets[k]));
    const bwid = Math.min(10, (W - M * 2) / s.keys.length - 1.5);
    s.keys.forEach((k, i) => {
      const h = s.buckets[k] / max * ch, x = M + i * (bwid + 1.5);
      if (k === s.peak) doc.setFillColor(52, 180, 110); else doc.setFillColor(150, 154, 160);
      doc.rect(x, y + ch - h, bwid, h, 'F');
      doc.setFontSize(6); doc.setTextColor(90, 92, 98);
      doc.text(String(s.buckets[k]), x + bwid / 2, y + ch - h - 1, { align: 'center' });
      if (s.keys.length <= 24 || i % 2 === 0) doc.text(k, x + bwid / 2, y + ch + 4, { align: 'center' });
    });
    y += ch + 12;
    if (s.peak) { doc.setFontSize(9); doc.setTextColor(90, 92, 98); doc.text(`Fascia di punta: ${s.peak} (${s.buckets[s.peak]} ingressi)${s.rate ? ` · ritmo medio ~${s.rate}/ora` : ''}`, M, y); y += 8; }
  }

  // per stato
  const cats = Object.entries(s.cats);
  if (cats.length) {
    need(12 + cats.length * 6);
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 17, 20); doc.text('Per ' + list.headers[cols.cat].toLowerCase(), M, y); doc.setFont('helvetica', 'normal'); y += 6;
    cats.forEach(([v, x]) => { doc.setFontSize(10); doc.text(`${v}`, M, y); doc.text(`${x.in} entrati su ${x.tot}`, W - M, y, { align: 'right' }); y += 6; });
    y += 4;
  }

  // per operatore
  const opE = Object.entries(s.ops).sort((a, b) => b[1] - a[1]);
  if (opE.length) {
    need(12 + opE.length * 6);
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 17, 20); doc.text('Ingressi registrati per operatore', M, y); doc.setFont('helvetica', 'normal'); y += 6;
    opE.forEach(([w, n]) => { doc.setFontSize(10); doc.text(w, M, y); doc.text(String(n), W - M, y, { align: 'right' }); y += 6; });
    y += 4;
  }

  // elenco entrati
  const table = (title, rows, colsDef) => {
    need(20);
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 17, 20); doc.text(title, M, y); y += 6;
    const head = () => { doc.setFillColor(240, 241, 243); doc.rect(M, y - 4, W - M * 2, 6, 'F'); doc.setFontSize(8); doc.setTextColor(90, 92, 98); colsDef.forEach(cd => doc.text(cd.h, cd.x, y)); y += 5; doc.setFont('helvetica', 'normal'); };
    head();
    rows.forEach(r => {
      if (y > 282) { newPage(); doc.setFont('helvetica', 'bold'); head(); }
      doc.setFontSize(9); doc.setTextColor(30, 30, 34);
      colsDef.forEach(cd => doc.text(doc.splitTextToSize(String(cd.v(r) ?? ''), cd.w)[0] || '', cd.x, y));
      y += 5.2;
    });
    y += 6;
  };
  const entered = s.entries.map(e => e.r);
  if (entered.length) table(`Entrati (${entered.length})`, entered, [
    { h: 'NOME', x: M, w: 52, v: r => r._name },
    { h: 'ENTRATO CON / INFO', x: M + 54, w: 54, v: r => recs[r.k].v || r._sub },
    { h: 'INGRESSO', x: M + 110, w: 16, v: r => fmtTime(recs[r.k].t) },
    { h: 'DA', x: M + 127, w: 22, v: r => who((recs[r.k].l || []).find(e => e[1] === 'i'), recs[r.k]) },
    { h: 'USCITA', x: M + 151, w: 14, v: r => recs[r.k].o ? fmtTime(recs[r.k].o) : '' },
    { h: 'DA', x: M + 166, w: 14, v: r => recs[r.k].o ? who(lastEntry(recs[r.k], 'o'), recs[r.k]) : '' }
  ]);
  const noted = list.rows.filter(r => recs[r.k]?.n);
  if (noted.length) table(`Note (${noted.length})`, noted, [
    { h: 'NOME', x: M, w: 58, v: r => r._name },
    { h: 'NOTA', x: M + 60, w: W - M * 2 - 60, v: r => recs[r.k].n }
  ]);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150, 152, 158); doc.text(`PadaniaTuning Check-in · pagina ${i} di ${pages}`, W / 2, 292, { align: 'center' }); }
  await saveFile(doc.output('blob'), `Padania_riepilogo_${dateTag()}.pdf`);
  toast('Riepilogo PDF creato 📄');
}

/* Su telefono usa il menu Condividi (File, WhatsApp, Mail…), su computer scarica */
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
  $('#bigToggle').checked = settings.big;
  $('#syncToggle').checked = settings.sync;
  document.documentElement.classList.toggle('big', settings.big);
  $('#capSet').textContent = settings.capacity ? `${settings.capacity} persone · avviso dal 75%` : 'Non impostata';
}
$('#wakeToggle').addEventListener('change', e => { settings.wake = e.target.checked; saveSettings(); settings.wake ? requestWake() : releaseWake(); });
$('#soundToggle').addEventListener('change', e => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) feedback('ok'); });
$('#bigToggle').addEventListener('change', e => { settings.big = e.target.checked; saveSettings(); applySettings(); });
$('#syncToggle').addEventListener('change', e => {
  settings.sync = e.target.checked; saveSettings();
  if (settings.sync) { Object.keys(recs).forEach(k => { queue[k] = 1; }); saveRecs(); toast('Sincronizzazione attiva 🔁'); }
  startSync(); renderOnline(); renderSyncPill();
});

async function requestWake() {
  if (!settings.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isAuthed()) { requestWake(); if (settings.sync) syncNow(); }
});

/* =====================================================
   MODALE + TOAST
   ===================================================== */
let modalResolve = null;
function modal({ title, text = '', body = '', ok = 'OK', cancel = 'Annulla', danger = false, single = false, focus, onBody }) {
  if (modalResolve) closeModal(false);
  $('#toast').className = '';
  $('#mTitle').textContent = title;
  $('#mText').textContent = text;
  $('#mBody').innerHTML = body;
  const okBtn = $('#mOk');
  okBtn.textContent = ok;
  okBtn.className = 'btn ' + (single ? 'btn-ghost' : danger ? 'btn-danger' : 'btn-chrome');
  $('#mCancel').textContent = cancel;
  $('#mCancel').hidden = single;
  $('.sheet-actions').classList.toggle('single', single);
  $('#modal').hidden = false;
  $('.sheet').scrollTop = 0;
  onBody?.($('#mBody'));
  if (focus) setTimeout(() => $(focus)?.focus(), 250);
  return new Promise(res => { modalResolve = res; });
}
function closeModal(v) {
  $('#modal').hidden = true;
  const r = modalResolve; modalResolve = null;
  r?.({ ok: v === true, value: v });
}
/* finestra con scelte multiple: restituisce l'id scelto o null */
async function choose(title, text, options) {
  const res = await modal({
    title, text, single: true, ok: 'Indietro',
    body: `<div class="opts">${options.map(o => `<button class="opt${o.active ? ' active' : ''}${o.cls ? ' ' + o.cls : ''}" data-opt="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div>`,
    onBody: b => b.addEventListener('click', e => { const x = e.target.closest('[data-opt]'); if (x) closeModal('opt:' + x.dataset.opt); })
  });
  return typeof res.value === 'string' && res.value.startsWith('opt:') ? res.value.slice(4) : null;
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
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !$('#mCancel').hidden) { e.preventDefault(); closeModal(true); }
});

let toastTimer;
function toast(msg, type = '', actionLabel, actionFn) {
  const t = $('#toast');
  if (!$('#scanner').hidden) return;   // nello scanner c'è già il riquadro risultato
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
settings = { ...settings, ...load(K_SET, {}) };
if (!settings.device) { settings.device = 'Telefono ' + Math.random().toString(36).slice(2, 5).toUpperCase(); saveSettings(); }
if (!settings.url) settings.url = DEFAULT_SCRIPT_URL;
list = load(K_LIST, null);
recs = load(K_RECS, {});
queue = load(K_QUEUE, {});
if (list) { mergeAdded(); prepare(); }
applySettings();
renderBioSetting();
renderAll();
showAuth(!isAuthed());

function hideSplash() { const s = $('#splash'); if (!s) return; s.classList.add('hide'); setTimeout(() => s.remove(), 400); }
window.addEventListener('load', () => setTimeout(hideSplash, 350));
setTimeout(hideSplash, 2500);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

/* =====================================================
   AGGIORNAMENTO APP
   Dalla Home di iPhone non c'è il tasto "ricarica": questo scarica
   l'ultima versione da GitHub e riavvia. Lista e check-in restano.
   ===================================================== */
const APP_FILES = ['./', './index.html', './script.js', './style.css', './sw.js', './manifest.webmanifest', './schermo.html'];
async function updateApp() {
  if (!navigator.onLine) return toast('Serve internet per aggiornare', 'err');
  toast('Scarico l\'ultima versione…');
  try {
    if (Object.keys(queue).length && settings.sync) await syncNow();          // prima manda i check-in in sospeso
    await Promise.all(APP_FILES.map(u => fetch(u, { cache: 'reload' }).catch(() => {})));   // salta la cache del telefono
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
  } catch (e) { console.error(e); }
  try { sessionStorage.setItem('ptJustUpdated', APP_VERSION); } catch {}
  location.replace(location.pathname + '?v=' + Date.now());
}

/* controlla se su GitHub c'è una versione più nuova */
async function checkUpdate(manual) {
  if (!navigator.onLine) { if (manual) toast('Serve internet per controllare', 'err'); return; }
  try {
    const txt = await fetch('./script.js?check=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
    const m = txt.match(/const APP_VERSION = '([^']+)'/);
    const latest = m ? m[1] : APP_VERSION;
    const isNew = latest !== APP_VERSION;
    $('#updBanner').hidden = !isNew;
    $('#updBanner').innerHTML = `✨ <b>Nuova versione disponibile</b> (v${esc(latest)}) · Tocca per aggiornare`;
    $('#updTxt').textContent = isNew ? `Disponibile la v${latest} · tocca per aggiornare` : `Versione v${APP_VERSION} · sei aggiornato`;
    if (manual) isNew ? updateApp() : toast(`Hai già l'ultima versione (v${APP_VERSION}) ✓`);
  } catch (e) { console.error(e); if (manual) toast('Controllo non riuscito, riprova', 'err'); }
}
$('#updBanner').addEventListener('click', updateApp);
$('#appVersion').textContent = 'v' + APP_VERSION;
$('#updTxt').textContent = `Versione v${APP_VERSION}`;
try {
  const j = sessionStorage.getItem('ptJustUpdated');
  if (j) { sessionStorage.removeItem('ptJustUpdated'); if (location.search.includes('v=')) history.replaceState(null, '', location.pathname); setTimeout(() => toast(`App aggiornata alla v${APP_VERSION} ✓`), 900); }
} catch {}
setTimeout(() => checkUpdate(false), 4000);
setInterval(() => { if (document.visibilityState === 'visible') checkUpdate(false); }, 10 * 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(false); });

let originalData  = [];
let currentFilter = 'all';
let html5QrCode   = null;
let lastAction    = null;
let autoSaveTimer = null;
let sortState     = null;               // { type:'col'|'time'|'status', index?:number, dir:1|-1 }
let currentPage   = 1;
const PAGE_SIZE   = 50;

/* ─── DOM ─── */
const fileInput     = document.getElementById('fileInput');
const searchInput   = document.getElementById('searchInput');
const table         = document.getElementById('table');
const exportBtn     = document.getElementById('exportBtn');
const saveBtn       = document.getElementById('saveBtn');
const resetBtn      = document.getElementById('resetBtn');
const undoBtn       = document.getElementById('undoBtn');
const qrBtn         = document.getElementById('qrBtn');
const statusCounter = document.getElementById('statusCounter');
const progressBar   = document.getElementById('progressBar');
const toast         = document.getElementById('toast');
const pills         = document.querySelectorAll('.pill');
const checkinPage    = document.getElementById('checkinPage');
const helpPage       = document.getElementById('helpPage');
const checkinTab     = document.getElementById('checkinTab');
const helpTab        = document.getElementById('helpTab');
const helpBtn        = document.getElementById('helpBtn');
const progressPercent= document.getElementById('progressPercent');
const statsTab       = document.getElementById('statsTab');
const statsPage      = document.getElementById('statsPage');
const statsRefreshBtn= document.getElementById('statsRefreshBtn');
const paginationBox  = document.getElementById('pagination');
const pgPrev         = document.getElementById('pgPrev');
const pgNext         = document.getElementById('pgNext');
const pgInfo         = document.getElementById('pgInfo');

/* ─── PASSWORD DI ACCESSO ───
   Richiesta ogni volta che l'app viene chiusa completamente:
   sessionStorage si svuota alla chiusura di scheda/app e viene
   ricreato ad ogni nuovo avvio, quindi il gate riappare da solo. */
const PT_PASSWORD  = 'PadaniaTuning00!';
const authOverlay   = document.getElementById('pt-auth');
const authCard      = document.getElementById('pt-auth-card');
const authInputEl   = document.getElementById('pt-auth-input');
const authBtnEl     = document.getElementById('pt-auth-btn');
const authErrorEl   = document.getElementById('pt-auth-error');

function checkAuth() {
  if (sessionStorage.getItem('ptAuthed') === '1') {
    authOverlay.classList.add('pt-hide');
  } else {
    authOverlay.classList.remove('pt-hide');
    setTimeout(() => authInputEl && authInputEl.focus(), 300);
  }
}
function tryAuth() {
  if (authInputEl.value === PT_PASSWORD) {
    sessionStorage.setItem('ptAuthed', '1');
    authOverlay.classList.add('pt-hide');
    authInputEl.value = '';
    authErrorEl.textContent = '';
  } else {
    authErrorEl.textContent = 'Password errata, riprova.';
    authCard.classList.add('shake');
    setTimeout(() => authCard.classList.remove('shake'), 400);
  }
}
authBtnEl.addEventListener('click', tryAuth);
authInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAuth(); });
checkAuth();

/* ─── AUTOSAVE ogni 10 minuti ─── */
function startAutoSave() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    if (originalData.length === 0) return;
    const blob  = new Blob(
      [JSON.stringify({ checkboxState: getSaved(), timestampState: getTimes(), notesState: getNotes() }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = `autosave_${dateTag()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Autosave completato');
  }, 5 * 60 * 1000); // ogni 5 minuti (prima 10, per maggiore sicurezza dati)
}
startAutoSave();

/* ─── EVENTI ─── */
fileInput.addEventListener('change', handleFile);
searchInput.addEventListener('input', () => { currentPage = 1; renderTable(); });
exportBtn.addEventListener('click', exportExcel);
resetBtn.addEventListener('click', handleReset);
undoBtn.addEventListener('click', handleUndo);
qrBtn.addEventListener('click', toggleQr);
function showPage(page){
  checkinPage.hidden = page !== 'checkin';
  statsPage.hidden   = page !== 'stats';
  helpPage.hidden    = page !== 'help';
  checkinTab.classList.toggle('active', page === 'checkin');
  statsTab.classList.toggle('active', page === 'stats');
  helpTab.classList.toggle('active', page === 'help');
  window.scrollTo({top:0,behavior:'smooth'});
  if (page === 'stats') renderStats();
}
checkinTab.addEventListener('click',()=>showPage('checkin'));
statsTab.addEventListener('click',()=>showPage('stats'));
helpTab.addEventListener('click',()=>showPage('help'));
helpBtn.addEventListener('click',()=>showPage('help'));
statsRefreshBtn.addEventListener('click', renderStats);
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();showPage('checkin');searchInput.focus();}
});

saveBtn.addEventListener('click', () => {
  const blob  = new Blob(
    [JSON.stringify({ checkboxState: getSaved(), timestampState: getTimes(), notesState: getNotes() }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = `backup_${dateTag()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup salvato!');
});

pills.forEach(pill => {
  pill.addEventListener('click', () => {
    currentFilter = pill.dataset.filter;
    currentPage = 1;
    pills.forEach(p => p.className = 'pill');
    pill.classList.add(
      currentFilter === 'all' ? 'active-all' :
      currentFilter === 'yes' ? 'active-yes' : 'active-no'
    );
    renderTable();
  });
});

/* ─── STATS ─── */
function updateStats() {
  const saved   = getSaved();
  const total   = originalData.length > 0 ? originalData.length - 1 : 0;
  const count   = Object.keys(saved).length;
  const missing = total - count;

  if (currentFilter === 'no') {
    statusCounter.textContent = `In attesa: ${missing} / ${total}`;
    statusCounter.style.color = '#ff9800';
    progressBar.style.background = '#ff9800';
  } else {
    statusCounter.textContent = `Entrati: ${count} / ${total}`;
    statusCounter.style.color = 'var(--green)';
    progressBar.style.background = 'var(--green)';
  }

  const percent = total > 0 ? Math.round(count / total * 100) : 0;
  progressBar.style.width = percent + '%';
  if (progressPercent) progressPercent.textContent = percent + '%';
  undoBtn.style.display = lastAction ? 'inline-block' : 'none';
}

/* ─── FILE (con validazione e protezione da sovrascritture accidentali) ─── */
function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const existingCheckins = Object.keys(getSaved()).length;
  if (originalData.length > 0 && existingCheckins > 0) {
    const ok = confirm(
      `Hai gia' ${existingCheckins} check-in registrati con la lista attuale.\n` +
      `Caricare un nuovo file puo' disallineare i check-in se l'ordine dei partecipanti cambia.\n\n` +
      `Continuare comunque?`
    );
    if (!ok) { e.target.value = ''; return; }
  }

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = new Uint8Array(evt.target.result);
      const wb   = XLSX.read(data, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });

      if (!rows || rows.length < 2) {
        showToast('File vuoto o senza partecipanti (serve intestazione + almeno una riga)', 'toast-error');
        return;
      }

      originalData = rows.map((row, i) => ({ id: i, data: row }));
      sortState = null;
      currentPage = 1;
      renderTable();
      showToast(`${originalData.length - 1} partecipanti caricati`);
    } catch (err) {
      console.error(err);
      showToast('File non valido o danneggiato', 'toast-error');
    }
  };
  reader.onerror = () => showToast('Errore nella lettura del file', 'toast-error');
  reader.readAsArrayBuffer(file);
  e.target.value = '';
}

/* ─── RICERCA per iniziali ─── */
function matchSearch(item, term) {
  if (!term) return true;
  const cells = item.data.map(c => String(c).toLowerCase());

  // match diretto su qualsiasi cella
  if (cells.some(c => c.includes(term))) return true;

  // match per iniziali: "mr" trova "mario rossi"
  if (term.length >= 2 && /^[a-z]+$/.test(term)) {
    const fullName = cells.join(' ');
    const words    = fullName.split(/\s+/).filter(Boolean);
    const initials = words.map(w => w[0]).join('');
    if (initials.includes(term)) return true;
  }

  return false;
}

/* ─── RENDER (con ordinamento, paginazione e note) ─── */
function sortValue(item, type, index, times, saved, notes) {
  if (type === 'col')    return String(item.data[index] ?? '').toLowerCase();
  if (type === 'time')   return times[item.id] || 0;
  if (type === 'status') return saved[item.id] ? 1 : 0;
  if (type === 'note')   return (notes[item.id] || '').toLowerCase();
  return '';
}

function renderTable() {
  table.innerHTML = '';
  paginationBox.style.display = 'none';

  if (originalData.length === 0) {
    table.innerHTML = `<tbody><tr><td colspan="1" style="border:none">
      <div class="empty-state"><div class="icon">📋</div>
      <p>Nessuna lista caricata.<br>Premi <strong>Carica lista Excel / CSV</strong> per iniziare.</p>
      </div></td></tr></tbody>`;
    updateStats();
    return;
  }

  updateStats();

  const saved = getSaved();
  const times = getTimes();
  const notes = getNotes();
  const term  = searchInput.value.toLowerCase().trim();

  const headerRow = originalData.find(item => item.id === 0);
  let dataRows = originalData.filter(item => {
    if (item.id === 0) return false;
    if (!matchSearch(item, term)) return false;
    if (currentFilter === 'yes') return !!saved[item.id];
    if (currentFilter === 'no')  return !saved[item.id];
    return true;
  });

  /* Ordinamento */
  if (sortState) {
    dataRows.sort((a, b) => {
      const va = sortValue(a, sortState.type, sortState.index, times, saved, notes);
      const vb = sortValue(b, sortState.type, sortState.index, times, saved, notes);
      if (va < vb) return -1 * sortState.dir;
      if (va > vb) return 1 * sortState.dir;
      return 0;
    });
  }

  /* Paginazione (solo sulle righe dati, non sull'header) */
  const totalPages = Math.max(1, Math.ceil(dataRows.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const pageRows = dataRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  if (dataRows.length > PAGE_SIZE) {
    paginationBox.style.display = 'flex';
    pgInfo.textContent = `Pagina ${currentPage} di ${totalPages} (${dataRows.length} risultati)`;
    pgPrev.disabled = currentPage <= 1;
    pgNext.disabled = currentPage >= totalPages;
  }

  let maxCols = 0;
  originalData.forEach(item => { if (item.data.length > maxCols) maxCols = item.data.length; });

  const tbody = document.createElement('tbody');
  const rowsToRender = [headerRow, ...pageRows].filter(Boolean);

  rowsToRender.forEach(item => {
    const tr = document.createElement('tr');
    const isHeader = item.id === 0;
    if (!isHeader && saved[item.id]) tr.classList.add('selected');

    /* Click su tutta la riga per fare check-in (esclude checkbox e campo nota) */
    if (!isHeader) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', (e) => {
        if (e.target.type === 'checkbox' || e.target.classList.contains('note-input')) return;
        const cb = tr.querySelector('input[type="checkbox"]');
        if (cb) {
          cb.checked = !cb.checked;
          handleCheckIn(item.id, cb.checked, tr);
        }
      });
    }

    /* Colonne dati (ordinabili) */
    for (let col = 0; col < maxCols; col++) {
      const cell = document.createElement(isHeader ? 'th' : 'td');
      if (isHeader) {
        cell.classList.add('sortable');
        cell.appendChild(document.createTextNode(item.data[col] ?? ''));
        const arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        const active = sortState && sortState.type === 'col' && sortState.index === col;
        arrow.textContent = active ? (sortState.dir === 1 ? '▲' : '▼') : '↕';
        if (active) cell.classList.add('sort-active');
        cell.appendChild(arrow);
        cell.addEventListener('click', () => {
          if (sortState && sortState.type === 'col' && sortState.index === col) sortState.dir *= -1;
          else sortState = { type: 'col', index: col, dir: 1 };
          currentPage = 1;
          renderTable();
        });
      } else {
        cell.textContent = item.data[col] ?? '';
      }
      tr.appendChild(cell);
    }

    /* Colonna Ora (ordinabile) */
    const timeCell = document.createElement(isHeader ? 'th' : 'td');
    if (isHeader) {
      timeCell.classList.add('sortable');
      timeCell.appendChild(document.createTextNode('Ora'));
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      const active = sortState && sortState.type === 'time';
      arrow.textContent = active ? (sortState.dir === 1 ? '▲' : '▼') : '↕';
      if (active) timeCell.classList.add('sort-active');
      timeCell.appendChild(arrow);
      timeCell.addEventListener('click', () => {
        if (sortState && sortState.type === 'time') sortState.dir *= -1;
        else sortState = { type: 'time', dir: 1 };
        currentPage = 1;
        renderTable();
      });
    } else {
      timeCell.className = 'timestamp-cell';
      timeCell.textContent = times[item.id] ? formatTime(times[item.id]) : '—';
    }
    tr.appendChild(timeCell);

    /* Colonna Entrato (ordinabile) */
    const actionCell = document.createElement(isHeader ? 'th' : 'td');
    if (isHeader) {
      actionCell.classList.add('sortable');
      actionCell.appendChild(document.createTextNode('Entrato'));
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      const active = sortState && sortState.type === 'status';
      arrow.textContent = active ? (sortState.dir === 1 ? '▲' : '▼') : '↕';
      if (active) actionCell.classList.add('sort-active');
      actionCell.appendChild(arrow);
      actionCell.addEventListener('click', () => {
        if (sortState && sortState.type === 'status') sortState.dir *= -1;
        else sortState = { type: 'status', dir: 1 };
        currentPage = 1;
        renderTable();
      });
    } else {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!saved[item.id];
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        handleCheckIn(item.id, cb.checked, tr);
      });
      actionCell.appendChild(cb);
    }
    tr.appendChild(actionCell);

    /* Colonna Note */
    const noteCell = document.createElement(isHeader ? 'th' : 'td');
    if (isHeader) {
      noteCell.textContent = 'Note';
    } else {
      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.className = 'note-input';
      noteInput.placeholder = 'Nota…';
      noteInput.value = notes[item.id] || '';
      noteInput.addEventListener('click', (e) => e.stopPropagation());
      noteInput.addEventListener('change', (e) => {
        updateNote(item.id, e.target.value);
      });
      noteCell.appendChild(noteInput);
    }
    tr.appendChild(noteCell);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
}

pgPrev.addEventListener('click', () => { currentPage--; renderTable(); });
pgNext.addEventListener('click', () => { currentPage++; renderTable(); });

/* ─── CHECK-IN ─── */
function handleCheckIn(id, isChecked, tr) {
  lastAction = { id, wasChecked: !isChecked };
  updateStorage(id, isChecked);
  updateTime(id, isChecked);

  if (isChecked) {
    tr.classList.add('selected', 'flash');
    setTimeout(() => tr.classList.remove('flash'), 700);
    showToast(`Entrato: ${getNameById(id)}`);
  } else {
    tr.classList.remove('selected');
    showToast('Check-in rimosso', 'toast-undo');
  }

  updateStats();

  const times = getTimes();
  const cells = tr.querySelectorAll('td');
  // Ordine colonne finali: [..dati.., Ora, Entrato, Note] -> Ora e' la terzultima cella
  const timeIdx = cells.length - 3;
  if (cells[timeIdx]) {
    cells[timeIdx].textContent = times[id] ? formatTime(times[id]) : '—';
  }
}

/* ─── UNDO ─── */
function handleUndo() {
  if (!lastAction) return;
  const { id, wasChecked } = lastAction;
  updateStorage(id, wasChecked);
  updateTime(id, wasChecked);
  lastAction = null;
  showToast('Annullato', 'toast-undo');
  renderTable();
}

/* ─── QR (normale) ─── */
function toggleQr() {
  const readerDiv = document.getElementById('reader');
  if (readerDiv.style.display === 'none' || !readerDiv.style.display) {
    readerDiv.style.display = 'block';
    qrBtn.textContent = 'Chiudi QR';
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (text) => { processQrCode(text); stopScanner(); }
    ).catch(err => { console.error(err); stopScanner(); });
  } else {
    stopScanner();
  }
}

function stopScanner() {
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().then(() => {
      html5QrCode.clear();
      document.getElementById('reader').style.display = 'none';
      qrBtn.textContent = '📷 QR';
    }).catch(err => console.error(err));
  } else {
    document.getElementById('reader').style.display = 'none';
    qrBtn.textContent = '📷 QR';
  }
}

function processQrCode(text) {
  const term  = text.toLowerCase().trim();
  const found = originalData.find(item =>
    item.id !== 0 && item.data.some(c => String(c).toLowerCase().trim() === term)
  );

  if (found) {
    if (getSaved()[found.id]) {
      showToast('Gia registrato!', 'toast-error');
      return;
    }
    updateStorage(found.id, true);
    updateTime(found.id, true);
    lastAction = { id: found.id, wasChecked: false };
    const name = getNameById(found.id);
    showToast(`Entrato: ${name}`);
    renderTable();
  } else {
    showToast('Non trovato nel registro', 'toast-error');
  }
}

/* ─── RESET ─── */
function handleReset() {
  if (!confirm("Azzerare tutti i check-in e le note? L'operazione non e reversibile.")) return;
  localStorage.removeItem('checkboxState');
  localStorage.removeItem('timestampState');
  localStorage.removeItem('notesState');
  lastAction = null;
  currentPage = 1;
  renderTable();
  showToast('Reset completato', 'toast-undo');
}

/* ─── EXPORT ─── */
function exportExcel() {
  if (originalData.length === 0) { showToast('Nessun dato da esportare', 'toast-error'); return; }
  const saved = getSaved();
  const times = getTimes();
  const notes = getNotes();
  const exportData = originalData.map(item => {
    const row = [...item.data];
    if (item.id === 0) { row.push('Ora', 'Entrato', 'Note'); }
    else { row.push(times[item.id] ? formatTime(times[item.id]) : '', saved[item.id] ? 'SI' : 'NO', notes[item.id] || ''); }
    return row;
  });
  const ws = XLSX.utils.aoa_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Padania");
  XLSX.writeFile(wb, `Report_${dateTag()}.xlsx`);
  showToast('Excel esportato!');
}

/* ─── STORAGE (con protezione errori: es. storage pieno o non disponibile) ─── */
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error('Errore salvataggio localStorage', err);
    showToast('Errore nel salvataggio dati locali!', 'toast-error');
    return false;
  }
}
function safeGetItem(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (err) {
    console.error('Errore lettura localStorage', err);
    return fallback;
  }
}

function getSaved() { return JSON.parse(safeGetItem('checkboxState', "{}")); }
function getTimes()  { return JSON.parse(safeGetItem('timestampState', "{}")); }
function getNotes()  { return JSON.parse(safeGetItem('notesState', "{}")); }

function updateStorage(id, isChecked) {
  const saved = getSaved();
  isChecked ? saved[id] = true : delete saved[id];
  safeSetItem('checkboxState', JSON.stringify(saved));
}

function updateTime(id, isChecked) {
  const times = getTimes();
  isChecked ? times[id] = Date.now() : delete times[id];
  safeSetItem('timestampState', JSON.stringify(times));
}

function updateNote(id, text) {
  const notes = getNotes();
  if (text && text.trim()) notes[id] = text.trim();
  else delete notes[id];
  safeSetItem('notesState', JSON.stringify(notes));
}

/* ─── UTILS ─── */
function getNameById(id) {
  const item = originalData.find(i => i.id === id);
  return item ? (item.data[0] || '') + (item.data[1] ? ' ' + item.data[1] : '') : 'Sconosciuto';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function dateTag() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
}

/* ─── STATISTICHE ─── */
function computeStats() {
  const total   = originalData.length > 0 ? originalData.length - 1 : 0;
  const saved   = getSaved();
  const times   = getTimes();
  const notes   = getNotes();
  const count   = Object.keys(saved).length;
  const missing = total - count;
  const percent = total > 0 ? Math.round(count / total * 100) : 0;

  const timeValues = Object.values(times).filter(Boolean).sort((a, b) => a - b);
  const firstTime = timeValues.length ? formatTime(timeValues[0]) : '—';
  const lastTime  = timeValues.length ? formatTime(timeValues[timeValues.length - 1]) : '—';

  /* Ingressi raggruppati per fascia di 15 minuti */
  const buckets = {};
  timeValues.forEach(ts => {
    const d = new Date(ts);
    const m = Math.floor(d.getMinutes() / 15) * 15;
    const key = `${String(d.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const bucketKeys = Object.keys(buckets).sort();
  const maxBucket = bucketKeys.length ? Math.max(...bucketKeys.map(k => buckets[k])) : 1;
  const peakKey = bucketKeys.length
    ? bucketKeys.reduce((best, k) => (buckets[k] > buckets[best] ? k : best), bucketKeys[0])
    : null;

  /* Ritmo medio tra un ingresso e il successivo */
  let avgGapMin = null;
  if (timeValues.length > 1) {
    const span = timeValues[timeValues.length - 1] - timeValues[0];
    avgGapMin = Math.round((span / (timeValues.length - 1)) / 60000);
  }

  return {
    total, count, missing, percent, firstTime, lastTime,
    buckets, bucketKeys, maxBucket, peakKey, avgGapMin,
    notesCount: Object.keys(notes).length
  };
}

function renderStats() {
  const s = computeStats();
  document.getElementById('statTotal').textContent   = s.total;
  document.getElementById('statEntrati').textContent = s.count;
  document.getElementById('statAttesa').textContent  = s.missing;
  document.getElementById('statPercent').textContent = s.percent + '%';
  document.getElementById('statPrimo').textContent   = s.firstTime;
  document.getElementById('statUltimo').textContent  = s.lastTime;
  document.getElementById('statPicco').textContent   = s.peakKey ? `${s.peakKey} (${s.buckets[s.peakKey]} ingressi)` : '—';
  document.getElementById('statRitmo').textContent   = s.avgGapMin != null ? `~1 ogni ${s.avgGapMin} min` : '—';
  document.getElementById('statNote').textContent    = s.notesCount;

  const chart = document.getElementById('barChart');
  chart.innerHTML = '';
  if (s.bucketKeys.length === 0) {
    chart.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:6px 0;">Nessun ingresso registrato ancora.</p>';
    return;
  }
  s.bucketKeys.forEach(k => {
    const col = document.createElement('div'); col.className = 'bar-col';
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.style.height = Math.round((s.buckets[k] / s.maxBucket) * 100) + '%';
    bar.title = `${k} — ${s.buckets[k]} ingressi`;
    const label = document.createElement('div'); label.className = 'bar-label'; label.textContent = k;
    col.appendChild(bar); col.appendChild(label);
    chart.appendChild(col);
  });
}

let toastTimer;
function showToast(msg, cls = '') {
  toast.textContent = msg;
  toast.className = 'show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ''; }, 2800);
}
'use strict';

const ScheduleUI = (() => {
  const SALAT = ['STUDIO 1', 'STUDIO 2', 'STUDIO 3'];

  function addDays(isoDate, n) {
    const d = new Date(isoDate);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const GRID_START    = 9 * 60;  // 09:00 - matches the earliest default business-hours opening (MA/LA)
  const GRID_END      = 24 * 60; // 24:00
  const PX_PER_MIN    = 1.5;
  const DAY_HEADER_H  = 14;      // px height of day-header label (pysty/vertical)
  const DAY_HEADER_W  = 30;      // px width of day-header label (vaaka/horizontal) - matches CSS
  const ROW_H_VAAKA   = 50;      // px height of one day-row (vaaka/horizontal)

  let currentSchedule = null;
  let dragState = null;
  let contextTarget = null;
  let draggingMovieId = null; // movie being dragged from the list, if any (see grid drop target below)
  let gridDropCandidate = null;
  let gridGhostEl = null;

  // ── Undo / redo ──────────────────────────────────────────────────────────
  // Snapshots of currentSchedule, capped at the 5 most recent actions. Every
  // schedule-mutating action (generate, import, drag-move, drag-add, delete,
  // duplicate, modal edit, show-count/theater overrides) calls pushUndo()
  // right before it commits its change; a new action clears the redo stack,
  // like every editor. Undo/redo restores the whole schedule object - note
  // that undoing an Excel import does NOT remove movies the import added to
  // the library (the library isn't part of the schedule state).

  const HISTORY_MAX = 5;
  let undoStack = [];
  let redoStack = [];

  const scheduleSnapshot = () => currentSchedule == null ? null : JSON.parse(JSON.stringify(currentSchedule));

  function pushUndo() {
    undoStack.push(scheduleSnapshot());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function restoreSnapshot(snap) {
    currentSchedule = snap;
    Storage.saveSchedule(currentSchedule);
    if (currentSchedule) {
      document.getElementById('viikko-alku').value = currentSchedule.viikkoAlku;
      document.getElementById('viikko-loppu').value = currentSchedule.viikkoLoppu;
      updateWeekLabel(currentSchedule.viikkoAlku, currentSchedule.viikkoLoppu);
    }
    buildWeekPanel();
    renderGrid();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(scheduleSnapshot());
    restoreSnapshot(undoStack.pop());
    updateHistoryButtons();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(scheduleSnapshot());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    restoreSnapshot(redoStack.pop());
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  function toMin(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function toHHMM(min) {
    return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;
  }

  function round15(min) { return Math.round(min / 15) * 15; }

  const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // 8 fixed categorical hues (base tier) plus a darker shade of each (extended
  // tier) - 16 slots total, since a single real week here can run 9+ distinct
  // movies at once (more than the base 8 alone can distinguish). Each entry's
  // text color is precomputed per-swatch (not assumed white) - every pairing
  // here is >=4.76:1 contrast, comfortably above the 4.5:1 WCAG AA minimum for
  // normal text, checked against both black and white and keeping whichever
  // passes better.
  const GRID_COLORS = [
    { bg: '#2a78d6', text: '#000000' }, // blue
    { bg: '#1baf7a', text: '#000000' }, // aqua
    { bg: '#eda100', text: '#000000' }, // yellow
    { bg: '#008300', text: '#ffffff' }, // green
    { bg: '#4a3aa7', text: '#ffffff' }, // violet
    { bg: '#e34948', text: '#000000' }, // red
    { bg: '#e87ba4', text: '#000000' }, // magenta
    { bg: '#eb6834', text: '#000000' }, // orange
    { bg: '#1d5496', text: '#ffffff' }, // blue (shade)
    { bg: '#137b55', text: '#ffffff' }, // aqua (shade)
    { bg: '#a67100', text: '#000000' }, // yellow (shade)
    { bg: '#005c00', text: '#ffffff' }, // green (shade)
    { bg: '#342975', text: '#ffffff' }, // violet (shade)
    { bg: '#9f3332', text: '#ffffff' }, // red (shade)
    { bg: '#a25673', text: '#ffffff' }, // magenta (shade)
    { bg: '#a54924', text: '#ffffff' }, // orange (shade)
  ];

  // Color follows the movie's own persisted colorSlot (Storage.js assigns it
  // once, guaranteeing no two movies collide while under 16 total), never
  // rank or position - so a movie's color stays stable across regenerations
  // regardless of what other movies are added, removed, or reordered around
  // it. `movieById` is a Map built once per renderGrid() call; falls back to
  // hashing the id (the old, non-guaranteed behavior) only if a screening
  // references a movie no longer in the library.
  function movieColor(movieId, movieById) {
    const movie = movieById.get(movieId);
    if (movie && movie.colorSlot != null) {
      return GRID_COLORS[movie.colorSlot % GRID_COLORS.length];
    }
    let hash = 0;
    for (let i = 0; i < movieId.length; i++) {
      hash = (hash * 31 + movieId.charCodeAt(i)) | 0;
    }
    return GRID_COLORS[Math.abs(hash) % GRID_COLORS.length];
  }

  // ── This week's roster ───────────────────────────────────────────────────

  // `valitut` is the movies playing this week, in rank order (index 0 = top
  // billing). It is explicit state the user edits through the "Lisää elokuvia"
  // picker and the per-row delete button - the panel shows exactly these
  // movies and nothing else.
  //
  // It used to be implicit: the panel listed the whole library with a checkbox
  // per row, and "checked" was reconstructed on every rebuild from whichever
  // movies happened to have screenings. So that's what an old saved schedule
  // migrates to, with the old `jarjestys` (which ranked the entire library)
  // supplying the order. `jarjestys` is never written again.
  function migrateRoster(schedule) {
    if (!schedule || Array.isArray(schedule.valitut)) return schedule;
    const withShows = new Set((schedule.naytokset ?? []).map(n => n.elokuvaId));
    const ranked = (schedule.jarjestys ?? []).filter(id => withShows.has(id));
    const rest = [...withShows].filter(id => !ranked.includes(id));
    schedule.valitut = [...ranked, ...rest];
    return schedule;
  }

  // Every roster edit needs somewhere to write, even before a program exists.
  // Creates the schedule in memory only - the caller decides whether the
  // change it is about to make is worth persisting.
  function ensureSchedule() {
    if (currentSchedule) {
      if (!Array.isArray(currentSchedule.valitut)) migrateRoster(currentSchedule);
      return currentSchedule;
    }
    const viikkoAlku = document.getElementById('viikko-alku').value || nextFriday();
    currentSchedule = {
      viikkoAlku,
      viikkoLoppu: document.getElementById('viikko-loppu').value || addDays(viikkoAlku, 6),
      naytokset: [],
      valitut: [],
      naytosTavoitteet: {},
      saliYlitys: {},
    };
    return currentSchedule;
  }

  // The panel's DOM order is the rank order (drag-to-reorder rewrites it in
  // place), so it - not `valitut` - is the source of truth while the tab is open.
  function rosterIdsFromDom() {
    return [...document.querySelectorAll('#elokuva-lista .elokuva-rivi')].map(row => row.dataset.id);
  }

  // Roster ids resolved against the library, dropping any movie deleted from
  // the library since. Never persisted from here: the next real roster edit
  // writes the cleaned list back on its own.
  function rosterMovies(ids) {
    const byId = new Map(Library.getAll().map(m => [m.id, m]));
    return (ids ?? currentSchedule?.valitut ?? []).map(id => byId.get(id)).filter(Boolean);
  }

  function showCount(movieId) {
    return (currentSchedule?.naytokset ?? []).filter(n => n.elokuvaId === movieId).length;
  }

  // Drops a movie from this week entirely: off the roster, off the grid, and
  // its pinned overrides with it. Screenings are user data, so losing them
  // needs a confirmation; a movie with none goes quietly.
  function removeFromWeek(id) {
    if (!currentSchedule) return;
    const movie = Library.getAll().find(m => m.id === id);
    const nimi = movie ? movie.nimi : 'Elokuva';
    const shows = showCount(id);
    if (shows > 0 && !confirm(`"${nimi}" on ohjelmassa ${shows} kertaa tällä viikolla.\n\nPoistetaanko elokuva ja sen näytökset?`)) return;

    pushUndo();
    currentSchedule.valitut = (currentSchedule.valitut ?? []).filter(x => x !== id);
    currentSchedule.naytokset = currentSchedule.naytokset.filter(n => n.elokuvaId !== id);
    if (currentSchedule.naytosTavoitteet) delete currentSchedule.naytosTavoitteet[id];
    if (currentSchedule.saliYlitys) delete currentSchedule.saliYlitys[id];
    Storage.saveSchedule(currentSchedule);
    buildWeekPanel();
    renderGrid();
  }

  // ── "Lisää elokuvia" picker ──────────────────────────────────────────────

  // A working copy, so Peruuta is a complete no-op.
  let pickerSelected = null;

  function openPicker() {
    const movies = Library.getAll();
    if (movies.length === 0) {
      alert('Ei elokuvia kirjastossa. Lisää ensin elokuvia Kirjasto-välilehdeltä.');
      return;
    }
    pickerSelected = new Set(rosterIdsFromDom());
    renderPicker();
    document.getElementById('viikko-valinta-modal').classList.add('open');
  }

  function closePicker() {
    document.getElementById('viikko-valinta-modal').classList.remove('open');
    pickerSelected = null;
  }

  function renderPicker() {
    const tbody = document.getElementById('viikko-valinta-tbody');
    tbody.innerHTML = '';

    Library.getAll().forEach(m => {
      const shows = showCount(m.id);
      const tr = document.createElement('tr');
      tr.dataset.id = m.id;
      const badge = m.lastenelokuva ? '<span class="badge badge-lastenelokuva">Lastenelokuva</span>' : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="valinta-check" ${pickerSelected.has(m.id) ? 'checked' : ''}></td>
        <td>${escHtml(m.nimi)}</td>
        <td>${m.kesto} min</td>
        <td>${badge}</td>
        <td>${escHtml(m.ikäraja)}</td>
        <td>${m.hinta.toFixed(2)} €</td>
        <td>${escHtml(m.jakelija)}</td>
        <td class="tuonti-status">${shows > 0 ? shows : ''}</td>
      `;
      tbody.appendChild(tr);
    });

    updatePickerSummary();
  }

  function updatePickerSummary() {
    const total = Library.getAll().length;
    const n = pickerSelected.size;
    document.getElementById('viikko-valinta-summary').textContent = `${n}/${total} elokuvaa valittu tälle viikolle`;

    const selectAll = document.getElementById('viikko-valinta-select-all');
    selectAll.checked = n === total && total > 0;
    selectAll.indeterminate = n > 0 && n < total;
  }

  function onPickerTableChange(e) {
    if (!pickerSelected || !e.target.classList.contains('valinta-check')) return;
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (e.target.checked) pickerSelected.add(tr.dataset.id);
    else pickerSelected.delete(tr.dataset.id);
    updatePickerSummary();
  }

  function onPickerSelectAll(e) {
    if (!pickerSelected) return;
    pickerSelected = e.target.checked ? new Set(Library.getAll().map(m => m.id)) : new Set();
    renderPicker();
  }

  function commitPicker() {
    if (!pickerSelected) return;
    const before = rosterIdsFromDom();
    const removed = before.filter(id => !pickerSelected.has(id));

    // Unticking a movie that is already on the grid destroys its screenings -
    // say so before doing it, and treat "no" as a cancel of the whole save.
    const losing = removed.map(id => ({ id, shows: showCount(id) })).filter(x => x.shows > 0);
    if (losing.length > 0) {
      const byId = new Map(Library.getAll().map(m => [m.id, m]));
      const lines = losing.map(x => `• ${byId.get(x.id)?.nimi ?? x.id} (${x.shows} näytöstä)`).join('\n');
      const ok = confirm(
        `${losing.length} poistettavalla elokuvalla on näytöksiä tällä viikolla:\n\n${lines}\n\n` +
        'Poistetaanko elokuvat ja niiden näytökset?\n(Peruuta säilyttää nykyisen valinnan.)'
      );
      if (!ok) return;
    }

    // Kept movies hold their rank; newly picked ones join the tail in library order.
    const kept = before.filter(id => pickerSelected.has(id));
    const added = Library.getAll().map(m => m.id).filter(id => pickerSelected.has(id) && !kept.includes(id));
    const valitut = [...kept, ...added];

    ensureSchedule();
    if (!sameOrder(valitut, currentSchedule.valitut ?? [])) {
      pushUndo();
      currentSchedule.valitut = valitut;
      removed.forEach(id => {
        currentSchedule.naytokset = currentSchedule.naytokset.filter(n => n.elokuvaId !== id);
        if (currentSchedule.naytosTavoitteet) delete currentSchedule.naytosTavoitteet[id];
        if (currentSchedule.saliYlitys) delete currentSchedule.saliYlitys[id];
      });
      Storage.saveSchedule(currentSchedule);
    }

    closePicker();
    buildWeekPanel();
    renderGrid();
  }

  // ── Week setup panel ─────────────────────────────────────────────────────

  function buildWeekPanel() {
    const viikkoAlku = currentSchedule?.viikkoAlku ?? nextFriday();
    const viikkoLoppu = currentSchedule?.viikkoLoppu ?? addDays(viikkoAlku, 6);

    document.getElementById('viikko-alku').value = viikkoAlku;
    document.getElementById('viikko-loppu').value = viikkoLoppu;
    updateWeekLabel(viikkoAlku, viikkoLoppu);

    const movies = Library.getAll();
    const roster = rosterMovies();
    renderNaytosStats(); // the roster (and so the movie count) can change while the tab is hidden

    const list = document.getElementById('elokuva-lista');
    list.innerHTML = '';

    if (roster.length === 0) {
      list.innerHTML = movies.length === 0
        ? '<p class="lista-tyhja">Ei elokuvia kirjastossa. Lisää ensin elokuvia Kirjasto-välilehdeltä.</p>'
        : '<p class="lista-tyhja">Ei elokuvia tällä viikolla. Paina &ldquo;+ Lisää elokuvia&rdquo;.</p>';
      refreshNaytosPreview();
      return;
    }

    // The title chip carries the movie's own grid color, so the ranking list
    // reads as a legend for the schedule blocks; the kids marker is the same
    // 👶 the grid blocks use (the old separate "Lapset" badge is gone).
    const movieById = new Map(movies.map(m => [m.id, m]));

    roster.forEach((m, i) => {
      const div = document.createElement('div');
      div.className = 'elokuva-rivi';
      div.draggable = true;
      div.dataset.id = m.id;

      const color = movieColor(m.id, movieById);
      const lastenMarker = m.lastenelokuva ? '<span title="Lastenelokuva">👶 </span>' : '';
      div.innerHTML = `
        <div class="elokuva-rivi-main">
          <span class="drag-handle">⠿</span>
          <span class="rank-number">${i + 1}.</span>
          <strong title="${escHtml(m.nimi)}" style="background:${color.bg};color:${color.text}">${lastenMarker}${escHtml(m.nimi)}</strong>
        </div>
        <div class="elokuva-rivi-controls">
          <input type="number" class="el-naytos-tavoite" data-id="${m.id}" min="0" max="99"
                 title="Näytösten määrä tällä viikolla - automaattinen ellei muokattu">
          <button type="button" class="btn-icon btn-reset-naytos" data-id="${m.id}" title="Palauta automaattiseksi">↺</button>
          <select class="el-sali-ylitys" data-id="${m.id}" title="Sali - automaattinen ellei valittu">
            <option value="">Auto</option>
            <option value="STUDIO 1">Studio 1</option>
            <option value="STUDIO 2">Studio 2</option>
            <option value="STUDIO 3">Studio 3</option>
          </select>
          <button type="button" class="btn-icon btn-danger btn-poista-viikosta" data-id="${m.id}"
                  title="Poista elokuva tältä viikolta">🗑️</button>
        </div>
      `;
      div.addEventListener('dragstart', onRowDragStart);
      div.addEventListener('dragend', onRowDragEnd);
      list.appendChild(div);
    });

    list.querySelectorAll('.el-naytos-tavoite').forEach(inp => inp.addEventListener('change', onNaytosTavoiteChange));
    list.querySelectorAll('.btn-reset-naytos').forEach(btn => btn.addEventListener('click', () => resetNaytosTavoite(btn.dataset.id)));
    list.querySelectorAll('.el-sali-ylitys').forEach(sel => sel.addEventListener('change', onSaliYlitysChange));
    list.querySelectorAll('.btn-poista-viikosta').forEach(btn => btn.addEventListener('click', () => removeFromWeek(btn.dataset.id)));
    refreshNaytosPreview();
  }

  // Computes what Scheduler.schedule() would actually produce per movie right
  // now (current roster, rank order, and any saved overrides) - this is a live
  // "what if I clicked Luo ohjelma" preview, not a separate formula, so it
  // never disagrees with the real result.
  function computePreviewCounts() {
    const viikkoAlku = document.getElementById('viikko-alku').value;
    if (!viikkoAlku) return {};
    const viikkoLoppu = document.getElementById('viikko-loppu').value || addDays(viikkoAlku, 6);

    const selected = rosterMovies(rosterIdsFromDom());
    if (selected.length === 0) return {};

    const settings = Storage.getSettings();
    const overrides = currentSchedule?.naytosTavoitteet ?? {};
    const saliYlitys = currentSchedule?.saliYlitys ?? {};
    const preview = Scheduler.schedule(selected, settings, viikkoAlku, viikkoLoppu, overrides, saliYlitys);

    const counts = {};
    preview.forEach(n => { counts[n.elokuvaId] = (counts[n.elokuvaId] || 0) + 1; });
    return counts;
  }

  // Updates every show-count field: overridden movies show the user's pinned
  // target (styled differently), everything else shows the live preview.
  function refreshNaytosPreview() {
    const counts = computePreviewCounts();
    const overrides = currentSchedule?.naytosTavoitteet ?? {};
    document.querySelectorAll('.el-naytos-tavoite').forEach(inp => {
      const id = inp.dataset.id;
      if (document.activeElement === inp) return; // don't fight the user mid-edit
      if (overrides[id] != null) {
        inp.value = overrides[id];
        inp.classList.add('overridden');
      } else {
        inp.value = counts[id] ?? 0;
        inp.classList.remove('overridden');
      }
    });
    const saliOverrides = currentSchedule?.saliYlitys ?? {};
    document.querySelectorAll('.el-sali-ylitys').forEach(sel => {
      const id = sel.dataset.id;
      if (document.activeElement === sel) return; // don't fight the user mid-edit
      sel.value = saliOverrides[id] ?? '';
      sel.classList.toggle('overridden', saliOverrides[id] != null);
    });
  }

  function onNaytosTavoiteChange(e) {
    const inp = e.currentTarget;
    const id = inp.dataset.id;
    const raw = inp.value.trim();

    if (raw === '') { resetNaytosTavoite(id); return; }

    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) return;
    if (currentSchedule?.naytosTavoitteet?.[id] === n) return; // no-op, don't burn a history slot
    pushUndo();

    ensureSchedule();
    if (!currentSchedule.naytosTavoitteet) currentSchedule.naytosTavoitteet = {};

    currentSchedule.naytosTavoitteet[id] = n;
    Storage.saveSchedule(currentSchedule);
    refreshNaytosPreview();
  }

  // Clears one movie's pinned show-count target, reverting its field to the
  // live auto-computed preview - same effect as blanking the input by hand.
  function resetNaytosTavoite(id) {
    if (currentSchedule?.naytosTavoitteet?.[id] != null) {
      pushUndo();
      delete currentSchedule.naytosTavoitteet[id];
      Storage.saveSchedule(currentSchedule);
    }
    refreshNaytosPreview();
  }

  function resetAllNaytosTavoitteet() {
    if (currentSchedule && Object.keys(currentSchedule.naytosTavoitteet ?? {}).length > 0) {
      pushUndo();
      currentSchedule.naytosTavoitteet = {};
      Storage.saveSchedule(currentSchedule);
    }
    refreshNaytosPreview();
  }

  // Manual per-movie theater assignment - "Auto" (empty value) clears the
  // override and reverts to the rank-order round-robin home theater.
  function onSaliYlitysChange(e) {
    const sel = e.currentTarget;
    const id = sel.dataset.id;
    const value = sel.value;

    const existing = currentSchedule?.saliYlitys?.[id] ?? '';
    if (existing === value) return; // no-op, don't burn a history slot
    pushUndo();

    ensureSchedule();
    if (!currentSchedule.saliYlitys) currentSchedule.saliYlitys = {};

    if (value === '') {
      delete currentSchedule.saliYlitys[id];
    } else {
      currentSchedule.saliYlitys[id] = value;
    }
    Storage.saveSchedule(currentSchedule);
    refreshNaytosPreview();
  }

  // ── Week panel drag-to-reorder ───────────────────────────────────────────

  function onRowDragStart(e) {
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', e.currentTarget.dataset.id);
    // Tracked separately from dataTransfer: browsers only reliably expose
    // dataTransfer.getData() during 'drop', not 'dragover', but the grid drop
    // target needs to know which movie is being dragged on every dragover too.
    draggingMovieId = e.currentTarget.dataset.id;
  }

  function onRowDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    draggingMovieId = null;
    clearGridDropPreview();
    renumberRows(); // rows were reordered live in onRowDragOver - fix up the displayed rank numbers to match

    // The roster IS the rank order, so a reorder is a real change to persist -
    // but a drag that ends where it started must not burn a history slot.
    const ids = rosterIdsFromDom();
    if (currentSchedule && !sameOrder(ids, currentSchedule.valitut ?? [])) {
      pushUndo();
      currentSchedule.valitut = ids;
      Storage.saveSchedule(currentSchedule);
    }
    refreshNaytosPreview(); // rank order changed, so the live preview may have too
  }

  // Re-walks the week panel's rows in their current (possibly just-dragged)
  // DOM order and updates each one's displayed rank number - buildWeekPanel()
  // only assigns these once at render time, but dragging reorders the DOM
  // directly (onRowDragOver) without a full rebuild.
  function renumberRows() {
    document.querySelectorAll('#elokuva-lista .elokuva-rivi').forEach((row, i) => {
      const rankEl = row.querySelector('.rank-number');
      if (rankEl) rankEl.textContent = `${i + 1}.`;
    });
  }

  function onRowDragOver(e) {
    e.preventDefault();
    const list = e.currentTarget;
    const dragging = list.querySelector('.elokuva-rivi.dragging');
    if (!dragging) return;

    // Find the row whose midpoint is just below the cursor, so the dragged
    // row lands above it; falling off the end means append to the bottom.
    const afterRow = [...list.querySelectorAll('.elokuva-rivi:not(.dragging)')].reduce((closest, row) => {
      const box = row.getBoundingClientRect();
      const offset = e.clientY - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, row };
      return closest;
    }, { offset: -Infinity, row: null }).row;

    if (afterRow) {
      list.insertBefore(dragging, afterRow);
    } else {
      list.appendChild(dragging);
    }
  }

  function nextFriday() {
    const d = new Date();
    const day = d.getDay(); // 0=Sun, 5=Fri
    const diff = (5 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  function updateWeekLabel(isoAlku, isoLoppu) {
    const start = new Date(isoAlku);
    const end = new Date(isoLoppu);
    const fmt = (dt) => `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;
    const startDay = Scheduler.PAIVA_LYHYET[start.getDay()];
    const endDay   = Scheduler.PAIVA_LYHYET[end.getDay()];
    document.getElementById('viikko-label').textContent = `OHJELMISTO: ${startDay} ${fmt(start)} – ${endDay} ${fmt(end)}`;
  }

  // ── Auto-generate ─────────────────────────────────────────────────────────

  function luoOhjelma() {
    if (currentSchedule && currentSchedule.naytokset.length > 0) {
      let msg = 'Nykyinen ohjelma korvataan uudella. Jatketaanko?';
      const overrideCount = Object.keys(currentSchedule.naytosTavoitteet ?? {}).length;
      if (overrideCount > 0) {
        msg += `\n\n${overrideCount} elokuvalla on käsin asetettu näytösmäärä, joka säilyy.`;
      }
      if (!confirm(msg)) return;
    }

    const viikkoAlku = document.getElementById('viikko-alku').value;
    if (!viikkoAlku) { alert('Valitse ensin alkupäivä.'); return; }
    const viikkoLoppu = document.getElementById('viikko-loppu').value || addDays(viikkoAlku, 6);

    // DOM order reflects any drag-reordering the user did, so it doubles as the rank order.
    const selected = rosterMovies(rosterIdsFromDom());
    if (selected.length === 0) { alert('Lisää ensin elokuvia viikkoon "+ Lisää elokuvia" -painikkeella.'); return; }

    const settings = Storage.getSettings();
    // Any per-movie show-count targets set in the week panel are honored as
    // hard caps; movies without one keep using the emergent rank-based model.
    const naytosTavoitteet = currentSchedule?.naytosTavoitteet ?? {};
    // Any per-movie manual theater assignments are honored as the movie's home
    // theater (still falling back to another theater if that one is full).
    const saliYlitys = currentSchedule?.saliYlitys ?? {};
    // selected's array order is the rank Scheduler.schedule uses (index 0 = most popular)
    const naytokset = Scheduler.schedule(selected, settings, viikkoAlku, viikkoLoppu, naytosTavoitteet, saliYlitys);

    pushUndo();
    currentSchedule = { viikkoAlku, viikkoLoppu, naytokset, valitut: selected.map(m => m.id), naytosTavoitteet, saliYlitys };
    Storage.saveSchedule(currentSchedule);
    renderGrid();
    refreshNaytosPreview();
  }

  // Wipes the grid back to a blank week without touching the roster - the
  // starting point for building a program by hand. Per-movie show-count and
  // theater overrides survive too: they are settings on the roster, not part
  // of the grid ("↺ Nollaa kaikki" is what clears those).
  function tyhjennaGrid() {
    const n = currentSchedule?.naytokset.length ?? 0;
    if (n === 0) return;
    if (!confirm(`Poistetaanko kaikki ${n} näytöstä aikataulusta?\n\nViikon elokuvat säilyvät listassa.`)) return;
    pushUndo();
    currentSchedule.naytokset = [];
    Storage.saveSchedule(currentSchedule);
    renderGrid();
  }

  // ── Import a week program from Excel (same format as the export) ─────────

  function normalizeNimi(s) {
    return String(s).trim().toUpperCase().replace(/\s+/g, ' ');
  }

  function importOhjelmaFile(file) {
    const reader = new FileReader();
    reader.onerror = () => alert('Tiedostoa ei voitu lukea.');
    reader.onload = e => {
      let parsed;
      try {
        parsed = Exporter.parseScheduleWorkbook(e.target.result);
      } catch {
        alert('Tiedostoa ei voitu tulkita. Varmista että se on tämän työkalun viemä (tai samanmuotoinen) .xlsx-ohjelmisto.');
        return;
      }
      applyImportedSchedule(parsed);
    };
    reader.readAsArrayBuffer(file);
  }

  function applyImportedSchedule({ screenings, viikkoAlku, viikkoLoppu, warnings }) {
    if (screenings.length === 0) {
      alert('Tiedostosta ei löytynyt yhtään näytöstä.');
      return;
    }

    if (currentSchedule && currentSchedule.naytokset.length > 0) {
      if (!confirm('Nykyinen ohjelma korvataan tuodulla. Jatketaanko?')) return;
    }

    // Match screenings to library movies by name; anything unknown is added
    // to the library only with the user's explicit permission - declining
    // cancels the whole import rather than importing a partial schedule.
    const movieByNimi = new Map(Library.getAll().map(m => [normalizeNimi(m.nimi), m]));
    const unknown = new Map(); // normalized name -> first screening carrying its data
    screenings.forEach(s => {
      const key = normalizeNimi(s.nimi);
      if (!movieByNimi.has(key) && !unknown.has(key)) unknown.set(key, s);
    });

    if (unknown.size > 0) {
      const names = [...unknown.values()].map(s => `• ${s.nimi}`).join('\n');
      const ok = confirm(
        `Tiedostossa on ${unknown.size} elokuvaa, joita ei ole kirjastossa:\n\n${names}\n\n` +
        'Lisätäänkö ne kirjastoon ja jatketaan tuontia?\n(Peruuta keskeyttää tuonnin - mitään ei muuteta.)'
      );
      if (!ok) return;

      const hintaraja = Storage.getSettings().lastenelokuva?.hintaraja ?? 12.5;
      const newMovies = [...unknown.values()].map(s => ({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        nimi: s.nimi,
        kesto: s.kesto,
        ikäraja: s.ikäraja,
        hinta: s.hinta ?? 0,
        jakelija: s.jakelija,
        lastenelokuva: s.hinta != null && Math.abs(s.hinta - hintaraja) < 0.01,
      }));
      Storage.saveMovies([...Storage.getMovies(), ...newMovies]);
      Library.refresh();
      newMovies.forEach(m => movieByNimi.set(normalizeNimi(m.nimi), m));
    }

    const naytokset = screenings.map(s => {
      const movie = movieByNimi.get(normalizeNimi(s.nimi));
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        sali: s.sali,
        paiva: s.paiva,
        alkaa: toHHMM(s.alkaaMin),
        loppuu: toHHMM(s.alkaaMin + s.kesto),
        elokuvaId: movie.id,
        nimi: movie.nimi,
        kesto: s.kesto,
        ikäraja: s.ikäraja,
        hinta: s.hinta ?? movie.hinta,
        jakelija: s.jakelija || movie.jakelija,
        lastenelokuva: !!movie.lastenelokuva,
      };
    });

    // The imported week IS the roster - a library movie the file never mentions
    // simply isn't playing. Rank order comes from the file itself: most shows first.
    const countById = new Map();
    naytokset.forEach(n => countById.set(n.elokuvaId, (countById.get(n.elokuvaId) ?? 0) + 1));
    const valitut = [...countById.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

    // Pin each imported movie's show count, same convention as adding a
    // screening manually on the grid - so the week panel shows the imported
    // reality and a later "Luo ohjelma" honors it.
    const naytosTavoitteet = {};
    countById.forEach((count, id) => { naytosTavoitteet[id] = count; });

    const alku = viikkoAlku ?? document.getElementById('viikko-alku').value ?? nextFriday();
    const loppu = viikkoLoppu ?? addDays(alku, 6);
    document.getElementById('viikko-alku').value = alku;
    document.getElementById('viikko-loppu').value = loppu;
    updateWeekLabel(alku, loppu);

    pushUndo();
    currentSchedule = { viikkoAlku: alku, viikkoLoppu: loppu, naytokset, valitut, naytosTavoitteet, saliYlitys: {} };
    Storage.saveSchedule(currentSchedule);
    buildWeekPanel();
    renderGrid();

    const msgs = [...warnings];
    if (!viikkoAlku) msgs.push('Viikon päivämääriä ei löytynyt tiedostosta - käytetään valittua viikkoa.');
    if (msgs.length > 0) showWarning(msgs.join(' '));
  }

  // ── Grid rendering ────────────────────────────────────────────────────────

  // Live tally of the week as it stands, recomputed on every schedule change
  // (generate, import, drag-add, drag-move, delete, duplicate, undo/redo).
  function renderNaytosStats() {
    const el = document.getElementById('viikko-stats');
    if (!el) return;
    const naytokset = currentSchedule?.naytokset ?? [];
    const perSali = SALAT.map(sali => `
      <span class="stat-chip"><span class="stat-chip-nimi">${escHtml(sali)}</span>
      <span class="stat-chip-arvo">${naytokset.filter(n => n.sali === sali).length}</span></span>`).join('');
    el.innerHTML = `
      <span class="stat-total"><strong>${naytokset.length}</strong> ${naytokset.length === 1 ? 'näytös' : 'näytöstä'}</span>
      <span class="stat-elokuvat">${rosterMovies().length} elokuvaa</span>
      ${perSali}`;

    // Nothing on the grid, nothing to clear - same signal the tally already gives.
    const tyhjenna = document.getElementById('btn-tyhjenna-grid');
    if (tyhjenna) tyhjenna.disabled = naytokset.length === 0;
  }

  // The week's REAL opening hours are an outcome of the generated program,
  // not a setting: derived per day from the actual showings exactly like the
  // Excel export's opening-hours row (doors open avautuu_ennen_min before
  // the first show; the closing figure is the last show's start). Shown
  // above the grid so it's visible that the hours change with the program.
  // With nothing scheduled there are no hours to report, so the line carries
  // the empty grid's "what do I do now" hint instead.
  function renderViikkoAukiolo() {
    const el = document.getElementById('viikko-aukiolo');
    if (!el) return;
    if (!currentSchedule || currentSchedule.naytokset.length === 0) {
      el.textContent = rosterMovies().length === 0
        ? 'Ei näytöksiä. Lisää elokuvia viikkoon, raahaa ne ruudukkoon tai paina "Luo ohjelma".'
        : 'Ei näytöksiä. Raahaa elokuvia listasta ruudukkoon tai paina "Luo ohjelma".';
      return;
    }
    const settings = Storage.getSettings();
    const ennenMin = settings.aukiolo_excel?.avautuu_ennen_min ?? 30;
    const sulkuOffset = settings.aukiolo_excel?.sulkeutuu_offset_min ?? 0;
    const PAIVA_LOWER = { PE: 'Pe', LA: 'La', SU: 'Su', MA: 'Ma', TI: 'Ti', KE: 'Ke', TO: 'To' };
    const fmt = min => `${String(Math.floor(min / 60)).padStart(2, '0')}.${String(min % 60).padStart(2, '0')}`;
    const paivat = Scheduler.getPaivat(currentSchedule.viikkoAlku, currentSchedule.viikkoLoppu);
    const parts = paivat.map(paiva => {
      const starts = currentSchedule.naytokset.filter(n => n.paiva === paiva).map(n => toMin(n.alkaa));
      if (starts.length === 0) return null;
      return `${PAIVA_LOWER[paiva]} ${fmt(Math.min(...starts) - ennenMin)}–${fmt(Math.max(...starts) + sulkuOffset)}`;
    }).filter(Boolean);
    el.textContent = parts.length ? `Aukiolo tällä viikolla: ${parts.join('  ')}` : '';
  }

  // Always draws the full week - theaters, days and time axis - even with no
  // screenings at all, because an empty grid is a valid starting point: it is
  // the drop target for building a program by hand, movie by movie.
  function renderGrid() {
    renderNaytosStats();
    renderViikkoAukiolo();
    const container = document.getElementById('aikataulu-grid');
    container.innerHTML = '';

    const naytokset = currentSchedule?.naytokset ?? [];
    const settings = Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';
    container.classList.toggle('suunta-vaaka', horizontal);
    container.classList.toggle('grid-tyhja', naytokset.length === 0);
    const movieById = new Map(Library.getAll().map(m => [m.id, m]));

    const totalMin = GRID_END - GRID_START;
    const gridLen = totalMin * PX_PER_MIN; // px length of the time axis
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;

    // Time axis
    const timeAxis = document.createElement('div');
    timeAxis.className = 'time-axis';
    if (horizontal) {
      timeAxis.style.width = gridLen + 'px';
    } else {
      timeAxis.style.height = (gridLen + DAY_HEADER_H) + 'px';
    }
    for (let h = 10; h <= 23; h++) {
      const tick = document.createElement('div');
      tick.className = 'time-tick';
      const offset = (h * 60 - GRID_START) * PX_PER_MIN;
      // In vertical mode the ruler sits beside the day-headers, so each tick
      // bakes in DAY_HEADER_H itself; in horizontal mode the ruler's own
      // margin-left (see CSS) already accounts for DAY_HEADER_W, so ticks don't.
      tick.style.top = horizontal ? '' : (DAY_HEADER_H + offset) + 'px';
      tick.style.left = horizontal ? offset + 'px' : '';
      tick.textContent = `${h}.00`;
      timeAxis.appendChild(tick);
    }
    container.appendChild(timeAxis);

    const wrapper = document.createElement('div');
    wrapper.className = 'sali-wrapper';

    // Falls back to the date inputs so the blank grid has days before a
    // schedule object has ever been created.
    const viikkoAlku = currentSchedule?.viikkoAlku || document.getElementById('viikko-alku').value || nextFriday();
    const viikkoLoppu = currentSchedule?.viikkoLoppu || document.getElementById('viikko-loppu').value || addDays(viikkoAlku, 6);
    const paivat = Scheduler.getPaivat(viikkoAlku, viikkoLoppu);

    SALAT.forEach(sali => {
      const col = document.createElement('div');
      col.className = 'sali-col';
      col.dataset.sali = sali;

      const header = document.createElement('div');
      header.className = 'sali-header';
      header.textContent = sali;
      col.appendChild(header);

      const lane = document.createElement('div');
      lane.className = 'sali-lane';
      lane.dataset.sali = sali;
      if (horizontal) {
        lane.style.width = gridLen + 'px';
      } else {
        lane.style.height = (gridLen + DAY_HEADER_H) + 'px';
      }

      // Place screening blocks
      paivat.forEach(paiva => {
        const screenings = naytokset
          .filter(n => n.sali === sali && n.paiva === paiva)
          .sort((a, b) => toMin(a.alkaa) - toMin(b.alkaa));

        // Day column (vertical) / day row (horizontal) within lane
        const dayCol = document.createElement('div');
        dayCol.className = 'day-col';
        dayCol.dataset.paiva = paiva;
        dayCol.dataset.sali = sali;
        if (horizontal) {
          dayCol.style.width = gridLen + 'px';
          dayCol.style.height = ROW_H_VAAKA + 'px';
        } else {
          dayCol.style.height = (gridLen + DAY_HEADER_H) + 'px';
        }

        const dayHeader = document.createElement('div');
        dayHeader.className = 'day-header';
        dayHeader.textContent = paiva;
        dayCol.appendChild(dayHeader);

        // Hour lines inside this day column/row
        for (let h = 10; h <= 23; h++) {
          const line = document.createElement('div');
          line.className = 'hour-line';
          const offset = headerOffset + (h * 60 - GRID_START) * PX_PER_MIN;
          positionBox(line, horizontal, offset, '1px', '0', '0');
          dayCol.appendChild(line);
        }

        screenings.forEach(n => {
          const block = buildBlock(n, horizontal, headerOffset, movieById);
          dayCol.appendChild(block);

          // Same-theater gap after this show - visualizes minimivali_sama_sali,
          // the window the algorithm (and drag validation) actually enforces.
          const bufferMin = settings.minimivali_sama_sali;
          if (bufferMin > 0) {
            const bufOffset = headerOffset + (toMin(n.alkaa) + n.kesto - GRID_START) * PX_PER_MIN;
            const buf = document.createElement('div');
            buf.className = 'buffer-zone';
            buf.dataset.id = n.id;
            positionBox(buf, horizontal, bufOffset, (bufferMin * PX_PER_MIN) + 'px', '2px', '2px');
            dayCol.appendChild(buf);
          }
        });

        lane.appendChild(dayCol);
      });

      col.appendChild(lane);
      wrapper.appendChild(col);
    });

    container.appendChild(wrapper);
    attachContextMenu();
  }

  // Positions an element along the time axis: `offset`/`sizeAlong` go on
  // left/width (horizontal mode) or top/height (vertical mode); `crossInset`
  // is the fixed inset on the perpendicular axis (e.g. "2px" padding, or "0"
  // for hour-lines spanning the full cross dimension).
  function positionBox(el, horizontal, offset, sizeAlong, crossInsetStart, crossInsetEnd) {
    if (horizontal) {
      el.style.left = offset + 'px';
      el.style.width = sizeAlong;
      el.style.top = crossInsetStart;
      el.style.bottom = crossInsetEnd;
      el.style.right = '';
      el.style.height = '';
    } else {
      el.style.top = offset + 'px';
      el.style.height = sizeAlong;
      el.style.left = crossInsetStart;
      el.style.right = crossInsetEnd;
      el.style.bottom = '';
      el.style.width = '';
    }
  }

  function buildBlock(n, horizontal, headerOffset, movieById) {
    const startMin = toMin(n.alkaa);
    const offset = headerOffset + (startMin - GRID_START) * PX_PER_MIN;
    const sizeAlong = Math.max(n.kesto * PX_PER_MIN, horizontal ? 40 : 20);

    const color = movieColor(n.elokuvaId, movieById);
    const block = document.createElement('div');
    block.className = 'naytokset-block';
    positionBox(block, horizontal, offset, sizeAlong + 'px', '2px', '2px');
    block.style.backgroundColor = color.bg;
    block.style.color = color.text;
    block.dataset.id = n.id;
    block.title = `${n.nimi}\n${n.alkaa}–${n.loppuu}\n${n.kesto} min`;

    const isLasten = n.lastenelokuva === true || n.kategoria === 'lastenelokuva';
    const lastenMarker = isLasten ? '<span class="block-lasten" title="Lastenelokuva">👶</span>' : '';

    block.innerHTML = `
      ${lastenMarker}
      <span class="block-time">${n.alkaa.replace(':','.')}</span>
      <span class="block-nimi">${escHtml(n.nimi)}</span>
      <span class="block-kesto">${n.kesto}min</span>
    `;

    block.addEventListener('mousedown', onBlockMouseDown);
    block.addEventListener('contextmenu', onContextMenu);
    return block;
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  // Dragging is custom (mousedown/mousemove/mouseup) rather than native HTML5
  // drag-and-drop, because native DnD gives the browser control of the drag
  // image - there's no way to move the real block in real time or update its
  // displayed start time as the cursor moves. Instead we clone the block into
  // a `position:fixed` overlay that follows the cursor, snapped to the same
  // 15-min/theater grid it would actually land on, and re-run
  // Scheduler.validateScreening() on every move so the clone visibly flags
  // (red) any position that would overlap another show's buffer. Only a
  // currently-valid position can be dropped; anything else reverts.
  function onBlockMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();

    const block = e.currentTarget;
    const id = block.dataset.id;
    const n = currentSchedule.naytokset.find(x => x.id === id);
    if (!n) return;

    const settings = Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';

    // Drag the real block/buffer elements directly (switching to
    // position:fixed) rather than cloning them - renderGrid() always rebuilds
    // the whole grid on mouseup regardless of outcome, so there's nothing to
    // restore afterward either way, and this avoids the two failure modes a
    // clone has: it starts unpositioned until the first mousemove (a visible
    // flash), and hiding "the original" is a separate element to track.
    const rect = block.getBoundingClientRect();
    block.classList.add('live-dragging');
    block.style.position = 'fixed';
    block.style.pointerEvents = 'none';
    setFixedBox(block, rect.left, rect.top, rect.width, rect.height);

    const buf = document.querySelector(`.buffer-zone[data-id="${id}"]`);
    if (buf) {
      const bufRect = buf.getBoundingClientRect();
      buf.style.position = 'fixed';
      buf.style.pointerEvents = 'none';
      setFixedBox(buf, bufRect.left, bufRect.top, bufRect.width, bufRect.height);
    }

    dragState = {
      id,
      kesto: n.kesto,
      horizontal,
      settings,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
      block,
      buf,
      lastCandidate: null,
    };

    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp);
  }

  // Nearest start time in the target room+day where the show actually fits,
  // searching outward from where the cursor put it in 15-min steps. Later is
  // tried before earlier at equal distance: dropping onto the tail of another
  // show reads as "put it after that one". Returns the wanted start unchanged
  // when it already fits, or null when the whole room-day has no room for it.
  //
  // Only same-room overlap constrains a screening (Scheduler.validateScreening),
  // so this never has to look outside the cell being dropped into.
  function nearestFreeStart(base, wantedStart, kesto, settings) {
    const existing = currentSchedule?.naytokset ?? [];
    const maxStart = GRID_END - kesto;
    if (maxStart < GRID_START) return null;

    const wanted = Math.max(GRID_START, Math.min(wantedStart, maxStart));
    const fits = s => Scheduler.validateScreening(
      { ...base, kesto, alkaa: toHHMM(s), loppuu: toHHMM(s + kesto) },
      existing, settings
    ).length === 0;

    if (fits(wanted)) return wanted;
    for (let delta = 15; delta <= maxStart - GRID_START; delta += 15) {
      const later = wanted + delta;
      if (later <= maxStart && fits(later)) return later;
      const earlier = wanted - delta;
      if (earlier >= GRID_START && fits(earlier)) return earlier;
    }
    return null;
  }

  function snappedNotice(start) {
    showWarning(`Ei tilaa haluttuun kohtaan - näytös siirrettiin lähimpään vapaaseen (${toHHMM(start).replace(':', '.')}).`);
  }

  // The cursor is over a spot this show cannot occupy - either it will slide to
  // `start` on drop, or nothing in this room-day fits and the drop reverts.
  const blockedAt = candidate => !candidate.valid || candidate.snapped;

  function setFixedBox(el, left, top, width, height) {
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = width + 'px';
    el.style.height = height + 'px';
    el.style.right = '';
    el.style.bottom = '';
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const { horizontal, block, buf, grabOffsetX, grabOffsetY, kesto, settings, id } = dragState;
    const bufferMin = settings.minimivali_sama_sali;

    const floatLeft = e.clientX - grabOffsetX;
    const floatTop = e.clientY - grabOffsetY;

    // pointer-events:none on both (set at drag start) keeps elementFromPoint
    // from hitting the dragged elements themselves.
    const under = document.elementFromPoint(floatLeft + 3, floatTop + 3);
    const dayCol = under && under.closest('.day-col');

    let candidate = null;
    if (dayCol) {
      const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
      const dayColRect = dayCol.getBoundingClientRect();
      const relPos = horizontal ? floatLeft - dayColRect.left : floatTop - dayColRect.top;
      const snappedStart = round15(GRID_START + (relPos - headerOffset) / PX_PER_MIN);

      const newSali = dayCol.dataset.sali;
      const newPaiva = dayCol.dataset.paiva;
      // Not clamped to the day's configured opening hours - dragging past them
      // is allowed, and extends that day's hours on drop (see onPointerUp).
      const wanted = Math.max(GRID_START, Math.min(snappedStart, GRID_END - kesto));

      // The block tracks the cursor, so the drag stays direct - it is drawn
      // where you are pointing, not where it would end up. `start` is where the
      // drop will actually put it: `wanted` when that fits, otherwise the
      // nearest slot that does. The two differing is what turns the block red.
      const fitted = nearestFreeStart({ id, sali: newSali, paiva: newPaiva }, wanted, kesto, settings);
      const start = fitted ?? wanted;
      candidate = { sali: newSali, paiva: newPaiva, start, wanted, valid: fitted != null, snapped: start !== wanted };

      // Snap into the target cell along the cross axis. Buffer offset is based
      // on the real kesto (matching renderGrid's static buffer-zone math), not
      // the visually-clamped minimum block size below.
      const alongOffset = headerOffset + (wanted - GRID_START) * PX_PER_MIN;
      const bufAlongOffset = alongOffset + kesto * PX_PER_MIN;
      if (horizontal) {
        setFixedBox(block, dayColRect.left + alongOffset, dayColRect.top + 2, Math.max(kesto * PX_PER_MIN, 40), dayColRect.height - 4);
        if (buf) setFixedBox(buf, dayColRect.left + bufAlongOffset, dayColRect.top + 2, bufferMin * PX_PER_MIN, dayColRect.height - 4);
      } else {
        setFixedBox(block, dayColRect.left + 2, dayColRect.top + alongOffset, dayColRect.width - 4, Math.max(kesto * PX_PER_MIN, 20));
        if (buf) setFixedBox(buf, dayColRect.left + 2, dayColRect.top + bufAlongOffset, dayColRect.width - 4, bufferMin * PX_PER_MIN);
      }
      if (buf) buf.style.visibility = '';
    } else {
      setFixedBox(block, floatLeft, floatTop, block.offsetWidth, block.offsetHeight);
      if (buf) buf.style.visibility = 'hidden';
    }

    dragState.lastCandidate = candidate;
    // Red means "not here": either the spot under the cursor is taken (the drop
    // will slide it to `start`) or the whole room-day is full (the drop reverts).
    block.classList.toggle('drag-invalid', !!candidate && blockedAt(candidate));
    // The time shown is always where the block would LAND, so a slide is never
    // a surprise even though the block itself is still under the cursor.
    const timeSpan = block.querySelector('.block-time');
    if (timeSpan && candidate) timeSpan.textContent = toHHMM(candidate.start).replace(':', '.');
  }

  function onPointerUp() {
    if (!dragState) return;
    document.removeEventListener('mousemove', onPointerMove);
    document.removeEventListener('mouseup', onPointerUp);

    const { id, lastCandidate } = dragState;
    // No cleanup needed for block/buf - renderGrid() below wipes and rebuilds
    // the whole grid unconditionally, discarding these repositioned elements.

    if (lastCandidate && lastCandidate.valid) {
      const idx = currentSchedule.naytokset.findIndex(n => n.id === id);
      if (idx !== -1) {
        const n = currentSchedule.naytokset[idx];
        const moved = n.sali !== lastCandidate.sali || n.paiva !== lastCandidate.paiva || n.alkaa !== toHHMM(lastCandidate.start);
        if (moved) pushUndo();
        currentSchedule.naytokset[idx] = {
          ...n,
          sali: lastCandidate.sali,
          paiva: lastCandidate.paiva,
          alkaa: toHHMM(lastCandidate.start),
          loppuu: toHHMM(lastCandidate.start + n.kesto),
        };
        Storage.saveSchedule(currentSchedule);
        extendOpeningHours(lastCandidate.paiva, lastCandidate.start, lastCandidate.start + n.kesto);
        if (lastCandidate.snapped) snappedNotice(lastCandidate.start);
      }
    } else if (lastCandidate) {
      showWarning('Salissa ei ole vapaata kohtaa tänä päivänä - siirto peruttu.');
    }

    dragState = null;
    renderGrid();
  }

  // Dragging a show earlier/later than the day's configured hours extends
  // those hours to fit rather than blocking the move. The extended day
  // becomes a pinned override (Storage's aukioloajat_yliajot) so it persists
  // instead of reverting to the built-in default on next load. Note that
  // sulkeutuu is the scheduler's evening ANCHOR (when the day's last show
  // starts), so pinning a later value here also shifts where the next
  // auto-generation anchors that day's evening - intentional: a manually
  // dragged-late show is a statement that the day should run later.
  function extendOpeningHours(paiva, startMin, endMin) {
    const settings = Storage.getSettings();
    const current = settings.aukioloajat[paiva];
    const openMin = Scheduler.toMin(current.avautuu);
    const closeMin = Scheduler.toMin(current.sulkeutuu);
    const newOpen = Math.min(openMin, startMin);
    const newClose = Math.max(closeMin, endMin);
    if (newOpen === openMin && newClose === closeMin) return;

    if (!settings.aukioloajat_yliajot) settings.aukioloajat_yliajot = {};
    settings.aukioloajat_yliajot[paiva] = { avautuu: toHHMM(newOpen), sulkeutuu: toHHMM(newClose) };
    Storage.saveSettings(settings);
  }

  // ── Drag a movie from the list onto the grid to add a show ───────────────

  // Reuses the same native drag already used for in-list reordering
  // (onRowDragStart/onRowDragEnd) - the grid is just a second valid drop
  // target. draggingMovieId (set in onRowDragStart) identifies the movie
  // since dataTransfer.getData() isn't reliably readable during 'dragover'.
  function onGridDragOver(e) {
    if (!draggingMovieId) return;
    const dayCol = e.target.closest && e.target.closest('.day-col');
    if (!dayCol) { clearGridDropPreview(); return; }
    e.preventDefault();

    const movie = Library.getAll().find(m => m.id === draggingMovieId);
    if (!movie) return;

    const settings = Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
    const dayColRect = dayCol.getBoundingClientRect();
    const relPos = horizontal ? e.clientX - dayColRect.left : e.clientY - dayColRect.top;
    const snappedStart = round15(GRID_START + (relPos - headerOffset) / PX_PER_MIN);
    const wanted = Math.max(GRID_START, Math.min(snappedStart, GRID_END - movie.kesto));

    const base = { id: '__preview__', sali: dayCol.dataset.sali, paiva: dayCol.dataset.paiva };
    const fitted = nearestFreeStart(base, wanted, movie.kesto, settings);
    const start = fitted ?? wanted;
    const candidate = { sali: base.sali, paiva: base.paiva, start, wanted, valid: fitted != null, snapped: start !== wanted, movieId: movie.id };

    // Ghost sits under the cursor and reddens where the show cannot go, exactly
    // like a block being moved; its label reads the time the drop would give it.
    showGridDropPreview(dayCol, horizontal, headerOffset, wanted, start, movie.kesto, blockedAt(candidate));
    gridDropCandidate = candidate;
  }

  function showGridDropPreview(dayCol, horizontal, headerOffset, posStart, labelStart, kesto, blocked) {
    if (!gridGhostEl) {
      gridGhostEl = document.createElement('div');
      gridGhostEl.className = 'naytokset-block grid-drop-ghost';
      gridGhostEl.innerHTML = '<span class="block-time"></span>';
    }
    if (gridGhostEl.parentElement !== dayCol) dayCol.appendChild(gridGhostEl);

    const offset = headerOffset + (posStart - GRID_START) * PX_PER_MIN;
    const sizeAlong = Math.max(kesto * PX_PER_MIN, horizontal ? 40 : 20);
    positionBox(gridGhostEl, horizontal, offset, sizeAlong + 'px', '2px', '2px');
    gridGhostEl.querySelector('.block-time').textContent = toHHMM(labelStart).replace(':', '.');
    gridGhostEl.classList.toggle('drag-invalid', blocked);
  }

  function clearGridDropPreview() {
    if (gridGhostEl && gridGhostEl.parentElement) gridGhostEl.parentElement.removeChild(gridGhostEl);
    gridDropCandidate = null;
  }

  function onGridDrop(e) {
    if (!draggingMovieId) return;
    e.preventDefault();

    const candidate = gridDropCandidate;
    clearGridDropPreview();
    if (!candidate) return;
    if (!candidate.valid) { showWarning('Salissa ei ole vapaata kohtaa tänä päivänä.'); return; }

    const movie = Library.getAll().find(m => m.id === candidate.movieId);
    if (!movie) return;

    pushUndo();
    ensureSchedule();
    const naytos = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      sali: candidate.sali,
      paiva: candidate.paiva,
      alkaa: toHHMM(candidate.start),
      loppuu: toHHMM(candidate.start + movie.kesto),
      elokuvaId: movie.id,
      nimi: movie.nimi,
      kesto: movie.kesto,
      ikäraja: movie.ikäraja,
      hinta: movie.hinta,
      jakelija: movie.jakelija,
      lastenelokuva: !!movie.lastenelokuva,
    };
    currentSchedule.naytokset.push(naytos);
    extendOpeningHours(candidate.paiva, candidate.start, candidate.start + movie.kesto);

    // Pin the show-count field to the movie's new real total so it visibly
    // reflects the manually-added screening, exactly like an explicit override.
    const actualCount = currentSchedule.naytokset.filter(n => n.elokuvaId === movie.id).length;
    if (!currentSchedule.naytosTavoitteet) currentSchedule.naytosTavoitteet = {};
    currentSchedule.naytosTavoitteet[movie.id] = actualCount;

    // The drag can only have started from a roster row, so the movie is already
    // on the roster - nothing to select. (Rebuilding the panel here would also
    // destroy the row mid-drag, before its own dragend fires.)
    Storage.saveSchedule(currentSchedule);
    renderGrid();
    refreshNaytosPreview();
    if (candidate.snapped) snappedNotice(candidate.start);
  }

  // ── Context menu (right-click) ────────────────────────────────────────────

  // The menu is position:fixed, so it must be placed in VIEWPORT coordinates
  // (clientX/clientY). Using pageX/pageY put it scrollY pixels too low - on a
  // scrolled page, often off-screen entirely. It also has to be opened before
  // it can be measured, hence the two-step: show, measure, then clamp so it
  // never hangs off the bottom or right edge.
  function onContextMenu(e) {
    e.preventDefault();
    contextTarget = e.currentTarget.dataset.id;

    const menu = document.getElementById('context-menu');
    menu.classList.add('open');

    const margin = 4;
    const left = Math.max(margin, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - margin));
    const top = Math.max(margin, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - margin));
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
  }

  function attachContextMenu() {
    document.addEventListener('click', () => {
      document.getElementById('context-menu').classList.remove('open');
    }, { once: false });
  }

  function contextEdit() {
    document.getElementById('context-menu').classList.remove('open');
    if (!contextTarget) return;
    const n = currentSchedule.naytokset.find(n => n.id === contextTarget);
    if (!n) return;

    document.getElementById('edit-alkaa').value = n.alkaa;
    document.getElementById('edit-sali').value = n.sali;
    document.getElementById('edit-hinta').value = n.hinta;
    document.getElementById('edit-modal-otsikko').textContent = `Muokkaa: ${n.nimi}`;
    document.getElementById('edit-modal').classList.add('open');
  }

  function contextRemove() {
    document.getElementById('context-menu').classList.remove('open');
    if (!contextTarget) return;
    if (!confirm('Poistetaanko tämä näytös?')) return;
    pushUndo();
    currentSchedule.naytokset = currentSchedule.naytokset.filter(n => n.id !== contextTarget);
    Storage.saveSchedule(currentSchedule);
    renderGrid();
    contextTarget = null;
  }

  function contextDuplicate() {
    document.getElementById('context-menu').classList.remove('open');
    if (!contextTarget) return;
    const n = currentSchedule.naytokset.find(n => n.id === contextTarget);
    if (!n) return;
    const settings = Storage.getSettings();
    const endMin = Scheduler.toMin(n.loppuu ?? toHHMM(toMin(n.alkaa) + n.kesto));
    const newStart = Scheduler.round15(endMin + settings.minimivali_sama_sali);
    const newEnd = newStart + n.kesto;
    pushUndo();
    currentSchedule.naytokset.push({
      ...n,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      alkaa: toHHMM(newStart),
      loppuu: toHHMM(newEnd),
    });
    Storage.saveSchedule(currentSchedule);
    renderGrid();
  }

  function saveEditModal() {
    const n = currentSchedule.naytokset.find(n => n.id === contextTarget);
    if (!n) return;
    const newAlkaa = document.getElementById('edit-alkaa').value;
    const newSali  = document.getElementById('edit-sali').value;
    const newHinta = parseFloat(document.getElementById('edit-hinta').value);
    if (!newAlkaa) { alert('Syötä alkamisaika.'); return; }
    pushUndo();
    n.alkaa  = newAlkaa;
    n.loppuu = toHHMM(toMin(newAlkaa) + n.kesto);
    n.sali   = newSali;
    n.hinta  = isNaN(newHinta) ? n.hinta : newHinta;
    Storage.saveSchedule(currentSchedule);
    document.getElementById('edit-modal').classList.remove('open');
    renderGrid();
  }

  function showWarning(msg) {
    const bar = document.getElementById('warning-bar');
    bar.textContent = '⚠️ ' + msg;
    bar.classList.add('visible');
    setTimeout(() => bar.classList.remove('visible'), 5000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  // The dates the user picks are the week's dates, always - including a week
  // that already has screenings on it, such as one just imported from Excel.
  // (They used to be ignored in that case, which left an imported program stuck
  // on the dates its file carried: the grid, the label and the Excel export all
  // kept the old week no matter what the calendar said.)
  //
  // Screenings are keyed by WEEKDAY, not by date, so moving the week to another
  // Friday-to-Thursday span carries every show with it and nothing is stranded.
  // Only a range that drops a weekday entirely can strand shows - that destroys
  // user data, so it takes a yes, and a no puts the dates back untouched.
  function onWeekDatesChanged() {
    const alku = document.getElementById('viikko-alku').value;
    if (!alku) return;
    const loppu = document.getElementById('viikko-loppu').value || addDays(alku, 6);

    if (!currentSchedule) { renderGrid(); return; }

    const paivat = new Set(Scheduler.getPaivat(alku, loppu));
    const stranded = currentSchedule.naytokset.filter(n => !paivat.has(n.paiva));
    const unchanged = currentSchedule.viikkoAlku === alku && currentSchedule.viikkoLoppu === loppu;
    if (unchanged && stranded.length === 0) return;

    if (stranded.length > 0) {
      const days = [...new Set(stranded.map(n => n.paiva))].join(', ');
      const ok = confirm(
        `Uusi jakso ei sisällä päiviä ${days}, joilla on ${stranded.length} näytöstä.\n\n` +
        'Poistetaanko nämä näytökset?\n(Peruuta palauttaa edelliset päivämäärät.)'
      );
      if (!ok) {
        document.getElementById('viikko-alku').value = currentSchedule.viikkoAlku;
        document.getElementById('viikko-loppu').value = currentSchedule.viikkoLoppu;
        updateWeekLabel(currentSchedule.viikkoAlku, currentSchedule.viikkoLoppu);
        return;
      }
    }

    pushUndo(); // restores both the old dates and any screenings dropped with them
    currentSchedule.naytokset = currentSchedule.naytokset.filter(n => paivat.has(n.paiva));
    currentSchedule.viikkoAlku = alku;
    currentSchedule.viikkoLoppu = loppu;
    Storage.saveSchedule(currentSchedule);
    renderGrid();
    refreshNaytosPreview(); // a longer or shorter week changes what "Luo ohjelma" would produce
  }

  function init() {
    currentSchedule = migrateRoster(Storage.getSchedule());

    document.getElementById('viikko-alku').addEventListener('change', e => {
      const alku = e.target.value;
      const loppu = addDays(alku, 6);
      document.getElementById('viikko-loppu').value = loppu;
      updateWeekLabel(alku, loppu);
      onWeekDatesChanged();
    });
    document.getElementById('viikko-loppu').addEventListener('change', e => {
      const alku = document.getElementById('viikko-alku').value;
      if (alku) updateWeekLabel(alku, e.target.value);
      onWeekDatesChanged();
    });

    document.getElementById('btn-luo-ohjelma').addEventListener('click', luoOhjelma);
    document.getElementById('btn-reset-kaikki-naytos').addEventListener('click', resetAllNaytosTavoitteet);

    // Week movie picker
    document.getElementById('btn-lisaa-viikkoon').addEventListener('click', openPicker);
    document.getElementById('btn-viikko-valinta-peruuta').addEventListener('click', closePicker);
    document.getElementById('btn-viikko-valinta-tallenna').addEventListener('click', commitPicker);
    document.getElementById('viikko-valinta-tbody').addEventListener('change', onPickerTableChange);
    document.getElementById('viikko-valinta-select-all').addEventListener('change', onPickerSelectAll);
    document.getElementById('viikko-valinta-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closePicker();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closePicker();
    });

    document.getElementById('btn-vie-excel').addEventListener('click', () => {
      if (!currentSchedule || currentSchedule.naytokset.length === 0) {
        alert('Ei ohjelmoituja näytöksiä vietäväksi.');
        return;
      }
      Exporter.exportToExcel(currentSchedule);
    });

    const ohjelmaTuonti = document.getElementById('ohjelma-tuonti-tiedosto');
    document.getElementById('btn-tuo-ohjelma').addEventListener('click', () => ohjelmaTuonti.click());
    ohjelmaTuonti.addEventListener('change', () => {
      if (ohjelmaTuonti.files[0]) importOhjelmaFile(ohjelmaTuonti.files[0]);
      ohjelmaTuonti.value = '';
    });

    document.getElementById('btn-tyhjenna-grid').addEventListener('click', tyhjennaGrid);
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Leave native text-field undo alone while the user is typing in one
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      // Only when the schedule editor tab is visible
      if (!document.getElementById('ohjelmointi-panel').classList.contains('active')) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    // Context menu actions
    document.getElementById('ctx-muokkaa').addEventListener('click', contextEdit);
    document.getElementById('ctx-poista').addEventListener('click', contextRemove);
    document.getElementById('ctx-kopioi').addEventListener('click', contextDuplicate);

    // Edit modal
    document.getElementById('btn-edit-tallenna').addEventListener('click', saveEditModal);
    document.getElementById('btn-edit-peruuta').addEventListener('click', () => {
      document.getElementById('edit-modal').classList.remove('open');
    });

    // Edit sali options
    const editSali = document.getElementById('edit-sali');
    ['STUDIO 1','STUDIO 2','STUDIO 3'].forEach(s => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      editSali.appendChild(opt);
    });

    document.getElementById('elokuva-lista').addEventListener('dragover', onRowDragOver);

    const grid = document.getElementById('aikataulu-grid');
    grid.addEventListener('dragover', onGridDragOver);
    grid.addEventListener('drop', onGridDrop);

    initSuuntaToggle();

    buildWeekPanel();
    renderGrid(); // the empty grid is a real, usable drop target - always draw it
  }

  // Orientation toggle lives on this tab (not Settings) so switching it takes
  // effect immediately - it persists the choice and re-renders the grid right
  // away, rather than waiting for the next thing that happens to call
  // renderGrid() (like a drag).
  function initSuuntaToggle() {
    const buttons = document.querySelectorAll('.suunta-btn');
    const markActive = () => {
      const suunta = Storage.getSettings().aikataulu_suunta ?? 'pysty';
      buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.suunta === suunta));
    };
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const settings = Storage.getSettings();
        if (settings.aikataulu_suunta === btn.dataset.suunta) return;
        settings.aikataulu_suunta = btn.dataset.suunta;
        Storage.saveSettings(settings);
        markActive();
        renderGrid();
      });
    });
    markActive();
  }

  return { init, buildWeekPanel, renderGrid };
})();

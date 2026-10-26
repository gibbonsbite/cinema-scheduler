'use strict';

const ScheduleUI = (() => {
  const SALAT = ['STUDIO 1', 'STUDIO 2', 'STUDIO 3'];

  // Calendar-date math lives in scheduler.js, where it is done on UTC days
  // so a daylight-saving change inside the week can't shift or drop a day.
  const addDays = Scheduler.addDays;
  const GRID_START    = 9 * 60;  // 09:00 - matches the earliest default business-hours opening (MA/LA)
  const GRID_END      = 24 * 60; // 24:00
  const PX_PER_MIN    = 1.5;
  const DAY_HEADER_H  = 14;      // px height of day-header label (pysty/vertical)
  const DAY_HEADER_W  = 30;      // px width of day-header label (vaaka/horizontal) - matches CSS
  const ROW_H_VAAKA   = 56;      // px height of one day-row (vaaka/horizontal) - fits the title tab over a large showtime

  let currentSchedule = null;
  let dragState = null;
  let selectedIds = new Set(); // shows picked with a selection box or Ctrl/⌘-click
  let marquee = null;          // the selection box being drawn
  let groupDrag = null;        // several selected shows being moved together
  let contextTarget = null;
  let draggingMovieId = null;
  let rowDragSettings = null; // settings for the current list drag (see onRowDragStart) // movie being dragged from the list, if any (see grid drop target below)
  let gridDropCandidate = null;
  let gridGhostEl = null;
  let eriSaliZonesDrawn = false; // see drawEriSaliZones()

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
    buildPlanPage();
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

  // Manual edits snap to the "Raahauksen tarkkuus" setting (raahaus_tarkkuus,
  // default 5 min) - dragging, making room, filling gaps, moving between
  // theaters. "Täytä ohjelma" keeps quarter hours (Scheduler.populate).
  const snapOf = settings => settings?.raahaus_tarkkuus ?? 5;
  const roundSnap = (min, step) => Math.round(min / step) * step;
  const ceilSnap = (min, step) => Math.ceil(min / step) * step;
  const floorSnap = (min, step) => Math.floor(min / step) * step;

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

  // One color per movie for THIS week, as a Map id -> palette entry, built
  // once per render and shared by the grid blocks and the roster chips (the
  // roster doubles as the legend, so both must agree).
  //
  // Storage.js gives every movie a persisted colorSlot, but only as a
  // preference: the library holds every title ever imported, far more than
  // 16, so slots inevitably repeat across it - and a week whose roster mixes
  // old titles with freshly imported ones used to come out with several
  // movies in the same color. The clash is resolved here, inside the week's
  // roster: walking it in rank order, a movie keeps its own slot unless a
  // higher-ranked movie already took it, in which case it gets the lowest
  // slot still free this week. So colors are unique while the roster has
  // 16 or fewer movies, and a movie's color is stable across regenerations,
  // since only the roster (not the grid) decides it. A screening whose movie
  // is gone from the library falls back to hashing its id.
  function weekColors() {
    const byId = new Map(Library.getAll().map(m => [m.id, m]));
    const naytokset = currentSchedule?.naytokset ?? [];
    const ids = [...new Set([...(currentSchedule?.valitut ?? []), ...naytokset.map(n => n.elokuvaId)])];
    const N = GRID_COLORS.length;
    const taken = new Set();
    const colors = new Map();
    ids.forEach(id => {
      if (id == null) return;
      const movie = byId.get(id);
      let slot;
      if (!movie) {
        const key = String(id);
        let hash = 0;
        for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
        slot = Math.abs(hash) % N;
      } else {
        const own = Number.isInteger(movie.colorSlot) ? Math.abs(movie.colorSlot) % N : 0;
        slot = own;
        if (taken.has(own)) {
          const free = [...Array(N).keys()].find(i => !taken.has(i));
          if (free != null) slot = free;
        }
      }
      taken.add(slot);
      colors.set(id, GRID_COLORS[slot]);
    });
    return colors;
  }

  function movieColor(movieId, colors) {
    if (colors.has(movieId)) return colors.get(movieId);
    // Not on the roster and without screenings - can only happen for a
    // roster row rendered from ids that never made it into `valitut`.
    return GRID_COLORS[0];
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
    if (!schedule) return schedule;
    if (!Array.isArray(schedule.valitut)) {
      const withShows = new Set((schedule.naytokset ?? []).map(n => n.elokuvaId));
      const ranked = (schedule.jarjestys ?? []).filter(id => withShows.has(id));
      const rest = [...withShows].filter(id => !ranked.includes(id));
      schedule.valitut = [...ranked, ...rest];
    }
    // Weeks saved before the plan existed get one read off their own grid,
    // so nothing on the Suunnittelu page starts blank.
    if (!isPlan(schedule.suunnitelma)) schedule.suunnitelma = derivePlan(schedule.valitut, schedule.naytokset ?? []);
    return schedule;
  }

  // ── The week's plan ──────────────────────────────────────────────────────
  // Which movies each theater runs this week, in priority order, and on
  // which days:
  //   suunnitelma = { 'STUDIO 1': [{ id, paivat: ['PE', ...], auto }, ...], ... }
  // Edited on the Suunnittelu page (drag movies into a theater's box, order
  // them, pick days) and by the theater checkboxes under each movie in the
  // Ohjelmointi list. "Täytä ohjelma" turns it into one show per card per
  // checked day. Higher in a theater means higher priority: the evening
  // slot in that room, and - while the card's days are automatic - more
  // days (AUTO_DAYS). It is the input for filling the grid, not a mirror of
  // it: hand edits on the grid don't write back into the plan.
  const ALL_PAIVAT = ['PE', 'LA', 'SU', 'MA', 'TI', 'KE', 'TO'];

  // Days a card gets by its position in the theater while `auto`: the top
  // two titles play every day - in the reference weeks a room's two best
  // titles run 6-8 shows each - and the rest taper off.
  const AUTO_DAYS = [7, 7, 4, 3, 2];
  // A room usually runs 3 shows on Saturday and 2 on other days; partial-
  // week cards fill the room's least-used days first (Saturday, Sunday and
  // Friday first among equals).
  const ROOM_DAY_SLOTS = { LA: 3 };
  const DAY_PREFERENCE = ['LA', 'SU', 'PE', 'MA', 'TI', 'TO', 'KE'];

  const emptyPlan = () => Object.fromEntries(SALAT.map(s => [s, []]));
  const isPlan = p => !!p && typeof p === 'object' && SALAT.every(s => Array.isArray(p[s]));

  // Each theater's movies and days as the grid actually has them - for weeks
  // that predate the plan and for imported weeks. Within a theater, the
  // movie with the most shows there comes first.
  function derivePlan(ids, naytokset) {
    const plan = emptyPlan();
    const roster = ids ?? [];
    SALAT.forEach(sali => {
      const counts = new Map();
      naytokset.filter(n => n.sali === sali && roster.includes(n.elokuvaId))
        .forEach(n => counts.set(n.elokuvaId, (counts.get(n.elokuvaId) ?? 0) + 1));
      plan[sali] = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || roster.indexOf(a[0]) - roster.indexOf(b[0]))
        .map(([id]) => ({ id, auto: false,
          paivat: ALL_PAIVAT.filter(p => naytokset.some(n => n.sali === sali && n.elokuvaId === id && n.paiva === p)) }));
    });
    return plan;
  }

  function weekPaivat() {
    const alku = currentSchedule?.viikkoAlku ?? (document.getElementById('viikko-alku').value || nextFriday());
    return Scheduler.getPaivat(alku, currentSchedule?.viikkoLoppu ?? addDays(alku, 6));
  }

  // The plan, made valid: every theater has a list, only movies still on
  // the roster are in it, and automatic cards carry the days their position
  // gives them for this week's dates.
  function getPlan() {
    ensureSchedule();
    if (!isPlan(currentSchedule.suunnitelma)) currentSchedule.suunnitelma = derivePlan(currentSchedule.valitut, currentSchedule.naytokset);
    const onRoster = new Set(currentSchedule.valitut ?? []);
    SALAT.forEach(s => { currentSchedule.suunnitelma[s] = currentSchedule.suunnitelma[s].filter(c => onRoster.has(c.id)); });
    applyAutoDays(currentSchedule.suunnitelma);
    return currentSchedule.suunnitelma;
  }

  // Recomputes the days of every automatic card, top of each theater down.
  function applyAutoDays(plan) {
    const paivat = weekPaivat();
    SALAT.forEach(sali => {
      const load = Object.fromEntries(paivat.map(p => [p, 0]));
      const fill = p => load[p] / (ROOM_DAY_SLOTS[p] ?? 2);
      plan[sali].forEach((card, i) => {
        if (card.auto) {
          const want = Math.min(paivat.length, AUTO_DAYS[i] ?? AUTO_DAYS[AUTO_DAYS.length - 1]);
          const chosen = [...paivat].sort((a, b) => fill(a) - fill(b) || DAY_PREFERENCE.indexOf(a) - DAY_PREFERENCE.indexOf(b)).slice(0, want);
          card.paivat = ALL_PAIVAT.filter(p => chosen.includes(p));
        }
        card.paivat.forEach(p => { if (p in load) load[p]++; });
      });
    });
  }

  // Every change to the plan goes through here: one undo step, automatic
  // days refreshed, saved.
  function editPlan(change) {
    pushUndo();
    const plan = getPlan();
    change(plan);
    applyAutoDays(plan);
    Storage.saveSchedule(currentSchedule);
  }

  // Puts a movie into a theater at `index` - its position counted without
  // its own card, the end when omitted - or moves it there if it is already
  // in that theater; `fromSali` takes it out of another theater at the same
  // time (a drag between boxes).
  function placeInTheater(plan, id, sali, index, fromSali) {
    let card = null;
    if (fromSali && fromSali !== sali) {
      const at = plan[fromSali].findIndex(c => c.id === id);
      if (at !== -1) [card] = plan[fromSali].splice(at, 1);
    }
    const existing = plan[sali].findIndex(c => c.id === id);
    if (existing !== -1) [card] = plan[sali].splice(existing, 1);
    card = card ?? { id, paivat: [], auto: true };
    plan[sali].splice(index ?? plan[sali].length, 0, card);
  }

  function removeFromTheater(plan, id, sali) {
    plan[sali] = plan[sali].filter(c => c.id !== id);
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
      suunnitelma: emptyPlan(),
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
    if (isPlan(currentSchedule.suunnitelma)) SALAT.forEach(s => removeFromTheater(currentSchedule.suunnitelma, id, s));
    Storage.saveSchedule(currentSchedule);
    buildWeekPanel();
    buildPlanPage();
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
        if (isPlan(currentSchedule.suunnitelma)) SALAT.forEach(s => removeFromTheater(currentSchedule.suunnitelma, id, s));
      });
      Storage.saveSchedule(currentSchedule);
    }

    closePicker();
    buildWeekPanel();
    renderGrid();
    buildPlanPage();
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
      return;
    }

    // The title chip carries the movie's grid color for this week, so the
    // ranking list reads as a legend for the schedule blocks; the kids marker
    // is the same 👶 the grid blocks use (the old separate "Lapset" badge is
    // gone).
    const colors = weekColors();
    const plan = getPlan();

    roster.forEach(m => {
      const div = document.createElement('div');
      div.className = 'elokuva-rivi';
      div.draggable = true;
      div.dataset.id = m.id;

      // The whole row wears the movie's grid color, so the list reads as a
      // legend for the schedule blocks. Below the title: which theaters the
      // movie is in this week (set on the Suunnittelu page) - indicators
      // only, not controls.
      const color = movieColor(m.id, colors);
      div.style.setProperty('--blk-bg', color.bg);
      div.style.setProperty('--blk-fg', color.text);
      const lastenMarker = m.lastenelokuva ? '<span title="Lastenelokuva">👶 </span>' : '';
      const salit = SALAT.filter(sali => plan[sali].some(c => c.id === m.id));
      div.innerHTML = `
        <div class="elokuva-rivi-main">
          <span class="drag-handle" title="Raahaa järjestääksesi tai ruudukkoon lisätäksesi">⠿</span>
          <strong title="${escHtml(m.nimi)}">${lastenMarker}${escHtml(m.nimi)}</strong>
          ${ikarajaBadge(m.ikäraja)}
        </div>
        <div class="elokuva-rivi-controls">
          <span class="sali-otsikko">Sali:</span>
          ${salit.length ? salit.map(saliBadge).join('')
                         : '<span class="sali-merkki ei-salia" title="Lisää elokuva saliin Suunnittelu-sivulla">ei salia</span>'}
          <button type="button" class="btn-icon btn-danger btn-poista-viikosta" data-id="${m.id}"
                  title="Poista elokuva tältä viikolta">🗑️</button>
        </div>
      `;
      div.addEventListener('dragstart', onRowDragStart);
      div.addEventListener('dragend', onRowDragEnd);
      list.appendChild(div);
    });

    list.querySelectorAll('.btn-poista-viikosta').forEach(btn => btn.addEventListener('click', () => removeFromWeek(btn.dataset.id)));
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
    rowDragSettings = Storage.getSettings(); // read once, not on every dragover
  }

  function onRowDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    draggingMovieId = null;
    clearGridDropPreview();
    clearEriSaliZones();

    // The list order is just the user's own arrangement - priority lives in
    // the theater boxes on the Suunnittelu page - but it is kept with the
    // week. A drag that ends where it started doesn't burn a history slot.
    const ids = rosterIdsFromDom();
    if (currentSchedule && !sameOrder(ids, currentSchedule.valitut ?? [])) {
      pushUndo();
      currentSchedule.valitut = ids;
      Storage.saveSchedule(currentSchedule);
      buildPlanPage(); // the bucket follows the same order
    }
  }

  // Reorders the list live while a row is dragged over it: the row lands
  // above the first row whose midpoint is below the cursor.
  function onRowDragOver(e) {
    e.preventDefault();
    const list = e.currentTarget;
    const dragging = list.querySelector('.elokuva-rivi.dragging');
    if (!dragging) return;
    const afterRow = [...list.querySelectorAll('.elokuva-rivi:not(.dragging)')].reduce((closest, row) => {
      const box = row.getBoundingClientRect();
      const offset = e.clientY - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, row };
      return closest;
    }, { offset: -Infinity, row: null }).row;
    if (afterRow) list.insertBefore(dragging, afterRow);
    else list.appendChild(dragging);
  }


  // Today is the one place the local clock matters: "today" is the user's own
  // calendar day (toISOString would give yesterday's date between midnight and
  // 2-3 am Finnish time), and everything after that is calendar-date math.
  function nextFriday() {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const diff = (5 - now.getDay() + 7) % 7 || 7; // getDay: 0=Sun, 5=Fri
    return addDays(today, diff);
  }

  function updateWeekLabel(isoAlku, isoLoppu) {
    const label = iso => `${Scheduler.weekdayOf(iso)} ${Scheduler.isoToFin(iso)}`;
    document.getElementById('viikko-label').textContent = `OHJELMISTO: ${label(isoAlku)} – ${label(isoLoppu)}`;
  }

  // Wipes the grid back to a blank week without touching the roster - the
  // starting point for building a program by hand. The plan survives too: it
  // belongs to the roster, not to the grid.
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

    // The plan is read off the imported week itself: each movie's theaters
    // and days as the file has them.
    const suunnitelma = derivePlan(valitut, naytokset);

    const alku = viikkoAlku ?? document.getElementById('viikko-alku').value ?? nextFriday();
    const loppu = viikkoLoppu ?? addDays(alku, 6);
    document.getElementById('viikko-alku').value = alku;
    document.getElementById('viikko-loppu').value = loppu;
    updateWeekLabel(alku, loppu);

    pushUndo();
    currentSchedule = { viikkoAlku: alku, viikkoLoppu: loppu, naytokset, valitut, suunnitelma };
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
      ${selectedIds.size ? `<span class="stat-valinta">${selectedIds.size} valittu · Esc poistaa valinnan</span>` : ''}
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
        ? 'Ei näytöksiä. Lisää elokuvia viikkoon ja täytä ohjelma Suunnittelu-sivulla, tai raahaa ne ruudukkoon.'
        : 'Ei näytöksiä. Täytä ohjelma Suunnittelu-sivulla, tai raahaa elokuvia listasta ruudukkoon.';
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
  // Which theater the vertical view shows - a per-browser preference, so it
  // lives in localStorage (and survives being unavailable there).
  const PYSTY_SALI_KEY = 'cs_pysty_sali';
  function pystySali() {
    let v = null;
    try { v = localStorage.getItem(PYSTY_SALI_KEY); } catch { /* storage blocked */ }
    return v === 'KAIKKI' || SALAT.includes(v) ? v : SALAT[0];
  }

  // Tabs above the vertical grid: each theater with its week's show count,
  // and "Kaikki salit" for the side-by-side view. Hidden in the horizontal
  // view, which always stacks all three.
  function renderSaliTabs(horizontal, naytokset) {
    const el = document.getElementById('sali-tabit');
    if (!el) return;
    el.hidden = horizontal;
    if (horizontal) return;
    const current = pystySali();
    el.innerHTML = [...SALAT, 'KAIKKI'].map(v => {
      const label = v === 'KAIKKI' ? 'Kaikki salit' : v.replace('STUDIO ', 'Studio ');
      const n = v === 'KAIKKI' ? naytokset.length : naytokset.filter(x => x.sali === v).length;
      return `<button type="button" class="sali-tab${v === current ? ' active' : ''}" data-sali="${v}"${v === 'KAIKKI' ? '' : ` data-nro="${saliNumero(v)}"`}>${label} <span class="sali-tab-n">${n}</span></button>`;
    }).join('');
    el.querySelectorAll('.sali-tab').forEach(btn => btn.addEventListener('click', () => {
      try { localStorage.setItem(PYSTY_SALI_KEY, btn.dataset.sali); } catch { /* storage blocked */ }
      renderGrid();
    }));
  }

  // Whether a tab's page is on screen. Pages that aren't are not rebuilt -
  // switching to a tab rebuilds it (index.html), so a hidden rebuild was
  // pure cost (undo, for one, rebuilt all three).
  const panelActive = id => document.getElementById(id)?.classList.contains('active');

  function renderGrid() {
    if (!panelActive('ohjelmointi-panel') && !dragState) return;
    const ids = new Set((currentSchedule?.naytokset ?? []).map(n => n.id));
    selectedIds = new Set([...selectedIds].filter(id => ids.has(id)));
    renderNaytosStats();
    renderViikkoAukiolo();
    const container = document.getElementById('aikataulu-grid');
    container.innerHTML = '';
    eriSaliZonesDrawn = false;

    const naytokset = currentSchedule?.naytokset ?? [];
    const settings = Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';
    container.classList.toggle('suunta-vaaka', horizontal);
    container.classList.toggle('grid-tyhja', naytokset.length === 0);
    const colors = weekColors();

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

    // Vertical view: one theater at a time (or all of them) - the seven day
    // columns of a single theater then fill the whole width.
    renderSaliTabs(horizontal, naytokset);
    const shownSalat = horizontal || pystySali() === 'KAIKKI' ? SALAT : [pystySali()];
    container.classList.toggle('yksi-sali', !horizontal && shownSalat.length === 1);
    // All three theaters side by side leave each day column too narrow for a
    // title or a time written across, so there they run down the block.
    const sideways = !horizontal && shownSalat.length > 1;
    container.classList.toggle('kaikki-pysty', sideways);

    shownSalat.forEach(sali => {
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

        // Hour lines are the cell's own background (see .day-col in the CSS),
        // offset past the day header - 14 elements per cell, ~300 per grid,
        // were most of a rebuild's style and layout work.
        dayCol.style.setProperty('--hour-offset', headerOffset + 'px');

        screenings.forEach(n => {
          // A show being dragged is drawn only by its ghost (which lives
          // outside the grid and survives this rebuild - see onBlockMouseDown).
          if (dragState && n.id === dragState.id) return;
          const block = buildBlock(n, horizontal, headerOffset, colors);
          block.classList.toggle('pysty-teksti', sideways);
          if (selectedIds.has(n.id)) block.classList.add('selected');
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
  // for bands spanning the full cross dimension).
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

  // A theater as a numbered badge in that theater's own color (--sali-1..3 in
  // the CSS) - the same colors mark the theater tabs and planning boxes.
  const saliNumero = sali => sali.replace('STUDIO ', '');
  const saliBadge = sali => `<span class="sali-badge" data-sali="${saliNumero(sali)}" title="${sali.replace('STUDIO ', 'Studio ')}">${saliNumero(sali)}</span>`;

  // The Finnish age rating as a small badge in the rating's own color (S
  // green, 7 yellow, 12 orange, 16 red, 18 black - the colors of the
  // official symbols).
  function ikarajaBadge(ika) {
    const v = String(ika ?? '').trim().toUpperCase();
    if (!v) return '';
    const key = v === 'S' ? 'S' : (v.match(/\d+/)?.[0] ?? '');
    return `<span class="ikaraja-badge" data-ika="${escHtml(key)}" title="Ikäraja ${escHtml(v)}">${escHtml(v)}</span>`;
  }

  // A show block is drawn like a file folder: the title on a tab at the top
  // left, the showtime large on the body below it. Both parts take the
  // movie's color from --blk-bg / --blk-fg set on the block.
  function blockInner(nimi, aika, isLasten) {
    const lasten = isLasten ? '<span class="block-lasten" title="Lastenelokuva">👶</span>' : '';
    return `<div class="block-tab">${lasten}<span class="block-nimi">${escHtml(nimi)}</span></div>` +
      `<div class="block-body"><span class="block-time">${aika}</span></div>`;
  }

  function buildBlock(n, horizontal, headerOffset, colors) {
    const startMin = toMin(n.alkaa);
    const offset = headerOffset + (startMin - GRID_START) * PX_PER_MIN;
    const sizeAlong = Math.max(n.kesto * PX_PER_MIN, horizontal ? 40 : 20);

    const color = movieColor(n.elokuvaId, colors);
    const block = document.createElement('div');
    block.className = 'naytokset-block';
    positionBox(block, horizontal, offset, sizeAlong + 'px', '2px', '2px');
    block.style.setProperty('--blk-bg', color.bg);
    block.style.setProperty('--blk-fg', color.text);
    block.dataset.id = n.id;
    // The length isn't printed on the block any more; it stays in the tooltip.
    block.title = `${n.nimi}\n${n.alkaa}–${n.loppuu}\n${n.kesto} min`;

    const isLasten = n.lastenelokuva === true || n.kategoria === 'lastenelokuva';
    block.innerHTML = blockInner(n.nimi, n.alkaa.replace(':', '.'), isLasten);

    block.addEventListener('mousedown', onBlockMouseDown);
    block.addEventListener('contextmenu', onContextMenu);
    return block;
  }

  // ── Cross-theater no-start bands ──────────────────────────────────────────

  // Shown only while something is being dragged. In every room-day cell, a
  // striped band marks the times at which a show may NOT start because a show
  // in another room starts within minimivali_eri_sali of it - the dragged
  // block's leading edge landing inside a band is what turns it red
  // (Scheduler.validateScreening). It's the start that's constrained, not the
  // whole block, which is why the band is drawn around the other show's start
  // and not its span. Bands that overlap are merged so the stripes stay even.
  // `excludeId` is the show being moved: its own old start must not fence
  // off the other rooms. Nothing is drawn when the setting is 0 (the default).
  function drawEriSaliZones(excludeId) {
    clearEriSaliZones();
    if (!currentSchedule) return;
    const settings = Storage.getSettings();
    const gap = settings.minimivali_eri_sali ?? 0;
    if (gap <= 0) return;
    const step = snapOf(settings);
    const horizontal = settings.aikataulu_suunta === 'vaaka';
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;

    document.querySelectorAll('#aikataulu-grid .day-col').forEach(cell => {
      const { sali, paiva } = cell.dataset;
      const bands = currentSchedule.naytokset
        .filter(n => n.id !== excludeId && n.paiva === paiva && n.sali !== sali)
        .map(n => {
          // Starts snap to the drag step, and each one is drawn as the slot it
          // opens. The blocked starts are strictly less than `gap` away (a
          // start exactly `gap` off is allowed), so the band runs from the
          // first blocked slot to the end of the last one. Drawn as plain
          // s±gap, it reached a whole slot too early on the left.
          const s = toMin(n.alkaa);
          const firstBlocked = floorSnap(s - gap, step) + step;
          const lastBlocked = ceilSnap(s + gap, step) - step;
          return [Math.max(GRID_START, firstBlocked), Math.min(GRID_END, lastBlocked + step)];
        })
        .sort((a, b) => a[0] - b[0])
        .reduce((merged, [from, to]) => {
          const last = merged[merged.length - 1];
          if (last && from <= last[1]) last[1] = Math.max(last[1], to);
          else merged.push([from, to]);
          return merged;
        }, []);

      bands.forEach(([from, to]) => {
        const zone = document.createElement('div');
        zone.className = 'eri-sali-zone';
        positionBox(zone, horizontal, headerOffset + (from - GRID_START) * PX_PER_MIN, ((to - from) * PX_PER_MIN) + 'px', '0', '0');
        // Under every block (z-index), so nothing loses legibility.
        cell.appendChild(zone);
      });
    });
    eriSaliZonesDrawn = true;
  }

  function clearEriSaliZones() {
    document.querySelectorAll('#aikataulu-grid .eri-sali-zone').forEach(z => z.remove());
    eriSaliZonesDrawn = false;
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  // Dragging is custom (mousedown/mousemove/mouseup) rather than native HTML5
  // drag-and-drop, because native DnD gives the browser control of the drag
  // image - there's no way to move the real block in real time or update its
  // displayed start time as the cursor moves. Instead we clone the block into
  // a `position:fixed` overlay that follows the cursor, snapped to the same
  // 15-min/theater grid it would actually land on, and re-run
  // Scheduler.validateScreening() on every move so the clone visibly flags
  // (red) any position that would overlap another show's buffer or start too
  // close to another room's show (the striped bands, drawEriSaliZones). Only
  // a currently-valid position can be dropped; anything else reverts.
  function onBlockMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();

    const block = e.currentTarget;
    const id = block.dataset.id;
    const n = currentSchedule.naytokset.find(x => x.id === id);
    if (!n) return;

    // Ctrl/⌘/Shift-click adds the show to the selection or takes it out.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
      block.classList.toggle('selected', selectedIds.has(id));
      renderNaytosStats();
      return;
    }
    // Grabbing one of several selected shows moves them all.
    if (selectedIds.has(id) && selectedIds.size > 1) { startGroupDrag(e, block); return; }
    if (selectedIds.size) setSelection(new Set());

    const settings = Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';

    // Drag the real block/buffer elements directly (switching to
    // position:fixed) rather than cloning them - renderGrid() always rebuilds
    // the whole grid on mouseup regardless of outcome, so there's nothing to
    // restore afterward either way, and this avoids the two failure modes a
    // clone has: it starts unpositioned until the first mousemove (a visible
    // flash), and hiding "the original" is a separate element to track.
    // Both are moved onto <body> for the drag, so the grid can be rebuilt
    // under them - hovering a theater tab switches the vertical view to that
    // theater mid-drag (onPointerMove) - and removed again on drop.
    const rect = block.getBoundingClientRect();
    block.classList.add('live-dragging');
    block.style.position = 'fixed';
    block.style.pointerEvents = 'none';
    setFixedBox(block, rect.left, rect.top, rect.width, rect.height);
    document.body.appendChild(block);

    const buf = document.querySelector(`.buffer-zone[data-id="${id}"]`);
    if (buf) {
      const bufRect = buf.getBoundingClientRect();
      buf.style.position = 'fixed';
      buf.style.pointerEvents = 'none';
      setFixedBox(buf, bufRect.left, bufRect.top, bufRect.width, bufRect.height);
      document.body.appendChild(buf);
    }

    drawEriSaliZones(id);

    dragState = {
      id,
      kesto: n.kesto,
      horizontal,
      settings,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
      ghostW: rect.width,
      ghostH: rect.height,
      block,
      buf,
      lastCandidate: null,
    };

    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp);
  }

  // The latest snap step a show of this length can start on and still end
  // by the grid's end. Floored to the grid: clamping to the raw GRID_END - kesto
  // put a 121-minute film dragged to the far right at 21.59, and the search
  // for a free slot then stepped through 21.44, 21.29... - off-grid times that
  // sit within the cross-room gap of nearly every other start, so late-evening
  // drops landed hours away or were refused outright.
  const latestStart = (kesto, step = 15) => floorSnap(GRID_END - kesto, step);

  // Nearest start time in the target room+day where the show actually fits,
  // searching outward from where the cursor put it in snap steps. Later is
  // tried before earlier at equal distance: dropping onto the tail of another
  // show reads as "put it after that one". Returns the wanted start unchanged
  // when it already fits, or null when the whole room-day has no room for it.
  //
  // Everything that constrains a screening (Scheduler.validateScreening) is
  // about the same day, so this never has to look outside the cell being
  // dropped into - other rooms only matter for the start-spacing rule, and
  // that too is a question about this cell's day.
  function nearestFreeStart(base, wantedStart, kesto, settings) {
    const existing = currentSchedule?.naytokset ?? [];
    const step = snapOf(settings);
    const maxStart = latestStart(kesto, step);
    if (maxStart < GRID_START) return null;

    const wanted = Math.max(GRID_START, Math.min(wantedStart, maxStart));
    const fits = s => Scheduler.validateScreening(
      { ...base, kesto, alkaa: toHHMM(s), loppuu: toHHMM(s + kesto) },
      existing, settings
    ).length === 0;

    if (fits(wanted)) return wanted;
    for (let delta = step; delta <= maxStart - GRID_START; delta += step) {
      const later = wanted + delta;
      if (later <= maxStart && fits(later)) return later;
      const earlier = wanted - delta;
      if (earlier >= GRID_START && fits(earlier)) return earlier;
    }
    return null;
  }

  // ── Making room ──────────────────────────────────────────────────────────
  // A show dropped onto a spot that its own room's neighbours crowd keeps that
  // spot; the neighbours make way instead. Each show in the way moves away
  // from the dropped one - the shows in `afterIds` (by default: those whose
  // midpoint is after the dropped show's) later, the rest earlier - just far
  // enough to leave the room buffer, and the moves cascade down (or up) the
  // room's day only as far as they have to: the first neighbour that already
  // clears stops the cascade. A moved show also steps clear of other rooms'
  // starts (minimivali_eri_sali).
  //
  // `shifted` (id -> start) gives shows a new place before any making room -
  // the gap fill in dropCandidate - and those count as moves too.
  //
  // Returns the moves ([] when nothing is in the way), or null when room
  // can't be made - a show would have to run past 24:00 or start before
  // 09:00, or the spot itself sits too close to another room's start, which
  // moving this room's shows can't fix. The caller then falls back to the
  // nearest free slot.
  function makeRoomPlan(base, start, kesto, settings, afterIds, shifted = new Map()) {
    const gapSama = settings.minimivali_sama_sali;
    const gapEri = settings.minimivali_eri_sali ?? 0;
    const day = (currentSchedule?.naytokset ?? []).filter(x => x.id !== base.id && x.paiva === base.paiva);
    const step = snapOf(settings);
    const otherStarts = day.filter(x => x.sali !== base.sali).map(x => toMin(x.alkaa));
    const crossClash = s => gapEri > 0 && otherStarts.some(o => Math.abs(o - s) < gapEri);
    if (crossClash(start)) return null;

    const room = day.filter(x => x.sali === base.sali);
    const at = x => shifted.get(x.id) ?? toMin(x.alkaa);
    const mid = start + kesto / 2;
    const isAfter = afterIds ? (x => afterIds.has(x.id)) : (x => at(x) + x.kesto / 2 >= mid);
    const moves = [];
    // A show that keeps its place ends the cascade - unless a shifted show
    // still follows, which must be recorded as moved.
    const settled = (x, list, i, to) => to === toMin(x.alkaa) && !list.slice(i + 1).some(y => shifted.has(y.id));

    let edge = start + kesto;
    const later = room.filter(isAfter).sort((a, b) => at(a) - at(b));
    for (let i = 0; i < later.length; i++) {
      const x = later[i], from = toMin(x.alkaa);
      let to = Math.max(at(x), ceilSnap(edge + gapSama, step));
      if (to !== at(x)) while (crossClash(to)) to += step;
      if (settled(x, later, i, to)) break;
      if (to + x.kesto > GRID_END) return null;
      if (to !== from) moves.push({ n: x, from, to });
      edge = to + x.kesto;
    }
    edge = start;
    const earlier = room.filter(y => !isAfter(y)).sort((a, b) => at(b) - at(a));
    for (let i = 0; i < earlier.length; i++) {
      const x = earlier[i], from = toMin(x.alkaa);
      let to = Math.min(at(x), floorSnap(edge - gapSama - x.kesto, step));
      if (to !== at(x)) while (crossClash(to)) to -= step;
      if (settled(x, earlier, i, to)) break;
      if (to < GRID_START) return null;
      if (to !== from) moves.push({ n: x, from, to });
      edge = to;
    }

    // Safety net: the day as it would be must pass the same check a drag does.
    const moved = new Map(moves.map(m => [m.n.id, m.to]));
    const after = (currentSchedule?.naytokset ?? []).filter(x => x.id !== base.id).map(x => moved.has(x.id)
      ? { ...x, alkaa: toHHMM(moved.get(x.id)), loppuu: toHHMM(moved.get(x.id) + x.kesto) } : x);
    const check = [{ ...base, kesto, alkaa: toHHMM(start), loppuu: toHHMM(start + kesto) },
      ...after.filter(x => moved.has(x.id))];
    if (check.some(x => Scheduler.validateScreening(x, [...after, check[0]], settings).length)) return null;
    return moves.sort((a, b) => a.from - b.from);
  }

  // Where the drop goes and what it does, for both a moved block and a show
  // dragged in from the list. Everything is read off the dragged block - the
  // thing the user is watching - not off the cursor, which can sit anywhere
  // inside it.
  //
  // Order: the block goes between the room's two shows whose midpoints
  // bracket its own midpoint, so dragging it past the middle of a show puts
  // it on that show's other side.
  //
  // Time: where the block is, as long as that clears both neighbours by the
  // room buffer. A block pushed into the show before it sits right after that
  // show; one pushed into the show after it sits right before it. Only when
  // the gap between the two is too small do the neighbours make way: the
  // shows after it move later (or, if they can't - past midnight - the ones
  // before it move earlier). Failing all that, the nearest free slot (red,
  // with reasons) or nothing at all.
  //
  // Gap fill: a show moved within its own room-day past one or more of its
  // neighbours leaves a hole where it was. The shows it passed over slide
  // into that hole as a group (spacing kept): moving it right, they move
  // earlier so the first starts where it used to start; moving it left, they
  // move later so the last ends where it used to end. When that can't be
  // done (another room's start in the way), the move goes ahead without it.
  // Dropped overlapping the space the passed-over shows used to take up, the
  // moved show snaps right against them (just the cleanup buffer
  // between), so dragging one show across another is a clean swap: the
  // passed-over show's tail lands on the moved show's start, or the moved
  // show takes their old start. Dropped beyond that space, it stays put.
  function dropCandidate(base, wanted, kesto, settings) {
    const where = { sali: base.sali, paiva: base.paiva, wanted, pointedAt: wanted };
    const gapSama = settings.minimivali_sama_sali;
    const step = snapOf(settings);
    const room = (currentSchedule?.naytokset ?? [])
      .filter(x => x.id !== base.id && x.paiva === base.paiva && x.sali === base.sali)
      .sort((a, b) => toMin(a.alkaa) - toMin(b.alkaa));
    const mid = wanted + kesto / 2;
    let idx = room.findIndex(x => toMin(x.alkaa) + x.kesto / 2 > mid);
    if (idx === -1) idx = room.length;
    const afterIds = new Set(room.slice(idx).map(x => x.id));
    const maxStart = latestStart(kesto, step);

    const fills = [];
    const orig = (currentSchedule?.naytokset ?? []).find(x => x.id === base.id);
    if (orig && orig.sali === base.sali && orig.paiva === base.paiva) {
      const os = toMin(orig.alkaa), oe = os + orig.kesto;
      const origIdx = room.filter(x => toMin(x.alkaa) < os).length;
      const shifted = new Map();
      let dir = null, gStart = 0, gEnd = 0;
      if (idx > origIdx) {
        const group = room.slice(origIdx, idx);
        const delta = toMin(group[0].alkaa) - os;
        if (delta > 0) group.forEach(x => shifted.set(x.id, toMin(x.alkaa) - delta));
        dir = 'right';
        gEnd = Math.max(...group.map(x => toMin(x.alkaa) + x.kesto));
      } else if (idx < origIdx) {
        const group = room.slice(idx, origIdx);
        const last = group[group.length - 1];
        const delta = floorSnap(oe - (toMin(last.alkaa) + last.kesto), step);
        if (delta > 0) group.forEach(x => shifted.set(x.id, toMin(x.alkaa) + delta));
        dir = 'left';
        gStart = toMin(group[0].alkaa);
      }
      if (shifted.size) fills.push({ shifted, dir, gStart, gEnd });
    }
    fills.push({ shifted: new Map() });

    for (const { shifted, dir, gStart, gEnd } of fills) {
      const at = x => shifted.get(x.id) ?? toMin(x.alkaa);
      const prev = room[idx - 1], next = room[idx];
      // Right after the previous show / right before the next one.
      const lo = prev ? ceilSnap(at(prev) + prev.kesto + gapSama, step) : GRID_START;
      const hi = next ? floorSnap(at(next) - gapSama - kesto, step) : maxStart;
      let start = Math.max(GRID_START, Math.min(maxStart, Math.max(lo, Math.min(wanted, hi))));
      // The swap magnet (see above)
      if (dir === 'right' && wanted < gEnd) start = Math.max(GRID_START, Math.min(maxStart, lo));
      if (dir === 'left' && wanted + kesto > gStart) start = Math.max(GRID_START, Math.min(maxStart, Math.max(lo, hi)));

      // Where the block sits clear of its neighbours, it stays exactly there -
      // a spot too close to another room's start is refused (red), as the
      // no-start bands show. Only a start that had to snap against a
      // neighbour may step along (up to half an hour) to clear another
      // room's start.
      const offsets = [0];
      for (let d = step; d <= 30; d += step) offsets.push(d, -d);
      const tries = start === wanted ? [start]
        : [...new Set([...offsets.map(d => start + d), hi, lo])].filter(t => t >= GRID_START && t <= maxStart);
      for (const t of tries) {
        const moves = makeRoomPlan(base, t, kesto, settings, afterIds, shifted);
        if (moves) return { ...where, wanted: t, start: t, valid: true, snapped: false, moves };
      }
    }

    const fitted = nearestFreeStart(base, wanted, kesto, settings);
    const candidate = { ...where, start: fitted ?? wanted, valid: fitted != null, snapped: (fitted ?? wanted) !== wanted, moves: [] };
    candidate.reasons = refusalReasons(base, wanted, kesto, settings);
    return candidate;
  }

  // Live preview of a plan: the neighbours that would make way are drawn at
  // their new times while the cursor is there, and slide back when it moves
  // on. Only the DOM moves - renderGrid() rebuilds everything on drop.
  const previewed = new Map(); // show id -> its kesto and original start
  let previewKey = '';
  function previewMoves(moves, horizontal) {
    const key = (moves ?? []).map(m => m.n.id + ':' + m.to).join(',');
    if (key === previewKey && (key !== '' || previewed.size === 0)) return;
    previewKey = key;
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
    const grid = document.getElementById('aikataulu-grid');
    const place = (id, startMin, kesto) => {
      const block = grid.querySelector(`.naytokset-block[data-id="${id}"]:not(.live-dragging)`);
      const buf = grid.querySelector(`.buffer-zone[data-id="${id}"]`);
      const off = headerOffset + (startMin - GRID_START) * PX_PER_MIN;
      const prop = horizontal ? 'left' : 'top';
      if (block) {
        block.style[prop] = off + 'px';
        const time = block.querySelector('.block-time');
        if (time) time.textContent = dot(startMin);
      }
      if (buf && !buf.style.position) buf.style[prop] = (off + kesto * PX_PER_MIN) + 'px';
      return block;
    };
    const next = new Map((moves ?? []).map(m => [m.n.id, m]));
    previewed.forEach((p, id) => {
      if (next.has(id)) return;
      place(id, p.from, p.kesto)?.classList.remove('making-room');
      previewed.delete(id);
    });
    next.forEach((m, id) => {
      if (!previewed.has(id)) previewed.set(id, { from: m.from, kesto: m.n.kesto });
      place(id, m.to, m.n.kesto)?.classList.add('making-room');
    });
  }

  // "RESIDENT EVIL 16.15 → 16.30" per moved show
  const moveLines = moves => moves.map(m => `${m.n.nimi} ${dot(m.from)} → ${dot(m.to)}`);

  // Applies a plan's moves to the schedule (opening hours stretch to fit, as
  // for a drag) and says what moved.
  function applyMoves(candidate, verb) {
    if (!candidate.moves?.length) return;
    candidate.moves.forEach(m => {
      const n = currentSchedule.naytokset.find(x => x.id === m.n.id);
      if (!n) return;
      n.alkaa = toHHMM(m.to);
      n.loppuu = toHHMM(m.to + n.kesto);
      extendOpeningHours(n.paiva, m.to, m.to + n.kesto);
    });
    showWarning(`Näytös ${verb} kohtaan ${dot(candidate.start)}. Samassa salissa siirtyivät myös:\n` +
      moveLines(candidate.moves).join('\n'), 'ℹ️');
  }

  // ── Saying why a spot was refused ────────────────────────────────────────
  // Every show in the way of `wanted`, as the clauses validateScreening writes.
  function refusalReasons(base, wanted, kesto, settings) {
    return Scheduler.validateScreening(
      { ...base, kesto, alkaa: toHHMM(wanted), loppuu: toHHMM(wanted + kesto) },
      currentSchedule?.naytokset ?? [], settings);
  }

  const dot = min => toHHMM(min).replace(':', '.');

  // "Ei mahtunut kohtaan 14.30: samassa salissa X alkaa 16.15 – väliin jäisi
  // 18 min, tarvitaan 30 min." The first show in the way is spelled out; any
  // others are counted.
  function refusalText(candidate) {
    const [first, ...rest] = candidate.reasons ?? [];
    if (!first) return `Ei mahtunut kohtaan ${dot(candidate.wanted)}.`;
    const more = rest.length ? ` (tiellä myös ${rest.length} ${rest.length === 1 ? 'muu näytös' : 'muuta näytöstä'})` : '';
    return `Ei mahtunut kohtaan ${dot(candidate.wanted)}: ${first}${more}.`;
  }

  // After a drop that could not stay where it was put: what was in the way,
  // then what happened to the show instead. `verb` is "siirrettiin" for a
  // moved show and "lisättiin" for one dragged in from the list.
  function snappedNotice(candidate, verb = 'siirrettiin') {
    showWarning(`${refusalText(candidate)}\nNäytös ${verb} lähimpään vapaaseen kohtaan: ${dot(candidate.start)}.`);
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
    const { horizontal, block, buf, grabOffsetX, grabOffsetY, ghostW, ghostH, kesto, settings, id } = dragState;
    const bufferMin = settings.minimivali_sama_sali;

    const floatLeft = e.clientX - grabOffsetX;
    const floatTop = e.clientY - grabOffsetY;

    // Every layout read happens here, before anything on the page is
    // touched: hit-testing and measuring after moving the ghost forced the
    // browser to lay the page out again on every mouse move (it was most of
    // a drag's cost). The cell is the one under the cursor; the time is read
    // from the ghost's leading edge, which is where its start is drawn.
    // pointer-events:none on the ghost (set at drag start) keeps
    // elementFromPoint from hitting it.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const dayCol = under && under.closest('#aikataulu-grid .day-col');
    const dayColRect = dayCol ? dayCol.getBoundingClientRect() : null;

    // The dragged block is a ghost that follows the cursor exactly, wherever
    // the show will actually land - that spot gets its own placeholder in the
    // grid (showLandingMarker). Its buffer zone rides along behind it.
    setFixedBox(block, floatLeft, floatTop, ghostW, ghostH);
    if (buf) {
      if (horizontal) setFixedBox(buf, floatLeft + kesto * PX_PER_MIN, floatTop, bufferMin * PX_PER_MIN, ghostH);
      else setFixedBox(buf, floatLeft, floatTop + kesto * PX_PER_MIN, ghostW, bufferMin * PX_PER_MIN);
    }
    onDragOverTab(under && under.closest('.sali-tab'));

    let candidate = null;
    if (dayCol) {
      const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
      const relPos = horizontal ? floatLeft - dayColRect.left : floatTop - dayColRect.top;
      const step = snapOf(settings);
      const snappedStart = roundSnap(GRID_START + (relPos - headerOffset) / PX_PER_MIN, step);
      // Not clamped to the day's configured opening hours - dragging past them
      // is allowed, and extends that day's hours on drop (see onPointerUp).
      const wanted = Math.max(GRID_START, Math.min(snappedStart, latestStart(kesto, step)));

      // `start` is where the drop will actually put it: `wanted` when that fits
      // or room can be made around it, the slot next to the show under the
      // cursor, or else the nearest slot that fits - that last case is what
      // turns the ghost red.
      candidate = dropCandidate({ id, sali: dayCol.dataset.sali, paiva: dayCol.dataset.paiva }, wanted, kesto, settings);
      if (candidate.valid) showLandingMarker(dayCol, horizontal, candidate.start, kesto);
      else hideLandingMarker();
    } else {
      hideLandingMarker();
    }

    dragState.lastCandidate = candidate;
    previewMoves(candidate?.moves, horizontal);
    // Red means "not here": the spot under the cursor is taken and nothing can
    // make way (the drop slides to the marker, or reverts if there is none).
    block.classList.toggle('drag-invalid', !!candidate && blockedAt(candidate));
    // The ghost reads the time it is pointing at; the landing marker reads the
    // time the drop will give the show.
    const timeSpan = dragState.timeSpan ?? (dragState.timeSpan = block.querySelector('.block-time'));
    if (timeSpan && candidate && timeSpan.textContent !== dot(candidate.pointedAt)) timeSpan.textContent = dot(candidate.pointedAt);
    showDragReason({ left: floatLeft, top: floatTop, right: floatLeft + ghostW, bottom: floatTop + ghostH }, horizontal, candidate);
  }

  // ── Selecting several shows ──────────────────────────────────────────────
  // Pressing on an empty part of the grid and dragging draws a selection
  // box; every show it touches is selected (Shift/Ctrl/⌘ adds to the current
  // selection). A plain click on empty grid, or Esc, clears it. Grabbing any
  // selected show then moves the whole selection (startGroupDrag).
  function setSelection(ids) {
    selectedIds = ids;
    document.querySelectorAll('#aikataulu-grid .naytokset-block').forEach(b => b.classList.toggle('selected', ids.has(b.dataset.id)));
    renderNaytosStats();
  }

  function onGridMouseDown(e) {
    if (e.button !== 0 || e.target.closest('.naytokset-block') || !e.target.closest('.day-col')) return;
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    marquee = {
      x0: e.clientX, y0: e.clientY, additive, moved: false, el: null,
      base: additive ? new Set(selectedIds) : new Set(),
      rects: [...document.querySelectorAll('#aikataulu-grid .naytokset-block')].map(b => ({ id: b.dataset.id, el: b, r: b.getBoundingClientRect() })),
    };
    document.addEventListener('mousemove', onMarqueeMove);
    document.addEventListener('mouseup', onMarqueeUp);
  }

  function onMarqueeMove(e) {
    const m = marquee;
    if (!m) return;
    if (!m.moved && Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < 4) return;
    m.moved = true;
    if (!m.el) { m.el = document.createElement('div'); m.el.className = 'valinta-laatikko'; document.body.appendChild(m.el); }
    const left = Math.min(m.x0, e.clientX), top = Math.min(m.y0, e.clientY);
    const right = Math.max(m.x0, e.clientX), bottom = Math.max(m.y0, e.clientY);
    setFixedBox(m.el, left, top, right - left, bottom - top);
    m.current = new Set(m.base);
    m.rects.forEach(({ id, el, r }) => {
      if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) m.current.add(id);
      el.classList.toggle('selected', m.current.has(id));
    });
  }

  function onMarqueeUp() {
    document.removeEventListener('mousemove', onMarqueeMove);
    document.removeEventListener('mouseup', onMarqueeUp);
    const m = marquee;
    marquee = null;
    if (!m) return;
    m.el?.remove();
    if (m.moved) setSelection(m.current ?? m.base);
    else if (!m.additive) setSelection(new Set());
  }

  // Moving the selection: every selected show shifts by the same time, and -
  // when the grabbed show is dropped into another day or theater - by the
  // same number of days and theaters, so the group keeps its shape. It is
  // all or nothing: if any show would clash (same-room buffer, another
  // room's start) or fall off the week or the grid, nothing moves and the
  // reason is shown. Ghosts follow the cursor; markers show where each
  // show would land.
  function startGroupDrag(e, primaryEl) {
    const settings = Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';
    const byId = new Map(currentSchedule.naytokset.map(n => [n.id, n]));
    const items = [...selectedIds].filter(id => byId.has(id)).map(id => {
      const el = document.querySelector(`#aikataulu-grid .naytokset-block[data-id="${id}"]`);
      const buf = document.querySelector(`#aikataulu-grid .buffer-zone[data-id="${id}"]`);
      return { n: byId.get(id), el, buf, r: el?.getBoundingClientRect(), br: buf?.getBoundingClientRect() };
    });
    items.forEach(it => [[it.el, it.r], [it.buf, it.br]].forEach(([el, r]) => {
      if (!el) return;
      el.classList.add('live-dragging');
      el.style.position = 'fixed';
      el.style.pointerEvents = 'none';
      setFixedBox(el, r.left, r.top, r.width, r.height);
      document.body.appendChild(el);
    }));
    groupDrag = { items, primary: items.find(it => it.n.id === primaryEl.dataset.id), x0: e.clientX, y0: e.clientY, settings, horizontal, plan: null, markers: [] };
    document.addEventListener('mousemove', onGroupMove);
    document.addEventListener('mouseup', onGroupUp);
  }

  function onGroupMove(e) {
    const g = groupDrag;
    if (!g) return;
    const { settings, horizontal, primary } = g;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const dayCol = under && under.closest('#aikataulu-grid .day-col');
    const cell = dayCol?.getBoundingClientRect();

    g.items.forEach(it => {
      if (it.el && it.r) setFixedBox(it.el, it.r.left + dx, it.r.top + dy, it.r.width, it.r.height);
      if (it.buf && it.br) setFixedBox(it.buf, it.br.left + dx, it.br.top + dy, it.br.width, it.br.height);
    });
    g.markers.forEach(m => m.remove());
    g.markers = [];
    g.plan = null;
    if (!dayCol || !primary?.r) { g.items.forEach(it => it.el?.classList.remove('drag-invalid')); hideDragReason(); return; }

    const step = snapOf(settings);
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
    const lead = horizontal ? primary.r.left + dx - cell.left : primary.r.top + dy - cell.top;
    const delta = roundSnap(GRID_START + (lead - headerOffset) / PX_PER_MIN, step) - toMin(primary.n.alkaa);
    const paivat = weekPaivat();
    const dd = paivat.indexOf(dayCol.dataset.paiva) - paivat.indexOf(primary.n.paiva);
    const dr = SALAT.indexOf(dayCol.dataset.sali) - SALAT.indexOf(primary.n.sali);

    const moving = new Set(g.items.map(it => it.n.id));
    const targets = g.items.map(it => {
      const start = toMin(it.n.alkaa) + delta;
      return { ...it.n, sali: SALAT[SALAT.indexOf(it.n.sali) + dr], paiva: paivat[paivat.indexOf(it.n.paiva) + dd],
        alkaa: toHHMM(Math.max(0, start)), loppuu: toHHMM(Math.max(0, start) + it.n.kesto), start };
    });
    const others = currentSchedule.naytokset.filter(n => !moving.has(n.id));
    let reasons = [];
    if (targets.some(t => !t.sali || !t.paiva)) reasons = ['osa näytöksistä menisi viikon tai salien ulkopuolelle'];
    else if (targets.some(t => t.start < GRID_START || t.start + t.kesto > GRID_END)) reasons = ['osa näytöksistä menisi klo 9-24 ulkopuolelle'];
    else targets.forEach(t => {
      const w = Scheduler.validateScreening(t, [...others, ...targets], settings);
      if (w.length) reasons.push(`${t.nimi} (${t.paiva} ${dot(t.start)}): ${w[0]}`);
    });
    g.plan = { targets, valid: reasons.length === 0, changed: delta !== 0 || dd !== 0 || dr !== 0, reasons };

    g.items.forEach(it => it.el?.classList.toggle('drag-invalid', !g.plan.valid));
    if (g.plan.valid) {
      targets.forEach(t => {
        const c = document.querySelector(`#aikataulu-grid .day-col[data-sali="${t.sali}"][data-paiva="${t.paiva}"]`);
        if (!c) return;
        const mk = document.createElement('div');
        mk.className = 'landing-marker';
        mk.innerHTML = `<span class="block-time">${dot(t.start)}</span>`;
        positionBox(mk, horizontal, headerOffset + (t.start - GRID_START) * PX_PER_MIN, Math.max(t.kesto * PX_PER_MIN, horizontal ? 40 : 20) + 'px', '2px', '2px');
        c.appendChild(mk);
        g.markers.push(mk);
      });
      hideDragReason();
    } else {
      const pr = primary.r;
      showDragReason({ left: pr.left + dx, top: pr.top + dy, right: pr.right + dx, bottom: pr.bottom + dy }, horizontal, {
        wanted: toMin(primary.n.alkaa) + delta, start: toMin(primary.n.alkaa) + delta, valid: false, moves: [], reasons,
        title: `${g.items.length} näytöstä ei mahdu tähän`, outcome: 'Pudotus perutaan - mikään ei siirry.' });
    }
  }

  function onGroupUp() {
    document.removeEventListener('mousemove', onGroupMove);
    document.removeEventListener('mouseup', onGroupUp);
    const g = groupDrag;
    groupDrag = null;
    if (!g) return;
    g.items.forEach(it => { it.el?.remove(); it.buf?.remove(); });
    g.markers.forEach(m => m.remove());
    hideDragReason();
    const plan = g.plan;
    if (plan?.valid && plan.changed) {
      pushUndo();
      plan.targets.forEach(t => {
        const n = currentSchedule.naytokset.find(x => x.id === t.id);
        Object.assign(n, { sali: t.sali, paiva: t.paiva, alkaa: toHHMM(t.start), loppuu: toHHMM(t.start + t.kesto) });
        extendOpeningHours(t.paiva, t.start, t.start + t.kesto);
      });
      Storage.saveSchedule(currentSchedule);
      showWarning(`${plan.targets.length} näytöstä siirrettiin.`, 'ℹ️');
    } else if (plan && !plan.valid) {
      showWarning(`Valittuja näytöksiä ei siirretty: ${plan.reasons[0]}${plan.reasons.length > 1 ? ` (ja ${plan.reasons.length - 1} muuta)` : ''}.`);
    }
    renderGrid();
  }

  // ── Moving a show to another theater ─────────────────────────────────────
  // In the vertical view one theater is on screen at a time. A show dragged
  // onto another theater's tab opens that theater after a moment (keep
  // holding and drop it at a time), or, dropped right on the tab, goes into
  // that theater at its own time. The right-click menu has the same move.
  const TAB_SWITCH_MS = 450;
  let tabSwitchTimer = null;

  function onDragOverTab(tab) {
    const target = tab?.dataset.sali ?? null;
    if (target === dragState.tabTarget) return;
    clearTimeout(tabSwitchTimer);
    document.querySelectorAll('.sali-tab.drop-hover').forEach(t => t.classList.remove('drop-hover'));
    dragState.tabTarget = target;
    if (!tab) return;
    tab.classList.add('drop-hover');
    hideLandingMarker();
    hideDragReason();
    previewMoves([], dragState.horizontal);
    dragState.lastCandidate = null;
    if (target === pystySali()) return;
    tabSwitchTimer = setTimeout(() => {
      if (!dragState) return;
      try { localStorage.setItem(PYSTY_SALI_KEY, target); } catch { /* storage blocked */ }
      previewed.clear();
      previewKey = '';
      renderGrid();
      drawEriSaliZones(dragState.id);
      document.querySelector(`.sali-tab[data-sali="${target}"]`)?.classList.add('drop-hover');
    }, TAB_SWITCH_MS);
  }

  // Puts a show into another theater on the same day, as close to its own
  // time as the room allows - the same placement rules as a drop there.
  function moveToSali(id, sali) {
    const n = currentSchedule?.naytokset.find(x => x.id === id);
    if (!n) { renderGrid(); return; }
    if (n.sali === sali) { renderGrid(); return; }
    const settings = Storage.getSettings();
    const candidate = dropCandidate({ id, sali, paiva: n.paiva }, toMin(n.alkaa), n.kesto, settings);
    const nimi = sali.replace('STUDIO ', 'Studio ');
    if (!candidate.valid) {
      showWarning(`${refusalText(candidate)}\n${nimi}: ei vapaata kohtaa tänä päivänä, joten näytös jäi paikalleen.`);
      renderGrid();
      return;
    }
    pushUndo();
    n.sali = sali;
    n.alkaa = toHHMM(candidate.start);
    n.loppuu = toHHMM(candidate.start + n.kesto);
    applyMoves(candidate, 'siirrettiin');
    extendOpeningHours(n.paiva, candidate.start, candidate.start + n.kesto);
    Storage.saveSchedule(currentSchedule);
    renderGrid();
    if (!candidate.moves?.length) showWarning(`${n.nimi} siirrettiin saliin ${nimi} (${n.paiva} ${dot(candidate.start)}).`, 'ℹ️');
  }

  // ── Where the drop will land ─────────────────────────────────────────────
  // A dashed placeholder in the target cell at the start the drop will give
  // the show, labelled with that time - so the free-moving ghost never has to
  // double as the answer to "where will it go". Shared by block drags and
  // list drags; it slides within a cell (CSS transition) as the slot changes.
  let landingEl = null;
  function showLandingMarker(dayCol, horizontal, startMin, kesto) {
    if (landingEl && landingEl.parentElement === dayCol && landingEl.dataset.start === String(startMin)) return;
    // Moving to another cell starts a fresh marker: a new element placed
    // before its first paint doesn't slide in from the old cell, without
    // having to force a layout to suppress the transition.
    if (landingEl && landingEl.parentElement !== dayCol) hideLandingMarker();
    if (!landingEl) {
      landingEl = document.createElement('div');
      landingEl.className = 'landing-marker';
      landingEl.innerHTML = '<span class="block-time"></span>';
      dayCol.appendChild(landingEl);
    }
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
    positionBox(landingEl, horizontal, headerOffset + (startMin - GRID_START) * PX_PER_MIN,
      Math.max(kesto * PX_PER_MIN, horizontal ? 40 : 20) + 'px', '2px', '2px');
    landingEl.querySelector('.block-time').textContent = dot(startMin);
    landingEl.dataset.start = String(startMin);
  }
  function hideLandingMarker() {
    if (landingEl) { landingEl.remove(); landingEl = null; }
  }

  // ── Why a dragged show is red ─────────────────────────────────────────────
  // A small note pinned to the dragged block (or the list-drag ghost) whenever
  // the spot under it is refused: every show in the way with the numbers
  // (minutes that would be left, minutes required), then where the drop will
  // put the show instead. The red bands only cover the cross-room rule - a
  // refusal caused by the SAME room (the film would end less than the cleanup
  // buffer before the next show) has no band, so without this the block was
  // simply red over a spot that looked free.
  let dragReasonEl = null;

  // `anchor` is the dragged thing's box - an element, or a rect the caller
  // already knows (the block ghost), which saves a layout read per move.
  // The note's content and size are rebuilt only when what it says changes.
  let dragReasonKey = null, dragReasonSize = null;
  function showDragReason(anchor, horizontal, candidate) {
    const makingRoom = !!candidate?.moves?.length;
    if (!candidate || (!blockedAt(candidate) && !makingRoom)) { hideDragReason(); return; }
    const key = JSON.stringify([candidate.title, candidate.wanted, candidate.start, candidate.valid, candidate.reasons, (candidate.moves ?? []).map(m => [m.n.id, m.to])]);
    if (dragReasonEl && key === dragReasonKey) { placeDragReason(anchor, horizontal); return; }
    dragReasonKey = key;
    const reasons = (candidate.reasons ?? []).map(r => r[0].toUpperCase() + r.slice(1));

    if (!dragReasonEl) {
      dragReasonEl = document.createElement('div');
      document.body.appendChild(dragReasonEl);
    }
    dragReasonEl.className = 'drag-reason' + (makingRoom ? ' making-room' : '');
    const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
    const shown = reasons.slice(0, 3);
    if (makingRoom) dragReasonEl.replaceChildren(
      line('drag-reason-title', `Kohtaan ${dot(candidate.start)} - muut siirtyvät:`),
      ...moveLines(candidate.moves).map(t => line('drag-reason-item', t)),
    );
    else dragReasonEl.replaceChildren(
      line('drag-reason-title', candidate.title ?? `Ei mahdu kohtaan ${dot(candidate.wanted)}`),
      ...shown.map(r => line('drag-reason-item', r)),
      ...(reasons.length > shown.length ? [line('drag-reason-item', `+ ${reasons.length - shown.length} muuta näytöstä`)] : []),
      line('drag-reason-outcome', candidate.outcome ? candidate.outcome : candidate.valid
        ? `Pudotettaessa siirtyy lähimpään vapaaseen kohtaan: ${dot(candidate.start)}`
        : 'Salissa ei ole tänä päivänä vapaata kohtaa - pudotus perutaan.'),
    );

    dragReasonSize = [dragReasonEl.offsetWidth, dragReasonEl.offsetHeight];
    placeDragReason(anchor, horizontal);
  }

  // Beside the block, on whichever side has room: under it when time runs
  // sideways, to its right when time runs downward.
  function placeDragReason(anchor, horizontal) {
    const a = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const [w, h] = dragReasonSize, m = 6;
    let left, top;
    if (horizontal) {
      left = a.left;
      top = a.bottom + m + h <= window.innerHeight ? a.bottom + m : a.top - m - h;
    } else {
      left = a.right + m + w <= window.innerWidth ? a.right + m : a.left - m - w;
      top = a.top;
    }
    dragReasonEl.style.left = Math.max(m, Math.min(left, window.innerWidth - w - m)) + 'px';
    dragReasonEl.style.top = Math.max(m, Math.min(top, window.innerHeight - h - m)) + 'px';
  }

  function hideDragReason() {
    if (dragReasonEl) { dragReasonEl.remove(); dragReasonEl = null; }
    dragReasonKey = null;
  }

  function onPointerUp() {
    if (!dragState) return;
    document.removeEventListener('mousemove', onPointerMove);
    document.removeEventListener('mouseup', onPointerUp);
    hideDragReason();
    hideLandingMarker();

    const { id, lastCandidate, block, buf, tabTarget } = dragState;
    // The ghost and its buffer were moved onto <body>; renderGrid() below
    // draws the show afresh wherever it ended up.
    block.remove();
    if (buf) buf.remove();
    clearTimeout(tabSwitchTimer);
    document.querySelectorAll('.sali-tab.drop-hover').forEach(t => t.classList.remove('drop-hover'));

    if (tabTarget) {
      // Dropped on a theater's tab: into that theater at the same time.
      dragState = null;
      previewed.clear();
      previewKey = '';
      if (SALAT.includes(tabTarget)) moveToSali(id, tabTarget);
      else renderGrid();
      return;
    }

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
        applyMoves(lastCandidate, 'siirrettiin');
        Storage.saveSchedule(currentSchedule);
        extendOpeningHours(lastCandidate.paiva, lastCandidate.start, lastCandidate.start + n.kesto);
        if (lastCandidate.snapped) snappedNotice(lastCandidate);
      }
    } else if (lastCandidate) {
      showWarning(`${refusalText(lastCandidate)}\nSalissa ei ole tänä päivänä yhtään vapaata kohtaa, joten siirto peruttiin.`);
    }

    dragState = null;
    previewed.clear();
    previewKey = '';
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
    // Drawn on first contact with the grid rather than at dragstart, so a
    // plain reorder inside the list never paints the grid.
    if (!eriSaliZonesDrawn) drawEriSaliZones(null);

    const settings = rowDragSettings ?? Storage.getSettings();
    const horizontal = settings.aikataulu_suunta === 'vaaka';
    const headerOffset = horizontal ? DAY_HEADER_W : DAY_HEADER_H;
    const dayColRect = dayCol.getBoundingClientRect();
    const relPos = horizontal ? e.clientX - dayColRect.left : e.clientY - dayColRect.top;
    const step = snapOf(settings);
    const snappedStart = roundSnap(GRID_START + (relPos - headerOffset) / PX_PER_MIN, step);
    const wanted = Math.max(GRID_START, Math.min(snappedStart, latestStart(movie.kesto, step)));

    const base = { id: '__preview__', sali: dayCol.dataset.sali, paiva: dayCol.dataset.paiva };
    const candidate = { ...dropCandidate(base, wanted, movie.kesto, settings), movieId: movie.id };
    previewMoves(candidate.moves, horizontal);

    // Ghost sits under the cursor and reddens where the show cannot go, exactly
    // like a block being moved, and its label reads the cursor's time too.
    showGridDropPreview(dayCol, horizontal, headerOffset, candidate.pointedAt, movie, blockedAt(candidate));
    if (candidate.valid && candidate.start !== candidate.pointedAt) showLandingMarker(dayCol, horizontal, candidate.start, movie.kesto);
    else hideLandingMarker();
    showDragReason(gridGhostEl, horizontal, candidate);
    gridDropCandidate = candidate;
  }

  function showGridDropPreview(dayCol, horizontal, headerOffset, posStart, movie, blocked) {
    const kesto = movie.kesto;
    if (!gridGhostEl || gridGhostEl.dataset.movie !== movie.id) {
      if (gridGhostEl) gridGhostEl.remove();
      gridGhostEl = document.createElement('div');
      gridGhostEl.className = 'naytokset-block grid-drop-ghost';
      gridGhostEl.dataset.movie = movie.id;
      const color = movieColor(movie.id, weekColors());
      gridGhostEl.style.setProperty('--blk-bg', color.bg);
      gridGhostEl.style.setProperty('--blk-fg', color.text);
      gridGhostEl.innerHTML = blockInner(movie.nimi, '', !!movie.lastenelokuva);
    }
    gridGhostEl.classList.toggle('pysty-teksti', document.getElementById('aikataulu-grid').classList.contains('kaikki-pysty'));
    if (gridGhostEl.parentElement !== dayCol) dayCol.appendChild(gridGhostEl);

    const offset = headerOffset + (posStart - GRID_START) * PX_PER_MIN;
    const sizeAlong = Math.max(kesto * PX_PER_MIN, horizontal ? 40 : 20);
    positionBox(gridGhostEl, horizontal, offset, sizeAlong + 'px', '2px', '2px');
    gridGhostEl.querySelector('.block-time').textContent = toHHMM(posStart).replace(':', '.');
    gridGhostEl.classList.toggle('drag-invalid', blocked);
  }

  function clearGridDropPreview() {
    if (gridGhostEl && gridGhostEl.parentElement) gridGhostEl.parentElement.removeChild(gridGhostEl);
    gridDropCandidate = null;
    hideDragReason();
    hideLandingMarker();
    if (previewed.size) previewMoves([], (rowDragSettings ?? Storage.getSettings()).aikataulu_suunta === 'vaaka');
  }

  function onGridDrop(e) {
    if (!draggingMovieId) return;
    e.preventDefault();

    const candidate = gridDropCandidate;
    clearGridDropPreview();
    if (!candidate) return;
    if (!candidate.valid) {
      showWarning(`${refusalText(candidate)}\nSalissa ei ole tänä päivänä yhtään vapaata kohtaa, joten näytöstä ei lisätty.`);
      return;
    }

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
    applyMoves(candidate, 'lisättiin');
    extendOpeningHours(candidate.paiva, candidate.start, candidate.start + movie.kesto);

    // The drag can only have started from a roster row, so the movie is already
    // on the roster - nothing to select. (Rebuilding the panel here would also
    // destroy the row mid-drag, before its own dragend fires.)
    Storage.saveSchedule(currentSchedule);
    renderGrid();
    if (candidate.snapped) snappedNotice(candidate, 'lisättiin');
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

    // "Siirrä saliin ..." for each of the other two theaters
    const n = currentSchedule?.naytokset.find(x => x.id === contextTarget);
    const salit = document.getElementById('ctx-salit');
    salit.innerHTML = SALAT.filter(s => s !== n?.sali)
      .map(s => `<button type="button" data-sali="${s}">➜ Siirrä saliin ${s.replace('STUDIO ', 'Studio ')}</button>`).join('');
    salit.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      document.getElementById('context-menu').classList.remove('open');
      moveToSali(contextTarget, b.dataset.sali);
    }));

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
    fillEditMovieSelect(n);
    document.getElementById('edit-modal').classList.add('open');
  }

  // The movie picker: this week's roster first, in rank order, then the rest
  // of the library alphabetically. A show whose movie has left the library
  // keeps an entry of its own, so opening the modal never changes it.
  function fillEditMovieSelect(n) {
    const select = document.getElementById('edit-elokuva');
    const roster = rosterMovies();
    const onRoster = new Set(roster.map(m => m.id));
    const rest = Library.getAll().filter(m => !onRoster.has(m.id))
      .sort((a, b) => a.nimi.localeCompare(b.nimi, 'fi'));
    const option = (id, nimi) => `<option value="${escHtml(id)}">${escHtml(nimi)}</option>`;
    let html = '';
    if (!onRoster.has(n.elokuvaId) && !rest.some(m => m.id === n.elokuvaId)) html += option(n.elokuvaId, n.nimi);
    if (roster.length) html += `<optgroup label="Tämän viikon elokuvat">${roster.map(m => option(m.id, m.nimi)).join('')}</optgroup>`;
    if (rest.length) html += `<optgroup label="Muut kirjaston elokuvat">${rest.map(m => option(m.id, m.nimi)).join('')}</optgroup>`;
    select.innerHTML = html;
    select.value = n.elokuvaId;
    document.getElementById('edit-kaikki').checked = true;
    onEditMovieChange();
  }

  // Picking another movie reveals the "all shows" option (with this week's
  // count) and puts the new movie's price in the price field, since the show
  // would otherwise keep the old movie's ticket price.
  function onEditMovieChange() {
    const n = currentSchedule?.naytokset.find(x => x.id === contextTarget);
    if (!n) return;
    const newId = document.getElementById('edit-elokuva').value;
    const changed = newId !== n.elokuvaId;
    const count = currentSchedule.naytokset.filter(x => x.elokuvaId === n.elokuvaId).length;
    document.getElementById('edit-kaikki-rivi').hidden = !changed || count < 2;
    document.getElementById('edit-kaikki-teksti').textContent =
      `Vaihda kaikki ${n.nimi} -näytökset tällä viikolla (${count} kpl)`;
    const movie = Library.getAll().find(m => m.id === newId);
    document.getElementById('edit-hinta').value = changed && movie ? movie.hinta : n.hinta;
  }

  // Turns shows of one movie into another: title, length, rating, price,
  // distributor and kids flag all come from the new movie, so the grid color
  // and the Excel row follow. Start times and rooms stay; the shows after
  // them are moved to fit by reflowAfterSwitch.
  function switchMovie(shows, movie) {
    shows.forEach(x => {
      x.elokuvaId = movie.id;
      x.nimi = movie.nimi;
      x.kesto = movie.kesto;
      x.ikäraja = movie.ikäraja;
      x.hinta = movie.hinta;
      x.jakelija = movie.jakelija;
      x.lastenelokuva = !!movie.lastenelokuva;
      x.loppuu = toHHMM(toMin(x.alkaa) + movie.kesto);
    });
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
    const newStart = ceilSnap(endMin + settings.minimivali_sama_sali, snapOf(settings));
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
    const oldId = n.elokuvaId;
    const newMovie = Library.getAll().find(m => m.id === document.getElementById('edit-elokuva').value);
    const switching = newMovie && newMovie.id !== oldId;
    const all = switching && document.getElementById('edit-kaikki').checked;
    pushUndo();
    // Where everything stood before the edit - the reflow below measures each
    // show's original gap against it.
    const before = new Map(currentSchedule.naytokset.map(x => [x.id, { alkaa: x.alkaa, kesto: x.kesto, sali: x.sali, paiva: x.paiva }]));
    n.alkaa  = newAlkaa;
    n.sali   = newSali;
    let switched = [];
    if (switching) {
      switched = all ? currentSchedule.naytokset.filter(x => x.elokuvaId === oldId) : [n];
      switchMovie(switched, newMovie);
      rosterAfterSwitch(oldId, newMovie.id);
    }
    n.loppuu = toHHMM(toMin(newAlkaa) + n.kesto);
    n.hinta  = isNaN(newHinta) ? n.hinta : newHinta;
    const moves = switching ? reflowAfterSwitch(switched, before) : [];
    Storage.saveSchedule(currentSchedule);
    document.getElementById('edit-modal').classList.remove('open');
    if (switching) buildWeekPanel(); // the roster changed too
    renderGrid();
    if (moves.length) {
      alert(`${newMovie.nimi} on eri mittainen, joten ${moves.length === 1 ? 'yksi näytös siirtyi' : `${moves.length} näytöstä siirtyi`}:\n\n` +
        moves.map(m => `${m.paiva} ${m.sali}: ${m.nimi} ${m.from.replace(':', '.')} → ${m.to.replace(':', '.')}${m.lateEnd ? ' (päättyy klo 24 jälkeen)' : ''}`).join('\n'));
    }
  }

  // After a movie switch changed some shows' length, the shows after them in
  // the same room-day are moved so everything fits again. Rules, in order
  // along each room's day:
  //  - a show moves only if the one before it now ends at a different time;
  //  - a longer film pushes the next show back only as far as needed to keep
  //    the gap it had (capped at the room buffer, so a gap the user had
  //    squeezed below the setting stays that tight rather than growing);
  //  - a shorter film pulls the next show forward if the two were packed
  //    back to back (gap within buffer + 14 min rounding), so the room stays
  //    packed; a deliberate longer pause is left alone;
  //  - a moved show that would start within minimivali_eri_sali of another
  //    room's start steps later 15 min at a time until it's clear.
  // Moves cascade down the room's day. Opening hours stretch to fit, as they
  // do for a drag. Returns the moves so they can be announced.
  function reflowAfterSwitch(switched, before) {
    const settings = Storage.getSettings();
    const gapSama = settings.minimivali_sama_sali;
    const gapEri = settings.minimivali_eri_sali ?? 0;
    const step = snapOf(settings);
    const ceil15 = m => ceilSnap(m, step);
    const moves = [];
    const roomDays = new Set(switched.map(x => x.paiva + '|' + x.sali));
    roomDays.forEach(key => {
      const [paiva, sali] = key.split('|');
      const chain = currentSchedule.naytokset.filter(x => x.paiva === paiva && x.sali === sali)
        .sort((a, b) => toMin(a.alkaa) - toMin(b.alkaa));
      for (let i = 1; i < chain.length; i++) {
        const pred = chain[i - 1], cur = chain[i];
        const b = before.get(pred.id);
        const stayed = b && b.paiva === paiva && b.sali === sali;
        const prevOldEnd = stayed ? toMin(b.alkaa) + b.kesto : null;
        const prevNewEnd = toMin(pred.alkaa) + pred.kesto;
        if (prevOldEnd === prevNewEnd) continue;

        const origStart = toMin(cur.alkaa);
        const origGap = prevOldEnd != null ? origStart - prevOldEnd : gapSama;
        const tight = ceil15(prevNewEnd + Math.max(0, Math.min(origGap, gapSama)));
        let start;
        if (prevOldEnd == null || prevNewEnd > prevOldEnd) start = Math.max(origStart, tight);
        else start = origGap <= gapSama + step - 1 ? Math.min(origStart, tight) : origStart;
        if (start === origStart) continue;

        if (gapEri > 0) {
          const collides = st => currentSchedule.naytokset.some(x =>
            x.paiva === paiva && x.sali !== sali && Math.abs(toMin(x.alkaa) - st) < gapEri);
          for (let guard = 0; guard < 36 && collides(start); guard++) start += step;
        }
        moves.push({ paiva, sali, nimi: cur.nimi, from: cur.alkaa, to: toHHMM(start), lateEnd: start + cur.kesto > GRID_END });
        cur.alkaa = toHHMM(start);
        cur.loppuu = toHHMM(start + cur.kesto);
        extendOpeningHours(paiva, start, start + cur.kesto);
      }
    });
    const order = ['PE', 'LA', 'SU', 'MA', 'TI', 'KE', 'TO'];
    return moves.sort((a, b) => order.indexOf(a.paiva) - order.indexOf(b.paiva) || a.sali.localeCompare(b.sali) || toMin(a.from) - toMin(b.from));
  }

  // Keeps the week's roster in step with a movie switch. The new movie takes
  // the old one's place in the ranking (right after it, if the old movie
  // still has shows). When the old movie has no shows left it leaves the
  // roster and the new one inherits its plan; otherwise the new movie's plan
  // is read off the shows it now has.
  function rosterAfterSwitch(oldId, newId) {
    const valitut = currentSchedule.valitut ?? (currentSchedule.valitut = []);
    const oldGone = !currentSchedule.naytokset.some(x => x.elokuvaId === oldId);
    const oldIdx = valitut.indexOf(oldId);
    if (!valitut.includes(newId)) {
      if (oldIdx === -1) valitut.push(newId);
      else valitut.splice(oldIdx + (oldGone ? 0 : 1), 0, newId);
    }
    const plan = getPlan();
    if (oldGone) {
      // The new movie takes the old one's cards (place, days) wherever it
      // doesn't already have its own.
      currentSchedule.valitut = valitut.filter(id => id !== oldId);
      SALAT.forEach(s => {
        if (plan[s].some(c => c.id === newId)) removeFromTheater(plan, oldId, s);
        else plan[s].forEach(c => { if (c.id === oldId) c.id = newId; });
      });
    } else {
      // Both stay: the new movie gets a card in each theater it now has shows in.
      const derived = derivePlan([newId], currentSchedule.naytokset);
      SALAT.forEach(s => { if (derived[s].length && !plan[s].some(c => c.id === newId)) plan[s].push(derived[s][0]); });
    }
  }

  // The message stays up long enough to be read - longer for a longer one -
  // and a new message restarts the clock rather than inheriting the old
  // message's, which used to hide a second warning early.
  let warningTimer = null;
  function showWarning(msg, icon = '⚠️') {
    const bar = document.getElementById('warning-bar');
    bar.textContent = icon + ' ' + msg;
    bar.classList.add('visible');
    clearTimeout(warningTimer);
    warningTimer = setTimeout(() => bar.classList.remove('visible'), Math.min(15000, Math.max(5000, msg.length * 75)));
  }

  // ── Suunnittelu: the planning page ────────────────────────────────────────
  // The week's movies sit in a bucket on the left; each theater is a box on
  // the right. Dragging a movie from the bucket into a box puts it in that
  // theater (a movie can be in several); its height in the box is its
  // priority there - the top card gets the evening slot and, while its days
  // are automatic, the most days. Cards are reordered by dragging within a
  // box, moved by dragging to another box, and taken out by dragging back
  // to the bucket (or ✕). Each card's day buttons pick its days by hand;
  // ↺ hands them back to the automatic choice. "Täytä ohjelma" fills the
  // week from all of it and opens Ohjelmointi for adjusting.
  let planDrag = null; // { id, fromSali } while a card or bucket movie is dragged

  function buildPlanPage() {
    const page = document.getElementById('suunnittelu-sisalto');
    if (!page || !panelActive('suunnittelu-panel')) return;
    const alku = currentSchedule?.viikkoAlku ?? (document.getElementById('viikko-alku').value || nextFriday());
    const loppu = currentSchedule?.viikkoLoppu ?? (document.getElementById('viikko-loppu').value || addDays(alku, 6));
    const label = iso => `${Scheduler.weekdayOf(iso)} ${Scheduler.isoToFin(iso)}`;
    document.getElementById('suunnittelu-viikko').textContent = `${label(alku)} – ${label(loppu)}`;

    const roster = rosterMovies();
    const byId = new Map(roster.map(m => [m.id, m]));
    const plan = roster.length ? getPlan() : emptyPlan();
    const paivat = weekPaivat();
    const colors = weekColors();
    const chip = m => {
      const c = movieColor(m.id, colors);
      return `<span class="plan-chip" style="background:${c.bg};color:${c.text}">${m.lastenelokuva ? '👶 ' : ''}${escHtml(m.nimi)}</span>`;
    };

    const bucket = roster.map(m => {
      const inRooms = SALAT.filter(s => plan[s].some(c => c.id === m.id));
      return `<div class="plan-movie" draggable="true" data-id="${m.id}">
          ${chip(m)}<span class="plan-movie-meta">${m.kesto} min${inRooms.length ? ` · Sali: ${inRooms.map(saliBadge).join('')}` : ''}</span>
        </div>`;
    }).join('') || '<p class="lista-tyhja">Ei elokuvia tällä viikolla. Lisää ne &ldquo;+ Lisää elokuvia&rdquo; -painikkeella.</p>';

    let total = 0;
    const boxes = SALAT.map(sali => {
      const perDay = Object.fromEntries(paivat.map(p => [p, 0]));
      const cards = plan[sali].map((card, i) => {
        const m = byId.get(card.id);
        if (!m) return '';
        const days = card.paivat.filter(p => paivat.includes(p));
        days.forEach(p => perDay[p]++);
        total += days.length;
        return `<div class="plan-card${card.auto ? '' : ' manual'}" draggable="true" data-id="${m.id}" data-sali="${sali}">
            <div class="plan-card-top">
              <span class="plan-card-rank">${i + 1}.</span>${chip(m)}
              <button type="button" class="plan-card-x" title="Poista tästä salista">✕</button>
            </div>
            <div class="plan-card-days">
              ${paivat.map(p => `<button type="button" class="plan-day${card.paivat.includes(p) ? ' on' : ''}" data-paiva="${p}">${p}</button>`).join('')}
              <span class="plan-card-n" title="Näytöksiä">${days.length}</span>
              ${card.auto ? '<span class="plan-card-auto" title="Päivät valitaan automaattisesti sijan mukaan">auto</span>'
                          : '<button type="button" class="plan-card-reset" title="Palauta automaattiset päivät">↺</button>'}
            </div>
          </div>`;
      }).join('');
      // A day whose shows can't fit between its earliest start and midnight
      // (lengths plus cleanup buffers) is flagged: "Täytä ohjelma" would have
      // to leave its lowest cards out.
      const settings = Storage.getSettings();
      const dayMinutes = p => plan[sali].filter(c => c.paivat.includes(p) && byId.has(c.id))
        .reduce((sum, c, i) => sum + byId.get(c.id).kesto + (i ? settings.minimivali_sama_sali : 0), 0);
      const loadRow = paivat.map(p => {
        const n = perDay[p], slots = ROOM_DAY_SLOTS[p] ?? 2;
        const over = dayMinutes(p) > 24 * 60 - toMin(settings.aukioloajat[p].avautuu);
        const cls = over ? ' over' : n > slots + 1 ? ' heavy' : n === 0 ? ' empty' : '';
        const title = over ? `${p}: ${n} näytöstä - ei mahdu klo 24 mennessä, alimmat jäävät pois` : `${p}: ${n} näytöstä`;
        return `<span class="plan-load${cls}" title="${title}">${p} <b>${n}</b></span>`;
      }).join('');
      return `<section class="plan-room" data-sali="${sali}" data-nro="${saliNumero(sali)}">
          <header><h3>${sali.replace('STUDIO ', 'Studio ')}</h3><span class="plan-room-sum">${Object.values(perDay).reduce((a, b) => a + b, 0)} näytöstä</span></header>
          <div class="plan-room-list" data-sali="${sali}">${cards || '<p class="plan-room-empty">Raahaa elokuvia tähän</p>'}</div>
          <footer class="plan-room-load">${loadRow}</footer>
        </section>`;
    }).join('');

    page.innerHTML = `<aside class="plan-bucket"><h3>Viikon elokuvat</h3><div class="plan-bucket-list">${bucket}</div></aside><div class="plan-rooms">${boxes}</div>`;
    document.getElementById('suunnittelu-yhteensa').textContent = `${total} ${total === 1 ? 'näytös' : 'näytöstä'} · ${roster.length} elokuvaa`;

    // Dragging: bucket movies and cards both carry an id; cards also their theater.
    page.querySelectorAll('.plan-movie, .plan-card').forEach(el => {
      el.addEventListener('dragstart', e => {
        planDrag = { id: el.dataset.id, fromSali: el.dataset.sali ?? null };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.id);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); planDrag = null; clearPlanDropMarks(); });
    });
    page.querySelectorAll('.plan-room-list').forEach(list => {
      list.addEventListener('dragover', e => {
        if (!planDrag) return;
        e.preventDefault();
        showPlanDropLine(list, planDropIndex(list, e.clientY));
      });
      list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) clearPlanDropMarks(); });
      list.addEventListener('drop', e => {
        if (!planDrag) return;
        e.preventDefault();
        const { id, fromSali } = planDrag;
        const index = planDropIndex(list, e.clientY);
        editPlan(plan => placeInTheater(plan, id, list.dataset.sali, index, fromSali));
        buildPlanPage();
      });
    });
    const bucketEl = page.querySelector('.plan-bucket');
    bucketEl.addEventListener('dragover', e => { if (planDrag?.fromSali) { e.preventDefault(); bucketEl.classList.add('drop-target'); } });
    bucketEl.addEventListener('dragleave', e => { if (!bucketEl.contains(e.relatedTarget)) bucketEl.classList.remove('drop-target'); });
    bucketEl.addEventListener('drop', e => {
      if (!planDrag?.fromSali) return;
      e.preventDefault();
      const { id, fromSali } = planDrag;
      editPlan(plan => removeFromTheater(plan, id, fromSali));
      buildPlanPage();
    });

    // Card buttons
    page.querySelectorAll('.plan-card').forEach(cardEl => {
      const { id, sali } = cardEl.dataset;
      const card = () => getPlan()[sali].find(c => c.id === id);
      cardEl.querySelector('.plan-card-x').addEventListener('click', () => { editPlan(plan => removeFromTheater(plan, id, sali)); buildPlanPage(); });
      cardEl.querySelectorAll('.plan-day').forEach(btn => btn.addEventListener('click', () => {
        editPlan(() => {
          const c = card();
          const on = !c.paivat.includes(btn.dataset.paiva);
          c.paivat = ALL_PAIVAT.filter(p => p === btn.dataset.paiva ? on : c.paivat.includes(p));
          c.auto = false;
        });
        buildPlanPage();
      }));
      cardEl.querySelector('.plan-card-reset')?.addEventListener('click', () => { editPlan(() => { card().auto = true; }); buildPlanPage(); });
    });
  }

  // Where in a theater's list a drop at clientY goes, counted without the
  // dragged card itself: before the first other card whose midpoint is
  // below the cursor, or at the end.
  function planDropIndex(list, clientY) {
    const cards = [...list.querySelectorAll('.plan-card:not(.dragging)')];
    const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return clientY < r.top + r.height / 2; });
    return i === -1 ? cards.length : i;
  }

  function showPlanDropLine(list, index) {
    clearPlanDropMarks();
    list.classList.add('drop-target');
    const line = document.createElement('div');
    line.className = 'plan-drop-line';
    const cards = [...list.querySelectorAll('.plan-card:not(.dragging)')];
    if (index < cards.length) list.insertBefore(line, cards[index]); else list.appendChild(line);
  }

  function clearPlanDropMarks() {
    document.querySelectorAll('.plan-drop-line').forEach(l => l.remove());
    document.querySelectorAll('#suunnittelu-panel .drop-target').forEach(el => el.classList.remove('drop-target'));
  }

  // Fills the week from the plan, replacing whatever is on the grid (after a
  // yes), then opens it in Ohjelmointi for adjusting. One undo step.
  function fillProgram() {
    const roster = rosterMovies();
    if (roster.length === 0) { alert('Lisää ensin elokuvia viikkoon.'); return; }
    const plan = getPlan();
    if (SALAT.every(s => plan[s].length === 0)) { alert('Raahaa ensin elokuvia saleihin.'); return; }
    const outside = roster.filter(m => !SALAT.some(s => plan[s].some(c => c.id === m.id)));

    const alku = currentSchedule.viikkoAlku ?? (document.getElementById('viikko-alku').value || nextFriday());
    const loppu = currentSchedule.viikkoLoppu ?? (document.getElementById('viikko-loppu').value || addDays(alku, 6));
    const { naytokset, warnings, dropped } = Scheduler.populate(new Map(roster.map(m => [m.id, m])), plan, Storage.getSettings(), alku, loppu);

    const existing = currentSchedule.naytokset.length;
    let msg = existing > 0 ? `Nykyiset ${existing} näytöstä korvataan suunnitelman mukaisilla.` : '';
    if (outside.length) msg += `${msg ? '\n\n' : ''}Näitä elokuvia ei ole missään salissa, joten ne jäävät ilman näytöksiä:\n${outside.map(m => `• ${m.nimi}`).join('\n')}`;
    // Shows past midnight are never placed: a day too full for its theater
    // keeps its higher-priority shows, and the user hears which are left out.
    if (dropped.length) msg += `${msg ? '\n\n' : ''}Nämä eivät mahdu klo 24 mennessä, joten ne jäävät pois:\n${dropped.map(d => `• ${d.paiva} ${d.sali.replace('STUDIO ', 'Studio ')}: ${d.nimi}`).join('\n')}`;
    if (msg && !confirm(`${msg}\n\nJatketaanko?`)) return;

    pushUndo();
    currentSchedule.viikkoAlku = alku;
    currentSchedule.viikkoLoppu = loppu;
    currentSchedule.naytokset = naytokset;
    Storage.saveSchedule(currentSchedule);
    document.querySelector('.tab-btn[data-tab="ohjelmointi"]')?.click();
    if (warnings.length) showWarning(warnings.join('\n'));
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


    // Week movie picker - reachable from both the Ohjelmointi list and the
    // Suunnittelu page
    document.getElementById('btn-lisaa-viikkoon').addEventListener('click', openPicker);
    document.getElementById('btn-suunnittelu-lisaa').addEventListener('click', openPicker);
    document.getElementById('btn-tayta-ohjelma').addEventListener('click', fillProgram);
    document.getElementById('elokuva-lista').addEventListener('dragover', onRowDragOver);
    document.getElementById('aikataulu-grid').addEventListener('mousedown', onGridMouseDown);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && selectedIds.size && panelActive('ohjelmointi-panel')) setSelection(new Set());
    });
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
      if (!['ohjelmointi-panel', 'suunnittelu-panel'].some(p => document.getElementById(p).classList.contains('active'))) return;
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
    document.getElementById('edit-elokuva').addEventListener('change', onEditMovieChange);
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

  return { init, buildWeekPanel, renderGrid, buildPlanPage };
})();

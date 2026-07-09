'use strict';

const Library = (() => {
  const SALAT = ['STUDIO 1', 'STUDIO 2', 'STUDIO 3'];
  const IKARAJAT = ['S', 'K-7', 'K-12', 'K-16', 'K-18'];

  let movies = [];
  let editingId = null;

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function validateMovieFields(nimi, kesto, hinta) {
    if (!nimi) return { valid: false, error: 'Nimi on pakollinen.' };
    if (!kesto || kesto < 1 || kesto > 600) return { valid: false, error: 'Kesto pitää olla 1–600 minuuttia.' };
    if (isNaN(hinta) || hinta < 0) return { valid: false, error: 'Tarkista hinta.' };
    return { valid: true, error: null };
  }

  // Case/whitespace-insensitive key for matching movie names across imports -
  // real historical schedule exports have been seen with stray trailing spaces.
  function normalizeName(s) {
    return String(s).trim().replace(/\s+/g, ' ').toLocaleLowerCase('fi-FI');
  }

  // Family-film ticket prices are consistently a single fixed value in
  // reference data (the configurable Asetukset threshold, default 12.50€) -
  // used to default lastenelokuva on import when the source doesn't already
  // say otherwise (never used to weaken an explicit `true`).
  function isChildPriced(hinta) {
    const hintaraja = Storage.getSettings().lastenelokuva?.hintaraja;
    return hintaraja != null && !isNaN(hinta) && hinta === hintaraja;
  }

  function render() {
    const tbody = document.getElementById('kirjasto-tbody');
    tbody.innerHTML = '';

    if (movies.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px">Ei elokuvia kirjastossa. Lisää uusi elokuva.</td></tr>';
      return;
    }

    movies.forEach(m => {
      const badge = m.lastenelokuva ? '<span class="badge badge-lastenelokuva">Lastenelokuva</span>' : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(m.nimi)}</td>
        <td>${m.kesto} min</td>
        <td>${badge}</td>
        <td>${escHtml(m.ikäraja)}</td>
        <td>${m.hinta.toFixed(2)} €</td>
        <td>${escHtml(m.jakelija)}</td>
        <td class="actions">
          <button class="btn-icon" onclick="Library.openEdit('${m.id}')" title="Muokkaa">✏️</button>
          <button class="btn-icon btn-danger" onclick="Library.deleteMovie('${m.id}')" title="Poista">🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function openModal(movie) {
    editingId = movie ? movie.id : null;

    document.getElementById('modal-otsikko').textContent = movie ? 'Muokkaa elokuvaa' : 'Lisää elokuva';
    document.getElementById('el-nimi').value = movie ? movie.nimi : '';
    document.getElementById('el-kesto').value = movie ? movie.kesto : '';
    document.getElementById('el-ikäraja').value = movie ? movie.ikäraja : 'K-12';
    document.getElementById('el-hinta').value = movie ? movie.hinta : '';
    document.getElementById('el-jakelija').value = movie ? movie.jakelija : '';
    document.getElementById('el-lastenelokuva').checked = movie ? !!movie.lastenelokuva : false;
    document.getElementById('el-error').textContent = '';

    document.getElementById('elokuva-modal').classList.add('open');
    document.getElementById('el-nimi').focus();
  }

  function closeModal() {
    document.getElementById('elokuva-modal').classList.remove('open');
    editingId = null;
  }

  function saveModal() {
    const nimi = document.getElementById('el-nimi').value.trim();
    const kesto = parseInt(document.getElementById('el-kesto').value, 10);
    const ikäraja = document.getElementById('el-ikäraja').value;
    const hinta = parseFloat(document.getElementById('el-hinta').value);
    const jakelija = document.getElementById('el-jakelija').value.trim();
    const lastenelokuva = document.getElementById('el-lastenelokuva').checked;

    const errEl = document.getElementById('el-error');
    const { valid, error } = validateMovieFields(nimi, kesto, hinta);
    if (!valid) { errEl.textContent = error; return; }

    if (editingId) {
      const idx = movies.findIndex(m => m.id === editingId);
      if (idx !== -1) movies[idx] = { ...movies[idx], nimi, kesto, ikäraja, hinta, jakelija, lastenelokuva };
    } else {
      movies.push({ id: generateId(), nimi, kesto, ikäraja, hinta, jakelija, lastenelokuva });
    }

    Storage.saveMovies(movies);
    closeModal();
    render();
  }

  function deleteMovie(id) {
    if (!confirm('Poistetaanko elokuva kirjastosta?')) return;
    movies = movies.filter(m => m.id !== id);
    Storage.saveMovies(movies);
    render();
  }

  // ── CSV export ──────────────────────────────────────────────────────────

  function csvEscapeField(value) {
    const s = String(value ?? '');
    return /["\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function moviesToCsv(movieList) {
    const header = ['nimi', 'kesto_min', 'ikaraja', 'hinta_eur', 'jakelija', 'lastenelokuva'];
    const lines = [header.join(',')];
    movieList.forEach(m => lines.push([
      csvEscapeField(m.nimi),
      csvEscapeField(m.kesto),
      csvEscapeField(m.ikäraja),
      csvEscapeField(m.hinta.toFixed(2)),
      csvEscapeField(m.jakelija || ''),
      csvEscapeField(m.lastenelokuva ? 'true' : 'false'),
    ].join(',')));
    return lines.join('\r\n');
  }

  function downloadBlob(filename, mimeType, content) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportMoviesToCsv() {
    const csv = '﻿' + moviesToCsv(movies); // BOM so Finnish characters survive in Excel
    const today = new Date().toISOString().slice(0, 10);
    downloadBlob(`Kirjasto ${today}.csv`, 'text/csv;charset=utf-8', csv);
  }

  // ── CSV import parsing ──────────────────────────────────────────────────

  // Hand-rolled RFC4180 parser - real movie names can contain commas/quotes,
  // so a naive line.split(',') would silently corrupt data.
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
  }

  const CSV_HEADER_ALIASES = {
    nimi: ['nimi'],
    kesto: ['kesto_min', 'kesto'],
    ikäraja: ['ikaraja', 'ikäraja'],
    hinta: ['hinta_eur', 'hinta'],
    jakelija: ['jakelija'],
    lastenelokuva: ['lastenelokuva'],
  };

  function mapCsvHeader(headerRow) {
    const norm = headerRow.map(h => h.trim().toLowerCase());
    const idx = {};
    Object.entries(CSV_HEADER_ALIASES).forEach(([field, aliases]) => {
      idx[field] = norm.findIndex(h => aliases.includes(h));
    });
    return idx;
  }

  // The same movie name can appear on multiple rows (once per screening, when
  // importing a schedule export rather than a clean movie list) - fold repeats
  // into one candidate, keeping the first non-blank distributor and flagging
  // any disagreement between rows so the preview can surface it as a warning.
  function foldByName(rawRows) {
    const byName = new Map();
    rawRows.forEach(r => {
      const key = normalizeName(r.nimi);
      if (!key) return;
      if (!byName.has(key)) {
        byName.set(key, { ...r, occurrences: 1, inconsistent: false });
      } else {
        const e = byName.get(key);
        e.occurrences++;
        if (!e.jakelija && r.jakelija) e.jakelija = r.jakelija;
        if (r.lastenelokuva) e.lastenelokuva = true;
        if ((r.kesto != null && r.kesto !== e.kesto) ||
            (r.hinta != null && r.hinta !== e.hinta) ||
            (r.ikäraja && r.ikäraja !== e.ikäraja)) {
          e.inconsistent = true;
        }
      }
    });
    return Array.from(byName.values());
  }

  function parseCsvMovies(text) {
    const rows = parseCsv(text);
    if (rows.length === 0) return { candidates: [], warnings: ['Tiedosto on tyhjä.'] };
    const idx = mapCsvHeader(rows[0]);
    if (idx.nimi === -1) return { candidates: [], warnings: ["Saraketta 'nimi' ei löytynyt CSV-tiedostosta."] };

    const raw = rows.slice(1)
      .filter(r => r.some(c => c.trim() !== ''))
      .map(r => {
        let ikäraja = (r[idx.ikäraja] || '').trim().toUpperCase();
        if (!IKARAJAT.includes(ikäraja)) ikäraja = 'K-12';
        const lastenRaw = (r[idx.lastenelokuva] || '').trim().toLowerCase();
        const hinta = parseFloat((r[idx.hinta] || '').replace(',', '.'));
        return {
          nimi: (r[idx.nimi] || '').trim(),
          kesto: parseInt(r[idx.kesto], 10),
          ikäraja,
          hinta,
          jakelija: (r[idx.jakelija] || '').trim(),
          lastenelokuva: ['true', '1', 'kyllä', 'yes', 'x'].includes(lastenRaw) || isChildPriced(hinta),
        };
      });

    const candidates = foldByName(raw).map(c => {
      const { valid, error } = validateMovieFields(c.nimi, c.kesto, c.hinta);
      return { ...c, invalid: !valid, invalidReason: error };
    });
    return { candidates, warnings: [] };
  }

  // ── Excel schedule import parsing ───────────────────────────────────────

  const PAIVAT = new Set(['PE', 'LA', 'SU', 'MA', 'TI', 'KE', 'TO']);

  // Real files (and this app's own export.js output) mix cell types: duration
  // and start time can be a literal "HH:MM"/"HH.MM" string, or an Excel time
  // fraction (0.0625 == 90 minutes); price can be a plain number or "12.50 €".
  function cellToDurationMinutes(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v < 2 ? Math.round(v * 1440) : Math.round(v);
    const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  function cellToPrice(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace('€', '').replace(',', '.').trim());
    return isNaN(n) ? null : n;
  }

  function parseExcelSchedule(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    const raw = [];
    const warnings = [];

    aoa.forEach((row, idx) => {
      if (idx === 0) return; // fixed title row at the top of every export
      if (!row || row.every(c => c == null || String(c).trim() === '')) return; // blank row (below the title, or a separator between theater blocks)

      const [, paivaCell, , nimiCell, kestoCell, ikärajaCell, hintaCell, jakelijaCell] = row;
      const nimi = nimiCell != null ? String(nimiCell).trim() : '';
      const paiva = paivaCell != null ? String(paivaCell).trim().toUpperCase() : '';

      if (!nimi) {
        if (!PAIVAT.has(paiva)) {
          // No movie name and not a day code - this is the trailing opening-hours
          // summary row, not a screening. Anything else unrecognized just skips quietly.
        }
        return;
      }

      let ikäraja = ikärajaCell != null ? String(ikärajaCell).trim().toUpperCase() : 'K-12';
      if (!IKARAJAT.includes(ikäraja)) ikäraja = 'K-12';

      const hinta = cellToPrice(hintaCell);
      raw.push({
        nimi,
        kesto: cellToDurationMinutes(kestoCell),
        ikäraja,
        hinta,
        jakelija: jakelijaCell != null ? String(jakelijaCell).trim() : '',
        lastenelokuva: isChildPriced(hinta), // not otherwise recoverable from a schedule export
      });
    });

    const candidates = foldByName(raw).map(c => {
      const { valid, error } = validateMovieFields(c.nimi, c.kesto, c.hinta);
      return { ...c, invalid: !valid, invalidReason: error };
    });
    return { candidates, warnings };
  }

  // ── Import preview modal ────────────────────────────────────────────────

  let importCandidates = [];

  function markDuplicatesAgainstLibrary(candidates) {
    const existing = new Set(movies.map(m => normalizeName(m.nimi)));
    return candidates.map(c => {
      const isDuplicate = existing.has(normalizeName(c.nimi));
      return { ...c, tempId: generateId(), isDuplicate, selected: !isDuplicate && !c.invalid };
    });
  }

  function handleImportFile(file) {
    const name = file.name.toLowerCase();
    const reader = new FileReader();
    reader.onerror = () => alert('Tiedostoa ei voitu lukea.');
    if (name.endsWith('.csv')) {
      reader.onload = e => openImportPreview(parseCsvMovies(e.target.result));
      reader.readAsText(file, 'utf-8');
    } else if (name.endsWith('.xlsx')) {
      reader.onload = e => openImportPreview(parseExcelSchedule(e.target.result));
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.xls')) {
      alert('Vanhaa .xls-muotoa ei tueta. Tallenna tiedosto .xlsx- tai .csv-muotoon ja yritä uudelleen.');
    } else {
      alert('Tuntematon tiedostomuoto. Käytä .csv- tai .xlsx-tiedostoa.');
    }
  }

  function openImportPreview({ candidates, warnings }) {
    importCandidates = markDuplicatesAgainstLibrary(candidates);

    const warnEl = document.getElementById('tuonti-warnings');
    const rowWarnings = candidates.filter(c => c.inconsistent).length;
    const allWarnings = [...warnings];
    if (rowWarnings > 0) allWarnings.push(`${rowWarnings} elokuvalla oli ristiriitaisia tietoja eri riveillä - tarkista arvot.`);
    warnEl.innerHTML = allWarnings.map(w => escHtml(w)).join('<br>');

    document.getElementById('tuonti-error').textContent = '';
    if (importCandidates.length === 0) {
      document.getElementById('tuonti-error').textContent = 'Tiedostosta ei löytynyt yhtään elokuvaa.';
    }

    renderImportTable();
    document.getElementById('tuonti-modal').classList.add('open');
  }

  function renderImportTable() {
    const tbody = document.getElementById('tuonti-tbody');
    tbody.innerHTML = '';

    importCandidates.forEach(c => {
      const tr = document.createElement('tr');
      tr.dataset.id = c.tempId;
      if (c.isDuplicate) tr.classList.add('row-duplicate');
      if (c.invalid) tr.classList.add('row-invalid');

      const disabled = c.isDuplicate || c.invalid;
      const statusText = c.isDuplicate ? 'Jo kirjastossa' : (c.invalid ? c.invalidReason : '');

      tr.innerHTML = `
        <td><input type="checkbox" class="tuonti-check" ${c.selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
        <td><input type="text" class="tuonti-field" data-field="nimi" value="${escHtml(c.nimi)}"></td>
        <td><input type="number" class="tuonti-field" data-field="kesto" value="${c.kesto ?? ''}" style="width:60px"></td>
        <td>
          <select class="tuonti-field" data-field="ikäraja">
            ${IKARAJAT.map(r => `<option value="${r}" ${c.ikäraja === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </td>
        <td><input type="number" class="tuonti-field" data-field="hinta" value="${c.hinta ?? ''}" step="0.50" style="width:70px"></td>
        <td><input type="text" class="tuonti-field" data-field="jakelija" value="${escHtml(c.jakelija || '')}" style="width:70px"></td>
        <td><input type="checkbox" class="tuonti-field" data-field="lastenelokuva" ${c.lastenelokuva ? 'checked' : ''}></td>
        <td class="tuonti-status">${escHtml(statusText)}</td>
      `;
      tbody.appendChild(tr);
    });

    updateImportSummary();
  }

  function updateImportSummary() {
    const dup = importCandidates.filter(c => c.isDuplicate).length;
    const invalid = importCandidates.filter(c => c.invalid).length;
    const selected = importCandidates.filter(c => c.selected && !c.isDuplicate && !c.invalid).length;
    let text = `${selected} valittu tuotavaksi`;
    if (dup > 0) text += `, ${dup} jo kirjastossa (ohitetaan)`;
    if (invalid > 0) text += `, ${invalid} virheellistä riviä`;
    document.getElementById('tuonti-summary').textContent = text;

    const selectAll = document.getElementById('tuonti-select-all');
    const selectable = importCandidates.filter(c => !c.isDuplicate && !c.invalid);
    selectAll.checked = selectable.length > 0 && selectable.every(c => c.selected);
  }

  function onImportTableChange(e) {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const c = importCandidates.find(x => x.tempId === tr.dataset.id);
    if (!c) return;

    if (e.target.classList.contains('tuonti-check')) {
      c.selected = e.target.checked;
      updateImportSummary();
      return;
    }

    if (e.target.classList.contains('tuonti-field')) {
      const field = e.target.dataset.field;
      if (field === 'lastenelokuva') {
        c.lastenelokuva = e.target.checked;
        return;
      }
      if (field === 'kesto') c.kesto = parseInt(e.target.value, 10);
      else if (field === 'hinta') c.hinta = parseFloat(e.target.value);
      else c[field] = e.target.value;

      // Editing name/duration/price can change validity or duplicate status live.
      const { valid, error } = validateMovieFields(c.nimi, c.kesto, c.hinta);
      c.invalid = !valid;
      c.invalidReason = error;
      const existing = new Set(movies.map(m => normalizeName(m.nimi)));
      c.isDuplicate = existing.has(normalizeName(c.nimi));
      if (c.isDuplicate || c.invalid) c.selected = false;
      renderImportTable();
    }
  }

  function onImportSelectAll(e) {
    const checked = e.target.checked;
    importCandidates.forEach(c => {
      if (!c.isDuplicate && !c.invalid) c.selected = checked;
    });
    renderImportTable();
  }

  function closeImportModal() {
    document.getElementById('tuonti-modal').classList.remove('open');
    importCandidates = [];
  }

  function commitImport() {
    const toAdd = importCandidates
      .filter(c => c.selected && !c.isDuplicate && !c.invalid)
      .map(c => ({
        id: generateId(),
        nimi: c.nimi.trim(),
        kesto: c.kesto,
        ikäraja: c.ikäraja,
        hinta: c.hinta,
        jakelija: c.jakelija,
        lastenelokuva: !!c.lastenelokuva,
      }));

    if (toAdd.length === 0) {
      document.getElementById('tuonti-error').textContent = 'Ei valittuja elokuvia tuotavaksi.';
      return;
    }

    movies = movies.concat(toAdd);
    Storage.saveMovies(movies);
    closeImportModal();
    render();
  }

  function init() {
    movies = Storage.getMovies();

    document.getElementById('btn-lisaa-elokuva').addEventListener('click', () => openModal(null));
    document.getElementById('btn-modal-tallenna').addEventListener('click', saveModal);
    document.getElementById('btn-modal-peruuta').addEventListener('click', closeModal);
    document.getElementById('elokuva-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });

    // Auto-tick "Lastenelokuva" when adding a NEW movie (never for an existing
    // one being edited) at the configured family-film price - the user can
    // still untick it manually before saving.
    document.getElementById('el-hinta').addEventListener('input', e => {
      if (editingId !== null) return;
      const hinta = parseFloat(e.target.value);
      const hintaraja = Storage.getSettings().lastenelokuva?.hintaraja;
      if (!isNaN(hinta) && hintaraja != null && hinta === hintaraja) {
        document.getElementById('el-lastenelokuva').checked = true;
      }
    });

    document.getElementById('btn-vie-csv').addEventListener('click', exportMoviesToCsv);

    const tuontiInput = document.getElementById('tuonti-tiedosto');
    document.getElementById('btn-tuo-elokuvat').addEventListener('click', () => tuontiInput.click());
    tuontiInput.addEventListener('change', () => {
      if (tuontiInput.files[0]) handleImportFile(tuontiInput.files[0]);
      tuontiInput.value = '';
    });

    document.getElementById('btn-tuonti-peruuta').addEventListener('click', closeImportModal);
    document.getElementById('btn-tuonti-tallenna').addEventListener('click', commitImport);
    document.getElementById('tuonti-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeImportModal();
    });
    document.getElementById('tuonti-tbody').addEventListener('change', onImportTableChange);
    document.getElementById('tuonti-select-all').addEventListener('change', onImportSelectAll);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal(); closeImportModal(); }
    });

    render();
  }

  return {
    init,
    render,
    openAdd: () => openModal(null),
    openEdit: (id) => openModal(movies.find(m => m.id === id)),
    deleteMovie,
    getAll: () => movies,
    refresh: () => { movies = Storage.getMovies(); render(); },
  };
})();

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

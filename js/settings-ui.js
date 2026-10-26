'use strict';

const SettingsUI = (() => {
  const PAIVAT = ['PE', 'LA', 'SU', 'MA', 'TI', 'KE', 'TO'];
  const PAIVA_NIMET = { PE:'Perjantai', LA:'Lauantai', SU:'Sunnuntai', MA:'Maanantai', TI:'Tiistai', KE:'Keskiviikko', TO:'Torstai' };

  const COL_NIMET = {
    A: 'Sali',
    B: 'Päivä',
    C: 'Aika',
    D: 'Elokuva',
    E: 'Kesto',
    F: 'Ikäraja',
    G: 'Hinta',
    H: 'Levittäjä',
  };

  function render() {
    const settings = Storage.getSettings();

    // Column widths - eight short fields, laid out two across (A-D | E-H)
    // instead of an eight-row table, which alone made the page scroll.
    const widths = document.getElementById('col-widths');
    widths.innerHTML = Object.entries(COL_NIMET).map(([col, nimi]) => `
      <label><span><b>${col}</b> ${nimi}</span>
        <input type="number" class="col-width-input" data-col="${col}" min="1" max="100"
               value="${settings.sarakeleveydet?.[col] ?? 8}"></label>`).join('');

    // Operating hours - unchecked days show (and use) the built-in default and
    // are disabled; checking "manuaalinen" pins that day to whatever's in the
    // time inputs when settings are saved.
    const tbody = document.getElementById('hours-tbody');
    tbody.innerHTML = '';
    PAIVAT.forEach(p => {
      const h = settings.aukioloajat[p];
      const manual = !!settings.aukioloajat_yliajot?.[p];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${PAIVA_NIMET[p]}</td>
        <td><input type="checkbox" class="hours-manual" data-paiva="${p}" ${manual ? 'checked' : ''}></td>
        <td><input type="time" data-paiva="${p}" data-field="avautuu" value="${h.avautuu}" ${manual ? '' : 'disabled'}></td>
        <td><input type="time" data-paiva="${p}" data-field="sulkeutuu" value="${h.sulkeutuu}" ${manual ? '' : 'disabled'}></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.hours-manual').forEach(cb => {
      cb.addEventListener('change', () => {
        const row = cb.closest('tr');
        row.querySelectorAll('input[data-field]').forEach(inp => { inp.disabled = !cb.checked; });
      });
    });

    // Gap inputs
    document.getElementById('gap-sama').value = settings.minimivali_sama_sali;
    document.getElementById('gap-eri').value = settings.minimivali_eri_sali;
    document.getElementById('raahaus-tarkkuus').value = String(settings.raahaus_tarkkuus ?? 5);

    // Excel opening times
    document.getElementById('aukiolo-ennen').value = settings.aukiolo_excel?.avautuu_ennen_min ?? 30;
    document.getElementById('aukiolo-sulku').value = settings.aukiolo_excel?.sulkeutuu_offset_min ?? 0;

    // Lastenelokuva time window
    renderLastenRules(settings);

    // The form now shows exactly what is stored.
    setDirty(false);
  }

  function renderLastenRules(settings) {
    const container = document.getElementById('kat-rules-container');
    container.innerHTML = '';

    // (Which days a kids' film plays is chosen per movie on the Suunnittelu
    // page now, so the old "Esitetään päivinä" list is gone.)
    const lasten = settings.lastenelokuva;

    const section = document.createElement('div');
    section.innerHTML = `
      <div class="set-fields">
        <label for="lasten-aikaisintaan">Aikaisintaan</label>
        <input type="time" id="lasten-aikaisintaan" value="${lasten.aikaisintaan}">
        <label for="lasten-viimeistaan">Viimeistään</label>
        <input type="time" id="lasten-viimeistaan" value="${lasten.viimeistaan}">
        <label for="lasten-hintaraja">Hinta (auto-tunnistus)</label>
        <input type="number" id="lasten-hintaraja" min="0" step="0.5" value="${lasten.hintaraja ?? 12.5}">
      </div>
    `;
    container.appendChild(section);
  }

  function save() {
    const settings = Storage.getSettings();

    // Hours - only days with "manuaalinen" checked get persisted as an override;
    // unchecked days are dropped from the override map so they keep tracking
    // whatever the app's built-in default is.
    if (!settings.aukioloajat_yliajot) settings.aukioloajat_yliajot = {};
    document.querySelectorAll('#hours-tbody tr').forEach(row => {
      const p = row.querySelector('.hours-manual').dataset.paiva;
      const manual = row.querySelector('.hours-manual').checked;
      if (manual) {
        const avautuu = row.querySelector('[data-field="avautuu"]').value;
        const sulkeutuu = row.querySelector('[data-field="sulkeutuu"]').value;
        settings.aukioloajat_yliajot[p] = { avautuu, sulkeutuu };
      } else {
        delete settings.aukioloajat_yliajot[p];
      }
    });

    // Gaps
    const sama = parseInt(document.getElementById('gap-sama').value, 10);
    const eri  = parseInt(document.getElementById('gap-eri').value, 10);
    if (!isNaN(sama) && sama >= 0) settings.minimivali_sama_sali = sama;
    if (!isNaN(eri)  && eri  >= 0) settings.minimivali_eri_sali  = eri;
    const tarkkuus = parseInt(document.getElementById('raahaus-tarkkuus').value, 10);
    if ([1, 5, 10, 15, 30].includes(tarkkuus)) settings.raahaus_tarkkuus = tarkkuus;

    // Lastenelokuva time window
    const lastenAik = document.getElementById('lasten-aikaisintaan').value;
    const lastenVii = document.getElementById('lasten-viimeistaan').value;
    if (lastenAik) settings.lastenelokuva.aikaisintaan = lastenAik;
    if (lastenVii) settings.lastenelokuva.viimeistaan = lastenVii;
    const hintaraja = parseFloat(document.getElementById('lasten-hintaraja').value);
    if (!isNaN(hintaraja) && hintaraja >= 0) settings.lastenelokuva.hintaraja = hintaraja;

    // Excel opening times
    const ennen = parseInt(document.getElementById('aukiolo-ennen').value, 10);
    const sulku = parseInt(document.getElementById('aukiolo-sulku').value, 10);
    if (!settings.aukiolo_excel) settings.aukiolo_excel = {};
    if (!isNaN(ennen) && ennen >= 0) settings.aukiolo_excel.avautuu_ennen_min = ennen;
    if (!isNaN(sulku)) settings.aukiolo_excel.sulkeutuu_offset_min = sulku;

    // Column widths
    if (!settings.sarakeleveydet) settings.sarakeleveydet = {};
    document.querySelectorAll('.col-width-input').forEach(inp => {
      const val = parseInt(inp.value, 10);
      if (!isNaN(val) && val >= 1) settings.sarakeleveydet[inp.dataset.col] = val;
    });

    Storage.saveSettings(settings);

    setDirty(false);
    const status = document.getElementById('asetukset-tila');
    status.textContent = '✓ Tallennettu';
    status.className = 'settings-status saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { if (!dirty) status.textContent = ''; }, 2500);
  }

  // ── Unsaved changes ───────────────────────────────────────────────────────
  // Nothing on this page takes effect until it is saved, and the rest of the
  // app reads only what is stored. So an edit that was never saved leaves the
  // form showing one value while the schedule editor works with another - a
  // gap setting typed as 15 while 45 is still in force, say. The page
  // therefore always says when it holds unsaved edits, and they are settled
  // before the user can get anywhere the old values would be used.
  let dirty = false;
  let savedTimer = null;

  function setDirty(value) {
    dirty = value;
    const status = document.getElementById('asetukset-tila');
    status.textContent = dirty ? '● Tallentamattomia muutoksia' : '';
    status.className = 'settings-status' + (dirty ? ' unsaved' : '');
  }

  // Leaving the tab with unsaved edits: save them or drop them, the user's
  // choice - never carry them along silently. (Dropping needs no work here:
  // the form is rebuilt from storage the next time the tab opens.)
  function leave() {
    if (!dirty) return;
    const saveThem = confirm(
      'Asetuksissa on tallentamattomia muutoksia.\n\n' +
      'OK = tallenna muutokset\nPeruuta = hylkää muutokset');
    if (saveThem) save(); else setDirty(false);
  }

  function init() {
    document.getElementById('btn-tallenna-asetukset').addEventListener('click', save);
    const panel = document.getElementById('asetukset-panel');
    panel.addEventListener('input', () => setDirty(true));
    panel.addEventListener('change', () => setDirty(true));
    window.addEventListener('beforeunload', e => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // Render on first load only if the tab is active (usually not)
  }

  return { init, render, leave };
})();

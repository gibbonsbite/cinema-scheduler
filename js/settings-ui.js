'use strict';

const SettingsUI = (() => {
  const PAIVAT = ['PE', 'LA', 'SU', 'MA', 'TI', 'KE', 'TO'];
  const PAIVA_NIMET = { PE:'Perjantai', LA:'Lauantai', SU:'Sunnuntai', MA:'Maanantai', TI:'Tiistai', KE:'Keskiviikko', TO:'Torstai' };

  const COL_NIMET = {
    A: 'Sali',
    B: 'Päivä',
    C: 'Aika',
    D: 'Elokuvan nimi',
    E: 'Kesto',
    F: 'Ikäraja',
    G: 'Hinta',
    H: 'Levittäjä',
  };

  function render() {
    const settings = Storage.getSettings();

    // Column widths
    const cwTbody = document.getElementById('col-widths-tbody');
    cwTbody.innerHTML = '';
    Object.entries(COL_NIMET).forEach(([col, nimi]) => {
      const val = settings.sarakeleveydet?.[col] ?? 8;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${col} – ${nimi}</td>
        <td><input type="number" class="col-width-input" data-col="${col}"
             min="1" max="100" value="${val}"
             style="width:55px;padding:3px 6px;border:1px solid #d0d6ea;border-radius:3px;font-size:0.85em"></td>
      `;
      cwTbody.appendChild(tr);
    });

    // Operating hours - unchecked days show (and use) the built-in default and
    // are disabled; checking "manuaalinen" pins that day to whatever's in the
    // time inputs when settings are saved.
    const tbody = document.getElementById('hours-tbody');
    tbody.innerHTML = '';
    PAIVAT.forEach(p => {
      const h = settings.aukioloajat[p];
      const manual = !!settings.aukioloajat_yliajot?.[p];
      const paino = settings.paivapainot?.[p] ?? '';
      const tavoite = settings.avautuu_tavoite?.[p] ?? '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${PAIVA_NIMET[p]}</td>
        <td><input type="checkbox" class="hours-manual" data-paiva="${p}" ${manual ? 'checked' : ''}></td>
        <td><input type="time" data-paiva="${p}" data-field="avautuu" value="${h.avautuu}" ${manual ? '' : 'disabled'}></td>
        <td><input type="time" class="tavoite-input" data-paiva="${p}" value="${tavoite}"></td>
        <td><input type="time" data-paiva="${p}" data-field="sulkeutuu" value="${h.sulkeutuu}" ${manual ? '' : 'disabled'}></td>
        <td><input type="number" class="paino-input" data-paiva="${p}" min="0" step="0.1" value="${paino}"
             style="width:58px;padding:3px 6px"></td>
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
    document.getElementById('min-per-sali').value = settings.min_naytoksia_salissa ?? 2;
    document.getElementById('viikko-naytokset').value = settings.naytoksia_viikossa ?? 45;

    // Excel opening times
    document.getElementById('aukiolo-ennen').value = settings.aukiolo_excel?.avautuu_ennen_min ?? 30;
    document.getElementById('aukiolo-sulku').value = settings.aukiolo_excel?.sulkeutuu_offset_min ?? 0;

    // Lastenelokuva time window
    renderLastenRules(settings);
  }

  function renderLastenRules(settings) {
    const container = document.getElementById('kat-rules-container');
    container.innerHTML = '';

    const lasten = settings.lastenelokuva;
    const dayChecks = PAIVAT.map(p => {
      const checked = lasten.paivat.includes(p) ? 'checked' : '';
      return `<label><input type="checkbox" class="lasten-paiva" data-paiva="${p}" ${checked}> ${p}</label>`;
    }).join('');

    const section = document.createElement('div');
    section.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="badge badge-lastenelokuva">Lastenelokuva</span>
      </div>
      <table class="kat-rules-table">
        <tr>
          <td style="width:120px;color:#666;font-size:0.83em">Aikaisintaan</td>
          <td><input type="time" id="lasten-aikaisintaan" value="${lasten.aikaisintaan}"></td>
        </tr>
        <tr>
          <td style="color:#666;font-size:0.83em">Viimeistään</td>
          <td><input type="time" id="lasten-viimeistaan" value="${lasten.viimeistaan}"></td>
        </tr>
        <tr>
          <td style="color:#666;font-size:0.83em">Hinta (auto-tunnistus)</td>
          <td><input type="number" id="lasten-hintaraja" min="0" step="0.5" value="${lasten.hintaraja ?? 12.5}" style="width:82px"></td>
        </tr>
      </table>
      <div style="margin-top:6px;font-size:0.82em;color:#666;margin-bottom:4px">Esitetään päivinä:</div>
      <div class="day-checkboxes">${dayChecks}</div>
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
    const minSali = parseInt(document.getElementById('min-per-sali').value, 10);
    if (!isNaN(minSali) && minSali >= 0) settings.min_naytoksia_salissa = minSali;
    const viikko = parseInt(document.getElementById('viikko-naytokset').value, 10);
    if (!isNaN(viikko) && viikko >= 1) settings.naytoksia_viikossa = viikko;

    // Day weights and opening-time targets
    if (!settings.paivapainot) settings.paivapainot = {};
    document.querySelectorAll('.paino-input').forEach(inp => {
      const val = parseFloat(inp.value);
      if (!isNaN(val) && val > 0) settings.paivapainot[inp.dataset.paiva] = val;
    });
    if (!settings.avautuu_tavoite) settings.avautuu_tavoite = {};
    document.querySelectorAll('.tavoite-input').forEach(inp => {
      if (inp.value) settings.avautuu_tavoite[inp.dataset.paiva] = inp.value;
    });

    // Lastenelokuva time window
    const lastenAik = document.getElementById('lasten-aikaisintaan').value;
    const lastenVii = document.getElementById('lasten-viimeistaan').value;
    if (lastenAik) settings.lastenelokuva.aikaisintaan = lastenAik;
    if (lastenVii) settings.lastenelokuva.viimeistaan = lastenVii;
    const lastenPaivat = [];
    document.querySelectorAll('.lasten-paiva').forEach(cb => {
      if (cb.checked) lastenPaivat.push(cb.dataset.paiva);
    });
    if (lastenPaivat.length > 0) settings.lastenelokuva.paivat = lastenPaivat;
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

    const msg = document.getElementById('asetukset-saved');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2500);
  }

  function init() {
    document.getElementById('btn-tallenna-asetukset').addEventListener('click', save);
    // Render on first load only if the tab is active (usually not)
  }

  return { init, render };
})();

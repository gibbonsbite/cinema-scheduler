'use strict';

const Exporter = (() => {
  const SALAT = ['STUDIO 1', 'STUDIO 2', 'STUDIO 3'];

  // Format minutes/1440 → Excel time serial (fraction of a day)
  function minutesToExcelTime(minutes) {
    return minutes / 1440;
  }

  // "HH:MM" → Excel time serial (fraction of a day), formatted as hh"."mm
  function toExcelTimeFraction(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return (h * 60 + m) / 1440;
  }

  // Finnish date string from ISO date + offset days
  function isoToPaiva(iso, offsetDays) {
    const d = new Date(iso);
    d.setDate(d.getDate() + offsetDays);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    return `${dd}.${mm}.${yy}`;
  }

  function exportToExcel(schedule) {
    const { viikkoAlku, viikkoLoppu, naytokset } = schedule;
    const paivat = Scheduler.getPaivat(viikkoAlku, viikkoLoppu);

    const isoLoppu = viikkoLoppu || (() => { const d = new Date(viikkoAlku); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })();
    const startDay = Scheduler.PAIVA_LYHYET[new Date(viikkoAlku).getDay()];
    const endDay   = Scheduler.PAIVA_LYHYET[new Date(isoLoppu).getDay()];
    const startFin = isoToPaiva(viikkoAlku, 0);
    const endFin   = isoToPaiva(isoLoppu, 0);
    const title = `OHJELMISTO: ${startDay} ${startFin} - ${endDay} ${endFin}`;

    const settings = Storage.getSettings();
    const wb = XLSX.utils.book_new();
    const rows = [];

    // Row 1: empty (row index 0 → Excel row 1)
    rows.push([null, null, null, null, null, null, null, null]);

    // Row 2: title in column D (index 3)
    rows.push([null, null, null, title, null, null, null, null]);

    // Row 3: empty separator
    rows.push([null, null, null, null, null, null, null, null]);

    const seenDistributors = new Set(); // movie IDs whose distributor has been written

    SALAT.forEach((sali, saliIdx) => {
      if (saliIdx > 0) {
        // blank row between theater blocks
        rows.push([null, null, null, null, null, null, null, null]);
      }

      let firstRowOfSali = true; // theater name only on the first screening row

      paivat.forEach(paiva => {
        const dayScreenings = naytokset
          .filter(n => n.sali === sali && n.paiva === paiva)
          .sort((a, b) => {
            const [ah, am] = a.alkaa.split(':').map(Number);
            const [bh, bm] = b.alkaa.split(':').map(Number);
            return (ah * 60 + am) - (bh * 60 + bm);
          });

        dayScreenings.forEach(n => {
          const movieKey = n.elokuvaId || n.nimi;
          const jakelija = seenDistributors.has(movieKey) ? null : n.jakelija;
          if (!seenDistributors.has(movieKey)) seenDistributors.add(movieKey);

          rows.push([
            firstRowOfSali ? sali : null,
            paiva,
            toExcelTimeFraction(n.alkaa),
            n.nimi,
            minutesToExcelTime(n.kesto),
            n.ikäraja,
            n.hinta,
            jakelija,
          ]);
          firstRowOfSali = false;
        });
      });
    });

    // Opening times row
    const PAIVA_LOWER = { PE:'Pe', LA:'La', SU:'Su', MA:'Ma', TI:'Ti', KE:'Ke', TO:'To' };
    const ennenMin = settings.aukiolo_excel?.avautuu_ennen_min ?? 30;
    const sulkuOffset = settings.aukiolo_excel?.sulkeutuu_offset_min ?? 0;
    const fmtDotTime = (min) => `${String(Math.floor(min / 60)).padStart(2,'0')}.${String(min % 60).padStart(2,'0')}`;

    const aukioloParts = paivat.map(paiva => {
      const starts = naytokset.filter(n => n.paiva === paiva).map(n => Scheduler.toMin(n.alkaa));
      if (starts.length === 0) return null;
      const avautuu = Math.min(...starts) - ennenMin;
      const sulkeutuu = Math.max(...starts) + sulkuOffset;
      return `${PAIVA_LOWER[paiva]} ${fmtDotTime(avautuu)}-${fmtDotTime(sulkeutuu)}`;
    }).filter(Boolean);

    rows.push([null, null, null, null, null, null, null, null]); // separator
    rows.push([aukioloParts.join(' '), null, null, null, null, null, null, null]);
    const aukioloRowExcel = rows.length; // 1-indexed Excel row number of this row

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Column widths from settings (editable in Asetukset tab)
    const cw = settings.sarakeleveydet || {};
    ws['!cols'] = ['A','B','C','D','E','F','G','H'].map(col => ({ wch: cw[col] ?? 8 }));
    ws['!cols'].push({ wch: 2 }); // column I — narrow, exists only for the right border

    // Apply number formats, Arial 9pt, and bold (A–D) to data rows (row 4 onward)
    const BOLD_COLS = new Set(['A','B','C','D']);
    Object.keys(ws).forEach(addr => {
      if (addr.startsWith('!')) return;
      const col = addr.replace(/[0-9]/g, '');
      const rowNum = parseInt(addr.replace(/[A-Z]/g, ''), 10);
      if (rowNum < 4 || rowNum === aukioloRowExcel) return;
      const cell = ws[addr];
      if (!cell) return;
      if (cell.t === 'n') {
        if (col === 'C') cell.z = 'hh"."mm';
        if (col === 'E') cell.z = '[h]:mm';
        if (col === 'G') cell.z = '#,##0.00" €"';
      }
      cell.s = {
        font: {
          name: col === 'A' ? 'Arial Black' : 'Arial',
          sz: 9,
          bold: BOLD_COLS.has(col),
        },
        ...(col === 'C' && { alignment: { horizontal: 'left' } }),
      };
    });

    // Opening times row: bold Arial + box border across A–I, merged into a
    // single cell.
    //
    // The whole week's hours are one long string (~104 chars) written to column
    // A, which is far narrower than the text. Excel only spills a cell's text
    // into neighbouring cells that are truly EMPTY, and A's neighbours are not:
    // they carry the box border, and this writer drops any cell that has no
    // value at all, so each one has to hold an empty string to exist. Excel
    // reads those as occupied and clipped the line at column A's width (82px);
    // LibreOffice ignores empty strings and spilled it, which is why the row
    // only looked right there. Merging the row's cells into one wide cell puts
    // the text in a cell that is genuinely wide enough (A–I is 614px against
    // the string's 593px at Arial 9 bold) and renders the same in both.
    const AUKIOLO_COLS = ['A','B','C','D','E','F','G','H','I'];
    const aukioloRow0 = aukioloRowExcel - 1; // 0-indexed row for the merge range
    ws['!merges'] = [{ s: { r: aukioloRow0, c: 0 }, e: { r: aukioloRow0, c: AUKIOLO_COLS.length - 1 } }];
    AUKIOLO_COLS.forEach((col, i) => {
      const addr = `${col}${aukioloRowExcel}`;
      if (!ws[addr]) ws[addr] = { t: 's', v: '' };
      ws[addr].s = {
        font: { name: 'Arial', sz: 9, bold: true },
        border: {
          top:    { style: 'thin' },
          bottom: { style: 'thin' },
          ...(i === 0                        && { left:  { style: 'thin' } }),
          ...(i === AUKIOLO_COLS.length - 1  && { right: { style: 'thin' } }),
        },
      };
    });
    // Extend sheet ref to include column I
    if (ws['!ref']) {
      ws['!ref'] = ws['!ref'].replace(/:([A-Z]+)(\d+)$/, (_, c, r) => ':' + (c >= 'I' ? c : 'I') + r);
    }

    // Title cell: Arial Black, underline
    const titleCellAddr = XLSX.utils.encode_cell({ r: 1, c: 3 });
    if (ws[titleCellAddr]) {
      ws[titleCellAddr].s = { font: { name: 'Arial Black', bold: true, sz: 12, underline: true } };
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Ohjelma');

    const shortYear = startFin.slice(8);
    const filename = `Ohjelmisto ${startFin.slice(0, 6)}${shortYear}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  // ── Import: parse a schedule workbook in this same format back into
  //    screenings ─────────────────────────────────────────────────────────
  //
  // Reads the exact layout exportToExcel writes (which is also the layout of
  // the historical reference files): positional columns
  // [Sali, Paiva, Aika, Nimi, Kesto, Ikaraja, Hinta, Jakelija], the theater
  // name only on its block's first row (forward-filled here), a title row
  // "OHJELMISTO: PE 10.07.2026 - TO 16.07.2026" giving the week's dates, and
  // a trailing opening-hours summary row (ignored - hours are derived from
  // the showings themselves).

  const PAIVA_KOODIT = new Set(['PE', 'LA', 'SU', 'MA', 'TI', 'KE', 'TO']);

  // Duration/time cells can be an Excel time fraction (raw number < 2) or a
  // "H:MM"/"H.MM" string, depending on which program wrote the file.
  function cellToMinutes(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v < 2 ? Math.round(v * 1440) : Math.round(v);
    const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})$/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  function cellToPrice(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace('€', '').replace(',', '.').trim());
    return isNaN(n) ? null : n;
  }

  function parseScheduleWorkbook(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    const screenings = [];
    const warnings = [];
    let viikkoAlku = null;
    let viikkoLoppu = null;
    let currentSali = null;

    // Week dates from the title row ("... PE 10.07.2026 - TO 16.07.2026")
    for (const row of aoa.slice(0, 6)) {
      const cell = (row || []).find(c => typeof c === 'string' && /OHJELMISTO/i.test(c));
      if (!cell) continue;
      const dates = [...cell.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)]
        .map(m => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
      if (dates.length >= 1) viikkoAlku = dates[0];
      if (dates.length >= 2) viikkoLoppu = dates[1];
      break;
    }

    aoa.forEach(row => {
      if (!row || row.every(c => c == null || String(c).trim() === '')) return;
      const [saliCell, paivaCell, aikaCell, nimiCell, kestoCell, ikärajaCell, hintaCell, jakelijaCell] = row;

      const nimi = nimiCell != null ? String(nimiCell).trim() : '';
      const paiva = paivaCell != null ? String(paivaCell).trim().toUpperCase() : '';
      if (!nimi || !PAIVA_KOODIT.has(paiva)) return; // title, separators, opening-hours summary

      // Theater carries forward from its block's first row. Only a screening
      // row may update it - the opening-hours summary also writes column A,
      // but never reaches here.
      if (saliCell != null && String(saliCell).trim() !== '') {
        const norm = String(saliCell).trim().toUpperCase();
        const match = SALAT.find(s => s === norm);
        if (match) {
          currentSali = match;
        } else {
          warnings.push(`Tuntematon sali "${String(saliCell).trim()}" - rivit ohitettu.`);
          currentSali = null;
        }
      }
      if (!currentSali) return;

      const alkaaMin = cellToMinutes(aikaCell);
      const kesto = cellToMinutes(kestoCell);
      if (alkaaMin == null || kesto == null || kesto < 1) {
        warnings.push(`Näytöksellä "${nimi}" (${paiva}) on virheellinen aika tai kesto - ohitettu.`);
        return;
      }

      screenings.push({
        sali: currentSali,
        paiva,
        alkaaMin,
        kesto,
        nimi,
        ikäraja: ikärajaCell != null ? String(ikärajaCell).trim().toUpperCase() : 'K-12',
        hinta: cellToPrice(hintaCell),
        jakelija: jakelijaCell != null ? String(jakelijaCell).trim() : '',
      });
    });

    return { screenings, viikkoAlku, viikkoLoppu, warnings };
  }

  return { exportToExcel, parseScheduleWorkbook };
})();

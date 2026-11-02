'use strict';

const Scheduler = (() => {
  const SALAT = ['STUDIO 1', 'STUDIO 2', 'STUDIO 3'];
  const PAIVA_LYHYET = ['SU', 'MA', 'TI', 'KE', 'TO', 'PE', 'LA']; // indexed by JS getDay()

  // ── Calendar dates ──────────────────────────────────────────────────────
  // A week's dates are plain calendar days ("2026-10-23"), with no time of
  // day and no time zone, so all arithmetic on them is done on UTC midnights
  // and never touches the local clock. Mixing the two (a UTC-parsed date
  // stepped with the local setDate/getDay) silently dropped a day whenever a
  // week crossed a daylight-saving change: in Finnish time the week of
  // 23-29.10.2026 came out without its Thursday, and a week across the March
  // change would have ended a day early.
  const DAY_MS = 86400000;
  function isoToUtc(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function addDays(iso, n) {
    return new Date(isoToUtc(iso) + n * DAY_MS).toISOString().slice(0, 10);
  }
  function weekdayOf(iso) {
    return PAIVA_LYHYET[new Date(isoToUtc(iso)).getUTCDay()];
  }
  // "2026-10-23" -> "23.10.2026"
  function isoToFin(iso) {
    const [y, m, d] = String(iso).split('-');
    return `${d}.${m}.${y}`;
  }

  // Returns Finnish day-code array for each calendar day from isoAlku to isoLoppu (inclusive).
  // Defaults to 7 days if isoLoppu is omitted.
  function getPaivat(isoAlku, isoLoppu) {
    const start = isoToUtc(isoAlku);
    const end = isoLoppu ? isoToUtc(isoLoppu) : start + 6 * DAY_MS;
    const days = [];
    for (let t = start; t <= end && days.length < 14; t += DAY_MS) {
      days.push(PAIVA_LYHYET[new Date(t).getUTCDay()]);
    }
    return days;
  }

  // Convert "HH:MM" to minutes since midnight
  function toMin(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  // Convert minutes since midnight to "HH:MM"
  function toHHMM(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  // Validate a single screening against constraints (used while/after dragging
  // in the editor). Two things are hard constraints:
  //
  //  - Same-theater overlap, respecting minimivali_sama_sali: two shows
  //    genuinely cannot play in the same room at once.
  //  - Cross-theater start spacing, minimivali_eri_sali (default 0 = off):
  //    no show may START within that many minutes of a show starting in
  //    another room the same day. schedule-ui.js draws these no-start bands
  //    while dragging (drawEriSaliZones).
  //
  // Returns one clause per conflicting show, written to be shown to the user
  // (the drag note and the drop message both do, after "Ei mahtunut kohtaan
  // 14.30: "). Each names the show in the way and gives the numbers: how many
  // minutes would be left between the two and how many the setting requires.
  // A bare "no room" told the user nothing when the spot LOOKED free - the
  // usual case being a film that would end less than the cleanup buffer
  // before the same room's next show.
  function validateScreening(naytos, allNaytokset, settings) {
    const warnings = [];
    const startMin = toMin(naytos.alkaa);
    const endMin = startMin + naytos.kesto;
    const gapSama = settings.minimivali_sama_sali;
    const gapEri = settings.minimivali_eri_sali ?? 0;
    const dot = hhmm => hhmm.replace(':', '.');

    const today = allNaytokset.filter(n => n.id !== naytos.id && n.paiva === naytos.paiva);
    today.forEach(n => {
      const nStart = toMin(n.alkaa);
      if (n.sali === naytos.sali) {
        const nEnd = nStart + n.kesto;
        if (startMin < nEnd + gapSama && endMin + gapSama > nStart) {
          if (startMin < nEnd && endMin > nStart) {
            warnings.push(`menisi päällekkäin, samassa salissa on ${n.nimi} ${dot(n.alkaa)}–${dot(toHHMM(nEnd))}`);
          } else if (nStart >= endMin) {
            warnings.push(`samassa salissa ${n.nimi} alkaa ${dot(n.alkaa)} – väliin jäisi ${nStart - endMin} min, tarvitaan ${gapSama} min`);
          } else {
            warnings.push(`samassa salissa ${n.nimi} päättyy ${dot(toHHMM(nEnd))} – väliin jäisi ${startMin - nEnd} min, tarvitaan ${gapSama} min`);
          }
        }
      } else if (gapEri > 0 && Math.abs(nStart - startMin) < gapEri) {
        warnings.push(`${n.sali}: ${n.nimi} alkaa ${dot(n.alkaa)} – eri salien alkujen väliin jäisi ${Math.abs(nStart - startMin)} min, tarvitaan ${gapEri} min`);
      }
    });

    return warnings;
  }

  return { validateScreening, toMin, toHHMM, getPaivat, addDays, weekdayOf, isoToFin, PAIVA_LYHYET, SALAT };
})();

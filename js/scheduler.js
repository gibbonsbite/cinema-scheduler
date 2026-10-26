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

  // Round up to next 15-minute boundary (cinema scheduling convention - reference
  // showtimes are always on the quarter-hour, e.g. 17.15, 19.30, never 17.05)
  function round15(min) {
    return Math.ceil(min / 15) * 15;
  }

  // Round DOWN to the previous 15-minute boundary. Used when packing a chain
  // backwards from the evening anchor: flooring an earlier show's start keeps
  // the gap to the show after it at >= the cleanup buffer (never rounds into
  // it), landing every same-theater gap in [buffer, buffer+14] - exactly the
  // 30-45 min spread observed between consecutive shows in the reference
  // schedules.
  function floor15(min) {
    return Math.floor(min / 15) * 15;
  }

  // ── Filling the week from the plan ───────────────────────────────────────
  //
  // The user decides which movies each theater runs, in priority order, and
  // on which days (the plan, edited on the Suunnittelu page and the theater
  // checkboxes in the Ohjelmointi list): one show per movie in a theater on
  // each of its checked days. All that is left to decide here is the times,
  // and that is done the way the real schedules are built - from the
  // evening backwards.
  //
  // Each theater-day is one back-to-back chain of shows ending on its
  // evening anchor (the day's configured "viimeinen näytös alkaa"), so the
  // day's opening time simply emerges from how many shows the room runs.
  // Within a chain, kids' movies come first (their prime is the afternoon,
  // and they must end by the kids' window), best-ranked kids title earliest,
  // and the best-ranked adult film sits on the anchor (adult prime is the
  // evening). Rank is the movie's position in that theater's list.
  //
  // The three rooms' anchors are staggered 30 min apart - the median gap
  // between rooms' last starts across the reference weeks - and which room
  // gets the latest is decided by its evening film, not by the room: across
  // 32 reference weeks every room order occurs, and the one lean in the data
  // is that the longer film starts earlier (61%). So the room whose evening
  // film is shortest and lowest-ranked takes the latest anchor (a rank step
  // weighs as much as 4 minutes of running time).
  const ANCHOR_STAGGER = 30;

  // Two rooms never start at the same time: the reference has a cross-room
  // start pair under 15 min apart on 0.2% of occasions. Applied as a floor
  // under the user's own minimivali_eri_sali.
  const MIN_ERI_SALI = 15;

  // A room running more shows than a room usually does that day ends LATER
  // as well as starting earlier - the reference splits the extra length
  // between the two ends (a 3-show Sunday room runs 13:45-17:45 against the
  // usual 2-show 14:45-17:15). Usual: 3 on Saturday, 2 on other days.
  const EXTRA_SHOW_LATER = 30;
  const TYPICAL_ROOM_SHOWS = { LA: 3 };

  // movies: Map of movie id -> library movie, for the week's movies.
  // plan: { 'STUDIO 1': [{ id, paivat: ['PE', ...] }, ...], ... } - each
  // theater's movies, highest priority first.
  // Returns { naytokset, warnings }: warnings name any room-day whose shows
  // could not all fit between the day's earliest start and midnight - they
  // are still placed (nothing the user planned is dropped), running late.
  function populate(movies, plan, settings, viikkoAlku, viikkoLoppu) {
    const naytokset = [];
    const warnings = [];
    const paivat = getPaivat(viikkoAlku, viikkoLoppu);
    const gapSama = settings.minimivali_sama_sali;
    const gapEri = Math.max(settings.minimivali_eri_sali ?? 0, MIN_ERI_SALI);
    const kidsEarliest = toMin(settings.lastenelokuva.aikaisintaan);
    const kidsLatestEnd = toMin(settings.lastenelokuva.viimeistaan);

    paivat.forEach(paiva => {
      const aukiolo = settings.aukioloajat[paiva];
      const floorMin = toMin(aukiolo.avautuu);             // absolute earliest start (safety floor)
      const anchorMin = floor15(toMin(aukiolo.sulkeutuu)); // when the day's last show starts
      const typicalRoomShows = TYPICAL_ROOM_SHOWS[paiva] ?? 2;

      // The plan's shows for today, room by room.
      const rooms = Object.fromEntries(SALAT.map(sali => [sali, []]));
      SALAT.forEach(sali => (plan[sali] ?? []).forEach((card, rankIndex) => {
        const movie = movies.get(card.id);
        if (movie && (card.paivat ?? []).includes(paiva)) rooms[sali].push({ movie, rankIndex });
      }));

      const chains = {};
      SALAT.forEach(sali => {
        const kids = rooms[sali].filter(x => x.movie.lastenelokuva).sort((a, b) => a.rankIndex - b.rankIndex);
        const adults = rooms[sali].filter(x => !x.movie.lastenelokuva).sort((a, b) => b.rankIndex - a.rankIndex);
        chains[sali] = [...kids, ...adults];
      });
      const eveningScore = sali => {
        const last = chains[sali][chains[sali].length - 1];
        return last ? last.movie.kesto - 4 * last.rankIndex : 0;
      };
      const anchorOrder = [...SALAT].sort((a, b) => eveningScore(a) - eveningScore(b));
      const placedToday = [];

      anchorOrder.forEach((sali, staggerIdx) => {
        const chain = chains[sali];
        if (chain.length === 0) return;

        // Pack backwards from this room's anchor: the last show starts ON the
        // anchor; each earlier show ends one cleanup buffer (floored to the
        // :15 grid) before the next starts. A kids-only chain can't hold the
        // evening slot - it ends where the kids' end-time rule allows.
        let anchor = anchorMin - staggerIdx * ANCHOR_STAGGER
          + EXTRA_SHOW_LATER * Math.max(0, chain.length - typicalRoomShows);
        const last = chain[chain.length - 1];
        if (last.movie.lastenelokuva) anchor = Math.min(anchor, floor15(kidsLatestEnd - last.movie.kesto));
        const starts = new Array(chain.length);
        for (let i = chain.length - 1; i >= 0; i--) {
          const x = chain[i];
          let start = i === chain.length - 1 ? anchor : floor15(starts[i + 1] - gapSama - x.movie.kesto);
          if (x.movie.lastenelokuva) start = Math.min(start, floor15(kidsLatestEnd - x.movie.kesto));
          starts[i] = start;
        }

        // A chain too long for its day starts at the safety floor instead and
        // runs on from there - every planned show stays.
        if (starts[0] < floorMin) {
          const shift = round15(floorMin - starts[0]);
          for (let i = 0; i < starts.length; i++) starts[i] += shift;
          for (let i = 1; i < starts.length; i++) {
            const minStart = round15(starts[i - 1] + chain[i - 1].movie.kesto + gapSama);
            if (starts[i] < minStart) starts[i] = minStart;
          }
        }

        // Tight packing: if the kids' end-time clamp opened a gap beyond the
        // buffer plus rounding, pull everything after it earlier - a room
        // never sits idle longer than cleanup + rounding.
        for (let i = 1; i < chain.length; i++) {
          const gap = starts[i] - (starts[i - 1] + chain[i - 1].movie.kesto);
          if (gap <= gapSama + 14) continue;
          let pull = floor15(gap - gapSama);
          for (let j = i; j < chain.length; j++) {
            if (chain[j].movie.lastenelokuva) pull = Math.min(pull, starts[j] - round15(kidsEarliest));
          }
          if (pull <= 0) continue;
          for (let j = i; j < chain.length; j++) starts[j] -= pull;
        }

        // Cross-theater spacing: walking the chain from the evening backwards,
        // a show starting within gapEri of another room's start moves 15 min
        // earlier together with everything before it. A chain already
        // starting at the day's earliest allowed time can't go earlier; then
        // the show moves later instead, with everything after it.
        // Moving a show later carries the shows after it along, which can
        // land one of them on another room's start - so the pass repeats
        // until the room's day is clean.
        const collides = st => placedToday.some(p => Math.abs(p - st) < gapEri);
        for (let pass = 0; pass < 6 && starts.some(collides); pass++) {
          for (let i = chain.length - 1; i >= 0; i--) {
            for (let guard = 0; guard < 8 && collides(starts[i]) && starts[0] - 15 >= floorMin; guard++) {
              for (let j = 0; j <= i; j++) starts[j] -= 15;
            }
            for (let guard = 0; guard < 8 && collides(starts[i]); guard++) {
              for (let j = i; j < chain.length; j++) starts[j] += 15;
            }
          }
        }

        const crowded = chain.filter((x, i) => collides(starts[i]));
        if (crowded.length) warnings.push(`${paiva} ${sali}: ${crowded.map(x => x.movie.nimi).join(', ')} alkaa alle ${gapEri} min päässä toisen salin näytöksestä - päivä on liian täynnä.`);

        const lastEnd = starts[starts.length - 1] + last.movie.kesto;
        if (lastEnd > 24 * 60) warnings.push(`${paiva} ${sali}: ${chain.length} näytöstä ei mahdu ennen puoltayötä (viimeinen päättyy ${toHHMM(lastEnd % (24 * 60))}).`);

        chain.forEach((x, i) => {
          placedToday.push(starts[i]);
          naytokset.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            sali,
            paiva,
            alkaa: toHHMM(starts[i]),
            loppuu: toHHMM(starts[i] + x.movie.kesto),
            elokuvaId: x.movie.id,
            nimi: x.movie.nimi,
            kesto: x.movie.kesto,
            ikäraja: x.movie.ikäraja,
            hinta: x.movie.hinta,
            jakelija: x.movie.jakelija,
            lastenelokuva: !!x.movie.lastenelokuva,
          });
        });
      });
    });

    return { naytokset, warnings };
  }

  // Validate a single screening against constraints (used while/after dragging
  // in the editor). Opening hours are intentionally NOT checked here - manual
  // edits are free to run earlier/later than the configured hours, and
  // schedule-ui.js extends that day's hours to match instead of blocking the
  // move. Two things are hard constraints:
  //
  //  - Same-theater overlap, respecting minimivali_sama_sali: two shows
  //    genuinely cannot play in the same room at once.
  //  - Cross-theater start spacing, minimivali_eri_sali (default 0 = off):
  //    no show may START within that many minutes of a show starting in
  //    another room the same day - the same |start - start| < gap test the
  //    generator's stagger pass uses, so a hand-moved show obeys exactly what
  //    the generator was asked to. schedule-ui.js draws these no-start bands
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

  return { populate, validateScreening, toMin, toHHMM, round15, getPaivat, addDays, weekdayOf, isoToFin, PAIVA_LYHYET, SALAT };
})();

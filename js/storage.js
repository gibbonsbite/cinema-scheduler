'use strict';

const Storage = (() => {
  const KEYS = {
    MOVIES: 'cs_movies',
    SCHEDULE: 'cs_schedule',
    SETTINGS: 'cs_settings',
  };

  const DEFAULTS = {
    settings: {
      // "Täytä ohjelma" (Scheduler.populate) builds each room's day BACKWARDS
      // from the evening, so these two fields mean: sulkeutuu = the evening
      // anchor (when that day's LAST show starts - the median last showtime
      // per weekday across 32 weeks of reference schedules), avautuu = the
      // absolute earliest a show may ever start (a wide safety floor, not a
      // real opening time). The actual opening time is never configured - it
      // emerges from how many shows the room runs, exactly like the
      // reference schedules, whose first showtime swings by hours week to
      // week while the last showtime stays put. js/export.js derives each week's real
      // effective hours from the placed showings. Individual days can still
      // be pinned manually - see aukioloajat_yliajot below.
      aukioloajat: {
        PE: { avautuu: '09:00', sulkeutuu: '20:00' },
        LA: { avautuu: '09:00', sulkeutuu: '19:45' },
        SU: { avautuu: '09:00', sulkeutuu: '17:45' },
        MA: { avautuu: '09:00', sulkeutuu: '18:30' },
        TI: { avautuu: '09:00', sulkeutuu: '19:15' },
        KE: { avautuu: '09:00', sulkeutuu: '19:15' },
        TO: { avautuu: '09:00', sulkeutuu: '19:15' },
      },
      // 30 min cleanup buffer between consecutive shows in the same room -
      // reference same-theater gaps are 30-45 min (median 33), which is
      // exactly this buffer plus rounding to the quarter-hour grid.
      minimivali_sama_sali: 30,
      // Minimum spacing between shows starting in DIFFERENT rooms. 0 = off:
      // the room anchors are already staggered 30 min apart by the
      // scheduler, so an extra cross-room constraint is unnecessary by
      // default.
      minimivali_eri_sali: 0,
      // The step every manual edit snaps to (dragging, making room, gap
      // fills, moving between theaters), in minutes: 1, 5, 10, 15 or 30.
      raahaus_tarkkuus: 5,
      // 'pysty' = time flows downward, theaters side by side (columns).
      // 'vaaka' = time flows sideways, theaters stacked (rows).
      aikataulu_suunta: 'vaaka',
      sarakeleveydet: { A:11, B:3, C:5, D:38, E:5, F:5, G:8, H:5 },
      aukiolo_excel: { avautuu_ennen_min: 30, sulkeutuu_offset_min: 0 },
      lastenelokuva: {
        aikaisintaan: '10:00',
        // Latest allowed END for a kids' show. Reference kids screenings
        // routinely end as late as ~19:15 (e.g. a 17:45 start + 90 min right
        // before the evening slot), so this sits just above that - tight
        // enough that kids' films never take the evening anchor, loose
        // enough not to punch holes in a chain between the afternoon kids
        // block and the evening show.
        viimeistaan: '19:30',
        paivat: ['PE','LA','SU','MA','TI','KE','TO'],
        // Price (EUR) at which a newly added/imported movie defaults to
        // lastenelokuva - family-film tickets are consistently priced at this
        // point in reference data while adult-oriented films cost more.
        hintaraja: 12.5,
      },
    },
  };

  // Titles are ALL CAPS on a programme sheet - every reference schedule and
  // every export writes them that way - so that is how they are stored, no
  // matter how they were typed in the library modal or what case an imported
  // file happened to use. Normalizing here (rather than at each entry point)
  // means every path through Storage lands on the same canonical title:
  // manual add/edit, CSV import, Excel schedule import, and the movies and
  // screenings already saved by an older version, which are rewritten the
  // first time they are read back.
  function isoNimi(nimi) {
    return String(nimi ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('fi-FI');
  }

  // Uppercases `nimi` in place on anything that has one (library movies and
  // schedule screenings alike). Mutates rather than copying so a caller holding
  // the same array - Library's `movies`, ScheduleUI's `currentSchedule` - sees
  // the canonical title immediately, without re-reading from storage. Returns
  // true if any title actually changed.
  function normalizeNimet(items) {
    let changed = false;
    (items ?? []).forEach(item => {
      if (!item || item.nimi == null) return;
      const iso = isoNimi(item.nimi);
      if (iso !== item.nimi) {
        item.nimi = iso;
        changed = true;
      }
    });
    return changed;
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // Each movie carries a persisted colorSlot (0-15) into the grid palette
  // (js/schedule-ui.js's GRID_COLORS), assigned here once like id or nimi
  // rather than derived fresh every time, so a movie's color survives
  // regenerations and reorderings. It is a PREFERENCE, not a guarantee: the
  // library grows past 16 titles within a few weeks of imports, so slots
  // repeat across the library no matter what. What the user actually sees
  // is one week's roster of ~8-12 movies, and schedule-ui.js's weekColors()
  // resolves any clash inside that roster at render time. This just spreads
  // new movies onto the slots the library uses least, so those clashes stay
  // rare. Mutates in place; returns true if anything was assigned (caller
  // decides whether that needs persisting).
  const COLOR_SLOT_COUNT = 16;
  // Anything but a whole number 0-15 (a string, NaN, a negative left by some
  // older build) counts as no slot at all and is reassigned.
  const validSlot = slot => Number.isInteger(slot) && slot >= 0 && slot < COLOR_SLOT_COUNT;
  function ensureColorSlots(movies) {
    const inUse = new Array(COLOR_SLOT_COUNT).fill(0);
    movies.forEach(m => { if (validSlot(m.colorSlot)) inUse[m.colorSlot]++; });
    let changed = false;
    movies.forEach(m => {
      if (validSlot(m.colorSlot)) return;
      let slot = 0;
      for (let i = 1; i < COLOR_SLOT_COUNT; i++) if (inUse[i] < inUse[slot]) slot = i;
      inUse[slot]++;
      m.colorSlot = slot;
      changed = true;
    });
    return changed;
  }

  // Whatever an older version (or a hand-edited backup) left in storage, the
  // UI gets well-formed records back: one malformed entry used to throw
  // inside the first grid render, and since the modules initialize one after
  // another in index.html, that also left every later button unwired. Broken
  // entries are dropped only from what is returned - storage itself is not
  // rewritten here; the next ordinary save simply stops carrying them.
  const isHHMM = t => typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t);
  function cleanSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') return null;
    schedule.naytokset = (Array.isArray(schedule.naytokset) ? schedule.naytokset : [])
      .filter(n => n && typeof n === 'object' && n.elokuvaId != null && isHHMM(n.alkaa));
    if (schedule.valitut != null) {
      schedule.valitut = Array.isArray(schedule.valitut) ? schedule.valitut.filter(id => id != null) : [];
    }
    return schedule;
  }

  return {
    // Movies saved before the blockbuster/taide categories were removed have a
    // `kategoria` string instead of a `lastenelokuva` boolean; derive it on read.
    getMovies: () => {
      const raw = load(KEYS.MOVIES, []);
      const movies = (Array.isArray(raw) ? raw : []).filter(m => m && typeof m === 'object' && m.id != null).map(m =>
        typeof m.lastenelokuva === 'boolean'
          ? m
          : { ...m, lastenelokuva: m.kategoria === 'lastenelokuva' }
      );
      const renamed = normalizeNimet(movies);
      if (ensureColorSlots(movies) || renamed) save(KEYS.MOVIES, movies);
      return movies;
    },
    saveMovies: (movies) => {
      normalizeNimet(movies);
      ensureColorSlots(movies);
      save(KEYS.MOVIES, movies);
    },

    getSchedule: () => {
      const schedule = cleanSchedule(load(KEYS.SCHEDULE, null));
      // A screening carries its own copy of the title, so the week saved by an
      // older version needs the same rewrite the library gets.
      if (schedule && normalizeNimet(schedule.naytokset)) save(KEYS.SCHEDULE, schedule);
      return schedule;
    },
    saveSchedule: (schedule) => {
      normalizeNimet(schedule?.naytokset);
      save(KEYS.SCHEDULE, schedule);
    },

    getSettings: () => {
      const saved = load(KEYS.SETTINGS, null);
      // deep merge saved over defaults so new default keys always appear
      if (!saved) return JSON.parse(JSON.stringify(DEFAULTS.settings));
      const merged = JSON.parse(JSON.stringify(DEFAULTS.settings));
      // Only days the user explicitly pinned (aukioloajat_yliajot) replace the
      // built-in default - any day left on "auto" keeps tracking DEFAULTS, so
      // improvements to the default hours apply immediately without requiring
      // every user to re-save. (The old `aukioloajat` full-week key from before
      // this override system is simply never read again.)
      merged.aukioloajat_yliajot = saved.aukioloajat_yliajot || {};
      Object.entries(merged.aukioloajat_yliajot).forEach(([p, h]) => {
        merged.aukioloajat[p] = h;
      });
      if (saved.minimivali_sama_sali != null) merged.minimivali_sama_sali = saved.minimivali_sama_sali;
      if (saved.minimivali_eri_sali != null) merged.minimivali_eri_sali = saved.minimivali_eri_sali;
      if ([1, 5, 10, 15, 30].includes(Number(saved.raahaus_tarkkuus))) merged.raahaus_tarkkuus = Number(saved.raahaus_tarkkuus);
      if (saved.aikataulu_suunta) merged.aikataulu_suunta = saved.aikataulu_suunta;
      if (saved.lastenelokuva) {
        merged.lastenelokuva = Object.assign(merged.lastenelokuva, saved.lastenelokuva);
      } else if (saved.kategoriasaannot?.lastenelokuva) {
        // Migrate the pre-category-removal shape (kategoriasaannot.lastenelokuva) once.
        const old = saved.kategoriasaannot.lastenelokuva;
        merged.lastenelokuva = { aikaisintaan: old.aikaisintaan, viimeistaan: old.viimeistaan, paivat: old.paivat };
      }
      if (saved.sarakeleveydet) merged.sarakeleveydet = Object.assign(merged.sarakeleveydet, saved.sarakeleveydet);
      if (saved.aukiolo_excel) merged.aukiolo_excel = Object.assign(merged.aukiolo_excel, saved.aukiolo_excel);
      // The scheduler adds these to minute counts, so one stored as text
      // ("30", from a hand-edited backup or an old build) would concatenate
      // instead - "1000" + "30" - and make every slot look taken. Anything
      // that isn't a usable number falls back to the default.
      // (The generator's weekly targets and day weights - naytoksia_viikossa,
      // min_naytoksia_salissa, paivapainot, avautuu_tavoite - are gone with
      // the generator; values still in old saved settings are simply not read.)
      for (const key of ['minimivali_sama_sali', 'minimivali_eri_sali']) {
        const value = typeof merged[key] === 'string' && merged[key].trim() !== '' ? Number(merged[key]) : merged[key];
        merged[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULTS.settings[key];
      }
      return merged;
    },
    saveSettings: (settings) => save(KEYS.SETTINGS, settings),
  };
})();

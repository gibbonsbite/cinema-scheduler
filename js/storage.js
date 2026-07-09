'use strict';

const Storage = (() => {
  const KEYS = {
    MOVIES: 'cs_movies',
    SCHEDULE: 'cs_schedule',
    SETTINGS: 'cs_settings',
  };

  const DEFAULTS = {
    settings: {
      // The scheduler builds each day BACKWARDS from the evening, so these
      // two fields mean: sulkeutuu = the evening anchor (when that day's
      // LAST show starts - the median last showtime per weekday across 27
      // weeks of reference schedules), avautuu = the absolute earliest a
      // show may ever start (a wide safety floor, not a real opening time).
      // The actual opening time is never configured or hardcoded - it
      // emerges from how many shows the day runs (weekdays open later
      // simply because they run fewer shows), exactly like the reference
      // schedules, whose first showtime swings by hours week to week while
      // the last showtime stays put. js/export.js derives each week's real
      // effective hours from the placed showings. Individual days can still
      // be pinned manually - see aukioloajat_yliajot below.
      aukioloajat: {
        PE: { avautuu: '09:00', sulkeutuu: '20:00' },
        LA: { avautuu: '09:00', sulkeutuu: '19:45' },
        SU: { avautuu: '09:00', sulkeutuu: '17:45' },
        MA: { avautuu: '09:00', sulkeutuu: '18:45' },
        TI: { avautuu: '09:00', sulkeutuu: '19:15' },
        KE: { avautuu: '09:00', sulkeutuu: '20:00' },
        TO: { avautuu: '09:00', sulkeutuu: '19:15' },
      },
      // How heavily each weekday is programmed relative to the others. The
      // scheduler fills days in proportion to these, so a bigger number
      // means more shows land on that day. Defaults are the average per-day
      // show counts across the 27 reference weeks (Saturday the peak at
      // 9.2, Monday the lightest at 5.3); the absolute scale doesn't matter,
      // only the ratios do.
      paivapainot: {
        PE: 6.4, LA: 9.2, SU: 6.6, MA: 5.3, TI: 6.0, KE: 7.0, TO: 6.4,
      },
      // When each weekday's FIRST show should start, at the latest - the
      // median first-show start per weekday across the 27 reference weeks.
      // The scheduler's backwards-packed chains usually open this early on
      // their own; if a light program would open a day later than this, the
      // day is topped up with extra shows until its opening lands as close
      // to the target as possible. Set a day earlier to force it longer.
      avautuu_tavoite: {
        PE: '16:30', LA: '13:30', SU: '14:00', MA: '16:00', TI: '16:00', KE: '15:45', TO: '16:15',
      },
      // Roughly how many shows a full 7-day week should run in total
      // (reference weeks run 38-61, median 46). Spare capacity under this
      // number is handed to the tail of a small roster as extra shows; a
      // big roster's rank tiers already exceed it and ignore it.
      naytoksia_viikossa: 45,
      // Every room must run at least this many shows every day the cinema
      // is open (a business rule: no theater sits nearly dark). The
      // scheduler reaches the floor by MOVING shows from the most loaded
      // days, so weekly totals stay put; if the selected roster is too
      // small to cover it, the floor is best-effort.
      min_naytoksia_salissa: 2,
      // 30 min cleanup buffer between consecutive shows in the same room -
      // reference same-theater gaps are 30-45 min (median 33), which is
      // exactly this buffer plus rounding to the quarter-hour grid.
      minimivali_sama_sali: 30,
      // Minimum spacing between shows starting in DIFFERENT rooms. 0 = off:
      // the room anchors are already staggered 30 min apart by the
      // scheduler, so an extra cross-room constraint is unnecessary by
      // default.
      minimivali_eri_sali: 0,
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

  // Grid color assignment (js/schedule-ui.js's GRID_COLORS) needs a per-movie
  // slot that's genuinely unique - not just a hash that happens not to
  // collide - so it's assigned here once and persisted, exactly like id or
  // nimi, rather than derived fresh every time. Mutates any movie missing
  // colorSlot in place, picking the lowest slot (0-15) not already taken by
  // another movie in this same list - deleting a movie frees its slot for
  // the next new one automatically, since only movies that currently exist
  // are ever checked. Returns true if anything was assigned (caller decides
  // whether that needs persisting).
  const COLOR_SLOT_COUNT = 16;
  function ensureColorSlots(movies) {
    const used = new Set(movies.map(m => m.colorSlot).filter(s => s != null));
    let changed = false;
    let overflow = 0; // once all 16 slots are taken, cycle rather than pile every remaining movie onto slot 15
    movies.forEach(m => {
      if (m.colorSlot != null) return;
      let slot = 0;
      while (used.has(slot) && slot < COLOR_SLOT_COUNT) slot++;
      if (slot >= COLOR_SLOT_COUNT) {
        slot = overflow % COLOR_SLOT_COUNT;
        overflow++;
      } else {
        used.add(slot);
      }
      m.colorSlot = slot;
      changed = true;
    });
    return changed;
  }

  return {
    // Movies saved before the blockbuster/taide categories were removed have a
    // `kategoria` string instead of a `lastenelokuva` boolean; derive it on read.
    getMovies: () => {
      const movies = load(KEYS.MOVIES, []).map(m =>
        typeof m.lastenelokuva === 'boolean'
          ? m
          : { ...m, lastenelokuva: m.kategoria === 'lastenelokuva' }
      );
      if (ensureColorSlots(movies)) save(KEYS.MOVIES, movies);
      return movies;
    },
    saveMovies: (movies) => {
      ensureColorSlots(movies);
      save(KEYS.MOVIES, movies);
    },

    getSchedule: () => load(KEYS.SCHEDULE, null),
    saveSchedule: (schedule) => save(KEYS.SCHEDULE, schedule),

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
      if (saved.paivapainot) merged.paivapainot = Object.assign(merged.paivapainot, saved.paivapainot);
      if (saved.avautuu_tavoite) merged.avautuu_tavoite = Object.assign(merged.avautuu_tavoite, saved.avautuu_tavoite);
      if (saved.naytoksia_viikossa != null) merged.naytoksia_viikossa = saved.naytoksia_viikossa;
      if (saved.min_naytoksia_salissa != null) merged.min_naytoksia_salissa = saved.min_naytoksia_salissa;
      if (saved.minimivali_sama_sali != null) merged.minimivali_sama_sali = saved.minimivali_sama_sali;
      if (saved.minimivali_eri_sali != null) merged.minimivali_eri_sali = saved.minimivali_eri_sali;
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
      return merged;
    },
    saveSettings: (settings) => save(KEYS.SETTINGS, settings),
  };
})();

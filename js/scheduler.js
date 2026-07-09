'use strict';

const Scheduler = (() => {
  const SALAT = ['STUDIO 1', 'STUDIO 2', 'STUDIO 3'];
  const PAIVA_LYHYET = ['SU', 'MA', 'TI', 'KE', 'TO', 'PE', 'LA']; // indexed by JS getDay()

  // Returns Finnish day-code array for each calendar day from isoAlku to isoLoppu (inclusive).
  // Defaults to 7 days if isoLoppu is omitted.
  function getPaivat(isoAlku, isoLoppu) {
    const start = new Date(isoAlku);
    const end = isoLoppu ? new Date(isoLoppu) : new Date(+start + 6 * 86400000);
    const days = [];
    const d = new Date(start);
    while (d <= end && days.length < 14) {
      days.push(PAIVA_LYHYET[d.getDay()]);
      d.setDate(d.getDate() + 1);
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

  // Rank 0-2 (the top 3 movies) are always scheduled every eligible day of the
  // week, one show per active day - a hard rule, not a historical average
  // (26 weeks of reference schedules show rank 2/3 falling short of 7 days
  // nearly half the time, but the rule going forward is unconditional).
  const TOP_RANK_COUNT = 3;

  // Beyond the top 3, reference data shows a movie's total weekly shows and
  // its number of active days converge to the same number (rank 3 ~5.1/5.1,
  // rank 8 ~2.4/2.4 - essentially always exactly one show per active day), so
  // a single tier table drives both the day-budget and the show-count cap,
  // rather than two separately-tapered tables. Values are rank 3..8 (0-indexed
  // from this table's own start), tail default 2 beyond that.
  const RANK_TIERS = [5, 4, 4, 3, 3, 2];

  // A full 3-room week holds ~45 shows (reference weeks run 38-61, median
  // 46). The tier table above is calibrated on the 27-week reference average
  // (13.7 distinct movies), where tail titles get squeezed by sheer roster
  // size; with a small roster those weeks' spare capacity flows back to the
  // tail. The one 9-movie reference week ran 45 shows with tiers
  // 7,7,7,5,5,4,4,3,3 - buildTailTiers reproduces exactly that: any capacity
  // left under the target is handed back +1 at a time to the leftmost tail
  // rank sitting below its better-ranked neighbor, keeping the taper
  // monotone. Big rosters already exceed the capacity and are left
  // untouched. Values are in full-week (7-day) terms like RANK_TIERS.
  // Fallback for settings.naytoksia_viikossa (editable in Asetukset).
  const WEEK_SHOW_CAPACITY = 45;

  function buildTailTiers(movieCount, capacity) {
    const nTop = Math.min(TOP_RANK_COUNT, movieCount);
    const tiers = [];
    for (let i = 0; i < movieCount - nTop; i++) {
      tiers.push(i < RANK_TIERS.length ? RANK_TIERS[i] : 2);
    }
    let spare = capacity - nTop * 7 - tiers.reduce((a, b) => a + b, 0);
    while (spare > 0) {
      // Spread each round of spare shows across the taper's steps - one +1
      // at the head of every descending run, left to right ([5,4,4,3,3,2]
      // with 3 spare -> [5,5,4,4,3,3], the real 9-movie week's tail). Only
      // when the tail is completely flat does its front rise, never past 7.
      const heads = [];
      for (let j = 1; j < tiers.length; j++) {
        if (tiers[j] < tiers[j - 1]) heads.push(j);
      }
      if (heads.length === 0) {
        if (tiers.length === 0 || tiers[0] >= 7) break;
        tiers[0]++;
        spare--;
        continue;
      }
      for (const j of heads) {
        if (spare === 0) break;
        tiers[j]++;
        spare--;
      }
    }
    return tiers;
  }

  // Weekend-preference tie-break for day picking - in the reference data,
  // partial-week movies play Saturday 83% of the time, Friday/Sunday ~55%,
  // mid-week days ~45%, Monday 35%.
  const KEEP_PRIORITY = ['LA', 'SU', 'PE', 'MA', 'TI', 'TO', 'KE'];

  // How many shows each weekday carries relative to the others - the average
  // per-day show counts across all 27 reference weeks. Saturday is the peak
  // business day (9.2 shows on average, half again more than a weekday) and
  // Monday the lightest (5.3). Day picking below fills days in proportion to
  // these, so weekends pack tightest, exactly like the real schedules -
  // a flat everyone-gets-the-same split would starve Saturday to feed Monday.
  // These are only the fallback: settings.paivapainot (editable in the
  // Asetukset hours table) carries the live values.
  const DAY_WEIGHT = { MA: 5.3, TI: 6.0, KE: 7.0, TO: 6.4, PE: 6.4, LA: 9.2, SU: 6.6 };

  // When each weekday's FIRST show should start, at the latest - the median
  // first-show start per weekday across the 27 reference weeks (Saturday
  // opens at 13:30, a plain weekday around 16:00). The backwards-packed
  // chains usually reach this on their own; when a light roster would open
  // a day later than this, the day loop tops the day up with extra shows
  // until its opening lands as close to the target as an extra chain link
  // can get it. Fallback for settings.avautuu_tavoite (editable in
  // Asetukset).
  const OPEN_TARGET = { MA: '16:00', TI: '16:00', KE: '15:45', TO: '16:15', PE: '16:30', LA: '13:30', SU: '14:00' };

  // When a movie's day-budget is below its number of eligible days, its days
  // are picked to fill the week PROPORTIONALLY: the day whose current load
  // is smallest relative to its weight share comes first (weekend
  // preference breaks ties). This both keeps every day of the week stocked
  // (a fixed keep-order had every tail movie drop the SAME mid-week days,
  // leaving Tue-Thu theaters running a single show) and gives Saturday its
  // real-world peak instead of a flat split.
  function pickBalancedDays(eligibleDays, budget, dayLoad, weightOf) {
    if (budget >= eligibleDays.length) return eligibleDays;
    const pressure = d => dayLoad.get(d) / weightOf(d);
    const ranked = [...eligibleDays].sort((a, b) =>
      (pressure(a) - pressure(b)) || (KEEP_PRIORITY.indexOf(a) - KEEP_PRIORITY.indexOf(b)));
    const keep = new Set(ranked.slice(0, budget));
    return eligibleDays.filter(d => keep.has(d)); // preserve calendar order
  }

  // naytosTavoitteet: optional { [movieId]: totalShowsThisWeek } overrides. A
  // movie without an entry is capped at its rank-tier day count instead (see
  // TOP_RANK_COUNT/RANK_TIERS above). A movie WITH an explicit entry isn't
  // bound to the rank-based day-budget - it can use any of its eligible days
  // to reach that total - and is hard-capped at exactly that many shows for
  // the week.
  // saliYlitys: optional { [movieId]: saliName } manual theater assignment.
  // A movie with an entry is pinned into that room's chain each day it
  // plays, bypassing the rank-based room fill (see room assignment inside
  // the day loop below); everything else routes around the pin.
  function schedule(selectedMovies, settings, viikkoAlku, viikkoLoppu, naytosTavoitteet = {}, saliYlitys = {}) {
    const naytokset = [];
    const paivat = getPaivat(viikkoAlku, viikkoLoppu);

    // selectedMovies is already rank-ordered (index 0 = most popular/highest priority)

    // Which days each movie plays, and how many shows it runs each of those
    // days, are weekly properties decided once up front in a single pass in
    // rank order (deterministic - this replaces the old greedy
    // fill-until-full repeat loop). Rank 0-2 always get every eligible day
    // (TOP_RANK_COUNT); beyond that, RANK_TIERS gives the day-budget and
    // pickBalancedDays spreads those budgets across the week's emptiest
    // days, so mid-week days stay stocked instead of every tail movie
    // keeping the same weekend subset. Default is exactly one show per
    // active day; an explicit naytosTavoitteet target above the day count
    // adds repeats to the movie's lightest days, one below it keeps only
    // that many of its days - both load-balanced the same way.
    const dailyCounts = new Map();
    const dayLoad = new Map(paivat.map(p => [p, 0])); // total shows assigned per day so far
    const tailTiers = buildTailTiers(selectedMovies.length,
      settings.naytoksia_viikossa ?? WEEK_SHOW_CAPACITY);
    const painot = settings.paivapainot ?? {};
    const weightOf = d => painot[d] ?? DAY_WEIGHT[d] ?? 6;

    selectedMovies.forEach((movie, rankIndex) => {
      const eligibleDays = movie.lastenelokuva
        ? paivat.filter(p => settings.lastenelokuva.paivat.includes(p))
        : paivat;

      let days;
      if (naytosTavoitteet[movie.id] != null || rankIndex < TOP_RANK_COUNT) {
        days = eligibleDays;
      } else {
        const tier7 = tailTiers[rankIndex - TOP_RANK_COUNT];
        const budget = Math.max(1, Math.round(tier7 * paivat.length / 7));
        days = pickBalancedDays(eligibleDays, budget, dayLoad, weightOf);
      }
      const cap = naytosTavoitteet[movie.id] ?? days.length;

      const counts = new Map();
      if (cap <= days.length) {
        pickBalancedDays(days, cap, dayLoad, weightOf).forEach(d => counts.set(d, 1));
      } else {
        days.forEach(d => counts.set(d, 1));
        for (let extra = 0; extra < cap - days.length; extra++) {
          const pressure = d => (dayLoad.get(d) + counts.get(d)) / weightOf(d);
          const lightest = [...days].sort((a, b) =>
            (pressure(a) - pressure(b)) || (KEEP_PRIORITY.indexOf(a) - KEEP_PRIORITY.indexOf(b)))[0];
          counts.set(lightest, counts.get(lightest) + 1);
        }
      }
      counts.forEach((c, d) => dayLoad.set(d, dayLoad.get(d) + c));
      dailyCounts.set(movie.id, counts);
    });

    // ── Per-day floor: every room runs at least min_naytoksia_salissa shows ──
    // A day short of the floor (floor x 3 rooms in total) pulls one show at a
    // time from the most overloaded day that can spare one, choosing the
    // lowest-ranked movie that plays the donor day but not the short day (and
    // is eligible on it). Moving - never adding - keeps the weekly total and
    // every movie's show count exactly as the tiers decided. Note this
    // intentionally diverges from the reference schedules, which do run a
    // single-show room on 6.5% of theater-days (mostly Mondays); the floor is
    // a business rule. If the roster simply can't cover the floor (too few
    // movies, kids-day restrictions), it stays best-effort.
    const minPerRoom = settings.min_naytoksia_salissa ?? 2;
    const dayFloor = minPerRoom * SALAT.length;
    let floorGuard = paivat.length * dayFloor;
    while (floorGuard-- > 0) {
      const short = paivat
        .filter(d => dayLoad.get(d) < dayFloor)
        .sort((a, b) => dayLoad.get(a) - dayLoad.get(b))[0];
      if (!short) break;
      let best = null;
      selectedMovies.forEach((movie, rankIndex) => {
        const counts = dailyCounts.get(movie.id);
        if (counts.get(short)) return; // already plays the short day
        if (movie.lastenelokuva && !settings.lastenelokuva.paivat.includes(short)) return;
        counts.forEach((c, d) => {
          if (c === 0 || dayLoad.get(d) - 1 < dayFloor) return; // donor must stay at the floor
          const pressure = dayLoad.get(d) / weightOf(d);
          if (!best || pressure > best.pressure ||
              (pressure === best.pressure && rankIndex > best.rankIndex)) {
            best = { movie, rankIndex, from: d, pressure };
          }
        });
      });
      if (!best) break;
      const counts = dailyCounts.get(best.movie.id);
      counts.set(best.from, counts.get(best.from) - 1);
      if (counts.get(best.from) === 0) counts.delete(best.from);
      counts.set(short, 1);
      dayLoad.set(best.from, dayLoad.get(best.from) - 1);
      dayLoad.set(short, dayLoad.get(short) + 1);
    }

    // ── Per-day construction: backwards-packed chains from evening anchors ──
    //
    // Reference schedules are built from the evening, not the morning: each
    // weekday's LAST showtime is remarkably stable (that's the configured
    // sulkeutuu - the "evening anchor", when the day's final show starts),
    // while the FIRST showtime swings by hours depending on how many shows
    // that day runs. Each theater-day is one back-to-back chain of shows
    // ending on its anchor, so the day's opening time simply EMERGES from
    // the chain lengths - weekdays open later than Saturday purely because
    // they run fewer shows; no opening time is hardcoded anywhere. Within a
    // chain, kids' movies always come first (their prime is the afternoon)
    // and the best-ranked adult sits on the anchor (adult prime is the
    // evening). The three rooms' anchors are staggered 30 min apart - the
    // median gap between rooms' last starts across 27 reference weeks.
    const ANCHOR_STAGGER = 30; // min between consecutive rooms' evening anchors

    paivat.forEach(paiva => {
      const aukiolo = settings.aukioloajat[paiva];
      const floorMin = toMin(aukiolo.avautuu);             // absolute earliest start (safety floor)
      const anchorMin = floor15(toMin(aukiolo.sulkeutuu)); // when the day's last show starts
      const gapSama = settings.minimivali_sama_sali;
      const gapEri = settings.minimivali_eri_sali;
      const kidsEarliest = toMin(settings.lastenelokuva.aikaisintaan);
      const kidsLatestEnd = toMin(settings.lastenelokuva.viimeistaan);

      // Today's showings - one entry per show, so a naytosTavoitteet target
      // above the day count appears here as many times as it plays today.
      let showings = [];
      selectedMovies.forEach((movie, rankIndex) => {
        const count = dailyCounts.get(movie.id).get(paiva) ?? 0;
        for (let i = 0; i < count; i++) showings.push({ movie, rankIndex });
      });
      if (showings.length === 0) return;

      const isPinned = s => SALAT.includes(saliYlitys[s.movie.id]);

      // Builds the whole day from a list of showings - room assignment,
      // chain ordering, backwards packing - and returns the placements as
      // [{ sali, start, s }] without touching anything outside, so the
      // opening-target pass below can build a trial day with one more show
      // and simply discard it if it doesn't help.
      const buildDay = (dayShowings) => {

        // ── Room assignment ──
        // Counts are balanced across rooms (7 shows -> 3+2+2). On a normal day
        // the remainder goes to STUDIO 1 first; on a LIGHT day (5 shows or
        // fewer) it's the big room that rests - across the 27 reference weeks'
        // light days STUDIO 1 averages the fewest shows (1.46) and STUDIO 2 the
        // most (1.81), so the remainder order flips to S2 -> S3 -> S1. This is
        // what keeps STUDIO 3 running 2 shows on a 5-6 show Monday/Tuesday
        // instead of eating every shortfall.
        const rooms = { 'STUDIO 1': [], 'STUDIO 2': [], 'STUDIO 3': [] };
        const base = Math.floor(dayShowings.length / SALAT.length);
        const rem = dayShowings.length % SALAT.length;
        const remOrder = dayShowings.length <= 5
          ? ['STUDIO 2', 'STUDIO 3', 'STUDIO 1']
          : SALAT;
        const roomCap = {};
        SALAT.forEach(s => { roomCap[s] = base; });
        remOrder.slice(0, rem).forEach(s => { roomCap[s]++; });

        const unassigned = [];
        dayShowings.forEach(s => {
          if (isPinned(s)) rooms[saliYlitys[s.movie.id]].push(s);
          else unassigned.push(s);
        });
        unassigned.sort((a, b) => a.rankIndex - b.rankIndex);

        const free = sali => rooms[sali].length < roomCap[sali];

        // Strict rank fill: saliYlitys pins first (above), then the best
        // remaining titles pack STUDIO 1 full, the next STUDIO 2, and the rank
        // tail lands in STUDIO 3 - in the reference schedules S1's shows are
        // 68% top-3 titles while S3's are only 9%; a per-room rank-rotation
        // here previously parked a top title in S3 every single day. Filling
        // by strict rank also keeps each movie in the same room day after day,
        // as the reference does.
        unassigned.forEach(s => {
          const target = SALAT.find(free)
            ?? SALAT.reduce((a, b) => rooms[a].length <= rooms[b].length ? a : b);
          rooms[target].push(s);
        });

        // Every room's evening should end on an adult show (548/561 reference
        // theater-days do). A room that came out all-kids swaps its lowest-
        // ranked kid for the closest-ranked spare adult from a room holding
        // two or more adults, so the rooms' rank tiering survives the swap -
        // but a top-3 kids title is never traded down into STUDIO 3 (on kids-
        // heavy days the reference simply runs the room kids-only instead,
        // e.g. a Tuesday STUDIO 1 of VAIANA + KÄTYRIT with the two tail
        // adults stacked in S3). Pinned shows never move. With no acceptable
        // spare adult, the kids-only chain simply ends early on the kids'
        // end-time rule (see packOnce).
        SALAT.forEach(sali => {
          const shows = rooms[sali];
          if (shows.length === 0 || shows.some(x => !x.movie.lastenelokuva)) return;
          const swappable = shows.filter(x => !isPinned(x));
          if (swappable.length === 0) return;
          const kid = swappable.reduce((a, b) => a.rankIndex >= b.rankIndex ? a : b);
          let donor = null, adult = null;
          SALAT.forEach(other => {
            if (other === sali) return;
            if (kid.rankIndex < TOP_RANK_COUNT && other === 'STUDIO 3') return;
            const adults = rooms[other].filter(x => !x.movie.lastenelokuva && !isPinned(x));
            if (rooms[other].filter(x => !x.movie.lastenelokuva).length < 2) return;
            adults.forEach(a => {
              if (!adult || Math.abs(a.rankIndex - kid.rankIndex) < Math.abs(adult.rankIndex - kid.rankIndex)) {
                donor = other;
                adult = a;
              }
            });
          });
          if (!adult) return;
          rooms[sali][rooms[sali].indexOf(kid)] = adult;
          rooms[donor][rooms[donor].indexOf(adult)] = kid;
        });

        // ── Chain ordering and backwards packing per room ──
        const entries = [];     // the day's placements, collected room by room
        const placedToday = []; // starts already emitted today (for the optional cross-theater stagger)

        SALAT.forEach((sali, saliIdx) => {
          const roomShows = rooms[sali];
          if (roomShows.length === 0) return;

          // Chronological chain: kids first, best-ranked kids title earliest
          // (it takes the prime matinee slot); adults after, ordered so the
          // BEST adult lands last, on the evening anchor.
          const kids = roomShows.filter(x => x.movie.lastenelokuva).sort((a, b) => a.rankIndex - b.rankIndex);
          const adults = roomShows.filter(x => !x.movie.lastenelokuva).sort((a, b) => b.rankIndex - a.rankIndex);
          const chain = [...kids, ...adults];

          // Pack backwards from this room's anchor: the last show starts ON
          // the anchor; each earlier show ends one cleanup buffer (floored to
          // the :15 grid) before the next starts. A kids-only chain can't hold
          // the evening slot - it ends where the kids' end-time rule allows.
          // The morning floor is a hard lower clamp; a chain long enough to
          // hit it (possible only with extreme manual repeat targets) drops
          // its lowest-priority show until it fits.
          const packOnce = (arr) => {
            let anchor = anchorMin - saliIdx * ANCHOR_STAGGER;
            const last = arr[arr.length - 1];
            if (last.movie.lastenelokuva) {
              anchor = Math.min(anchor, floor15(kidsLatestEnd - last.movie.kesto));
            }
            const st = new Array(arr.length);
            for (let i = arr.length - 1; i >= 0; i--) {
              const s = arr[i];
              let start = i === arr.length - 1
                ? anchor
                : floor15(st[i + 1] - gapSama - s.movie.kesto);
              if (s.movie.lastenelokuva) {
                start = Math.min(start, floor15(kidsLatestEnd - s.movie.kesto));
              }
              st[i] = Math.max(start, floorMin);
            }
            return st;
          };
          const overlaps = (arr, st) => arr.some((s, i) =>
            i > 0 && st[i - 1] + arr[i - 1].movie.kesto + gapSama > st[i]);

          let starts = packOnce(chain);
          while (chain.length > 1 && overlaps(chain, starts)) {
            let worst = 0;
            chain.forEach((s, i) => { if (s.rankIndex > chain[worst].rankIndex) worst = i; });
            chain.splice(worst, 1);
            starts = packOnce(chain);
          }

          // Forward compaction: if the kids end-time clamp opened a gap beyond
          // buffer+rounding, pull EVERYTHING after the gap earlier until the
          // gap is an ordinary cleanup buffer again. Tight packing is a hard
          // rule - a room never sits idle longer than cleanup+rounding - and it
          // outranks exact anchor adherence: the evening show slides earlier
          // than the nominal anchor only in the rare case the kids rule forces
          // it (e.g. unusually late configured hours), which is exactly what a
          // real cinema would do rather than leave the room dark for an hour.
          // The pull is floored to the :15 grid so the closed gap lands back in
          // [buffer, buffer+14] like every normally-packed one; a kids show in
          // the pulled suffix never goes below its earliest-allowed start.
          for (let i = 1; i < chain.length; i++) {
            const gap = starts[i] - (starts[i - 1] + chain[i - 1].movie.kesto);
            if (gap <= gapSama + 14) continue;
            let pull = floor15(gap - gapSama);
            for (let j = i; j < chain.length; j++) {
              if (chain[j].movie.lastenelokuva) {
                pull = Math.min(pull, starts[j] - round15(kidsEarliest));
              }
            }
            if (pull <= 0) continue;
            for (let j = i; j < chain.length; j++) starts[j] -= pull;
          }

          // Optional cross-theater stagger (default 0 = off): nudge the whole
          // chain earlier in 15-min steps until no show starts within gapEri
          // of another room's show - the chain itself stays intact.
          if (gapEri > 0) {
            const collides = () => starts.some(st =>
              placedToday.some(p => Math.abs(p - st) < gapEri));
            let guard = 8;
            while (guard-- > 0 && collides() && starts[0] - 15 >= floorMin) {
              for (let i = 0; i < starts.length; i++) starts[i] -= 15;
            }
          }

          chain.forEach((s, i) => {
            placedToday.push(starts[i]);
            entries.push({ sali, start: starts[i], s });
          });
        });

        return entries;
      };

      let entries = buildDay(showings);

      // ── Opening-time target: top the day up until it opens early enough ──
      // Reference weekdays open around 16:00 and Saturday at 13:30 (median
      // first-show start over 27 weeks) almost regardless of roster size -
      // a light week just spreads its titles across more days. If this day's
      // emergent opening lands later than the target, try adding shows one
      // at a time - each the best-ranked movie NOT yet playing today (that's
      // how the reference lengthens a day; only 1.9% of its movie-days are
      // same-day repeats, and those are nearly all the #1 title, the
      // fallback here) - and keep whichever length opened CLOSEST to the
      // target (ties to the shorter day). A single extra show often lands in
      // a room whose chain isn't the day's earliest and moves nothing, so
      // the search always walks a few steps ahead rather than stopping at
      // the first unhelpful add. Explicit naytosTavoitteet totals are hard
      // caps and never topped up.
      const targetStr = (settings.avautuu_tavoite ?? {})[paiva] ?? OPEN_TARGET[paiva];
      if (targetStr) {
        const target = toMin(targetStr);
        const firstOf = es => Math.min(...es.map(e => e.start));
        const pickExtra = (cur) => {
          const today = new Set(cur.map(s => s.movie.id));
          let extra = null;
          selectedMovies.some((movie, rankIndex) => {
            if (naytosTavoitteet[movie.id] != null) return false;
            if (movie.lastenelokuva && !settings.lastenelokuva.paivat.includes(paiva)) return false;
            if (today.has(movie.id)) return false;
            extra = { movie, rankIndex };
            return true;
          });
          if (extra) return extra;
          // Whole roster already plays today - repeat the least-shown top
          // title, the only same-day repeat the reference runs.
          const perMovie = new Map();
          cur.forEach(s => perMovie.set(s.movie.id, (perMovie.get(s.movie.id) ?? 0) + 1));
          selectedMovies.slice(0, TOP_RANK_COUNT).forEach((movie, rankIndex) => {
            if (naytosTavoitteet[movie.id] != null) return;
            if (movie.lastenelokuva && !settings.lastenelokuva.paivat.includes(paiva)) return;
            if (!extra || (perMovie.get(movie.id) ?? 0) < (perMovie.get(extra.movie.id) ?? 0)) {
              extra = { movie, rankIndex };
            }
          });
          return extra;
        };
        let best = { dist: Math.abs(firstOf(entries) - target), showings, entries };
        let cur = { showings, entries };
        for (let step = 0; step < 5 && firstOf(cur.entries) > target + 15; step++) {
          const extra = pickExtra(cur.showings);
          if (!extra) break;
          const trialShowings = [...cur.showings, extra];
          const trialEntries = buildDay(trialShowings);
          cur = { showings: trialShowings, entries: trialEntries };
          const dist = Math.abs(firstOf(trialEntries) - target);
          if (dist < best.dist) best = { dist, ...cur };
        }
        ({ showings, entries } = best);
      }

      entries.forEach(({ sali, start, s }) => {
        naytokset.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          sali,
          paiva,
          alkaa: toHHMM(start),
          loppuu: toHHMM(start + s.movie.kesto),
          elokuvaId: s.movie.id,
          nimi: s.movie.nimi,
          kesto: s.movie.kesto,
          ikäraja: s.movie.ikäraja,
          hinta: s.movie.hinta,
          jakelija: s.movie.jakelija,
          lastenelokuva: !!s.movie.lastenelokuva,
        });
      });
    });

    return naytokset;
  }

  // Validate a single screening against constraints (used while/after dragging
  // in the editor). Opening hours are intentionally NOT checked here - manual
  // edits are free to run earlier/later than the configured hours, and
  // schedule-ui.js extends that day's hours to match instead of blocking the
  // move. Only same-theater overlap (respecting the gap) is a hard constraint,
  // since two shows genuinely cannot play in the same room at once.
  function validateScreening(naytos, allNaytokset, settings) {
    const warnings = [];
    const startMin = toMin(naytos.alkaa);
    const endMin = startMin + naytos.kesto;
    const gapSama = settings.minimivali_sama_sali;

    const same = allNaytokset.filter(n =>
      n.id !== naytos.id && n.sali === naytos.sali && n.paiva === naytos.paiva
    );
    same.forEach(n => {
      const nStart = toMin(n.alkaa);
      const nEnd = nStart + n.kesto;
      if (startMin < nEnd + gapSama && endMin + gapSama > nStart) {
        warnings.push(`Päällekkäisyys: ${n.nimi}`);
      }
    });

    return warnings;
  }

  return { schedule, validateScreening, toMin, toHHMM, round15, getPaivat, PAIVA_LYHYET, SALAT };
})();

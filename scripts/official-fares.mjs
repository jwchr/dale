// Fares on NJ Transit's official route 165 stops, from the printed timetable's fare-zone map (#31 step 2,
// plan docs/plans/2026-11-20-official-stop-fares.md, checked by Codex in #238). NJ Transit's schedule file has
// no fare data (#231), so the printed map stays the only source. A zone is never narrowed by guessing: a stop
// gets "zone X or Y" wherever the printed map and the stop match allow either, and no zone when they allow more.

const DIRS = ['toWestwood', 'toNewYork'];
/** Fewest printed timepoints that must anchor in each direction; below it no fares are added at all. */
export const MIN_ANCHORS = 16;

const WORDS = { STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', TERRACE: 'TERR', TER: 'TERR',
  PLACE: 'PL', COURT: 'CT', DRIVE: 'DR', TURNPIKE: 'TPKE', PARKWAY: 'PKWY', LANE: 'LN', HIGHWAY: 'HWY',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };

/** One cross street, normalized: case, punctuation, common abbreviations, N./S. */
const street = (s) => s.toUpperCase().replace(/[.,#']/g, ' ').split(/\s+/).filter(Boolean).map((w) => WORDS[w] ?? w).join(' ');

/** The two cross streets of "X at Y" (also "X - Y", "X & Y", "X under Y"), or undefined. */
export function crossStreets(where) {
  const parts = String(where).split(/\s+AT\s+|\s*-\s+|\s+-\s*|\s+&\s+|\s+UNDER\s+/i).map(street).filter(Boolean);
  return parts.length === 2 && parts[0] !== parts[1] ? parts.sort() : undefined;
}

/** Town name without the printed landmark or NJ's municipal type ("Hackensack (Sears)", "WEEHAWKEN TWP"). */
export function town(name) {
  return String(name).split(/\s+\(|\s+-\s+/)[0].toUpperCase().replace(/[.,]/g, '')
    .replace(/\s+(TWP|TOWNSHIP|BORO|BOROUGH|CITY|TOWN|VILLAGE)$/, '').trim();
}

const sameStreets = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const adjacent = (lo, hi) => hi - lo <= 1;

/**
 * Adds publishedFares to an official schedule. Returns the dataset (unchanged when the floor is not met)
 * and an aggregate report: anchors per direction and stops with one zone, two zones or none. No stop IDs.
 */
export function addOfficialFares(ds, doc) {
  const f = doc.fares;
  // Every route 165 variant NJ Transit's file names (165, 165T, 165P, 165R, 165RF, 165FP): the printed table covers them all.
  const routeIds = ds.routes.filter((r) => /^165[A-Z]*$/.test(r.shortName)).map((r) => r.id);
  const pabt = new Set(ds.stops.filter((s) => s.terminal === 'PABT').map((s) => s.id));
  const stops = new Map(ds.stops.map((s) => [s.id, s]));
  const printed = Object.fromEntries(DIRS.map((dir) => [dir, doc.timepoints[dir].map((t) => {
    const z = f.zones[dir][t.ref];
    if (!z || z.length < 1 || z.length > 2 || (z.length === 2 && z[1] !== z[0] + 1)) throw new Error(`bad fare zone for ${dir} ${t.ref}`);
    return { ref: t.ref, pabt: t.city === 'New York', streets: crossStreets(t.where), town: town(t.city), band: [z[0], z[z.length - 1]] };
  })]));

  // Direction of each pattern: printed order runs from Port Authority (toWestwood) or toward it (toNewYork).
  const patterns = ds.patterns.filter((p) => routeIds.includes(p.routeId));
  const dirOf = new Map();
  for (const p of patterns) {
    if (pabt.has(p.stopIds[0]) && !pabt.has(p.stopIds.at(-1))) dirOf.set(p.directionId, 'toWestwood');
    else if (pabt.has(p.stopIds.at(-1)) && !pabt.has(p.stopIds[0])) dirOf.set(p.directionId, 'toNewYork');
  }

  const anchored = { toWestwood: new Set(), toNewYork: new Set() };
  /** Every band each stop received, and stops a pattern placed in a gap wider than two adjacent zones. */
  const bands = new Map(), tooWide = new Set();
  const give = (id, band) => { if (!bands.has(id)) bands.set(id, []); bands.get(id).push(band); };

  for (const p of patterns) {
    const dir = dirOf.get(p.directionId);
    if (!dir) continue;
    const tps = printed[dir];
    // Candidate index per printed timepoint: exactly one matching stop in this pattern, else none.
    const cand = tps.map((tp) => {
      if (tp.pabt) {
        // Port Authority is the leading run of PABT stops (toWestwood) or the trailing run (toNewYork).
        let i;
        if (dir === 'toWestwood') { i = -1; while (pabt.has(p.stopIds[i + 1])) i++; }
        else { i = p.stopIds.length; while (i > 0 && pabt.has(p.stopIds[i - 1])) i--; if (i === p.stopIds.length) i = -1; }
        return i >= 0 ? i : undefined;
      }
      if (!tp.streets) return undefined;
      const hits = p.stopIds.flatMap((id, i) => {
        const s = stops.get(id);
        return s && !pabt.has(id) && s.city && town(s.city) === tp.town && sameStreets(crossStreets(s.name), tp.streets) ? [i] : [];
      });
      return hits.length === 1 ? hits[0] : undefined;
    });
    // Anchors keep the printed order: any pair out of order drops both.
    const keep = cand.map((c, k) => c !== undefined
      && cand.every((o, m) => o === undefined || m === k || (m < k ? o < c : o > c)));
    const anchors = cand.flatMap((c, k) => keep[k] ? [{ k, i: c }] : []);
    for (const a of anchors) anchored[dir].add(tps[a.k].ref);
    for (const a of anchors) give(p.stopIds[a.i], tps[a.k].band);
    // Stops between two anchors get the union of every printed band from the first to the second,
    // including timepoints in between that did not anchor (Codex, #238).
    for (let n = 0; n + 1 < anchors.length; n++) {
      const a = anchors[n], b = anchors[n + 1];
      const lo = Math.min(...tps.slice(a.k, b.k + 1).map((t) => t.band[0]));
      const hi = Math.max(...tps.slice(a.k, b.k + 1).map((t) => t.band[1]));
      for (let i = a.i + 1; i < b.i; i++) {
        const id = p.stopIds[i];
        if (pabt.has(id)) continue;
        if (adjacent(lo, hi)) give(id, [lo, hi]); else tooWide.add(id);
      }
    }
  }

  const report = { anchors: { toWestwood: anchored.toWestwood.size, toNewYork: anchored.toNewYork.size },
    of: { toWestwood: printed.toWestwood.length, toNewYork: printed.toNewYork.length }, oneZone: 0, twoZones: 0, noZone: 0, added: false };
  if (DIRS.some((dir) => anchored[dir].size < MIN_ANCHORS)) { report.noZone = ds.stops.length; return { ds, report }; }

  const stopZones = {};
  for (const id of pabt) stopZones[id] = [1, 1];
  for (const [id, list] of bands) {
    if (pabt.has(id) || tooWide.has(id)) continue;
    const lo = Math.min(...list.map((b) => b[0])), hi = Math.max(...list.map((b) => b[1]));
    if (adjacent(lo, hi)) stopZones[id] = [lo, hi];
  }
  for (const s of ds.stops) {
    const z = stopZones[s.id];
    if (!z) report.noZone++; else if (z[0] === z[1]) report.oneZone++; else report.twoZones++;
  }
  report.added = true;
  const publishedFares = {
    source: f.source,
    effective: f.effective,
    stopZones,
    newYorkStopIds: [...pabt],
    withinNewJersey: f.cashCents.withinNewJersey,
    toFromNewYork: f.cashCents.toFromNewYork,
    routeIds,
    matched: true,
  };
  return { ds: { ...ds, publishedFares }, report };
}

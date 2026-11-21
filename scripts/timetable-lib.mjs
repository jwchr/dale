// Build a Dale dataset from a hand-checked transcription of an NJ Transit PRINTED timetable
// (data/t0165/transcription.json). This is not NJ Transit's data feed; the dataset says so in
// meta.transcribed and the app shows a banner. The real GTFS build is scripts/gtfs-lib.mjs.

const DAY_TYPES = {
  weekday: { id: 'WKDY', days: [true, true, true, true, true, false, false] },
  saturday: { id: 'SAT', days: [false, false, false, false, false, true, false] },
  sunday: { id: 'SUN', days: [false, false, false, false, false, false, true] },
};
const DIRS = {
  toNewYork: { directionId: 0, code: 'N', suffix: '(to New York)' },
  toWestwood: { directionId: 1, code: 'W', suffix: '(to Westwood)' },
};
/** Far-future placeholder: the printed timetable does not say when it ends. The app banner says so. */
export const UNKNOWN_END = '20991231';

const hhmmToMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const stopIdFor = (dir, ref) => (ref === '1' ? 'PABT' : `${DIRS[dir].code}${ref}`);
const destinationWord = (city) => city.replace(/\s*\(.*?\)/g, '').split(' - ')[0].trim().toUpperCase();
const usDate = (ymd) => `${Number(ymd.slice(4, 6))}/${Number(ymd.slice(6, 8))}/${ymd.slice(2, 4)}`;

export function buildTimetableDataset(doc, { builtAt }) {
  const routes = [
    { id: 'R165', shortName: '165', longName: 'Westwood - New York', color: '1F6F43' },
    { id: 'R165T', shortName: '165T', longName: 'Westwood - New York (Turnpike express)', color: 'F2B705' },
  ];
  const routeFor = (variant) => (variant === 'T' ? routes[1] : routes[0]);

  const stops = [{ id: 'PABT', name: 'New York - Port Authority Bus Terminal', terminal: 'PABT' }];
  const order = { toNewYork: [], toWestwood: [] };
  const byRef = { toNewYork: new Map(), toWestwood: new Map() };
  for (const dir of Object.keys(DIRS)) {
    for (const tp of doc.timepoints[dir]) {
      order[dir].push(tp.ref);
      byRef[dir].set(tp.ref, tp);
      if (tp.ref === '1') continue;
      stops.push({ id: stopIdFor(dir, tp.ref), name: `${tp.city} - ${tp.where} ${DIRS[dir].suffix}` });
    }
  }
  const stopById = new Map(stops.map((s) => [s.id, s]));
  // Same map reference and same printed location in both directions = the stop across the street.
  // Several map references are different corners in the two directions; those get no twin.
  const norm = (t) => `${t.city}|${t.where}`.toLowerCase().replace(/\s+/g, ' ');
  for (const tp of doc.timepoints.toNewYork) {
    const other = byRef.toWestwood.get(tp.ref);
    if (tp.ref === '1' || !other || norm(tp) !== norm(other)) continue;
    stopById.get(stopIdFor('toNewYork', tp.ref)).twin = stopIdFor('toWestwood', tp.ref);
    stopById.get(stopIdFor('toWestwood', tp.ref)).twin = stopIdFor('toNewYork', tp.ref);
  }
  for (const id of ['N19', 'N20']) if (stopById.has(id)) stopById.get(id).noteId = 'westwood-pickup';
  // Printed note: PM Parkway express trips stop at the Exit 165 Park/Ride lot only on request at boarding.
  if (stopById.has('W13')) stopById.get('W13').noteId = 'parkride-request';

  const patterns = [];
  const patternIndex = new Map();
  const counters = new Map();
  const trips = [];
  const tripIds = new Set();

  for (const [dayType, byDir] of Object.entries(doc.tables)) {
    const cal = DAY_TYPES[dayType];
    if (!cal) throw new Error(`unknown day type ${dayType}`);
    for (const [dir, rows] of Object.entries(byDir)) {
      const d = DIRS[dir];
      if (!d) throw new Error(`unknown direction ${dir}`);
      for (const row of rows) {
        const refs = Object.keys(row.t).sort((a, b) => order[dir].indexOf(a) - order[dir].indexOf(b));
        if (refs.some((r) => !byRef[dir].has(r))) throw new Error(`unknown map reference in ${dayType}/${dir}`);
        if (refs.length < 2) throw new Error(`row with fewer than 2 stops in ${dayType}/${dir}`);
        const stopIds = refs.map((r) => stopIdFor(dir, r));
        const variant = row.v || undefined;
        const route = routeFor(variant);
        const key = `${dir}|${variant ?? ''}|${stopIds.join(',')}`;
        let pat = patternIndex.get(key);
        if (!pat) {
          const ck = `${d.code}${variant ?? 'L'}`;
          const n = (counters.get(ck) ?? 0) + 1;
          counters.set(ck, n);
          const last = refs[refs.length - 1];
          const dest = dir === 'toNewYork' ? 'NEW YORK' : destinationWord(byRef[dir].get(last).city);
          pat = { id: `${ck}${n}`, routeId: route.id, directionId: d.directionId, headsign: `${route.shortName} ${dest}`, stopIds };
          if (variant) pat.variant = variant;
          patternIndex.set(key, pat);
          patterns.push(pat);
        }
        const times = refs.map((r) => hhmmToMin(row.t[r]) * 60);
        const base = `${pat.id}-${cal.id}-${row.t[refs[0]].replace(':', '')}`;
        let id = base;
        for (let i = 2; tripIds.has(id); i++) id = `${base}-${i}`;
        tripIds.add(id);
        trips.push({ id, patternId: pat.id, serviceId: cal.id, times });
      }
    }
  }
  trips.sort((a, b) => (a.serviceId === b.serviceId ? a.times[0] - b.times[0] || (a.id < b.id ? -1 : 1) : a.serviceId < b.serviceId ? -1 : 1));

  const calendars = {};
  for (const cal of Object.values(DAY_TYPES)) calendars[cal.id] = { days: cal.days, start: doc.document.issued, end: UNKNOWN_END, added: [], removed: [] };

  const publishedGates = {
    source: doc.gates.source,
    effective: doc.gates.effective,
    rules: doc.gates.rules.map((r) => {
      const o = { service: r.service, dayTypes: r.dayTypes, gate: r.gate };
      if (r.door) o.door = r.door;
      if (r.from) { o.fromMin = hhmmToMin(r.from); o.toMin = hhmmToMin(r.to); }
      return o;
    }),
  };

  // Fare zones are per map reference and direction, read from the printed map; a boundary stop keeps both bands.
  const f = doc.fares;
  const stopZones = {};
  for (const dir of Object.keys(DIRS)) {
    for (const ref of order[dir]) {
      const z = f.zones[dir][ref];
      if (!z || z.length < 1 || z.length > 2 || (z.length === 2 && z[1] !== z[0] + 1)) throw new Error(`bad fare zone for ${dir} ${ref}`);
      const id = stopIdFor(dir, ref);
      const pair = [z[0], z[z.length - 1]];
      if (stopZones[id] && stopZones[id].join() !== pair.join()) throw new Error(`conflicting fare zones for ${id}`);
      stopZones[id] = pair;
    }
  }
  const publishedFares = {
    source: f.source,
    effective: f.effective,
    stopZones,
    newYorkStopIds: ['PABT'],
    withinNewJersey: f.cashCents.withinNewJersey,
    toFromNewYork: f.cashCents.toFromNewYork,
    routeIds: routes.map((r) => r.id),
  };

  return {
    meta: {
      demo: false,
      source: `NJ Transit printed timetable No. ${doc.document.number} (issued ${usDate(doc.document.issued)}), transcribed by Dale`,
      feedVersion: `t${doc.document.number.padStart(4, '0')}-${doc.document.issued}`,
      builtAt,
      timezone: 'America/New_York',
      transcribed: { issued: doc.document.issued, documentId: doc.document.id },
    },
    routes,
    stops,
    patterns,
    trips,
    calendars,
    publishedGates,
    publishedFares,
  };
}

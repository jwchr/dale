// Synthetic but realistically sized GTFS for the wider rescue schedule tests (#32, #31).
// Invented stops, routes and times only; no NJ Transit file or recording is used.
const PABT = { id: 'S0', name: 'PORT AUTHORITY BUS TERMINAL', lat: 40.757, lon: -73.991 };

interface RouteSpec { id: string; shortName: string; stops: string[]; trips: { WK: number; SA: number; SU: number }; frequency?: boolean }

/** Stop ids S1..S44 run from Port Authority out along the corridor; B*, C*, D* are branch stops. */
function stopsTable() {
  const rows = [PABT];
  for (let i = 1; i <= 44; i++) rows.push({ id: `S${i}`, name: `CORRIDOR AVE AT ${i} ST`, lat: 40.757 + i * 0.0045, lon: -73.991 - i * 0.0018 });
  for (const [prefix, base] of [['B', 12], ['C', 20], ['D', 30]] as const) {
    for (let i = 1; i <= 25; i++) rows.push({ id: `${prefix}${i}`, name: `${prefix} BRANCH RD AT ${i} AVE`, lat: 40.757 + base * 0.0045 + i * 0.002, lon: -73.991 - base * 0.0018 - i * 0.0042 });
  }
  // A stop about 300 m from S30 that only route 167 serves (a "near home" stop).
  rows.push({ id: 'N30', name: 'SIDE ST NEAR 30 ST', lat: 40.757 + 30 * 0.0045 + 0.0027, lon: -73.991 - 30 * 0.0018 });
  for (let i = 1; i <= 20; i++) rows.push({ id: `Z${i}`, name: `FAR AWAY RD AT ${i}`, lat: 39.9 + i * 0.003, lon: -74.9 });
  return rows;
}

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const corridorStops = ['S0', ...range('S', 1, 44)];

export const SYNTHETIC_ROUTES: RouteSpec[] = [
  { id: '163', shortName: '163', stops: corridorStops, trips: { WK: 90, SA: 60, SU: 45 } },
  { id: '164', shortName: '164', stops: corridorStops.slice(0, 40), trips: { WK: 80, SA: 50, SU: 35 } },
  { id: '165', shortName: '165', stops: corridorStops, trips: { WK: 120, SA: 80, SU: 60 } },
  { id: '165T', shortName: '165T', stops: ['S0', 'S1', ...range('S', 25, 44)], trips: { WK: 50, SA: 0, SU: 0 } },
  // Share corridor stops, then branch away.
  { id: '166', shortName: '166', stops: ['S0', ...range('S', 1, 12), ...range('B', 1, 25)], trips: { WK: 50, SA: 30, SU: 20 } },
  { id: '167', shortName: '167', stops: ['S0', ...range('S', 1, 29), 'N30', ...range('C', 1, 25)], trips: { WK: 45, SA: 25, SU: 15 } },
  { id: '168', shortName: '168', stops: ['S0', ...range('S', 1, 6), ...range('S', 28, 34), ...range('D', 1, 25)], trips: { WK: 40, SA: 20, SU: 15 } },
  // Shares only Port Authority: not a way home from the corridor.
  { id: '190', shortName: '190', stops: ['S0', ...range('Z', 1, 20)], trips: { WK: 40, SA: 20, SU: 10 } },
  // Shares no stop at all.
  { id: '900', shortName: '900', stops: range('Z', 1, 20), trips: { WK: 20, SA: 10, SU: 5 } },
  // Shares a corridor stop but runs on frequencies: no exact times.
  { id: '777', shortName: '777', stops: ['S20', 'S21', ...range('Z', 1, 5)], trips: { WK: 2, SA: 0, SU: 0 }, frequency: true },
];

const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');

export interface SyntheticOptions { fares?: boolean; zones?: boolean; routes?: RouteSpec[] }

/** GTFS text files keyed by name, like the official ZIP's entries. */
export function syntheticGtfs({ fares = false, zones = fares, routes = SYNTHETIC_ROUTES }: SyntheticOptions = {}): Record<string, string> {
  const stops = stopsTable();
  const zoneOf = (id: string) => id === 'S0' ? '1' : id.startsWith('S') ? String(2 + Math.floor(Number(id.slice(1)) / 8)) : id.startsWith('Z') ? '20' : '9';
  const files: Record<string, string> = {
    'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nNJB,Synthetic Bus,https://example.invalid,America/New_York\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\n' + routes.map((r) => `${r.id},NJB,${r.shortName},Synthetic ${r.shortName},3\n`).join(''),
    'stops.txt': `stop_id,stop_code,stop_name,stop_lat,stop_lon${zones ? ',zone_id' : ''}\n`
      + stops.map((s, i) => `${s.id},${30000 + i},"${s.name}",${s.lat.toFixed(6)},${s.lon.toFixed(6)}${zones ? `,${zoneOf(s.id)}` : ''}\n`).join(''),
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n'
      + 'WK,1,1,1,1,1,0,0,20261101,20261231\nSA,0,0,0,0,0,1,0,20261101,20261231\nSU,0,0,0,0,0,0,1,20261101,20261231\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nWK,20261126,2\nSU,20261126,1\n',
  };
  const trips: string[] = [], times: string[] = [], freq: string[] = [];
  for (const r of routes) {
    for (const service of ['WK', 'SA', 'SU'] as const) {
      const n = r.trips[service];
      for (let k = 0; k < n; k++) {
        for (const dir of [0, 1]) {
          const id = `${r.id}-${service}-${dir}-${k}`;
          const seq = dir === 0 ? [...r.stops].reverse() : r.stops; // 0 = to New York
          trips.push(`${r.id},${service},${id},${r.shortName} ${dir === 0 ? 'NEW YORK' : 'OUTBOUND'},${dir}`);
          const start = 5 * 3600 + Math.floor((k * 19 * 3600) / Math.max(n, 1));
          seq.forEach((stop, i) => {
            const t = start + i * 110;
            // Every fourth stop is a timepoint; the rest are left blank as the feed allows.
            const shown = i === 0 || i === seq.length - 1 || i % 4 === 0;
            times.push(`${id},${shown ? hms(t) : ''},${shown ? hms(t) : ''},${stop},${i + 1}`);
          });
          if (r.frequency) freq.push(`${id},06:00:00,22:00:00,900`);
        }
      }
    }
  }
  files['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id\n' + trips.join('\n') + '\n';
  files['stop_times.txt'] = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + times.join('\n') + '\n';
  if (freq.length) files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs\n' + freq.join('\n') + '\n';
  if (fares) {
    files['fare_attributes.txt'] = 'fare_id,price,currency_type,payment_method,transfers,transfer_duration\n'
      + 'Z1,1.60,USD,0,0,\nZ2,2.10,USD,0,0,\nNY,4.00,USD,1,,\nFAR,9.99,USD,0,0,\n';
    files['fare_rules.txt'] = 'fare_id,route_id,origin_id,destination_id,contains_id\n'
      + 'Z1,,2,2,\nZ2,,2,3,\nNY,165,1,4,\nNY,166,1,9,\nFAR,900,20,20,\n';
  }
  return files;
}

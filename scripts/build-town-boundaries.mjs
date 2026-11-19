#!/usr/bin/env node
// Usage: node scripts/build-town-boundaries.mjs [--year 2026] [--out public/data/towns.json]
// Builds the verified municipal borders used by Town Welcome cards (#99).
// Sources (both public, no credentials):
//  - US Census Bureau TIGER/Line county subdivisions for New Jersey (NJ municipalities are county
//    subdivisions). Public domain. Downloaded once per run; the zip is never committed.
//  - NJ Transit GIS public bus-stop layer (same layer as scripts/stop-cities.mjs), used only to find which
//    municipalities Dale's lines 163/164/165 stop in. Stop coordinates are NOT written to the output.
// Output keeps only towns Dale's stops fall in plus the towns sharing a border with them, with
// Douglas-Peucker-simplified polygons (max border shift = tolerance + rounding, well under 15 m).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { unzipSync } from 'fflate';
import { STOP_CITY_SOURCE } from '../src/domain/stopInfo.ts';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const year = opt('year', '2026');
const out = opt('out', 'public/data/towns.json');
const TIGER_URL = `https://www2.census.gov/geo/tiger/TIGER${year}/COUSUB/tl_${year}_34_cousub.zip`;
const LINES = [163, 164, 165];
const TOLERANCE_M = 10; // Douglas-Peucker tolerance in meters
const DECIMALS = 5; // 1e-5 degrees is at most ~1.1 m
const MAX_BYTES = 200 * 1024;

async function fetchBytes(url, limit) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > limit) throw new Error(`${url}: response too large`);
  return buf;
}

async function servedStops() {
  const records = [];
  for (let page = 0; page < 10; page++) {
    const url = new URL(STOP_CITY_SOURCE + '/query');
    for (const [k, v] of Object.entries({ f: 'json', where: `LINE IN (${LINES.join(',')})`, outFields: 'STOP_NUM,MUNICIPALITY,LINE,DLAT_GIS,DLONG_GIS', returnGeometry: 'false', orderByFields: 'OBJECTID', resultOffset: String(page * 1000), resultRecordCount: '1000' })) url.searchParams.set(k, v);
    const body = JSON.parse(new TextDecoder().decode(await fetchBytes(url.href, 8 * 1024 * 1024)));
    if (!Array.isArray(body.features) || body.error) throw new Error('Invalid NJ Transit stop response');
    records.push(...body.features.map(f => f.attributes));
    if (!body.exceededTransferLimit) return records.filter(a => Number.isFinite(a?.DLAT_GIS) && Number.isFinite(a?.DLONG_GIS)
      && Math.abs(a.DLAT_GIS - 40.8) < 1 && Math.abs(a.DLONG_GIS + 74.1) < 1);
  }
  throw new Error('Incomplete NJ Transit stop response');
}

// --- shapefile (.shp polygons + .dbf attributes) ---
function readDbf(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint32(4, true), headerLen = dv.getUint16(8, true), recordLen = dv.getUint16(10, true);
  const fields = [];
  for (let o = 32; buf[o] !== 0x0d; o += 32) {
    fields.push({ name: new TextDecoder().decode(buf.subarray(o, o + 11)).replace(/\0.*$/s, ''), len: buf[o + 16] });
  }
  const dec = new TextDecoder('utf-8'), rows = [];
  for (let i = 0; i < count; i++) {
    let o = headerLen + i * recordLen + 1; const row = {};
    for (const f of fields) { row[f.name] = dec.decode(buf.subarray(o, o + f.len)).trim(); o += f.len; }
    rows.push(row);
  }
  return rows;
}
function readShp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = dv.getInt32(24, false) * 2, shapes = [];
  for (let o = 100; o < end;) {
    const len = dv.getInt32(o + 4, false) * 2, c = o + 8, type = dv.getInt32(c, true);
    if (type !== 5) throw new Error(`Unexpected shape type ${type}`);
    const numParts = dv.getInt32(c + 36, true), numPoints = dv.getInt32(c + 40, true);
    const starts = []; for (let p = 0; p < numParts; p++) starts.push(dv.getInt32(c + 44 + p * 4, true));
    const pts = c + 44 + numParts * 4, rings = [];
    for (let p = 0; p < numParts; p++) {
      const ring = [];
      for (let k = starts[p]; k < (p + 1 < numParts ? starts[p + 1] : numPoints); k++) ring.push([dv.getFloat64(pts + k * 16, true), dv.getFloat64(pts + k * 16 + 8, true)]);
      rings.push(ring);
    }
    shapes.push(rings); o = c + len;
  }
  return shapes;
}

// --- geometry helpers ---
/** Positive for clockwise rings (shapefile outer rings). */
const signedArea = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[i][0] - r[j][0]) * (r[i][1] + r[j][1]); return a / 2; };
function inRing(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Shapefile rings: outer rings clockwise, holes counter-clockwise. Returns [[outer, ...holes], ...]. */
function toPolygons(rings) {
  const outers = rings.filter(r => signedArea(r) > 0).map(r => [r]);
  for (const hole of rings.filter(r => signedArea(r) <= 0)) {
    const owner = outers.find(p => inRing(hole[0], p[0]));
    if (!owner) throw new Error('Hole without an outer ring');
    owner.push(hole);
  }
  return outers;
}
const inTown = (pt, polys) => polys.some(([outer, ...holes]) => inRing(pt, outer) && !holes.some(h => inRing(pt, h)));

function simplifyRing(ring, toleranceM) {
  const lat0 = ring[0][1] * Math.PI / 180, kx = 111_320 * Math.cos(lat0), ky = 110_540;
  const P = ring.slice(0, -1).map(([x, y]) => [x * kx, y * ky]); // open ring, meters
  if (P.length < 4) return ring;
  let far = 1, best = -1;
  for (let i = 1; i < P.length; i++) { const d = (P[i][0] - P[0][0]) ** 2 + (P[i][1] - P[0][1]) ** 2; if (d > best) { best = d; far = i; } }
  const keep = new Uint8Array(P.length + 1); keep[0] = keep[far] = keep[P.length] = 1;
  const at = i => P[i % P.length];
  const stack = [[0, far], [far, P.length]];
  while (stack.length) {
    const [a, b] = stack.pop(); const A = at(a), B = at(b);
    const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    let idx = -1, dmax = 0;
    for (let i = a + 1; i < b; i++) {
      const p = at(i); let t = L2 ? ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] - A[0] - t * dx, p[1] - A[1] - t * dy);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > toleranceM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const outRing = [];
  for (let i = 0; i <= P.length; i++) if (keep[i]) outRing.push(ring[i % P.length]);
  return outRing.length >= 4 ? outRing : ring;
}
const round = v => Number(v.toFixed(DECIMALS));

// --- main ---
const zip = await fetchBytes(TIGER_URL, 50 * 1024 * 1024);
const sha256 = createHash('sha256').update(zip).digest('hex');
const files = unzipSync(zip, { filter: f => /\.(shp|dbf)$/.test(f.name) });
const shpName = Object.keys(files).find(n => n.endsWith('.shp')), dbfName = Object.keys(files).find(n => n.endsWith('.dbf'));
const rows = readDbf(files[dbfName]), shapes = readShp(files[shpName]);
if (rows.length !== shapes.length) throw new Error('Shapefile and attribute counts differ');
const all = rows.map((r, i) => ({ geoid: r.GEOID, name: r.NAME, namelsad: r.NAMELSAD, countyfp: r.COUNTYFP, cousubfp: r.COUSUBFP, polygons: toPolygons(shapes[i]) }))
  .filter(t => t.cousubfp !== '00000' && /^\d{10}$/.test(t.geoid));

const stops = await servedStops();
const served = new Map(), outside = [];
for (const s of stops) {
  const pt = [s.DLONG_GIS, s.DLAT_GIS]; const hits = all.filter(t => inTown(pt, t.polygons));
  if (hits.length === 1) {
    const t = hits[0]; const e = served.get(t.geoid) ?? { town: t, stops: 0, njtNames: new Set() };
    e.stops++; if (typeof s.MUNICIPALITY === 'string') e.njtNames.add(s.MUNICIPALITY.trim()); served.set(t.geoid, e);
  } else outside.push(`${s.STOP_NUM} ${s.MUNICIPALITY} (${hits.length} towns)`);
}
// Neighbors: share at least one exact TIGER border segment (positive length) with a served town; a corner touch is not enough.
const key = ([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`;
const edgeKey = (a, b) => { const ka = key(a), kb = key(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
const edges = (town) => town.polygons.flatMap((p) => p.flatMap((r) => r.slice(1).map((v, i) => [r[i], v]).filter(([a, b]) => key(a) !== key(b))));
const servedEdges = new Set();
for (const { town } of served.values()) for (const [a, b] of edges(town)) servedEdges.add(edgeKey(a, b));
const neighbors = all.filter(t => !served.has(t.geoid) && edges(t).some(([a, b]) => servedEdges.has(edgeKey(a, b))));

const pick = [...[...served.values()].map(e => ({ ...e.town, served: true })), ...neighbors.map(t => ({ ...t, served: false }))]
  .sort((a, b) => a.geoid.localeCompare(b.geoid));
const COUNTY = { '003': 'Bergen', '017': 'Hudson', '031': 'Passaic', '013': 'Essex' };
const towns = pick.map(t => {
  const polygons = t.polygons.map(p => p.map(r => simplifyRing(r, TOLERANCE_M).map(([x, y]) => [round(x), round(y)])));
  const xs = polygons.flat(2).map(v => v[0]), ys = polygons.flat(2).map(v => v[1]);
  return { geoid: t.geoid, name: t.name, nameLsad: t.namelsad, county: COUNTY[t.countyfp] ?? t.countyfp, served: t.served,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], polygons };
});
const ds = {
  meta: {
    source: 'US Census Bureau, TIGER/Line Shapefiles, County Subdivisions (New Jersey municipalities)',
    url: TIGER_URL, vintage: year, sha256, license: 'Public domain (US Government work, 17 U.S.C. 105)',
    retrievedAt: new Date().toISOString().slice(0, 10),
    coordinates: '[longitude, latitude], NAD83 (EPSG:4269); differs from WGS84 GPS by about 1 m in New Jersey',
    polygons: 'Each town is a list of polygons; each polygon is [outer ring, ...holes]; rings are closed',
    simplification: { method: 'Douglas-Peucker per ring', toleranceM: TOLERANCE_M, decimals: DECIMALS, note: 'Borders move at most tolerance plus rounding; neighboring towns are simplified separately, so tiny gaps or overlaps (under ~20 m) can exist along shared borders.' },
    selection: { rule: 'Towns containing an NJ Transit bus stop of lines 163/164/165, plus towns sharing a border with them', stopSource: STOP_CITY_SOURCE, stopCount: stops.length, stopsInNoNewJerseyTown: outside.length },
  },
  towns,
};
// Unusable source data (no stops matched, nothing selected) must never replace the committed dataset.
if (!served.size || !towns.length || !towns.every((t) => t.polygons.length)) throw new Error(`No usable towns selected (${served.size} served, ${towns.length} total); dataset left unchanged`);
const json = JSON.stringify(ds);
if (json.length > MAX_BYTES) throw new Error(`Output ${json.length} bytes exceeds ${MAX_BYTES}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, json + '\n');
console.log(`wrote ${out}: ${json.length} bytes, ${towns.length} towns (${served.size} served), ${stops.length} stops, ${outside.length} in no NJ town: ${[...new Set(outside)].join(", ")}`);
for (const e of served.values()) {
  const other = [...e.njtNames].filter(n => n.toLowerCase().replace(/ (twp|township|boro|borough|city|town)\.?$/i, '') !== e.town.name.toLowerCase());
  console.log(`served ${e.town.geoid} ${e.town.name} (${e.stops} stops)${other.length ? `; NJ Transit labels also: ${other.join(', ')}` : ''}`);
}
console.log('neighbors: ' + neighbors.map(t => t.name).join(', '));

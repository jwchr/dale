import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveStopScene, SIGN_NUMBER, SIGN_ROWS, SIGN_VIEW, signRowBand, signRowPlacement, STOP_SCENES, stopSignLines, stopSceneChoice, stopSignRoutes } from '../../src/domain/stopSign';
import { liveDataset } from '../helpers/liveBus';
import manifest from '../../src/assets/stop-scenes/source-manifest.json';

describe('seasonal stop artwork', () => {
  it('uses the New Jersey calendar with clear weather, never a forecast', () => {
    expect(resolveStopScene('auto', Date.parse('2026-03-01T02:00:00Z'))).toBe('winter-clear');
    expect(resolveStopScene('auto', Date.parse('2026-03-01T08:00:00Z'))).toBe('spring-clear');
    expect(resolveStopScene('auto', Date.parse('2026-07-01T12:00:00Z'))).toBe('summer-clear');
    expect(resolveStopScene('auto', Date.parse('2026-11-07T12:00:00Z'))).toBe('autumn-clear');
    expect(resolveStopScene('auto', NaN)).toBeUndefined();
    expect(resolveStopScene('auto', Infinity)).toBeUndefined();
    expect(resolveStopScene('winter-snow', NaN)).toBe('winter-snow');
    expect(stopSceneChoice('a made-up weather report')).toBe('auto');
  });
  it('keeps all eight approved source images byte-identical', () => {
    expect(manifest.assets).toHaveLength(8);
    for (const asset of manifest.assets) {
      const data = readFileSync(new URL(`../../src/assets/stop-scenes/${asset.file}`, import.meta.url));
      expect(data.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(data).digest('hex')).toBe(asset.sha256);
    }
  });
  it('shows only routes that board and reach this exact destination', () => {
    const ds = structuredClone(liveDataset);
    const route = ds.patterns.find(p => p.stopIds.includes('2') && p.stopIds.includes('3'))!;
    ds.patterns = [route];
    const name = ds.routes.find(r => r.id === route.routeId)!.shortName;
    expect(stopSignRoutes(ds, '2', '3', [])).toEqual([name]);
    expect(stopSignRoutes(ds, '3', '2', [])).toEqual([]);
    expect(stopSignRoutes(ds, '2', '3', ['absent'])).toEqual([]);
    route.noPickup = [route.stopIds.indexOf('2')];
    expect(stopSignRoutes(ds, '2', '3', [])).toEqual([]);
    route.noPickup = [];
    route.noDropOff = [route.stopIds.indexOf('3')];
    expect(stopSignRoutes(ds, '2', '3', [])).toEqual([]);
  });
});

/** Width and height from a lossy WebP (VP8) header. */
function webpSize(data: Buffer): [number, number] {
  expect(data.toString('ascii', 0, 4)).toBe('RIFF');
  expect(data.toString('ascii', 8, 16)).toBe('WEBPVP8 ');
  return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
}

describe('photographed stop sign (D69)', () => {
  it('has one prepared photo per scene, cropped to the lettering frame', () => {
    for (const scene of STOP_SCENES) {
      const data = readFileSync(new URL(`../../src/assets/stop-signs/${scene}.webp`, import.meta.url));
      expect(webpSize(data)).toEqual([SIGN_VIEW.width, SIGN_VIEW.height]);
      expect(data.byteLength).toBeLessThan(200_000);
    }
    // The preparation script crops to the same box the app letters on.
    const script = readFileSync(new URL('../../scripts/stop-sign-photos.py', import.meta.url), 'utf8');
    const { x, y, width, height } = SIGN_VIEW;
    expect(script).toContain(`CROP = (${x}, ${y}, ${x + width}, ${y + height})`);
  });
  it('places each route row on its own ruled line, tilted with the photo', () => {
    const rows = Array.from({ length: SIGN_ROWS }, (_, r) => signRowPlacement(r));
    rows.forEach((row, r) => {
      expect(row.slope).toBeLessThan(0);
      expect(row.x).toBeGreaterThan(0);
      expect(row.x + row.maxWidth).toBeLessThan(SIGN_VIEW.width);
      if (r) {
        expect(row.y - rows[r - 1]!.y).toBeCloseTo(20.83, 1);
        expect(row.slope).toBeGreaterThan(rows[r - 1]!.slope);
      }
    });
    // Baselines sit inside the rows under "Board Here For" and above the mybus plate number.
    expect(rows[0]!.y).toBeGreaterThan(597.5 - SIGN_VIEW.y);
    expect(rows[SIGN_ROWS - 1]!.y).toBeLessThan(SIGN_NUMBER.y);
    expect(signRowPlacement(99)).toEqual(rows[SIGN_ROWS - 1]);
    expect(signRowPlacement(-2)).toEqual(rows[0]);
  });
  it('lists every route that picks up here, the way the sign prints it, and marks the rider\'s bus', () => {
    const ds = {
      routes: [{ id: 'r165', shortName: '165' }, { id: 'r163', shortName: '163' }, { id: 'r164', shortName: '164' }],
      stops: [{ id: 'A', name: 'Main St' }, { id: 'B', name: 'Elm St' }, { id: 'P', name: 'Port Authority', terminal: 'PABT' }, { id: 'H', name: 'Hackensack Terminal' }],
      patterns: [
        { id: 'p1', routeId: 'r165', stopIds: ['A', 'B', 'P'] },
        { id: 'p2', routeId: 'r163', stopIds: ['A', 'P'] },
        { id: 'p3', routeId: 'r164', stopIds: ['P', 'A', 'H'] },
        { id: 'p4', routeId: 'r164', stopIds: ['B', 'A'] },              // ends here: nothing to board
        { id: 'p5', routeId: 'r165', stopIds: ['A', 'P'], noPickup: [0] }, // drop-off only here
      ],
    } as unknown as Parameters<typeof stopSignLines>[0];
    expect(stopSignLines(ds, 'A', 'B', [])).toEqual([
      { route: '163', text: '163 To New York', yours: false },
      { route: '164', text: '164 To Hackensack Terminal', yours: false },
      { route: '165', text: '165 To New York', yours: true },
    ]);
    // Both New York routes reach Port Authority; a saved route filter keeps only the chosen one marked.
    expect(stopSignLines(ds, 'A', 'P', ['r163']).filter(l => l.yours).map(l => l.text)).toEqual(['163 To New York']);
    expect(stopSignLines(ds, 'A', 'P', []).filter(l => l.yours)).toHaveLength(2);
    expect(stopSignLines(ds, 'Z', 'P', [])).toEqual([]);
  });
  it('keeps the rider\'s own lines when more routes than rows board here', () => {
    const routes = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, shortName: String(100 + i) }));
    const ds = {
      routes, stops: [{ id: 'A', name: 'A' }, { id: 'P', name: 'Port Authority', terminal: 'PABT' }],
      patterns: routes.map(r => ({ id: `p${r.id}`, routeId: r.id, stopIds: ['A', 'P'] })),
    } as unknown as Parameters<typeof stopSignLines>[0];
    const lines = stopSignLines(ds, 'A', 'P', ['r9']);
    expect(lines).toHaveLength(SIGN_ROWS);
    expect(lines.filter(l => l.yours).map(l => l.text)).toEqual(['109 To New York']);
    expect(lines.at(-1)).toEqual({ route: '', text: '+4 more', yours: false });
  });
  it('highlights inside the ruled row', () => {
    const band = signRowBand(2), row = signRowPlacement(2);
    expect(band).toHaveLength(4);
    expect(band[0]![1]).toBeLessThan(row.y);
    expect(band[3]![1]).toBeGreaterThan(row.y);
    expect(band[1]![1]).toBeLessThan(band[0]![1]); // tilted with the photo
});
});

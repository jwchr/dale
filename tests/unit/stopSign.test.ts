import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveStopScene, stopSceneChoice, stopSignRoutes } from '../../src/domain/stopSign';
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

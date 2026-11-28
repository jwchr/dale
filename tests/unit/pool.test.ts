import { describe, expect, it } from 'vitest';
import { ARCHIVE_CONNECTIONS, inPool } from '../../worker/pool';

describe('inPool', () => {
  it('runs every item, never more than the limit at once', async () => {
    let running = 0, most = 0;
    const done: number[] = [];
    await inPool(Array.from({ length: 27 }, (_, n) => n), ARCHIVE_CONNECTIONS, async n => {
      running++; most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, n % 3));
      done.push(n); running--;
    });
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 27 }, (_, n) => n));
    expect(most).toBe(ARCHIVE_CONNECTIONS);
  });
  it('keeps going after a failed item is handled by the caller, and accepts an empty list', async () => {
    const seen: number[] = [];
    await inPool([1, 2, 3], 2, async n => { try { if (n === 1) throw new Error('x'); seen.push(n); } catch { seen.push(-n); } });
    expect(seen.sort()).toEqual([-1, 2, 3]);
    await expect(inPool([], 2, async () => {})).resolves.toBeUndefined();
  });
  it('leaves room for rail GTFS-RT within a Worker\'s 6 connections (RailData and BUSDV2 each use the limit)', () => {
    expect(2 * ARCHIVE_CONNECTIONS).toBeLessThanOrEqual(4);
  });
});

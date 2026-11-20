import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToCell, confidenceKeyFor, confidenceQueryString, parseConfidenceAnswer, parseConfidenceQuery, summarize,
  type ArrivalEvent, type ConfidenceCell, type ConfidenceKey } from '../../src/domain/arrivalConfidence';
import { clearArrivalConfidenceCache, loadArrivalConfidence } from '../../src/data/arrivalConfidence';
import { liveDataset as ds } from '../helpers/liveBus';

// Synthetic only: T1 (route 165) at stop "1" at 7:00 AM on weekdays.
const key: ConfidenceKey = { route: '165', direction: 0, stopId: '1', schedMinute: 7 * 60, dayType: 'weekday' };
const DATES = ['20261102', '20261103', '20261104', '20261105', '20261106', '20261109'];
const at = (d: string) => Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T07:00:00-05:00`);
const ev = (d: string, delay: number): ArrivalEvent => ({ key, serviceDate: d, arrivedAt: at(d) + delay * 1000, delaySeconds: delay });
const ready = () => summarize(DATES.reduce<ConfidenceCell | undefined>((c, d, i) => addToCell(c, ev(d, i * 90)), undefined), key, 'NJ Transit GTFS-RT G2, measured by Dale');
const dep = () => {
  const trip = ds.trips.find((t) => t.id === 'T1')!, pattern = ds.patterns.find((p) => p.id === trip.patternId)!;
  const route = ds.routes.find((r) => r.id === pattern.routeId)!;
  return { tripId: trip.id, serviceDate: '20261104', route, pattern, stopIndex: pattern.stopIds.indexOf('1') };
};

describe('How sure are we? query', () => {
  it('builds the Worker key from a departure and round-trips through the strict endpoint parser', () => {
    const k = confidenceKeyFor(ds, dep())!;
    expect(k).toEqual(key);
    expect(parseConfidenceQuery(new URLSearchParams(confidenceQueryString(k)), ds)).toEqual(key);
  });
  it('asks nothing for an estimated stop time or a route outside the corridor', () => {
    const d = dep(), trip = ds.trips.find((t) => t.id === 'T1')!;
    expect(confidenceKeyFor({ ...ds, trips: ds.trips.map((t) => t === trip ? { ...t, estimated: [d.stopIndex] } : t) }, d)).toBeUndefined();
    expect(confidenceKeyFor(ds, { ...d, route: { ...d.route, shortName: '190' } })).toBeUndefined();
  });
});

describe('How sure are we? answer check', () => {
  it('accepts the Worker answer for the asked key and its insufficient form', () => {
    const r = ready();
    expect(parseConfidenceAnswer(JSON.parse(JSON.stringify(r)), key)).toEqual(r);
    const low = summarize(undefined, key, 'x');
    expect(parseConfidenceAnswer(low, key)).toEqual(low);
  });
  it('rejects another stop or time, counts that do not add up, and bad records', () => {
    const r = ready() as Extract<ReturnType<typeof ready>, { state: 'ready' }>;
    expect(parseConfidenceAnswer(r, { ...key, stopId: '3' })).toBeUndefined();
    expect(parseConfidenceAnswer(r, { ...key, schedMinute: 7 * 60 + 1 })).toBeUndefined();
    expect(parseConfidenceAnswer({ ...r, samples: r.samples + 1 }, key)).toBeUndefined();
    expect(parseConfidenceAnswer({ ...r, oneMinute: r.oneMinute.slice(1) }, key)).toBeUndefined();
    expect(parseConfidenceAnswer({ ...r, worst: { ...r.worst, serviceDate: '2026-13-01' } }, key)).toBeUndefined();
    expect(parseConfidenceAnswer({ ...r, state: 'insufficient' }, key)).toBeUndefined();
    expect(parseConfidenceAnswer({ ...r, worst: { ...r.worst, minutes: r.worst.minutes + 1 } }, key)).toBeUndefined();
    if (r.state === 'ready') {
      const moved = r.fiveMinute.map((b) => ({ ...b, count: 0 }));
      moved[3] = { ...moved[3]!, count: r.samples };
      expect(r.fiveMinute[3]!.count).not.toBe(r.samples);
      expect(parseConfidenceAnswer({ ...r, fiveMinute: moved }, key)).toBeUndefined();
    }
    expect(parseConfidenceAnswer(null, key)).toBeUndefined();
  });
});

describe('How sure are we? fetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearArrivalConfidenceCache(); });
  const api = 'https://dale-live.example.workers.dev';
  it('treats 404 as off, a bad body or network error as unavailable, and keeps a good answer 10 minutes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadArrivalConfidence(api, key, 0)).toEqual({ state: 'off' });
    clearArrivalConfidenceCache();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ v: 1, state: 'ready' }), { status: 200 }));
    expect(await loadArrivalConfidence(api, key, 0)).toEqual({ state: 'unavailable' });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await loadArrivalConfidence(api, key, 0)).toEqual({ state: 'unavailable' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(ready()), { status: 200 }));
    expect((await loadArrivalConfidence(api, key, 1000)).state).toBe('answer');
    expect((await loadArrivalConfidence(api, key, 1000 + 9 * 60_000)).state).toBe('answer');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]![0]).toBe(`${api}/v1/arrival-confidence?route=165&stop=1&dir=0&sched=07%3A00&day=weekday`);
    expect(fetchMock.mock.calls[3]![1]).toMatchObject({ credentials: 'omit' });
  });
});

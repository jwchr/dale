import { describe, expect, it } from 'vitest';
import { createNormalizer } from '../../worker/normalize';
import { resolveOmittedDate, OMITTED_DATE_MARGIN_MS } from '../../worker/service-date';
import type { Dataset } from '../../src/domain/types';
import { parseLiveSnapshot, LIVE_SOURCE } from '../../src/domain/liveBus';
import { serviceTimeToInstant } from '../../src/domain/time';
import { liveDataset, NOW, binaryFeed, descriptor, vehicle, update } from '../helpers/liveBus';

function oneDate(date = '20261104') {
  const ds = structuredClone(liveDataset);
  for (const cal of Object.values(ds.calendars)) { cal.start = date; cal.end = date; cal.days.fill(true); cal.added = []; cal.removed = []; }
  return ds;
}
const undated = { tripId: descriptor.tripId, routeId: descriptor.routeId, directionId: descriptor.directionId };
const report = (trip: Record<string, unknown> = undated) => binaryFeed([{ id: 'v', vehicle: vehicle({ trip }) }]);

const at = (date: string, seconds: number) => serviceTimeToInstant(date, seconds, liveDataset.meta.timezone);
const reportAt = (ds: Dataset, tripId: string, instant: number) => createNormalizer(ds)(binaryFeed([{ id: 'v', vehicle: vehicle({ trip: { ...undated, tripId }, timestamp: instant / 1000 }) }], { timestamp: instant / 1000 + 5 }), 'vehicles', instant + 10_000);

describe('omitted service date from the report timestamp', () => {
  it('resolves an everyday weekday report from its own timestamp, for GPS and predictions', () => {
    const normalize = createNormalizer(liveDataset);
    const v = normalize(report(), 'vehicles', NOW);
    expect(v.observations[0]).toMatchObject({ tripInstanceId: 'T1@20261104', observedAt: NOW - 15_000 });
    expect(v.unresolvedDateTrips).toEqual([]);
    expect(normalize(binaryFeed([{ id: 'u', tripUpdate: update({ trip: undated }) }]), 'updates', NOW).updates[0]).toMatchObject({ tripInstanceId: 'T1@20261104', predictions: [{ at: NOW + 300_000 }] });
    expect(normalize(report({ ...undated, startDate: '' } as typeof undated), 'vehicles', NOW).observations).toHaveLength(1);
  });
  it('accepts the margin around the scheduled window and refuses reports outside it', () => {
    const first = at('20261104', 7 * 3600), last = at('20261104', 7 * 3600 + 40 * 60);
    for (const ok of [first - OMITTED_DATE_MARGIN_MS, last + OMITTED_DATE_MARGIN_MS]) expect(resolveOmittedDate(liveDataset, liveDataset.trips.find((t) => t.id === 'T1')!, ok)).toBe('20261104');
    for (const bad of [first - OMITTED_DATE_MARGIN_MS - 1000, last + OMITTED_DATE_MARGIN_MS + 1000]) {
      const v = reportAt(liveDataset, 'T1', bad);
      expect(v.observations).toEqual([]);
      expect(v.unresolvedDateTrips).toEqual(['T1']);
    }
  });
  it('never uses receipt time, and a report without its own timestamp stays unknown', () => {
    const v = createNormalizer(liveDataset)(binaryFeed([{ id: 'v', vehicle: vehicle({ trip: undated, timestamp: undefined }) }]), 'vehicles', NOW);
    expect(v.observations).toEqual([]);
    expect(v.unresolvedDateTrips).toEqual(['T1']);
    expect(resolveOmittedDate(liveDataset, liveDataset.trips[0]!, undefined)).toBeUndefined();
  });
  it('refuses when the calendar is not active that day (weekend, holiday removal)', () => {
    expect(reportAt(liveDataset, 'T1', at('20261107', 7 * 3600 + 1200)).observations).toEqual([]);
    expect(reportAt(liveDataset, 'T1', at('20261126', 7 * 3600 + 1200)).observations).toEqual([]);
    expect(reportAt(liveDataset, 'T1', at('20261127', 7 * 3600 + 1200)).observations[0]?.tripInstanceId).toBe('T1@20261127');
  });
  it('keeps an after-midnight report on the previous service date, and refuses when that date is inactive', () => {
    expect(reportAt(liveDataset, 'T2', at('20261106', 24 * 3600 + 900)).observations[0]?.tripInstanceId).toBe('T2@20261106');
    expect(reportAt(liveDataset, 'T2', at('20261108', 24 * 3600 + 900)).observations).toEqual([]);
  });
  it('refuses when two active service dates both fit the report', () => {
    const ds = structuredClone(liveDataset), trip = ds.trips.find((t) => t.id === 'T1')!;
    trip.times = [7 * 3600, 7 * 3600 + 600, 7 * 3600 + 20 * 3600];
    const overlap = at('20261105', 5 * 3600);
    expect(resolveOmittedDate(ds, trip, overlap)).toBeUndefined();
    expect(reportAt(ds, 'T1', overlap).observations).toEqual([]);
    expect(resolveOmittedDate(ds, trip, at('20261104', 7 * 3600))).toBe('20261104');
  });
  it('fails closed for trips longer than the bounded date scan', () => {
    const ds = structuredClone(liveDataset), trip = ds.trips.find((t) => t.id === 'T1')!;
    trip.times = [7 * 3600, 8 * 3600, 61 * 3600];
    expect(resolveOmittedDate(ds, trip, at('20261104', 7 * 3600))).toBeUndefined();
  });
  it.each([' ', '20261344', '20261105'])('never repairs an explicit invalid/inactive date %j using the unique date', (startDate) => {
    expect(createNormalizer(oneDate())(report({ ...undated, startDate } as typeof undated), 'vehicles', NOW).observations).toEqual([]);
  });
  it.each(['08:00:00', 'malformed', '07:60:00', '07:00:01', '24:00:00'])('rejects a contradictory supplied start time %j for GPS, predictions and cancellations', (startTime) => {
    const normalize = createNormalizer(oneDate());
    for (const trip of [{ ...undated, startTime }, { ...descriptor, startTime }]) {
      expect(normalize(report(trip), 'vehicles', NOW).observations).toEqual([]);
      for (const scheduleRelationship of [0, 3]) {
        expect(normalize(binaryFeed([{ id: 'u', tripUpdate: update({ trip: { ...trip, scheduleRelationship } }) }]), 'updates', NOW).updates).toEqual([]);
      }
    }
  });
  it('accepts equivalent canonical H:MM:SS/HH:MM:SS and retains hours beyond24', () => {
    for (const startTime of ['7:00:00', '07:00:00']) {
      expect(createNormalizer(oneDate())(report({ ...undated, startTime }), 'vehicles', NOW).observations).toHaveLength(1);
    }
    const ds = oneDate('20261103'), trip = ds.trips.find((t) => t.id === 'T1')!;
    trip.times = [24 * 3600 + 600, 24 * 3600 + 1200, 24 * 3600 + 2400];
    const at = serviceTimeToInstant('20261103', 24 * 3600 + 1500, ds.meta.timezone);
    const bytes = (startTime: string) => binaryFeed([{ id: 'v', vehicle: vehicle({ trip: { ...undated, startTime }, timestamp: at / 1000 - 15 }) }], { timestamp: at / 1000 - 10 });
    expect(createNormalizer(ds)(bytes('24:10:00'), 'vehicles', at).observations[0]?.tripInstanceId).toBe('T1@20261103');
    expect(createNormalizer(ds)(bytes('00:10:00'), 'vehicles', at).observations).toEqual([]);
  });
  it('does not convert a fresh report from another day into the sole published trip', () => {
    const ds = oneDate('20261103');
    expect(createNormalizer(ds)(report(), 'vehicles', NOW).observations).toEqual([]);
  });
  it('keeps after-midnight reports on the previous service date and respects the GTFS DST time base', () => {
    for (const date of ['20261103', '20261101', '20260308']) {
      const ds = oneDate(date), trip = ds.trips.find((t) => t.id === 'T1')!;
      trip.times = [24 * 3600 + 600, 24 * 3600 + 1200, 24 * 3600 + 2400];
      const at = serviceTimeToInstant(date, 24 * 3600 + 1500, ds.meta.timezone);
      const bytes = binaryFeed([{ id: 'v', vehicle: vehicle({ trip: undated, timestamp: at / 1000 - 15 }) }], { timestamp: at / 1000 - 10 });
      expect(createNormalizer(ds)(bytes, 'vehicles', at).observations[0]?.tripInstanceId).toBe('T1@' + date);
    }
  });
  it('retains route/direction/relationship checks and never enables compatibility for printed/demo data', () => {
    for (const patch of [{ routeId: 'other' }, { directionId: 1 }, { scheduleRelationship: 1 }]) {
      expect(createNormalizer(oneDate())(report({ ...undated, ...patch }), 'vehicles', NOW).observations).toEqual([]);
    }
    for (const patch of [{ demo: true }, { transcribed: { issued: '20261104', documentId: 'synthetic' } }, { realtime: undefined }]) {
      const ds = oneDate(); Object.assign(ds.meta, patch);
      expect(createNormalizer(ds)(report(), 'vehicles', NOW).observations).toEqual([]);
    }
  });
  it('keeps undated cancellations unknown (date-unknown), even inside the trip window, and accepts an explicit official cancellation date', () => {
    const bytes = (trip: Record<string, unknown>) => binaryFeed([{ id: 'u', tripUpdate: update({ trip: { ...trip, scheduleRelationship: 3 } }) }]);
    const undatedCancel = createNormalizer(liveDataset)(bytes(undated), 'updates', NOW);
    expect(undatedCancel.updates).toEqual([]);
    expect(undatedCancel.unresolvedDateTrips).toEqual(['T1']);
    expect(createNormalizer(liveDataset)(bytes(descriptor), 'updates', NOW).updates[0]?.cancelled).toBe(true);
  });
  it('discards unusable timestamps without poisoning otherwise valid GPS in the browser packet', () => {
    const ds = oneDate(), normalize = createNormalizer(ds), positions = normalize(report(), 'vehicles', NOW);
    const updates = normalize(binaryFeed([{ id: 'u', tripUpdate: update({ trip: undated, stopTimeUpdate: [{ stopId: '2', departure: { time: Number.MAX_SAFE_INTEGER } }] }) }]), 'updates', NOW);
    expect(updates.updates[0]?.predictions).toEqual([]);
    const packet = { v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, tripInstanceId: 'T1@20261104', receivedAt: NOW, vehicles: positions.feed, updates: updates.feed, observations: positions.observations, predictions: [], skippedStops: [] };
    expect(parseLiveSnapshot(packet, ds, 'T1', '20261104', NOW).observations).toHaveLength(1);
    expect(normalize(binaryFeed([{ id: 'v', vehicle: vehicle({ trip: undated, timestamp: Number.MAX_SAFE_INTEGER }) }]), 'vehicles', NOW).observations).toEqual([]);
    expect(normalize(binaryFeed([], { timestamp: Number.MAX_SAFE_INTEGER }), 'vehicles', NOW).feed.state).toBe('invalid');
  });
});

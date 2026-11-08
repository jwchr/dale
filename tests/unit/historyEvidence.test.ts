import { describe, expect, it } from 'vitest';
import { createHistorySelector } from '../../worker/history-evidence';
import { createNormalizer } from '../../worker/normalize';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update } from '../helpers/liveBus';

const normalize = createNormalizer(ds), select = createHistorySelector(ds);
const sample = () => normalize(binaryFeed([{ id: 'v', vehicle: vehicle() }]), 'vehicles', NOW);
describe('private history evidence selection', () => {
  it('retains the exact official identity, agency/receipt clocks, route and schedule version without inventing an arrival', () => {
    const result = select(sample(), NOW);
    expect(result.feedUsable).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ feedVersion: ds.meta.feedVersion, generatedAt: NOW - 10_000, receivedAt: NOW, route: '165', direction: 0,
      serviceDate: '20261104', observation: { tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: NOW - 15_000 } });
    expect(result.records[0]!.observation.stopCall).toBeUndefined();
    expect(result.records[0]).not.toHaveProperty('arrival');
  });
  it('deduplicates a repeated normalized report across a persisted checkpoint and records a later report', () => {
    const first = select(sample(), NOW);
    const again = select(sample(), NOW + 30_000, JSON.parse(JSON.stringify(first.watermarks)));
    expect(again.records).toEqual([]); expect(again.duplicates).toBe(1);
    const next = sample(); next.observations[0]!.observedAt += 10_000;
    expect(select(next, NOW + 30_000, first.watermarks).records).toHaveLength(1);
  });
  it('does not convert trip-update predictions into recorded vehicle observations', () => {
    const predictions = normalize(binaryFeed([{ id: 'u', tripUpdate: update() }]), 'updates', NOW);
    expect(predictions.updates[0]!.predictions.length).toBeGreaterThan(0);
    expect(select(predictions, NOW).records).toEqual([]);
  });
  it('retains distinct in-packet samples chronologically even when the packet lists them newest first', () => {
    const feed = sample(), older = { ...feed.observations[0]!, observedAt: NOW - 20_000 };
    feed.observations.push(older);
    const result = select(feed, NOW);
    expect(result.records.map(r => r.observation.observedAt)).toEqual([NOW - 20_000, NOW - 15_000]);
    expect(Object.values(result.watermarks)[0]!.observedAt).toBe(NOW - 15_000);
    const late = sample(); late.observations = [older];
    const checkpointed = select(late, NOW, result.watermarks);
    expect(checkpointed.records).toEqual([]); expect(checkpointed.outOfOrder).toBe(1); expect(checkpointed.duplicates).toBe(0);
  });
  it('never labels demo or transcribed datasets official history', () => {
    const demo = structuredClone(ds); demo.meta.demo = true;
    expect(createHistorySelector(demo)(sample(), NOW).feedUsable).toBe(false);
    const unknown = structuredClone(ds); delete unknown.meta.realtime;
    expect(createHistorySelector(unknown)(sample(), NOW).records).toEqual([]);
  });
  it.each(['stale', 'unavailable', 'invalid'] as const)('does not call a %s feed successful evidence', state => {
    const feed = sample(); feed.feed.state = state;
    const result = select(feed, NOW); expect(result.records).toEqual([]); expect(result.feedUsable).toBe(false);
  });
  it('rejects old/future, unknown-trip, wrong-calendar and invalid-position records', () => {
    for (const patch of [{ observedAt: NOW + 1 }, { observedAt: NOW - 120_001 }, { tripInstanceId: 'unknown@20261104' },
      { tripInstanceId: 'T1@20261107' }, { lat: 91 }, { lon: undefined }]) {
      const feed = sample(); Object.assign(feed.observations[0]!, patch);
      const result = select(feed, NOW); expect(result.records).toEqual([]); expect(result.rejected).toBe(1);
    }
  });
  it('rejects conflicting same-time bus positions rather than selecting whichever is last', () => {
    const feed = sample(); feed.observations.push({ ...feed.observations[0]!, lat: 40.5 });
    const result = select(feed, NOW); expect(result.records).toEqual([]); expect(result.conflicts).toBe(1);
    expect(result.watermarks).toEqual({});
  });
  it('preserves a verified stopped-at sample but does not label it the exact instant of arrival', () => {
    const feed = sample(); feed.observations[0]!.stopCall = { stopId: '2', stopIndex: 1, status: 'stopped_at' };
    expect(select(feed, NOW).records[0]!.observation.stopCall).toEqual({ stopId: '2', stopIndex: 1, status: 'stopped_at' });
    feed.observations[0]!.stopCall!.stopId = '3';
    expect(select(feed, NOW).records).toEqual([]);
  });
  it('keeps new schedule versions separate without erasing the supplied prior checkpoint', () => {
    const first = select(sample(), NOW), original = structuredClone(first.watermarks);
    const changed = structuredClone(ds); changed.meta.feedVersion = 'different-version';
    const result = createHistorySelector(changed)(sample(), NOW, first.watermarks);
    expect(result.records[0]!.feedVersion).toBe('different-version');
    expect(Object.keys(result.watermarks)).toHaveLength(2); expect(first.watermarks).toEqual(original);
  });
});

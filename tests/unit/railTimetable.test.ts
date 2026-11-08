import { describe, expect, it } from 'vitest';
import { sampleRailTimetable } from '../../src/data/railSample';
import { railExamples, type RailTimetable } from '../../src/domain/railTimetable';
import { isGeneratedFavoriteLabel } from '../../src/domain/favorites';
import { liveDataset } from '../helpers/liveBus';

describe('rail timetable preview source boundaries', () => {
  it('uses the supplied weekday example with distinct boarding, call and Penn arrival semantics', () => {
    const [journey] = railExamples(sampleRailTimetable, 'anderson', 'outbound', 'weekday');
    expect(journey).toMatchObject({ kind: 'sample', durationMin: 40, transferGapMin: 7, legs: [
      { train: '1602', from: { station: 'anderson', minute: 349, event: 'departure' }, to: { station: 'secaucus', minute: 369, event: 'call', mayLeaveEarly: true } },
      { from: { station: 'secaucus', minute: 376 }, to: { station: 'penn', minute: 389, event: 'arrival' } },
    ] });
    expect(journey!.legs[1].train).toBeUndefined(); // No invented train number for the connection.
  });
  it('does not offer train 1651 at Essex or conditional overnight train 2101', () => {
    expect(railExamples(sampleRailTimetable, 'anderson', 'return', 'weekday').map(x => x.legs[1].train)).toContain('1651');
    expect(railExamples(sampleRailTimetable, 'essex', 'return', 'weekday').map(x => x.legs[1].train)).toEqual(['1605', '1607']);
    expect(sampleRailTimetable.examples.some(x => x.train === '2101')).toBe(false);
  });
  it('keeps weekend return connections in travel order without inventing PVL arrival times', () => {
    const [journey] = railExamples(sampleRailTimetable, 'essex', 'return', 'weekend');
    expect(journey).toMatchObject({ durationMin: 32, transferGapMin: 7, legs: [
      { from: { station: 'penn', minute: 487 }, to: { station: 'secaucus', minute: 496, event: 'arrival' } },
      { train: '2103', from: { station: 'secaucus', minute: 503 }, to: { station: 'essex', minute: 519, event: 'call' } },
    ] });
  });
  it('rejects malformed or backwards connection times rather than creating a usable itinerary', () => {
    for (const invalid of [NaN, Infinity, -1, 4000, 348, 369.5]) {
      const broken: RailTimetable = { ...sampleRailTimetable, examples: [{ ...sampleRailTimetable.examples[0]!, secaucusPvl: invalid }] };
      expect(railExamples(broken, 'anderson', 'outbound', 'weekday')).toEqual([]);
    }
  });
});

describe('generated favorite labels after canonical spelling corrections', () => {
  const ds = structuredClone(liveDataset);
  ds.stops[0]!.sourceName = 'STATE ST AT LAWERENCE ST';
  ds.stops[0]!.name = 'STATE ST AT LAWRENCE ST';
  const favorite = { id: 'saved', label: '', fromStopId: ds.stops[0]!.id, toStopId: ds.stops[1]!.id, routeIds: [] };
  it('recognizes both source and current names without changing the stored favorite', () => {
    for (const name of [ds.stops[0]!.name, ds.stops[0]!.sourceName]) {
      const saved = { ...favorite, label: `${name} → ${ds.stops[1]!.name}` };
      const before = structuredClone(saved);
      expect(isGeneratedFavoriteLabel(ds, saved)).toBe(true);
      expect(saved).toEqual(before);
    }
  });
  it('keeps genuine custom labels and unknown-stop favorites', () => {
    expect(isGeneratedFavoriteLabel(ds, { ...favorite, label: 'My STATE ST AT LAWERENCE ST trip' })).toBe(false);
    expect(isGeneratedFavoriteLabel(ds, { ...favorite, label: `${ds.stops[0]!.name} → ${ds.stops[1]!.name}`, fromStopId: 'missing' })).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { demoDataset } from '../../src/data/demo';
import { boardingInfo, destinationGroups } from '../../src/domain/stopInfo';
import { checkDirection, destinationsFrom, searchStops } from '../../src/domain/direction';
import { liveDataset, miniFiles } from '../helpers/liveBus';
import { tripArrivalAt, tripTimeAt } from '../../src/domain/schedule';
import { parseDataset } from '../../src/domain/dataset';
// @ts-expect-error deployment script is ESM
import { addStopCities, withStopCities } from '../../scripts/stop-cities.mjs';
// @ts-expect-error existing builder is ESM
import { buildDataset } from '../../scripts/gtfs-lib.mjs';

const ds = () => structuredClone(liveDataset);
const record = (patch = {}) => ({ STOP_NUM: '0002', MUNICIPALITY: 'Hackensack', LINE: 165, DLAT_GIS: 40.89, DLONG_GIS: -74.04, ...patch });
describe('verified stop information and city labels', () => {
  it('joins exact public number, actual served line and nearby coordinates, preserving identities', () => {
    const input = ds(); Object.assign(input.stops.find(s => s.id === '2')!, { code: '0002', lat: 40.89, lon: -74.04 });
    const output = withStopCities(input, [record()]);
    expect(output.stops.find((s: { id: string }) => s.id === '2')).toMatchObject({ id: '2', code: '0002', city: 'Hackensack' });
    expect(output.trips).toEqual(input.trips); expect(output.patterns).toEqual(input.patterns); expect(input.stops.find(s => s.id === '2')?.city).toBeUndefined();
    for (const patch of [{ STOP_NUM: '2' }, { LINE: 163 }, { DLAT_GIS: 40.95 }, { MUNICIPALITY: '' }]) expect(withStopCities(input, [record(patch)]).stops.find((s: { id: string }) => s.id === '2')?.city).toBeUndefined();
    expect(withStopCities(input, [record(), record({ MUNICIPALITY: 'Other' })]).stops.find((s: { id: string }) => s.id === '2')?.city).toBeUndefined();
  });
  it('bounds public-only source queries; failed or truncated GIS never breaks the core schedule', async () => {
    let calls = 0;
    const net = async (url: string, init: RequestInit) => { calls++; expect(new URL(url).searchParams.get('where')).toBe('LINE IN (163,164,165)'); expect(init.credentials).toBe('omit'); expect(init.headers).toBeUndefined(); return Response.json({ features: [], exceededTransferLimit: true }); };
    const output = await addStopCities(ds(), net);
    expect(calls).toBe(4); expect(output.meta.stopCities.state).toBe('unavailable'); expect(output.trips).toEqual(liveDataset.trips);
    const failed = await addStopCities(ds(), async () => { throw new Error('offline'); });
    expect(failed.meta.stopCities.state).toBe('unavailable');
  });
  it('names only boardable pattern destinations, without a compass guess from direction0/1', () => {
    const input = ds(), pattern = input.patterns.find(p => p.stopIds.includes('2'))!;
    const info = boardingInfo(input, '2'); expect(info.destinations).toContain('PABT');
    for (const p of input.patterns) if (p.stopIds.includes('2')) p.noPickup = [p.stopIds.indexOf('2')];
    expect(boardingInfo(input, '2').destinations).toEqual([]);
    expect(pattern.directionId).toBe(0);
  });
  it('pins final Port Authority first and groups other stops only by supplied cities', () => {
    const input = ds(); input.stops.push({ id: 'stage', name: 'South Wing', terminal: 'PABT' });
    input.stops.find(s => s.id === '2')!.city = 'Hackensack';
    const groups = destinationGroups(input, '1', [input.stops.at(-1)!, ...input.stops]);
    expect(groups.terminal[0]?.id).toBe('3'); expect(groups.cities.map(g => g.city)).toEqual(['Hackensack', '']);
  });
  it('corrects only the known public Lawrence stop display name and keeps source/IDs', () => {
    const files = { ...miniFiles, 'stops.txt': miniFiles['stops.txt']!.replace('2,', '32728,').replace('MAIN ST, AT ELM', 'STATE ST AT LAWERENCE ST'), 'stop_times.txt': miniFiles['stop_times.txt']!.replaceAll(',2,2', ',32728,2') };
    // Public number in fixture is 30002; the bounded correction must not apply to it.
    const input = buildDataset(files, { routeShortNames: ['165'], feedVersion: 'x', builtAt: 'x' });
    expect(input.stops.find((s: { id: string }) => s.id === '32728')?.sourceName).toBeUndefined();
    files['stops.txt'] = files['stops.txt']!.replace('30002', '32728');
    const output = buildDataset(files, { routeShortNames: ['165'], feedVersion: 'x', builtAt: 'x' });
    expect(searchStops(output, 'Lawrence')[0]).toMatchObject({ id: '32728', code: '32728', sourceName: 'STATE ST AT LAWERENCE ST' });
  });
});
describe('destination selection efficiency preserves reachability and ordering', () => {
  it('matches the existing guard for every origin, including twins, restrictions and nearby stops', () => {
    for (const input of [demoDataset, liveDataset]) for (const origin of input.stops) {
      const expected = input.stops.map((s, i) => { const check = checkDirection(input, origin.id, s.id); return { s, i, g: s.id === origin.id ? 2 : check.ok ? 0 : check.reason === 'wrong-side' ? 1 : 2 }; })
        .filter(x => x.g < 2).sort((a, b) => a.g - b.g || Number(!!b.s.terminal) - Number(!!a.s.terminal) || a.i - b.i).map(x => x.s.id);
      expect(destinationsFrom(input, origin.id).map(s => s.id)).toEqual(expected);
    }
  });
});
describe('scheduled arrival is separate from stop departure', () => {
  it.each(['20261101', '20260308', '20261104'])('keeps dwell and GTFS day conversion on %s', date => {
    const input = ds(), trip = input.trips.find(t => t.id === 'T1')!; trip.arrivals![2] = trip.times[2]! - 300;
    expect(tripTimeAt(input, trip, date, 2) - tripArrivalAt(input, trip, date, 2)!).toBe(300000);
    trip.arrivals![2] = null; expect(tripArrivalAt(input, trip, date, 2)).toBeUndefined();
    expect(() => parseDataset(input)).not.toThrow();
    trip.arrivals![2] = trip.times[2]! + 1; expect(() => parseDataset(input)).toThrow();
  });
  it('does not interpolate or substitute missing canonical arrivals', () => {
    const input = ds(), trip = input.trips.find(t => t.id === 'T1')!;
    expect(trip.arrivals?.[1]).toBeNull(); expect(tripArrivalAt(input, trip, '20261104', 1)).toBeUndefined();
  });
});

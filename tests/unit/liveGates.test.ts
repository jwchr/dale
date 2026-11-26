import { describe, expect, it } from 'vitest';
import { gateCandidates, matchGateRows, newGateDiagnostics, parseDvResponse, parseSchedDepTime } from '../../worker/gates';
import { gateFor, parseLaneGate } from '../../src/domain/gate';
import { currentGatePostings, parseLiveGates } from '../../src/data/liveGates';
import { strings } from '../../src/ui/i18n';
import type { Dataset } from '../../src/domain/types';

import { NOW, dataset, row } from '../helpers/gates';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('strict DepartureVision parsing', () => {
  it.each(['11/26/2026 7:15 AM', '11/26/2026 7:15:00 AM', '11/26/2026 07:15', '11/26/2026 07:15:00', '2026-11-26T07:15', '2026-11-26T07:15:00', '2026-11-26 07:15', '2026-11-26 07:15:00'])('parses %s as Eastern wall time', text => {
    expect(parseSchedDepTime(text)).toBe(NOW + 900_000);
  });
  it.each(['3/8/2026 2:30 AM', '11/1/2026 1:30 AM', '2026-02-30T07:15', '2026-11-26T24:00', '2026-11-26T07:15Z', '11/26/2026 0:15 AM', '2026-11-26T07:15:60', '', 'garbage', ' 11/26/2026 7:15 AM', '11/26/2026 7:15 am'])('rejects invalid or ambiguous date %s', text => expect(parseSchedDepTime(text)).toBeNull());
  it.each(['311', '222-3', '222/3'])('accepts gate %s', gate => expect(parseLaneGate(gate)).not.toBeNull());
  it.each(['', null, '..', 'A1', '123456789', '1234', '222 - 333', '1/123', ' 311', '311 '])('rejects invalid gate %s', gate => {
    expect(parseLaneGate(gate)).toBeNull();
  });
  it('reads only the documented row array and drops unrelated properties', () => {
    expect(parseDvResponse(bytes({ DVTrip: [] }))).toEqual([]);
    expect(parseDvResponse(bytes([]))).toEqual([]);
    expect(parseDvResponse(bytes({ DVTrip: [row({ vehicle_id: 'private-field', internal_trip_number: 'private-field' })] }))).toEqual([row()]);
  });
  it.each([{}, { DVTrip: null }, { message: 'failed' }, { DVTrip: [null] }, { DVTrip: [{ public_route: 165 }] }, { DVTrip: Array(501).fill(row()) }])('rejects malformed envelopes rather than treating as empty: %j', v => expect(() => parseDvResponse(bytes(v))).toThrow());
  it('parses one-digit dates and noon/midnight without guessing', () => {
    expect(parseSchedDepTime('1/2/2026 12:00 AM')).toBe(Date.UTC(2026, 0, 2, 5));
    expect(parseSchedDepTime('1/2/2026 12:00 PM')).toBe(Date.UTC(2026, 0, 2, 17));
    expect(parseSchedDepTime('01/02/2026 23:59:59')).toBe(Date.UTC(2026, 0, 3, 4, 59, 59));
  });
  it('rejects invalid JSON and oversized data', () => {
    expect(() => parseDvResponse(new TextEncoder().encode('{'))).toThrow();
    expect(() => parseDvResponse(new Uint8Array(256 * 1024 + 1))).toThrow();
  });
});

describe('exact trip and boarding-call match', () => {
  it('matches route, exact time and terminal, with the correct boarding index for each terminal call', () => {
    const c = gateCandidates(dataset, NOW);
    const d = newGateDiagnostics(NOW);
    const postings = matchGateRows([row(), row({ sched_dep_time: '11/26/2026 7:20 AM', lanegate: '311' })], c, NOW, d);
    expect(postings).toEqual([
      { tripInstanceId: 't@20261126', boardingIndex: 0, gate: '222', door: '3', source: 'njt-departurevision', receivedAt: NOW },
      { tripInstanceId: 't@20261126', boardingIndex: 1, gate: '311', source: 'njt-departurevision', receivedAt: NOW },
    ]);
    expect(d.rowsSeen).toBe(2); expect(d.matched).toBe(2);
  });
  it('never posts a different-time, ambiguous, invalid, conflicting or wrong-terminal row; counters account for every row', () => {
    const c = gateCandidates(dataset, NOW), d = newGateDiagnostics(NOW);
    const ambiguous = { ...c[0]!, tripInstanceId: 'other@20261126' };
    const rows = [row(), row({ lanegate: '311' }), row({ sched_dep_time: '11/26/2026 7:16 AM' }), row({ timing_point_id: 'OTHER' }), row({ sched_dep_time: 'bad' }), row({ sched_dep_time: '11/26/2026 7:20 AM', lanegate: '..' })];
    expect(matchGateRows(rows, c, NOW, d)).toEqual([]);
    expect(d).toMatchObject({ rowsSeen: 6, matched: 0, drops: { conflict: 2, unmatched: 1, 'wrong-terminal': 1, 'invalid-date': 1, 'invalid-gate': 1 } });
    const a = newGateDiagnostics(NOW); expect(matchGateRows([row()], [...c, ambiguous], NOW, a)).toEqual([]); expect(a.drops.ambiguous).toBe(1);
  });
  it('deduplicates agreeing rows and caps shape diagnostics without retaining exact dates', () => {
    const d = newGateDiagnostics(NOW);
    expect(matchGateRows([row(), row()], gateCandidates(dataset, NOW), NOW, d)).toHaveLength(1);
    expect(d.scheduleShapes).toEqual(['99/99/9999 9:99 AM']); expect(d.gateShapes).toEqual(['999-9']); expect(d.matched).toBe(2);
    matchGateRows(Array.from({ length: 30 }, (_, i) => row({ timing_point_id: `POINT${i}` })), [], NOW, d);
    expect(d.timingPoints).toHaveLength(10);
  });
  it('matches previous service 24:15 and next service 00:15 during the 23:30 lookahead', () => {
    const ds = structuredClone(dataset); ds.trips[0]!.times = [24 * 3600 + 900, 25 * 3600, 26 * 3600];
    const now = Date.UTC(2026, 10, 27, 5);
    expect(matchGateRows([row({ sched_dep_time: '11/27/2026 12:15 AM' })], gateCandidates(ds, now), now)[0]?.tripInstanceId).toBe('t@20261126');
    ds.trips[0]!.times = [900, 1800, 3600];
    expect(matchGateRows([row({ sched_dep_time: '11/27/2026 12:15 AM' })], gateCandidates(ds, Date.UTC(2026, 10, 27, 4, 30)), now)[0]?.tripInstanceId).toBe('t@20261127');
  });
  it('excludes no-pickup, estimated, inactive and inbound calls without assuming a direction-ID convention', () => {
    for (const alter of [(ds: Dataset) => { ds.patterns[0]!.noPickup = [0, 1]; }, (ds: Dataset) => { ds.trips[0]!.estimated = [0, 1]; }, (ds: Dataset) => { ds.calendars.daily!.removed = ['20261126']; }, (ds: Dataset) => { ds.patterns[0]!.stopIds = ['d', 'p', 'p2']; }]) {
      const ds = structuredClone(dataset); alter(ds); expect(matchGateRows([row()], gateCandidates(ds, NOW), NOW)).toEqual([]);
    }
  });
});

describe('phone monotonic gate freshness', () => {
  const packet = (ageMs: number) => ({ v: 1, schemaVersion: 1, feedVersion: dataset.meta.feedVersion, postings: [{ tripInstanceId: 't@20261126', boardingIndex: 0, gate: '311', source: 'njt-departurevision', ageMs }] });
  it.each([-120_000, 120_000])('expires at precisely 120 seconds despite a %i ms wall-clock skew', skew => {
    const receipt = parseLiveGates(packet(110_000), dataset, 1000, 500);
    expect(currentGatePostings(receipt, 9499)[0]?.ageMs).toBe(119_999);
    expect(currentGatePostings(receipt, 9500)).toEqual([]);
    // A wall-clock timestamp has no place in the age calculation.
    const p = currentGatePostings(receipt, 9499);
    expect(gateFor('t@20261126', 'out', 0, 'weekday', p, [], undefined, undefined, 0).status).toBe('posted');
    expect(gateFor('t@20261126', 'out', 0, 'weekday', [{ ...p[0]!, observedAt: Date.now() + skew, ageMs: 120_000 }], [], undefined, undefined, 0).status).toBe('unknown');
    expect(gateFor('t@20261126', 'out', 0, 'weekday', p, [], undefined, undefined, 1).status).toBe('unknown');
  });
  it('counts the whole request duration and fails closed on a backwards monotonic clock', () => {
    const receipt = parseLiveGates(packet(110_000), dataset, 20_000, 500);
    expect(currentGatePostings(receipt, 500)).toEqual([]); expect(currentGatePostings(receipt, 499)).toEqual([]);
  });
  it('rejects wrong versions, duplicate postings, malformed gates and non-terminal calls', () => {
    for (const change of [{ feedVersion: 'other' }, { postings: [{ ...packet(0).postings[0], gate: 'A1' }] }, { postings: [...packet(0).postings, ...packet(0).postings] }, { postings: [{ ...packet(0).postings[0], boardingIndex: 2 }] }]) expect(() => parseLiveGates({ ...packet(0), ...change }, dataset, 0, 0)).toThrow();
  });
  it('uses EN/ES receipt ages, minutes and latency wording', () => {
    expect(strings.en.gateReceiptAge(40_000)).toBe('40 sec ago'); expect(strings.es.gateReceiptAge(40_000)).toBe('hace 40 s');
    expect(strings.en.gateReceiptAge(60_001)).toBe('1 min ago'); expect(strings.es.gateReceiptAge(60_001)).toBe('hace 1 min');
    expect(strings.en.gateLatencyNotice).toBe('may not be real time'); expect(strings.es.gateLatencyNotice).toBe('puede no ser en tiempo real');
  });
});

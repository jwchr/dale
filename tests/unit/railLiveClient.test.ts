import { describe, expect, it } from 'vitest';
import { minutesLate, parseLiveRailBoard, railBoardsFor, RAIL_STALE_MS } from '../../src/domain/railLive';

const NOW = Date.parse('2026-11-18T22:00:00Z');
const dep = (over: Record<string, unknown> = {}) => ({ trainId: '1620', line: 'Pascack Valley Line', lineCode: 'PV', destination: 'Hoboken',
  scheduledAt: NOW + 10 * 60_000, track: null, status: null, secondsLate: null, updatedAt: null, ...over });
const answer = (over: Record<string, unknown> = {}) => ({ v: 1, source: 'NJ Transit RailData', station: 'AS', state: 'ok', receivedAt: NOW - 20_000, departures: [dep()], skippedRows: 0, ...over });

describe('railBoardsFor', () => {
  it('uses the home station toward New York and Penn plus the Secaucus Pascack Valley level coming home', () => {
    expect(railBoardsFor('anderson', 'outbound')).toEqual(['AS']);
    expect(railBoardsFor('essex', 'outbound')).toEqual(['EX']);
    expect(railBoardsFor('essex', 'return')).toEqual(['NY', 'TS']);
  });
});

describe('parseLiveRailBoard', () => {
  it('keeps a valid answer and its age', () => {
    expect(parseLiveRailBoard(answer(), 'AS', NOW)).toEqual({ state: 'ok', station: 'AS', receivedAt: NOW - 20_000, stale: false, departures: [dep()] });
    expect(parseLiveRailBoard(answer({ receivedAt: NOW - RAIL_STALE_MS - 1 }), 'AS', NOW)).toMatchObject({ stale: true });
  });
  it('drops departures that have left, counting NJ Transit delay, and sorts', () => {
    const out = parseLiveRailBoard(answer({ departures: [dep({ trainId: 'B', scheduledAt: NOW + 60_000 }), dep({ trainId: 'GONE', scheduledAt: NOW - 2 * 60_000 }),
      dep({ trainId: 'LATE', scheduledAt: NOW - 2 * 60_000, secondsLate: 300 })] }), 'AS', NOW);
    expect(out.state === 'ok' && out.departures.map((d) => d.trainId)).toEqual(['LATE', 'B']);
  });
  it('treats any malformed answer as unavailable, never partly shown', () => {
    const bad = [null, 'x', answer({ v: 2 }), answer({ station: 'EX' }), answer({ state: 'unavailable' }), answer({ receivedAt: 'now' }), answer({ receivedAt: NOW + 10 * 60_000 }),
      answer({ departures: 'none' }), answer({ departures: Array(41).fill(dep()) }), answer({ departures: [dep({ trainId: '<b>' })] }), answer({ departures: [dep({ track: 3 })] }),
      answer({ departures: [dep({ destination: 'x'.repeat(65) })] }), answer({ departures: [dep({ secondsLate: 1.5 })] }), answer({ departures: [dep({ scheduledAt: -1 })] }),
      answer({ departures: [dep({ status: '' })] }), answer({ departures: [null] })];
    for (const raw of bad) expect(parseLiveRailBoard(raw, 'AS', NOW)).toEqual({ state: 'unavailable', station: 'AS' });
  });
});

describe('minutesLate', () => {
  it('shows only whole minutes NJ Transit reports, never early or under a minute', () => {
    expect([null, -60, 0, 59, 60, 179].map((secondsLate) => minutesLate(dep({ secondsLate }) as never))).toEqual([null, null, null, null, 1, 2]);
  });
});

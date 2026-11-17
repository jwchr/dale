import { describe, expect, it } from 'vitest';
import { createBusSession, reduceBusSession, type BusSession } from '../../src/domain/busLock';
import {
  activateOutcome, activationRetryDelay, addPendingDelete, base64UrlBytes, deleteDone, endReason, livePendingDeletes, normalizeHouseholdCode,
  parseRideAlertConfig, parseSavedRideAlerts, registerOutcome, rideRecord, validHouseholdCode, wantedRide,
} from '../../src/domain/lockedAlerts';
import type { Departure } from '../../src/domain/types';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = Date.UTC(2026, 10, 4, 12, 50);
// Invented trip; never a recorded NJ Transit or rider location.
const dep: Departure = {
  tripInstanceId: 'synthetic-trip@20261104', tripId: 'synthetic-trip', serviceDate: '20261104',
  route: { id: 'synthetic-route', shortName: 'Demo', longName: 'Synthetic test route' },
  pattern: { id: 'synthetic-pattern', routeId: 'synthetic-route', directionId: 0, headsign: 'Synthetic destination', stopIds: ['A', 'B', 'C', 'D'] },
  stopIndex: 1, departs: NOW - 200_000, estimated: false, arrivesEnd: NOW + 1_800_000,
};

function boardedSession(vehicleId?: string): BusSession {
  let s = createBusSession(dep, NOW - 600_000, 'test-session');
  s = reduceBusSession(s, { type: 'start_waiting', now: NOW - 500_000 });
  s = reduceBusSession(s, { type: 'arrived', now: NOW - 400_000 });
  s = reduceBusSession(s, { type: 'boarded', now: NOW - 300_000 });
  expect(s.phase).toBe('onboard');
  return vehicleId ? { ...s, lock: { ...s.lock, status: 'tracked', vehicleId } } : s;
}

describe('household code', () => {
  it('is trimmed, upper-cased and loses spaces and hyphens', () => {
    expect(normalizeHouseholdCode('  ab12-cd34 ef56‐gh78 \n')).toBe('AB12CD34EF56GH78');
    expect(validHouseholdCode('AB12CD34EF56GH78')).toBe(true);
    expect(validHouseholdCode('')).toBe(false);
    expect(validHouseholdCode('AB12!CD34')).toBe(false);
  });
});

describe('which ride to register', () => {
  it('needs a boarded rider, an exact locked vehicle and a stop further along the trip', () => {
    const s = boardedSession('bus-A');
    const alight = s.departure.stopIndex + 1;
    expect(wantedRide(s, alight)).toEqual({ key: `${s.id}|bus-A|${alight}`, sessionId: s.id, trip: s.departure.tripId, date: s.departure.serviceDate,
      vehicle: 'bus-A', board: s.departure.stopIndex, alight });
    expect(wantedRide(boardedSession(), alight)).toBeUndefined(); // no vehicle yet
    expect(wantedRide(s, s.departure.stopIndex)).toBeUndefined();
    expect(wantedRide(s, s.departure.pattern.stopIds.length)).toBeUndefined();
    expect(wantedRide({ ...s, phase: 'waiting' }, alight)).toBeUndefined();
    expect(wantedRide({ ...s, lock: { ...s.lock, status: 'cancelled' } }, alight)).toBeUndefined();
    // A confirmed vehicle change is a different ride; the rider's pending decision is not.
    expect(wantedRide({ ...s, lock: { ...s.lock, vehicleId: 'bus-B' } }, alight)!.key).not.toBe(wantedRide(s, alight)!.key);
    expect(wantedRide({ ...s, lock: { ...s.lock, status: 'needs_confirmation' } }, alight)!.key).toBe(wantedRide(s, alight)!.key);
  });

  it('ends as "got off" only after the rider said so; anything else is an unlock', () => {
    const s = boardedSession('bus-A');
    expect(endReason(reduceBusSession(s, { type: 'end', now: NOW }), s.id)).toBe('got_off');
    expect(endReason(s, s.id)).toBe('unlocked');
    expect(endReason(undefined, s.id)).toBe('unlocked');
    expect(endReason({ ...s, phase: 'ended' }, 'another')).toBe('unlocked');
  });
});

describe('server answers', () => {
  it('reads registration answers without ever inventing a ride', () => {
    expect(registerOutcome(201, { v: 1, id: ID, expiresAt: 1 })).toEqual({ kind: 'ok', id: ID });
    expect(registerOutcome(201, { v: 1, id: 'short' })).toEqual({ kind: 'failed' });
    expect(registerOutcome(401, { v: 1, error: 'code' })).toEqual({ kind: 'code' });
    expect(registerOutcome(429, { v: 1, error: 'later' })).toEqual({ kind: 'later' });
    expect(registerOutcome(429, { v: 1, error: 'full' })).toEqual({ kind: 'full' });
    expect(registerOutcome(503, { v: 1, available: false })).toEqual({ kind: 'unavailable' });
    expect(registerOutcome(400, { v: 1, error: 'invalid' })).toEqual({ kind: 'invalid' });
    expect(registerOutcome(0, undefined)).toEqual({ kind: 'failed' });
    expect(registerOutcome(500, undefined)).toEqual({ kind: 'failed' });
  });

  it('accepts the config only with a well-formed P-256 public key', () => {
    const key = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString('base64url');
    const ok = parseRideAlertConfig({ v: 1, available: true, publicKey: key });
    expect(ok.available).toBe(true);
    expect(ok.publicKey).toHaveLength(65);
    expect(parseRideAlertConfig({ v: 1, available: false })).toEqual({ available: false });
    expect(parseRideAlertConfig({ v: 1, available: true, publicKey: key.slice(0, 40) })).toEqual({ available: false });
    expect(parseRideAlertConfig({ v: 1, available: true, publicKey: 'not base64!' })).toEqual({ available: false });
    expect(parseRideAlertConfig(null)).toEqual({ available: false });
  });

  it('decodes base64url like the platform does', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlBytes(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
    expect(base64UrlBytes('a')).toBeUndefined();
  });

  it('treats a delete as finished only when the server answered it', () => {
    expect(deleteDone(204)).toBe(true);
    expect(deleteDone(404)).toBe(true);
    expect(deleteDone('network')).toBe(false);
    expect(deleteDone(503)).toBe(false);
    expect(deleteDone(500)).toBe(false);
    expect(activateOutcome(200)).toBe('active');
    expect(activateOutcome(410)).toBe('gone');
    expect(activateOutcome('network')).toBe('retry');
  });
});

describe('retries', () => {
  it('retries activation with growing waits and gives up before the server drops the pending ride at 2 minutes', () => {
    const created = 0;
    expect(activationRetryDelay(created, 1_000, 0)).toBe(1_000);
    expect(activationRetryDelay(created, 5_000, 3)).toBe(8_000);
    expect(activationRetryDelay(created, 30_000, 9)).toBe(10_000);
    expect(activationRetryDelay(created, 111_000, 9)).toBeUndefined();
    expect(activationRetryDelay(created, 120_000, 0)).toBeUndefined();
  });

  it('keeps one saved delete per ride, and drops those past the server\'s 3-hour cap', () => {
    const a = { id: ID, apiBase: 'https://dale-live.x.workers.dev', reason: 'got_off' as const, since: NOW };
    const list = addPendingDelete(addPendingDelete([], a), { ...a, reason: 'unlocked' });
    expect(list).toEqual([{ ...a, reason: 'unlocked' }]);
    expect(livePendingDeletes(list, NOW + 60_000)).toHaveLength(1);
    expect(livePendingDeletes(list, NOW + 3 * 3_600_000)).toEqual([]);
  });
});

describe('saved state and the service worker record', () => {
  it('reads saved settings defensively', () => {
    expect(parseSavedRideAlerts(null)).toEqual({ enabled: false, pending: [] });
    expect(parseSavedRideAlerts('{bad')).toEqual({ enabled: false, pending: [] });
    const ride = { id: ID, apiBase: 'https://dale-live.x.workers.dev', key: 'k', sessionId: 's', createdAt: 1, activated: true };
    expect(parseSavedRideAlerts(JSON.stringify({ enabled: true, code: 'AB12CD34EF56GH78', ride, pending: [{ id: 'bad' }] })))
      .toEqual({ enabled: true, code: 'AB12CD34EF56GH78', ride, pending: [] });
    expect(parseSavedRideAlerts(JSON.stringify({ enabled: true, code: 'no!', ride: { ...ride, id: 'x' } }))).toEqual({ enabled: true, pending: [] });
  });

  it('builds the record the contract names, starting at "riding" (rank 0) with no notice shown', () => {
    const text = { cantCheck: { title: 'a', body: 'b' }, ended: { title: 'c', body: 'd' } };
    expect(rideRecord(ID, 'https://fcm.googleapis.com/x', 'https://dale-live.x.workers.dev', 'es', text)).toEqual({
      rideId: ID, endpoint: 'https://fcm.googleapis.com/x', apiBase: 'https://dale-live.x.workers.dev', lang: 'es', highestShown: 0, noticeShown: false, text,
    });
  });
});

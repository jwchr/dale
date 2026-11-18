// Stop alerts while the phone is locked (#176 step C, docs/LOCKED_STOP_ALERTS.md). Pure rules only:
// which ride to register, what a server answer means, when to retry. The browser calls live in src/ui.
import type { BusSession } from './busLock';

/** The household code as typed or scanned: trimmed, upper case, without spaces or hyphens. */
export function normalizeHouseholdCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-‐-―]/g, '');
}

/** A plausible code (letters and numbers only); only the server can say whether it is right. */
export const validHouseholdCode = (code: string): boolean => /^[A-Z0-9]{8,64}$/.test(code);

/** 128 random bits, base64url without padding. */
export const validRideId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id);

/** A ride the server never saw activated is deleted there after this long, so the app stops trying too. */
export const ACTIVATE_WINDOW_MS = 2 * 60_000;
/** A row whose delete never reached the server is gone by then anyway (the server's hard cap). */
export const SERVER_RIDE_CAP_MS = 3 * 60 * 60_000;

/** The ride the app should have registered right now, or undefined for none. */
export interface WantedRide { key: string; sessionId: string; trip: string; date: string; vehicle: string; board: number; alight: number; lang: 'en' | 'es' }

/**
 * A ride is wanted once the rider has boarded a locked bus (an exact vehicle is known), with a stop to get
 * off at further along the trip. A vehicle change the rider has not confirmed keeps the current one.
 * The language is part of the ride: changing it mid-ride ends the ride and registers a new one, so the
 * server's lines and the service worker's record follow the new language.
 */
export function wantedRide(session: BusSession | undefined, alightIndex: number, lang: 'en' | 'es'): WantedRide | undefined {
  if (!session || session.phase !== 'onboard') return undefined;
  const { lock, departure: dep } = session;
  if (!lock.vehicleId || lock.status === 'cancelled' || lock.status === 'ended') return undefined;
  if (!Number.isInteger(alightIndex) || alightIndex <= dep.stopIndex || alightIndex >= dep.pattern.stopIds.length) return undefined;
  return {
    key: `${session.id}|${lock.vehicleId}|${alightIndex}|${lang}`, sessionId: session.id,
    trip: dep.tripId, date: dep.serviceDate, vehicle: lock.vehicleId, board: dep.stopIndex, alight: alightIndex, lang,
  };
}

export type EndReason = 'got_off' | 'unlocked';
/** "I got off" (or the rider reported leaving) ends the ride as got off; anything else is an unlock. */
export function endReason(session: BusSession | undefined, sessionId: string): EndReason {
  return session?.id === sessionId && (session.phase === 'ended' || session.phase === 'left') ? 'got_off' : 'unlocked';
}

export type RegisterOutcome =
  | { kind: 'ok'; id: string }
  | { kind: 'code' | 'later' | 'full' | 'unavailable' | 'invalid' | 'failed' };

/** What `POST /v1/ride-alerts` answered. Anything unexpected is a plain failure, never a ride. */
export function registerOutcome(status: number, body: unknown): RegisterOutcome {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (status === 201) {
    const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
    return validRideId(id) ? { kind: 'ok', id } : { kind: 'failed' };
  }
  if (status === 401) return { kind: 'code' };
  if (status === 429) return { kind: error === 'later' ? 'later' : 'full' };
  if (status === 503) return { kind: 'unavailable' };
  if (status === 400) return { kind: 'invalid' };
  return { kind: 'failed' };
}

/** A delete is finished once the server answered it (204) or says the id is unknown or gone. */
export const deleteDone = (status: number | 'network'): boolean => status === 204 || status === 200 || status === 404 || status === 410;

export type ActivateOutcome = 'active' | 'gone' | 'retry';
export const activateOutcome = (status: number | 'network'): ActivateOutcome =>
  status === 200 ? 'active' : status === 404 || status === 410 ? 'gone' : 'retry';

/**
 * How long to wait before the next activation try, or undefined to give up: the server deletes a ride
 * that was not activated within 2 minutes of being created.
 */
export function activationRetryDelay(createdAt: number, now: number, attempt: number): number | undefined {
  const delay = Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt));
  return now + delay - createdAt < ACTIVATE_WINDOW_MS ? delay : undefined;
}

export interface PendingDelete { id: string; apiBase: string; reason: EndReason; since: number }

/** Add a delete to retry later; one per ride. */
export function addPendingDelete(list: readonly PendingDelete[], item: PendingDelete): PendingDelete[] {
  return [...list.filter((p) => p.id !== item.id), item];
}

/** Deletes still worth sending: within the server's 3-hour cap, at most 10 kept. */
export function livePendingDeletes(list: readonly PendingDelete[], now: number): PendingDelete[] {
  return list.filter((p) => now - p.since < SERVER_RIDE_CAP_MS && now >= p.since - 60_000).slice(-10);
}

export interface RideAlertConfig { available: boolean; publicKey?: Uint8Array }

/** `GET /v1/ride-alerts/config`: available only with a well-formed uncompressed P-256 public key. */
export function parseRideAlertConfig(body: unknown): RideAlertConfig {
  if (!body || typeof body !== 'object') return { available: false };
  const b = body as { v?: unknown; available?: unknown; publicKey?: unknown };
  if (b.v !== 1 || b.available !== true || typeof b.publicKey !== 'string') return { available: false };
  const key = base64UrlBytes(b.publicKey);
  return key && key.length === 65 && key[0] === 4 ? { available: true, publicKey: key } : { available: false };
}

export function base64UrlBytes(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of text) {
    value = (value << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

export interface NoteText { title: string; body: string }
/** The service worker's ride record (IndexedDB `dale-ride-alerts`, store `ride`, key `current`). */
export interface RideRecord {
  rideId: string; endpoint: string; apiBase: string; lang: 'en' | 'es';
  /** Rank of the highest stage shown on this phone; starts at 0 ("riding"). */
  highestShown: number;
  noticeShown: boolean;
  text: { cantCheck: NoteText; ended: NoteText };
  /** The line shown for `highestShown`, re-shown silently when a lower or repeated stage arrives. */
  shown?: NoteText;
}

export function rideRecord(rideId: string, endpoint: string, apiBase: string, lang: 'en' | 'es', text: RideRecord['text']): RideRecord {
  return { rideId, endpoint, apiBase, lang, highestShown: 0, noticeShown: false, text };
}

/** Saved on this phone only. */
export interface SavedRideAlerts {
  enabled: boolean;
  code?: string;
  ride?: { id: string; apiBase: string; key: string; sessionId: string; createdAt: number; activated: boolean };
  pending: PendingDelete[];
}

/** Read the saved settings defensively: anything malformed is dropped, never repaired into a ride. */
export function parseSavedRideAlerts(raw: string | null | undefined): SavedRideAlerts {
  const empty: SavedRideAlerts = { enabled: false, pending: [] };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object') return empty;
    const out: SavedRideAlerts = { enabled: v.enabled === true, pending: [] };
    if (typeof v.code === 'string' && validHouseholdCode(v.code)) out.code = v.code;
    const r = v.ride as Record<string, unknown> | undefined;
    if (r && typeof r === 'object' && validRideId(r.id) && typeof r.apiBase === 'string' && typeof r.key === 'string'
      && typeof r.sessionId === 'string' && typeof r.createdAt === 'number' && typeof r.activated === 'boolean') {
      out.ride = { id: r.id, apiBase: r.apiBase, key: r.key, sessionId: r.sessionId, createdAt: r.createdAt, activated: r.activated };
    }
    if (Array.isArray(v.pending)) out.pending = v.pending.filter((p): p is PendingDelete => !!p && typeof p === 'object'
      && validRideId((p as PendingDelete).id) && typeof (p as PendingDelete).apiBase === 'string'
      && ['got_off', 'unlocked'].includes((p as PendingDelete).reason) && typeof (p as PendingDelete).since === 'number');
    return out;
  } catch { return empty; }
}

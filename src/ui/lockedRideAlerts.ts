// Locked-phone stop alerts (#176 step C): one place that registers, activates and ends the server ride
// (docs/LOCKED_STOP_ALERTS.md, flow steps 1 and 8). Changes run one at a time; each run compares the ride
// the phone should have with the one it has and takes the next step. Steps A and B never wait on it.
import { useEffect, useSyncExternalStore } from 'react';
import type { BusSession } from '../domain/busLock';
import {
  activateOutcome, activationRetryDelay, addPendingDelete, deleteDone, endReason, livePendingDeletes, parseSavedRideAlerts,
  registerOutcome, rideRecord, wantedRide, type EndReason, type SavedRideAlerts, type WantedRide,
} from '../domain/lockedAlerts';
import { strings, type Lang } from './i18n';
import {
  activateRide, deleteRide, deleteRideRecord, fetchRideAlertConfig, pushSupport, readRideRecordId, registerRide, subscribeFresh, unsubscribePush,
  writeRideRecord,
} from './rideAlertClient';
import { notifyPermission, requestNotify } from './stopAlertOutputs';

const STORAGE = 'arriba.rideAlerts.v1';
/** Saved deletes are retried when Dale opens, when the network returns, and at most this often meanwhile. */
const PENDING_RETRY_MS = 60_000;

export type LockedNote = 'unavailable' | 'unsupported' | 'iphone' | 'blocked' | 'code' | 'later' | 'full' | 'invalid' | 'failed' | 'storage';
export type LockedContext = 'ok' | 'demo' | 'no-live';
export interface LockedView {
  enabled: boolean;
  hasCode: boolean;
  context: LockedContext;
  ride: 'none' | 'starting' | 'on' | 'waiting-gps';
  removing: boolean;
  note?: LockedNote | undefined;
}
export interface LockedInput {
  api?: string | undefined; demo: boolean; realtime: boolean; lang: Lang;
  session?: BusSession | undefined; alightIndex: number;
  /** A lock saved before a reload, offered back to the rider: its ride is kept until they decide. */
  heldSessionId?: string | undefined;
}

const storage = (): Storage | undefined => { try { return window.localStorage; } catch { return undefined; } };
let saved: SavedRideAlerts = (() => { try { return parseSavedRideAlerts(storage()?.getItem(STORAGE)); } catch { return parseSavedRideAlerts(null); } })();
let input: LockedInput = { demo: false, realtime: false, lang: 'en', alightIndex: -1 };
let note: LockedNote | undefined;
/** A ride that failed to start is not retried by itself; the rider can try again. */
let blockedKey: string | undefined;
let registering = false;
let cleanupWanted = false;
let nextActivateAt = 0, activateAttempt = 0, nextPendingAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const listeners = new Set<() => void>();
let view: LockedView = computeView();

function contextOf(i: LockedInput): LockedContext { return i.demo ? 'demo' : i.api && i.realtime ? 'ok' : 'no-live'; }
function computeView(): LockedView {
  const s = input.session;
  const ride = saved.ride?.activated ? 'on' : registering || saved.ride ? 'starting'
    : saved.enabled && saved.code && s?.phase === 'onboard' && !s.lock.vehicleId && !note ? 'waiting-gps' : 'none';
  return { enabled: saved.enabled, hasCode: !!saved.code, context: contextOf(input), ride, removing: saved.pending.length > 0, note };
}
function emit() {
  const next = computeView();
  if ((Object.keys(next) as (keyof LockedView)[]).every((k) => next[k] === view[k])) return;
  view = next;
  for (const l of listeners) l();
}
function persist(next: SavedRideAlerts) {
  saved = next;
  try { storage()?.setItem(STORAGE, JSON.stringify(saved)); } catch { /* kept for this visit only */ }
  emit();
}

let running = false, again = false;
function kick() {
  if (running) { again = true; return; }
  running = true;
  void (async () => {
    try { do { again = false; await step(); } while (again); } catch { /* the next change tries again */ } finally { running = false; emit(); }
  })();
}
function later(ms: number) { clearTimeout(timer); timer = setTimeout(kick, ms); }

async function step() {
  await flushPending();
  const api = input.api;
  const want = saved.enabled && saved.code && contextOf(input) === 'ok' ? wantedRide(input.session, input.alightIndex, input.lang) : undefined;
  const ride = saved.ride;
  if (ride) {
    if (want && want.key === ride.key) { if (!ride.activated) await activate(); return; }
    if (!want && saved.enabled && ride.sessionId === input.heldSessionId) return;
    await endRide(endReason(input.session, ride.sessionId));
  }
  if (cleanupWanted && !saved.ride) { cleanupWanted = false; await unsubscribePush(); await deleteRideRecord(); }
  if (want && api && want.key !== blockedKey && !saved.ride) await register(want, api);
}

async function register(want: WantedRide, api: string) {
  registering = true; note = undefined; emit();
  const fail = (n: LockedNote) => { note = n; blockedKey = want.key; };
  try {
    const support = pushSupport();
    if (support !== 'supported') return fail(support === 'iphone-install' ? 'iphone' : 'unsupported');
    if (notifyPermission() !== 'granted') return fail('blocked');
    const config = await fetchRideAlertConfig(api);
    if (config === 'network') return fail('failed');
    if (!config.available || !config.publicKey) return fail('unavailable');
    const sub = await subscribeFresh(config.publicKey);
    if (!sub) return fail('failed');
    const lang = want.lang;
    const res = await registerRide(api, { code: saved.code!, endpoint: sub.endpoint, trip: want.trip, date: want.date, vehicle: want.vehicle, board: want.board, alight: want.alight, lang });
    const out = registerOutcome(res.status === 'network' ? 0 : res.status, res.body);
    if (out.kind !== 'ok') {
      await unsubscribePush();
      if (out.kind === 'code') { const { code: _wrong, ...rest } = saved; persist(rest); note = 'code'; return; }
      return fail(out.kind);
    }
    // Order matters (create, record, save, activate): a ride saved on this phone can be activated, so the
    // service worker's record is written first. Without it the worker could not check a push, so the ride
    // is deleted on the server and never saved here; the server also drops it after 2 minutes unactivated.
    const createdAt = Date.now();
    const t = strings[lang].lockedAlerts;
    const written = await writeRideRecord(rideRecord(out.id, sub.endpoint, api, lang, {
      cantCheck: { title: t.noteTitle, body: t.cantCheck }, ended: { title: t.endedTitle, body: t.ended },
    }));
    if (!written) {
      fail('storage');
      await unsubscribePush();
      await deleteRideRecord();
      await deleteOnServer(out.id, api, 'unlocked');
      return;
    }
    persist({ ...saved, ride: { id: out.id, apiBase: api, key: want.key, sessionId: want.sessionId, createdAt, activated: false } });
    activateAttempt = 0; nextActivateAt = 0;
    await activate();
  } finally { registering = false; emit(); }
}

/** Only an activated ride is watched by the server; retry while Dale is open, for up to 2 minutes. */
async function activate() {
  const ride = saved.ride;
  if (!ride || ride.activated || Date.now() < nextActivateAt) return;
  // Never activate a ride without its service-worker record (a start that was cut short, or a record the
  // browser lost): delete it on the server instead. The rider can try again.
  if (await readRideRecordId() !== ride.id) {
    if (saved.ride?.id !== ride.id) return;
    note = 'storage'; blockedKey = ride.key;
    await endRide('unlocked');
    return;
  }
  const out = activateOutcome(await activateRide(ride.apiBase, ride.id));
  if (saved.ride?.id !== ride.id) return;
  if (out === 'active') { persist({ ...saved, ride: { ...ride, activated: true } }); return; }
  const delay = out === 'retry' ? activationRetryDelay(ride.createdAt, Date.now(), activateAttempt++) : undefined;
  if (delay === undefined) { note = 'failed'; blockedKey = ride.key; await endRide('unlocked'); return; }
  nextActivateAt = Date.now() + delay;
  later(delay);
}

/** Step 8: unsubscribe first, then the record, then the server; a delete that fails is kept and retried. */
async function endRide(reason: EndReason) {
  const ride = saved.ride;
  if (!ride) return;
  await unsubscribePush();
  await deleteRideRecord();
  await deleteOnServer(ride.id, ride.apiBase, reason, { ride: undefined });
}

/** The delete is saved on this phone (with any other change, in one write) before it is sent, and retried if it fails. */
async function deleteOnServer(id: string, apiBase: string, reason: EndReason, change: Partial<SavedRideAlerts> = {}) {
  persist({ ...saved, ...change, pending: addPendingDelete(saved.pending, { id, apiBase, reason, since: Date.now() }) });
  if (deleteDone(await deleteRide(apiBase, id, reason))) persist({ ...saved, pending: saved.pending.filter((p) => p.id !== id) });
  else nextPendingAt = Date.now() + PENDING_RETRY_MS;
}

async function flushPending() {
  const now = Date.now();
  const live = livePendingDeletes(saved.pending, now);
  if (live.length !== saved.pending.length) persist({ ...saved, pending: live });
  if (!live.length || now < nextPendingAt || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  nextPendingAt = now + PENDING_RETRY_MS;
  for (const p of live) {
    if (deleteDone(await deleteRide(p.apiBase, p.id, p.reason))) persist({ ...saved, pending: saved.pending.filter((x) => x.id !== p.id) });
  }
  if (saved.pending.length) later(PENDING_RETRY_MS);
}

/** Feeds the current lock into the reconciler, and retries saved deletes when Dale opens or goes online. */
export function useLockedRideAlerts(next: LockedInput): void {
  useEffect(() => { input = next; emit(); kick(); });
  useEffect(() => {
    const retry = () => { nextPendingAt = 0; kick(); };
    retry();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);
}

export function useLockedAlertsView(): LockedView {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => view, () => view);
}

/** The rider agreed and entered a code: check the phone and the server, then turn the setting on. */
export async function turnOnLockedAlerts(code: string): Promise<boolean> {
  const show = (n: LockedNote) => { note = n; emit(); return false; };
  const support = pushSupport();
  if (support !== 'supported') return show(support === 'iphone-install' ? 'iphone' : 'unsupported');
  // Asked straight from the rider's tap, before any network wait, so iPhone accepts the request.
  if (!(notifyPermission() === 'granted' || await requestNotify())) return show('blocked');
  const config = input.api ? await fetchRideAlertConfig(input.api) : 'network';
  if (config === 'network' || !config.available) return show('unavailable');
  note = undefined; blockedKey = undefined;
  persist({ ...saved, enabled: true, code });
  kick();
  return true;
}

/** A new code after the server refused the saved one. */
export function setHouseholdCode(code: string): void {
  note = undefined; blockedKey = undefined;
  persist({ ...saved, code });
  kick();
}

export function turnOffLockedAlerts(): void {
  note = undefined; blockedKey = undefined; cleanupWanted = true;
  persist({ ...saved, enabled: false });
  kick();
}

export function retryLockedAlerts(): void {
  note = undefined; blockedKey = undefined; nextPendingAt = 0;
  emit();
  kick();
}

export function clearLockedNote(): void { note = undefined; emit(); }

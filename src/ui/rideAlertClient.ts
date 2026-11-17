// Browser side of locked-phone stop alerts (#176 step C): push subscription, the service worker's ride
// record in IndexedDB, and Dale's ride-alert routes. Every call resolves; failures come back as values.
import { parseRideAlertConfig, type RideAlertConfig, type RideRecord } from '../domain/lockedAlerts';
import { notifySupport, type NotifySupport } from './stopAlertOutputs';

const TIMEOUT_MS = 12_000;
const DB = 'dale-ride-alerts', STORE = 'ride', KEY = 'current';

/** Push needs notifications, a service worker and the Push API (iPhone: Home Screen, iOS 16.4+). */
export function pushSupport(): NotifySupport {
  const notes = notifySupport();
  if (notes !== 'supported') return notes;
  return 'serviceWorker' in navigator && 'PushManager' in window ? 'supported' : 'unsupported';
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number | 'network'; body?: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    let body: unknown;
    try { body = res.status === 204 ? undefined : await res.json(); } catch { body = undefined; }
    return { status: res.status, body };
  } catch { return { status: 'network' }; } finally { clearTimeout(timer); }
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const rideUrl = (api: string, id: string, suffix = '') => `${api}/v1/ride-alerts/${encodeURIComponent(id)}${suffix}`;

export async function fetchRideAlertConfig(api: string): Promise<RideAlertConfig | 'network'> {
  const res = await call(`${api}/v1/ride-alerts/config`);
  if (res.status === 'network') return 'network';
  return res.status === 200 ? parseRideAlertConfig(res.body) : { available: false };
}

export interface RegisterBody { code: string; endpoint: string; trip: string; date: string; vehicle: string; board: number; alight: number; lang: 'en' | 'es' }
export const registerRide = (api: string, ride: RegisterBody) => call(`${api}/v1/ride-alerts`, json('POST', { v: 1, ...ride }));
export const activateRide = async (api: string, id: string) => (await call(rideUrl(api, id, '/activate'), json('POST', {}))).status;
export const deleteRide = async (api: string, id: string, reason: 'got_off' | 'unlocked') =>
  (await call(`${rideUrl(api, id)}?reason=${reason}`, { method: 'DELETE' })).status;

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((r) => { timer = setTimeout(r, TIMEOUT_MS, undefined); })]);
  } catch { return undefined; } finally { clearTimeout(timer); }
}

/** Drop any earlier subscription, so a push still queued for an old ride can never reach this one. */
export async function subscribeFresh(publicKey: Uint8Array): Promise<PushSubscription | undefined> {
  const reg = await registration();
  if (!reg) return undefined;
  try {
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey as BufferSource });
  } catch { return undefined; }
}

/** First step of every ending: once unsubscribed, no further alert can reach this phone. */
export async function unsubscribePush(): Promise<void> {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* nothing subscribed, or no service worker */ }
}

function withStore(mode: IDBTransactionMode, act: (s: IDBObjectStore) => void): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE); };
      open.onerror = () => resolve(false);
      open.onblocked = () => resolve(false);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction(STORE, mode);
          act(tx.objectStore(STORE));
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = tx.onabort = () => { db.close(); resolve(false); };
        } catch { db.close(); resolve(false); }
      };
    } catch { resolve(false); }
  });
}
export const writeRideRecord = (record: RideRecord) => withStore('readwrite', (s) => { s.put(record, KEY); });
export const deleteRideRecord = () => withStore('readwrite', (s) => { s.delete(KEY); });

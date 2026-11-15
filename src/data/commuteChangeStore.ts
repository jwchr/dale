import { parseDataset } from '../domain/dataset';
import { advanceCommuteChanges, officialSchedule, type CommuteChangeState, type ChangedDeparture, type CommuteChange } from '../domain/commuteChanges';
import { loadFavorites, type Favorite } from '../domain/favorites';
import type { Dataset } from '../domain/types';

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Number.isFinite(new Date(x).getTime());
const texts = (x: unknown): x is string[] => Array.isArray(x) && x.every(text);
const date = (x: unknown) => {
  if (typeof x !== 'string' || !/^\d{8}$/.test(x)) return false;
  const value = new Date(`${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}T12:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10).replaceAll('-', '') === x;
};
const departure = (x: unknown): x is ChangedDeparture => record(x) && (x.direction === 'out' || x.direction === 'back') && text(x.route)
  && finite(x.departure) && (x.arrival === undefined || finite(x.arrival)) && typeof x.estimated === 'boolean' && texts(x.stops);
const notice = (x: unknown): x is CommuteChange => record(x) && ['id', 'favoriteId', 'favoriteKey', 'fromVersion', 'toVersion'].every(k => text(x[k]))
  && ['timetable', 'stops', 'selection', 'uncomparable'].includes(String(x.kind)) && (x.date === undefined || date(x.date))
  && Array.isArray(x.before) && x.before.every(departure) && Array.isArray(x.after) && x.after.every(departure)
  && (x.kind !== 'timetable' || date(x.date));

/** Validate the saved boundary independently of the current network schedule. Never trust arbitrary cached JSON. */
export function parseCommuteChangeState(raw: unknown): CommuteChangeState | undefined {
  try {
    if (!record(raw) || raw.version !== 1 || !texts(raw.favoriteKeys) || !Array.isArray(raw.notices) || !raw.notices.every(notice)) return undefined;
    const baseline = parseDataset(raw.baseline);
    if (!officialSchedule(baseline)) return undefined;
    return { version: 1, baseline, favoriteKeys: raw.favoriteKeys, notices: raw.notices };
  } catch { return undefined; }
}
interface Persistence { read(): Promise<unknown>; write(state: CommuteChangeState): Promise<void> }
export interface SavedCommuteChanges { state: CommuteChangeState; durable: boolean }
/** Serialize read/compare/dismiss/write in this tab; one cache entry atomically holds the baseline and its notices. */
export function createCommuteChangeStore(persistence: Persistence, exclusive: <T>(job: () => Promise<T>) => Promise<T> = job => job(), currentFavorites?: () => Favorite[] | undefined) {
  let state: CommuteChangeState | undefined, loaded = false, durable = true;
  let tail: Promise<unknown> = Promise.resolve();
  const run = (transform: (previous: CommuteChangeState | undefined) => CommuteChangeState | undefined) => {
    const body = async (): Promise<SavedCommuteChanges | undefined> => {
      if (!loaded || durable) {
        try { state = parseCommuteChangeState(await persistence.read()) ?? state; } catch { durable = false; }
        loaded = true;
      }
      const next = transform(state);
      if (!next) return undefined;
      state = next;
      // A failed page stays session-only. Retrying a whole-state write later could
      // replace another tab's newer baseline or restore a notice it dismissed.
      if (durable) try { await persistence.write(next); } catch { durable = false; }
      return { state: next, durable };
    };
    const job = tail.then(async () => {
      let entered = false;
      try {
        return await exclusive(() => { entered = true; return body(); });
      } catch (error) {
        // Some private/embedded contexts expose Web Locks but refuse acquisition. Keep the in-tab queue.
        if (entered) throw error; // Never replay a body that may already have written.
        return body();
      }
    });
    tail = job.catch(() => undefined);
    return job;
  };
  return {
    advance: (ds: Dataset, favorites: Favorite[], now: number, observeSchedule = true) => run(previous => {
      // Favorites are shared storage, while React's snapshot belongs to one tab.
      // Read the saved selection inside the same lock before pruning notices.
      if (durable && currentFavorites) {
        let confirmed: Favorite[] | undefined;
        try { confirmed = currentFavorites(); } catch { /* Keep this page session-only. */ }
        if (confirmed) favorites = confirmed;
        else durable = false;
      }
      return advanceCommuteChanges(previous, ds, favorites, now, observeSchedule);
    }),
    dismiss: (id: string) => run(previous => previous && ({ ...previous, notices: previous.notices.filter(n => n.id !== id) })),
  };
}
const stores = new Map<string, ReturnType<typeof createCommuteChangeStore>>();
export function commuteChangeStore(api: string, favoriteStorage: Pick<Storage, 'getItem'> | undefined) {
  let store = stores.get(api);
  if (!store) {
    // This is only a Cache API key. It is never fetched, sent to the Worker or shared with another service.
    const key = api + '/v1/local-commute-changes';
    store = createCommuteChangeStore({
      read: async () => (await (await caches.open('dale-commute-changes-v1')).match(key))?.json(),
      write: async state => { await (await caches.open('dale-commute-changes-v1')).put(key, new Response(JSON.stringify(state), { headers: { 'content-type': 'application/json' } })); },
    }, job => navigator.locks ? navigator.locks.request(key, job) : job(), () => {
      let readable = false;
      const favorites = loadFavorites({ getItem: key => {
        if (!favoriteStorage) throw Error('Saved trips unavailable');
        const value = favoriteStorage.getItem(key);
        readable = true;
        return value;
      } });
      return readable ? favorites : undefined;
    });
    stores.set(api, store);
  }
  return store;
}

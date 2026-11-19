// "How sure are we?" aggregates (#91), kept in the collector's own SQLite object. See docs/ARRIVAL_CONFIDENCE.md.
// Folds run inside the history alarm, at most hourly, from the private hot batches, and reserve SQLite writes only
// from the collector's spare daily margin (never the normal collection/archive/prune reservations). Rows are
// aggregate cells only: no vehicle ID, coordinate, trip ID or raw sample is stored or returned here.
import { addToCell, alreadyCounted, cellId, deriveArrivals, emptyRow, rowId, summarize, MIN_CONFIDENCE_SAMPLES,
  type ArrivalEvent, type ConfidenceAnswer, type ConfidenceKey, type ConfidenceRow, type Continuity } from '../src/domain/arrivalConfidence';
import type { VehicleObservation } from '../src/domain/lock';
import { LIVE_SOURCE } from '../src/domain/liveBus';
import type { Dataset } from '../src/domain/types';
import type { HistoryStorage } from './history-journal';

export const CONFIDENCE_SOURCE = `${LIVE_SOURCE}, measured by Dale`;
export const FOLD_MS = 3600_000, CATCH_UP_MS = 300_000, MAX_FOLD_BATCHES = 240, FIRST_CONTEXT_MS = 15 * 60_000;
export const MAX_ROW_BYTES = 1_000_000, MAX_CONFIDENCE_BYTES = 100_000_000, DATABASE_HEADROOM_BYTES = 450_000_000;
/** Reserve units from the collector's spare daily write margin; false = not now. `keep` leaves margin for others. */
export type SpareWrites = (units: number, now: number, keep?: number) => boolean;
export interface FoldCounters { arrivals: number; duplicates: number; refusedRowLimit: number; skipped: Record<string, number> }
interface Meta extends FoldCounters {
  v: 1; reason: 'waiting' | 'ready' | 'write-budget' | 'storage-limit' | 'error';
  checkpoint?: number; continuity: Continuity; folds: number; cells: number; rows: number; bytes: number;
  possibleGaps: number; otherSchedule: number; failures: number; lastFoldAt?: number;
}
const initial = (): Meta => ({ v: 1, reason: 'waiting', continuity: {}, folds: 0, cells: 0, rows: 0, bytes: 0, arrivals: 0, duplicates: 0,
  refusedRowLimit: 0, skipped: {}, possibleGaps: 0, otherSchedule: 0, failures: 0 });
const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

/** Only the normalized stop-call fields of a private batch. Vehicle IDs and coordinates are dropped right here. */
export function batchSamples(body: unknown): VehicleObservation[] {
  const records = (body as { records?: unknown })?.records;
  if (!Array.isArray(records)) return [];
  const out: VehicleObservation[] = [];
  for (const r of records) {
    const o = (r as { observation?: Partial<VehicleObservation> })?.observation;
    if (!o || typeof o.tripInstanceId !== 'string' || o.tripInstanceId.length > 256 || !Number.isSafeInteger(o.observedAt) || o.observedAt! <= 0) continue;
    const call = o.stopCall;
    const stopCall = call && call.status === 'stopped_at' && typeof call.stopId === 'string' && Number.isSafeInteger(call.stopIndex) && call.stopIndex >= 0
      ? { status: 'stopped_at' as const, stopId: call.stopId, stopIndex: call.stopIndex } : undefined;
    out.push({ tripInstanceId: o.tripInstanceId, vehicleId: '', observedAt: o.observedAt!, lat: 0, lon: 0, ...(stopCall ? { stopCall } : {}) });
  }
  return out;
}

export class ArrivalConfidence {
  private nextCheckAt = 0;
  constructor(private readonly storage: HistoryStorage, private readonly ds: Dataset, private readonly contextKey: string) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_arrival_meta (id INTEGER PRIMARY KEY CHECK(id IN (1,2)), body TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_arrival_rows (route TEXT NOT NULL, direction INTEGER NOT NULL, day_type TEXT NOT NULL, hour INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(route,direction,day_type,hour)) WITHOUT ROWID');
  }
  private read(): Meta {
    const row = this.storage.sql.exec('SELECT body FROM dale_arrival_meta WHERE id=1').toArray()[0];
    if (!row) return initial();
    const meta = JSON.parse(String(row.body)) as Meta;
    if (meta.v !== 1 || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0) throw new Error('confidence-state-invalid');
    return meta;
  }
  private write(meta: Meta) {
    this.storage.sql.exec('INSERT INTO dale_arrival_meta(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(meta));
  }
  readExtra(): unknown {
    const row = this.storage.sql.exec('SELECT body FROM dale_arrival_meta WHERE id=2').toArray()[0];
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  writeExtra(value: unknown) {
    this.storage.sql.exec('INSERT INTO dale_arrival_meta(id,body) VALUES(2,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(value));
  }
  private row(key: ConfidenceKey): { row: ConfidenceRow; bytes: number } | undefined {
    const id = rowId(key);
    const found = this.storage.sql.exec('SELECT body FROM dale_arrival_rows WHERE route=? AND direction=? AND day_type=? AND hour=?', id.route, id.direction, id.dayType, id.hour).toArray()[0];
    if (!found) return;
    const text = String(found.body), row = JSON.parse(text) as ConfidenceRow;
    if (row.v !== 1 || typeof row.cells !== 'object' || row.cells === null) throw new Error('confidence-row-invalid');
    return { row, bytes: bytesOf(text) };
  }
  /** The endpoint's answer for one key: one primary-key read, aggregates only. */
  answer(key: ConfidenceKey): ConfidenceAnswer {
    const cells = this.row(key)?.row.cells, id = cellId(key);
    return summarize(cells && Object.hasOwn(cells, id) ? cells[id] : undefined, key, CONFIDENCE_SOURCE);
  }
  /** Dry run: how many events would be new, without any write. */
  countNew(events: readonly ArrivalEvent[]) {
    const cache = new Map<string, ConfidenceRow | undefined>();
    let fresh = 0, counted = 0;
    const seen = new Set<string>();
    for (const e of events) {
      const rk = JSON.stringify(rowId(e.key));
      if (!cache.has(rk)) cache.set(rk, this.row(e.key)?.row);
      const cells = cache.get(rk)?.cells, id = cellId(e.key), mark = JSON.stringify([rk, id, e.serviceDate]);
      if (seen.has(mark) || alreadyCounted(cells && Object.hasOwn(cells, id) ? cells[id] : undefined, e.serviceDate)) counted++;
      else { fresh++; seen.add(mark); }
    }
    return { fresh, counted };
  }
  /**
   * Merge events into their rows. Prepares everything first, reserves `rows + 2 + extraUnits` spare writes, then
   * commits rows, meta and `commit` (the caller's own checkpoint) in one transaction. Returns undefined when the
   * write budget or storage guard refuses, so the caller keeps its checkpoint and retries later.
   */
  apply(events: readonly ArrivalEvent[], now: number, reserve: SpareWrites, options: { keep?: number; extraUnits?: number; update?: (meta: Meta) => void; commit?: (counters: FoldCounters) => void } = {}): FoldCounters | undefined {
    const meta = this.read();
    const counters: FoldCounters = { arrivals: 0, duplicates: 0, refusedRowLimit: 0, skipped: {} };
    const rows = new Map<string, { key: ConfidenceKey; row: ConfidenceRow; before: number; isNew: boolean; added: number; newCells: number }>();
    for (const e of events) {
      const rk = JSON.stringify(rowId(e.key));
      let entry = rows.get(rk);
      if (!entry) {
        const found = this.row(e.key);
        entry = { key: e.key, row: found?.row ?? emptyRow(), before: found?.bytes ?? 0, isNew: !found, added: 0, newCells: 0 };
        rows.set(rk, entry);
      }
      const id = cellId(e.key), old = Object.hasOwn(entry.row.cells, id) ? entry.row.cells[id] : undefined, next = addToCell(old, e);
      if (next === old) { counters.duplicates++; continue; }
      entry.row.cells[id] = next; entry.added++; if (!old) entry.newCells++;
    }
    let delta = 0, cells = 0, newRows = 0;
    const writes: { key: ConfidenceKey; text: string }[] = [];
    for (const entry of rows.values()) {
      if (!entry.added) continue;
      const text = JSON.stringify(entry.row), size = bytesOf(text);
      // A full row keeps its existing cells; its new arrivals are refused and counted, never silently dropped.
      if (size > MAX_ROW_BYTES) { counters.refusedRowLimit += entry.added; continue; }
      writes.push({ key: entry.key, text }); delta += size - entry.before; cells += entry.newCells; counters.arrivals += entry.added;
      if (entry.isNew) newRows++;
    }
    const size = this.storage.sql.databaseSize;
    // Leave the collector's own 500 MB database guard well clear, and keep these aggregates within their own cap.
    if (writes.length && (!Number.isSafeInteger(size) || size >= DATABASE_HEADROOM_BYTES || meta.bytes + delta > MAX_CONFIDENCE_BYTES)) return undefined;
    if (!reserve(writes.length + 2 + (options.extraUnits ?? 0), now, options.keep)) return undefined;
    this.storage.transactionSync(() => {
      for (const w of writes) {
        const id = rowId(w.key);
        this.storage.sql.exec('INSERT INTO dale_arrival_rows(route,direction,day_type,hour,body) VALUES(?,?,?,?,?) ON CONFLICT(route,direction,day_type,hour) DO UPDATE SET body=excluded.body',
          id.route, id.direction, id.dayType, id.hour, w.text);
      }
      const latest = this.read();
      latest.bytes += delta; latest.cells += cells; latest.rows += newRows; latest.arrivals += counters.arrivals;
      latest.duplicates += counters.duplicates; latest.refusedRowLimit += counters.refusedRowLimit;
      options.update?.(latest);
      this.write(latest);
      options.commit?.(counters);
    });
    return counters;
  }
  /** Hourly live fold over the private hot batches. Never throws into collection; failures back off and are counted. */
  fold(now: number, reserve: SpareWrites): void {
    if (now < this.nextCheckAt) return;
    try { this.foldOnce(now, reserve); }
    catch {
      this.nextCheckAt = now + FOLD_MS;
      // Two units: the journal's reservation row and this meta row. With no spare budget the failure goes uncounted.
      try { if (reserve(2, now)) this.storage.transactionSync(() => { const meta = this.read(); meta.failures++; meta.reason = 'error'; this.write(meta); }); } catch { /* counted next time */ }
    }
  }
  private foldOnce(now: number, reserve: SpareWrites) {
    const meta = this.read();
    const oldest = this.storage.sql.exec('SELECT MIN(attempt) AS a FROM dale_history_batches').toArray()[0]?.a;
    if (oldest === null || oldest === undefined) { this.nextCheckAt = now + FOLD_MS; return; }
    let checkpoint = meta.checkpoint, continuity = meta.continuity, missed = 0;
    const firstFold = checkpoint === undefined;
    // First fold: the first 15 retained minutes only seed continuity, so a bus already stopped is not a new arrival.
    if (checkpoint === undefined) checkpoint = Number(oldest) - 1;
    else if (Number(oldest) > checkpoint + 45_000) { missed = 1; continuity = {}; }
    const rows = this.storage.sql.exec('SELECT attempt,context_key,body FROM dale_history_batches WHERE attempt>? ORDER BY attempt LIMIT ?', checkpoint, MAX_FOLD_BATCHES).toArray();
    if (!rows.length) { this.nextCheckAt = now + FOLD_MS; return; }
    const samples: VehicleObservation[] = [], seedOnly: VehicleObservation[] = [];
    let other = 0;
    for (const row of rows) {
      if (String(row.context_key) !== this.contextKey) { other++; continue; }
      const list = batchSamples(JSON.parse(String(row.body)));
      (firstFold && Number(row.attempt) <= Number(oldest) + FIRST_CONTEXT_MS ? seedOnly : samples).push(...list);
    }
    const seeded = seedOnly.length ? deriveArrivals(this.ds, seedOnly, continuity).continuity : continuity;
    const derived = deriveArrivals(this.ds, samples, seeded);
    const last = Number(rows[rows.length - 1]!.attempt), more = rows.length === MAX_FOLD_BATCHES;
    const result = this.apply(derived.events, now, reserve, { update: (m) => {
      m.checkpoint = last; m.continuity = derived.continuity; m.folds++; m.lastFoldAt = now; m.reason = 'ready';
      m.possibleGaps += missed; m.otherSchedule += other;
      for (const [reason, n] of Object.entries(derived.skipped)) m.skipped[reason] = (m.skipped[reason] ?? 0) + n;
    } });
    if (!result) {
      this.nextCheckAt = now + FOLD_MS;
      const size = this.storage.sql.databaseSize;
      const reason = !Number.isSafeInteger(size) || size >= DATABASE_HEADROOM_BYTES || meta.bytes >= MAX_CONFIDENCE_BYTES ? 'storage-limit' : 'write-budget';
      if (meta.reason !== reason && reserve(2, now)) this.storage.transactionSync(() => { const m = this.read(); m.reason = reason; this.write(m); });
      return;
    }
    this.nextCheckAt = now + (more ? CATCH_UP_MS : FOLD_MS);
  }
  /** Health: counts and limits only. */
  status() {
    const { continuity: _private, checkpoint, ...meta } = this.read();
    return { available: true, ...meta, checkpointAt: checkpoint ?? null, minimumSamples: MIN_CONFIDENCE_SAMPLES,
      byteLimit: MAX_CONFIDENCE_BYTES, rowByteLimit: MAX_ROW_BYTES, foldIntervalMs: FOLD_MS };
  }
}

import type { NormalizedFeed } from './normalize';
import { createHistorySelector, type HistoryWatermark } from './history-evidence';
import type { Dataset } from '../src/domain/types';
import { LIVE_MAX_AGE_MS, LIVE_SOURCE } from '../src/domain/liveBus';

interface Cursor { toArray(): Record<string, unknown>[] }
export interface HistorySql { readonly databaseSize: number; exec(query: string, ...bindings: (string | number | null)[]): Cursor }
export interface HistoryStorage { sql: HistorySql; transactionSync<T>(callback: () => T): T }
export const HISTORY_INTERVAL_MS = 30_000;
const MAX_BATCH_BYTES = 128_000, MAX_JOURNAL_BYTES = 250_000_000, MAX_DATABASE_BYTES = 500_000_000;
// Conservative per-attempt reservation covers journal insert/metadata,
// existing relay cache writes, authentication rollover and one alarm reschedule.
const WRITE_RESERVATION = 12, DAILY_WRITE_BUDGET = 75_000;
export const HISTORY_HOT_MS = 6 * 3600_000;
export interface ArchiveReceipt { key: string; manifestKey: string; rawSHA256: string; gzipSHA256: string; rawBytes: number; gzipBytes: number; contextManifestKey?: string }
export async function historyContextKey(ds: Dataset) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ds)));
  return ds.meta.feedVersion + ':' + [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
type Reason = 'disabled' | 'starting' | 'collecting' | 'feed-gap' | 'quota-paused' | 'payload-limit' | 'storage-limit' | 'schedule-context-unavailable';
interface JournalState {
  v: 1; enabled: boolean; reason: Reason; startedAt?: number; lastAttemptAt?: number; completedAttempt?: number;
  lastSuccessAt?: number; lastObservationAt?: number; gapSince?: number;
  observations: number; batches: number; bytes: number; duplicates: number; rejected: number; conflicts: number; outOfOrder: number;
  budgetDay: string; reservedWrites: number; watermarks: Record<string, HistoryWatermark>;
}
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const initial = (now: number): JournalState => ({ v: 1, enabled: false, reason: 'disabled', observations: 0, batches: 0, bytes: 0,
  duplicates: 0, rejected: 0, conflicts: 0, outOfOrder: 0, budgetDay: day(now), reservedWrites: 0, watermarks: {} });

/** Private normalized bundles use SQLite rows, not public files or a rider trace.
 * One row per poll avoids a per-bus index/write multiplier on the Free plan.
 * The journal and dedupe checkpoint commit in the same synchronous transaction. */
export class HistoryJournal {
  private readonly select;
  private readonly feedVersion: string;
  constructor(private readonly storage: HistoryStorage, private readonly ds: Dataset, private readonly contextKey: string) {
    this.select = createHistorySelector(ds);
    this.feedVersion = ds.meta.feedVersion;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_history_meta (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_history_batches (attempt INTEGER PRIMARY KEY, received_at INTEGER NOT NULL, feed_version TEXT NOT NULL, context_key TEXT, bytes INTEGER NOT NULL, body TEXT NOT NULL, archive_receipt TEXT)');
    if (!storage.sql.exec('PRAGMA table_info(dale_history_batches)').toArray().some(row => row.name === 'archive_receipt'))
      storage.sql.exec('ALTER TABLE dale_history_batches ADD COLUMN archive_receipt TEXT');
    if (!storage.sql.exec('PRAGMA table_info(dale_history_batches)').toArray().some(row => row.name === 'context_key'))
      storage.sql.exec('ALTER TABLE dale_history_batches ADD COLUMN context_key TEXT');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS dale_history_pending ON dale_history_batches(attempt) WHERE archive_receipt IS NULL');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS dale_history_archived ON dale_history_batches(attempt) WHERE archive_receipt IS NOT NULL');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_history_schedules (feed_version TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(feed_version,part)) WITHOUT ROWID');
    storage.sql.exec("CREATE INDEX IF NOT EXISTS dale_history_cold_contexts ON dale_history_schedules(feed_version) WHERE part=-1 AND json_extract(body,'$.archiveReceipt.manifestKey') IS NOT NULL AND json_extract(body,'$.localRemoved') IS NULL");
  }
  private read(now: number): JournalState {
    const row = this.storage.sql.exec('SELECT body FROM dale_history_meta WHERE id=1').toArray()[0];
    if (!row) return initial(now);
    const state = JSON.parse(String(row.body)) as JournalState;
    if (state.v !== 1 || typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.bytes) || state.bytes < 0
      || !Number.isSafeInteger(state.reservedWrites) || state.reservedWrites < 0) throw new Error('history-state-invalid');
    return state;
  }
  private write(state: JournalState) {
    this.storage.sql.exec('INSERT INTO dale_history_meta(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(state));
  }
  private databaseFull() {
    const size = this.storage.sql.databaseSize;
    return !Number.isSafeInteger(size) || size < 0 || size >= MAX_DATABASE_BYTES;
  }
  private contextStored() {
    return this.storage.sql.exec('SELECT part FROM dale_history_schedules WHERE feed_version=? AND part=-1', this.contextKey).toArray().length === 1;
  }
  private ensureContext(state: JournalState, now: number) {
    if (this.contextStored()) return false;
    const body = JSON.stringify(this.ds), bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > 16_000_000 || state.bytes + bytes > MAX_JOURNAL_BYTES || this.databaseFull()) throw new Error('history-schedule-capacity');
    const parts: string[] = [];
    for (let start = 0; start < body.length;) {
      let end = Math.min(start + 32_000, body.length);
      // Never split a Unicode surrogate pair across SQL strings.
      const last = body.charCodeAt(end - 1);
      if (end < body.length && last >= 0xD800 && last <= 0xDBFF) end--;
      parts.push(body.slice(start, end)); start = end;
    }
    if (state.budgetDay !== day(now)) { state.budgetDay = day(now); state.reservedWrites = 0; }
    const reservation = 2 * parts.length + 4;
    if (state.reservedWrites + reservation > DAILY_WRITE_BUDGET) throw new Error('history-schedule-budget');
    for (const [part, text] of parts.entries()) this.storage.sql.exec('INSERT INTO dale_history_schedules(feed_version,part,body) VALUES(?,?,?)', this.contextKey, part, text);
    this.storage.sql.exec('INSERT INTO dale_history_schedules(feed_version,part,body) VALUES(?,-1,?)', this.contextKey,
      JSON.stringify({ v: 1, parts: parts.length, bytes, encoding: 'utf8-json' }));
    state.bytes += bytes; state.reservedWrites += reservation;
    return true;
  }
  setEnabled(enabled: boolean, now: number) {
    this.storage.transactionSync(() => {
      const state = this.read(now);
      // Preserve complete trip/stop/calendar context before the first observation
      // under each static version, including after an enabled redeployment.
      const addedContext = enabled && this.ensureContext(state, now);
      if (state.enabled === enabled && !addedContext) return;
      state.enabled = enabled; state.reason = enabled ? 'starting' : 'disabled';
      if (enabled) { state.startedAt ??= now; state.gapSince ??= now; }
      this.write(state);
    });
  }
  beginAttempt(now: number): number | undefined {
    return this.storage.transactionSync(() => {
      const state = this.read(now);
      if (!state.enabled || (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < HISTORY_INTERVAL_MS)) return;
      if (!this.contextStored()) {
        if (state.reason !== 'schedule-context-unavailable') { state.reason = 'schedule-context-unavailable'; state.gapSince ??= now; this.write(state); }
        return;
      }
      if (this.databaseFull()) {
        if (state.reason !== 'storage-limit') { state.reason = 'storage-limit'; state.gapSince ??= now; this.write(state); }
        return;
      }
      if (day(now) !== state.budgetDay) { state.budgetDay = day(now); state.reservedWrites = 0; }
      if (state.reservedWrites + WRITE_RESERVATION > DAILY_WRITE_BUDGET) {
        if (state.reason !== 'quota-paused') { state.reason = 'quota-paused'; state.gapSince ??= now; this.write(state); }
        return;
      }
      if (state.lastAttemptAt !== undefined && state.completedAttempt !== state.lastAttemptAt) state.gapSince ??= state.lastAttemptAt;
      state.lastAttemptAt = now; state.reservedWrites += WRITE_RESERVATION;
      this.write(state); return now;
    });
  }
  complete(attempt: number, feed: NormalizedFeed, receivedAt: number, updates?: NormalizedFeed): void {
    this.storage.transactionSync(() => {
      const state = this.read(receivedAt);
      if (!state.enabled || state.lastAttemptAt !== attempt || state.completedAttempt === attempt) return;
      const selected = this.select(feed, receivedAt, state.watermarks);
      state.completedAttempt = attempt;
      state.duplicates += selected.duplicates; state.rejected += selected.rejected;
      state.conflicts += selected.conflicts; state.outOfOrder += selected.outOfOrder;
      const diagnostics = Object.fromEntries(Object.entries(feed.diagnostics ?? {}).filter(([key, value]) =>
        ['entities', 'knownTrips', 'corridorRoutes', 'missingServiceDates', 'missingObservationTimes'].includes(key)
        && Number.isSafeInteger(value) && value >= 0));
      const quality = { source: LIVE_SOURCE, feedState: feed.feed.state, generatedAt: feed.feed.timestamp, diagnostics,
        censusAvailable: feed.presence !== undefined,
        updateFeedState: updates?.feed.state ?? 'unavailable', updateGeneratedAt: updates?.feed.timestamp,
        duplicates: selected.duplicates, rejected: selected.rejected, conflicts: selected.conflicts, outOfOrder: selected.outOfOrder };
      // Preserve known cancellations/skips and their source clock as context,
      // separately from GPS evidence. Do not archive predicted arrival times.
      const tripChanges = updates?.feed.state === 'ok' && updates.feed.timestamp !== undefined
        && updates.feed.timestamp <= receivedAt && receivedAt - updates.feed.timestamp <= LIVE_MAX_AGE_MS
        ? updates.updates.filter(u => u.observedAt <= receivedAt && receivedAt - u.observedAt <= LIVE_MAX_AGE_MS)
          .map(u => ({ tripInstanceId: u.tripInstanceId, observedAt: u.observedAt, cancelled: u.cancelled, skippedStops: [...u.skippedStops] })) : [];
      let records = selected.records;
      const census = (feed.presence ?? []).map(p => ({ vehicleId: p.vehicleId, tripId: p.tripId, tripInstanceId: p.tripInstanceId, routeId: p.routeId,
        observedAt: p.observedAt, qualification: p.qualification }));
      state.reason = selected.feedUsable ? 'collecting' : 'feed-gap';
      let body = JSON.stringify({ v: 1, feedVersion: this.feedVersion, contextKey: this.contextKey, receivedAt, quality, census, tripChanges, records });
      if (new TextEncoder().encode(body).byteLength > MAX_BATCH_BYTES
        || new TextEncoder().encode(JSON.stringify(selected.watermarks)).byteLength > 256_000) {
        state.reason = 'payload-limit'; records = [];
        body = JSON.stringify({ v: 1, feedVersion: this.feedVersion, contextKey: this.contextKey, receivedAt, quality, omissionReason: 'payload-limit', records });
      }
      const bytes = new TextEncoder().encode(body).byteLength;
      if (this.databaseFull() || state.bytes + bytes > MAX_JOURNAL_BYTES) state.reason = 'storage-limit';
      else {
        // Empty/error polls retain quality evidence too, so a recovered feed does
        // not erase prior missing-date, stale-feed or rejected-report intervals.
        this.storage.sql.exec('INSERT INTO dale_history_batches(attempt,received_at,feed_version,context_key,bytes,body) VALUES(?,?,?,?,?,?)',
          attempt, receivedAt, this.feedVersion, this.contextKey, bytes, body);
        state.bytes += bytes; state.batches++; state.observations += records.length;
        if (records.length) state.lastObservationAt = Math.max(...records.map(r => r.observation.observedAt));
      }
      if (state.reason === 'collecting') {
        state.watermarks = selected.watermarks;
        state.lastSuccessAt = receivedAt; delete state.gapSince;
      }
      if (state.reason !== 'collecting') state.gapSince ??= receivedAt;
      this.write(state);
    });
  }
  reserveStorageWrites(units: number, now: number): boolean {
    return this.storage.transactionSync(() => {
      const state = this.read(now);
      if (!state.enabled || !Number.isSafeInteger(units) || units < 1) return false;
      if (state.budgetDay !== day(now)) { state.budgetDay = day(now); state.reservedWrites = 0; }
      if (state.reservedWrites + units > DAILY_WRITE_BUDGET) return false;
      state.reservedWrites += units; this.write(state); return true;
    });
  }
  canCatchUpArchive(now: number) {
    const state = this.read(now), used = state.budgetDay === day(now) ? state.reservedWrites : 0;
    const untilMidnight = Date.parse(day(now) + 'T00:00:00Z') + 86400_000 - now;
    // Keep the rest of today's normal collection/archive/prune reservations
    // ahead of optional backlog catch-up work.
    return DAILY_WRITE_BUDGET - used >= Math.ceil(untilMidnight / HISTORY_INTERVAL_MS) * 24 + 16;
  }
  storageWritesRemaining(now: number) {
    const state = this.read(now);
    return DAILY_WRITE_BUDGET - (state.budgetDay === day(now) ? state.reservedWrites : 0);
  }
  nextUnarchived(): { attempt: number; feedVersion: string; contextKey: string; body: string } | undefined {
    const row = this.storage.sql.exec('SELECT attempt,feed_version,context_key,body FROM dale_history_batches WHERE archive_receipt IS NULL ORDER BY attempt LIMIT 1').toArray()[0];
    return row ? { attempt: Number(row.attempt), feedVersion: String(row.feed_version), contextKey: String(row.context_key ?? row.feed_version), body: String(row.body) } : undefined;
  }
  oldestUnarchivedAt(): number | null {
    const row = this.storage.sql.exec('SELECT attempt FROM dale_history_batches WHERE archive_receipt IS NULL ORDER BY attempt LIMIT 1').toArray()[0];
    return row ? Number(row.attempt) : null;
  }
  scheduleContext(version: string): { body?: string; receipt?: ArchiveReceipt } {
    const rows = this.storage.sql.exec('SELECT part,body FROM dale_history_schedules WHERE feed_version=? ORDER BY part', version).toArray();
    const manifest = rows.find(row => row.part === -1);
    if (!manifest) throw new Error('history-context-missing');
    const meta = JSON.parse(String(manifest.body));
    if (meta.archiveReceipt) return { receipt: meta.archiveReceipt as ArchiveReceipt };
    const parts = rows.filter(row => Number(row.part) >= 0);
    if (parts.length !== meta.parts || parts.some((row, index) => row.part !== index)) throw new Error('history-context-incomplete');
    const body = parts.map(row => String(row.body)).join('');
    if (new TextEncoder().encode(body).byteLength !== meta.bytes) throw new Error('history-context-size');
    return { body };
  }
  acknowledgeSchedule(version: string, receipt: ArchiveReceipt, onAcknowledged: () => void) {
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT body FROM dale_history_schedules WHERE feed_version=? AND part=-1', version).toArray()[0];
      if (!row) throw new Error('history-context-missing');
      const meta = JSON.parse(String(row.body));
      if (!meta.archiveReceipt) {
        meta.archiveReceipt = receipt;
        this.storage.sql.exec('UPDATE dale_history_schedules SET body=? WHERE feed_version=? AND part=-1', JSON.stringify(meta), version);
        onAcknowledged();
      }
    });
  }
  acknowledgeBatch(attempt: number, receipt: ArchiveReceipt, onAcknowledged: () => void) {
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT archive_receipt FROM dale_history_batches WHERE attempt=?', attempt).toArray()[0];
      if (!row) throw new Error('history-batch-missing');
      if (!row.archive_receipt) {
        this.storage.sql.exec('UPDATE dale_history_batches SET archive_receipt=? WHERE attempt=?', JSON.stringify(receipt), attempt);
        onAcknowledged();
      }
    });
  }
  pruneVerified(now: number) {
    this.storage.transactionSync(() => {
      const state = this.read(now);
      let changed = false;
      const row = this.storage.sql.exec('SELECT attempt,bytes,feed_version,context_key,archive_receipt FROM dale_history_batches WHERE attempt<=? AND archive_receipt IS NOT NULL ORDER BY attempt LIMIT 1', now - HISTORY_HOT_MS).toArray()[0];
      if (!state.enabled) return;
      if (state.budgetDay !== day(now)) { state.budgetDay = day(now); state.reservedWrites = 0; }
      if (row && state.reservedWrites + 4 <= DAILY_WRITE_BUDGET) {
        const receipt = JSON.parse(String(row.archive_receipt)) as ArchiveReceipt;
        const context = this.scheduleContext(String(row.context_key ?? row.feed_version)).receipt;
        if (context && receipt.contextManifestKey === context.manifestKey && /^[a-f0-9]{64}$/.test(receipt.rawSHA256)) {
          this.storage.sql.exec('DELETE FROM dale_history_batches WHERE attempt=?', Number(row.attempt));
          state.bytes -= Number(row.bytes); state.batches--; state.reservedWrites += 4;
          changed = true;
        }
      }
      const oldContext = this.storage.sql.exec("SELECT feed_version,body FROM dale_history_schedules WHERE part=-1 AND feed_version!=? AND json_extract(body,'$.archiveReceipt.manifestKey') IS NOT NULL AND json_extract(body,'$.localRemoved') IS NULL LIMIT 1", this.contextKey).toArray()[0];
      if (oldContext) {
        const meta = JSON.parse(String(oldContext.body)), reservation = 2 * Number(meta.parts) + 4;
        if (Number.isSafeInteger(reservation) && reservation > 0 && state.reservedWrites + reservation <= DAILY_WRITE_BUDGET) {
          // Complete original context remains in its verified immutable archive.
          this.storage.sql.exec('DELETE FROM dale_history_schedules WHERE feed_version=? AND part>=0', String(oldContext.feed_version));
          meta.localRemoved = true;
          this.storage.sql.exec('UPDATE dale_history_schedules SET body=? WHERE feed_version=? AND part=-1', JSON.stringify(meta), String(oldContext.feed_version));
          state.bytes -= Number(meta.bytes); state.reservedWrites += reservation;
          changed = true;
        }
      }
      if (changed) this.write(state);
    });
  }
  status(now: number) {
    const { watermarks: _privateCheckpoint, ...state } = this.read(now);
    const oldest = this.storage.sql.exec('SELECT attempt FROM dale_history_batches ORDER BY attempt LIMIT 1').toArray()[0];
    return { ...state, retention: 'indefinite-archive-before-hot-prune', hotHours: 6, scheduleVersion: this.feedVersion, scheduleContextStored: this.contextStored(),
      oldestRetainedAt: oldest ? Number(oldest.attempt) : null,
      incompleteAttempt: state.lastAttemptAt !== state.completedAttempt,
      stale: state.enabled && now - (state.lastSuccessAt ?? state.startedAt ?? now) > 120_000,
      byteLimit: MAX_JOURNAL_BYTES, databaseBytes: this.storage.sql.databaseSize, databaseByteLimit: MAX_DATABASE_BYTES,
      dailyWriteReservationLimit: DAILY_WRITE_BUDGET,
      nextAttemptAt: !state.enabled ? null : state.reason === 'quota-paused' && state.budgetDay === day(now)
        ? Date.parse(day(now) + 'T00:00:00Z') + 86400_000 : ['storage-limit', 'schedule-context-unavailable'].includes(state.reason)
          ? now + 3600_000 : Math.max(now, (state.lastAttemptAt ?? 0) + HISTORY_INTERVAL_MS) };
  }
}

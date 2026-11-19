// One-time replay of the private R2 archive (#91, collected since November 8, 2026) through the same arrival
// derivation as the live fold. Written, not run: it does nothing unless an operator sets the plain-text Worker
// setting ARRIVAL_BACKFILL to "dry-run:<deadline ms>" or "apply:<deadline ms>" (at most 48 hours ahead). See
// docs/ARRIVAL_CONFIDENCE.md. Each step runs inside the history alarm: one list call and at most 120 object reads,
// with R2 operations reserved in the archive's own ledger and SQLite writes from the spare daily margin only.
// Replays are idempotent: every cell counts a service date once. Health shows counts only, never keys or samples.
import { deriveArrivals, type ArrivalEvent, type Continuity } from '../src/domain/arrivalConfidence';
import { parseDataset } from '../src/domain/dataset';
import type { VehicleObservation } from '../src/domain/lock';
import type { Dataset } from '../src/domain/types';
import { ArrivalConfidence, batchSamples, type SpareWrites } from './arrival-confidence';
import { A_LIMIT, B_LIMIT } from './history-archive';
import type { HistoryStorage } from './history-journal';

export interface ArchiveReader {
  list(options: { prefix: string; limit: number; startAfter?: string }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean }>;
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
export const BACKFILL_FIRST_DAY = '2026-11-08', BACKFILL_STEP_OBJECTS = 120, BACKFILL_STEP_MS = 5_000, MAX_LEASE_MS = 48 * 3600_000;
/** Spare SQLite write units the backfill always leaves for live folds, archive catch-up and a schedule rollover. */
export const BACKFILL_KEEP_WRITES = 2500;
const BATCH_KEY = /^v1\/(\d{4}-\d{2}-\d{2})\/batches\/\d{13}-([a-f0-9]{64})\.json\.gz$/;
const MAX_BATCH_RAW = 256_000, MAX_CONTEXT_RAW = 16_000_000, DAY = 86400_000;
type Mode = 'dry-run' | 'apply';
interface Counters {
  steps: number; listCalls: number; objectsRead: number; batchesReplayed: number; checksumFailures: number; unreadable: number;
  contextsRead: number; contextUnavailable: number; samples: number; arrivalsDerived: number; newArrivals: number; alreadyCounted: number;
  skipped: Record<string, number>;
}
interface BackfillState extends Counters {
  v: 1; lease: string; mode: Mode; deadline: number; state: 'running' | 'done' | 'expired'; day: string;
  startAfter?: string; continuity: Continuity; startedAt: number; lastStepAt?: number; finishedAt?: number;
}
export function parseBackfillLease(value: unknown): { mode: Mode; deadline: number } | undefined {
  const m = typeof value === 'string' ? /^(dry-run|apply):([0-9]{13})$/.exec(value) : null;
  return m ? { mode: m[1] as Mode, deadline: Number(m[2]) } : undefined;
}
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
const sha = async (bytes: Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest('SHA-256', bytes));
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextDay = (day: string) => utcDay(Date.parse(day + 'T00:00:00Z') + DAY);
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('backfill-timeout')), 5_000); })]); }
  finally { clearTimeout(timer!); }
}
async function gunzip(compressed: ArrayBuffer, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await deadline(reader.read()); if (part.done) break;
      total += part.value.byteLength; if (total > limit) throw new Error('backfill-expanded-size');
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(total); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export class ArrivalBackfill {
  private pending?: Promise<void>;
  private nextStepAt = 0;
  private contexts = new Map<string, Dataset | null>();
  /** At most two archived schedules are read per step, matching the two reserved read operations. */
  private contextFetches = 0;
  constructor(private readonly storage: HistoryStorage, private readonly confidence: ArrivalConfidence, private readonly bucket: ArchiveReader,
    private readonly ds: Dataset, private readonly contextKey: string, private readonly setting: string | undefined, private readonly timer: () => number = Date.now) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_archive_days (day TEXT PRIMARY KEY, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL) WITHOUT ROWID');
  }
  private read(): BackfillState | undefined {
    const value = this.confidence.readExtra() as BackfillState | undefined;
    if (value !== undefined && (value.v !== 1 || typeof value.lease !== 'string')) throw new Error('backfill-state-invalid');
    return value;
  }
  /** Shared R2 ledger: the same 34-day buckets as the archive. The backfill may use at most half of each free cap. */
  private reserveOperations(a: number, b: number, now: number): boolean {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT COALESCE(SUM(class_a),0) AS a,COALESCE(SUM(class_b),0) AS b FROM dale_archive_days WHERE day>=?', utcDay(now - 33 * DAY)).toArray()[0]!;
      if (Number(row.a) + a > A_LIMIT / 2 || Number(row.b) + b > B_LIMIT / 2) return false;
      this.storage.sql.exec('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET class_a=class_a+excluded.class_a,class_b=class_b+excluded.class_b', utcDay(now), a, b);
      return true;
    });
  }
  async step(now: number, reserve: SpareWrites): Promise<void> {
    if (this.pending || now < this.nextStepAt) return;
    this.pending = this.run(now, reserve).catch(() => { this.nextStepAt = now + 3600_000; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private save(state: BackfillState) { this.storage.transactionSync(() => this.confidence.writeExtra(state)); }
  private async run(now: number, reserve: SpareWrites) {
    const lease = parseBackfillLease(this.setting);
    if (!lease) return;
    let state = this.read();
    if (!state || state.lease !== this.setting) {
      // A lease starts once, only before its deadline; the same lease can never restart after it finishes or expires.
      if (lease.deadline <= now || lease.deadline - now > MAX_LEASE_MS) return;
      state = { v: 1, lease: this.setting!, mode: lease.mode, deadline: lease.deadline, state: 'running', day: BACKFILL_FIRST_DAY, continuity: {}, startedAt: now,
        steps: 0, listCalls: 0, objectsRead: 0, batchesReplayed: 0, checksumFailures: 0, unreadable: 0, contextsRead: 0, contextUnavailable: 0,
        samples: 0, arrivalsDerived: 0, newArrivals: 0, alreadyCounted: 0, skipped: {} };
    }
    if (state.state !== 'running') return;
    this.contextFetches = 0;
    // Two units: the R2 ledger row and this state row. Live folds and a rollover keep their margin.
    if (!reserve(2, now, BACKFILL_KEEP_WRITES)) { this.nextStepAt = now + 3600_000; return; }
    if (now >= state.deadline) { state.state = 'expired'; state.finishedAt = now; this.save(state); return; }
    if (state.day > utcDay(now)) { state.state = 'done'; state.finishedAt = now; this.save(state); return; }
    if (!this.reserveOperations(1, BACKFILL_STEP_OBJECTS + 2, now)) { this.nextStepAt = now + 3600_000; this.save(state); return; }
    const next: BackfillState = structuredClone(state);
    next.steps++; next.listCalls++; next.lastStepAt = now;
    const prefix = `v1/${state.day}/batches/`;
    const listing = await deadline(this.bucket.list({ prefix, limit: 2 * BACKFILL_STEP_OBJECTS + 2, ...(state.startAfter ? { startAfter: state.startAfter } : {}) }));
    const listed = listing.objects.map((o) => o.key).filter((k) => typeof k === 'string' && k.startsWith(prefix));
    const keys = listed.filter((k) => BATCH_KEY.exec(k)?.[1] === state.day).slice(0, BACKFILL_STEP_OBJECTS);
    if (!keys.length) {
      if (listing.truncated && listed.length) next.startAfter = listed[listed.length - 1];
      else { next.day = nextDay(state.day); delete next.startAfter; if (next.day > utcDay(now)) { next.state = 'done'; next.finishedAt = now; } }
      this.save(next); return;
    }
    const started = this.timer(), batches: { key: string; contextKey: string; samples: VehicleObservation[] }[] = [];
    for (const key of keys) {
      if (this.timer() - started > BACKFILL_STEP_MS) break;
      next.startAfter = key; next.objectsRead++;
      const object = await deadline(this.bucket.get(key));
      if (!object || object.size > 4 * MAX_BATCH_RAW) { next.unreadable++; continue; }
      let raw: Uint8Array<ArrayBuffer>;
      try { raw = await gunzip(await deadline(object.arrayBuffer()), MAX_BATCH_RAW); } catch { next.unreadable++; continue; }
      // The archive key carries the raw SHA-256: an altered or truncated object is refused, never replayed.
      if (await sha(raw) !== BATCH_KEY.exec(key)![2]) { next.checksumFailures++; continue; }
      let body: { contextKey?: unknown; feedVersion?: unknown };
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { next.unreadable++; continue; }
      if (typeof body.contextKey !== 'string' || typeof body.feedVersion !== 'string') { next.unreadable++; continue; }
      batches.push({ key, contextKey: body.contextKey, samples: batchSamples(body) });
    }
    const events: ArrivalEvent[] = [];
    let continuity = state.continuity;
    for (const [i, batch] of batches.entries()) {
      const ds = await this.context(batch.contextKey, next);
      // A third archived schedule in one step waits for the next step: resume just before this batch.
      if (ds === undefined) { next.startAfter = i ? batches[i - 1]!.key : state.startAfter; if (!next.startAfter) delete next.startAfter; break; }
      if (!ds) { next.contextUnavailable++; continue; }
      next.batchesReplayed++; next.samples += batch.samples.length;
      const derived = deriveArrivals(ds, batch.samples, continuity);
      continuity = derived.continuity; events.push(...derived.events);
      for (const [reason, n] of Object.entries(derived.skipped)) next.skipped[reason] = (next.skipped[reason] ?? 0) + n;
    }
    next.continuity = continuity; next.arrivalsDerived += events.length;
    if (next.mode === 'dry-run') {
      const { fresh, counted } = this.confidence.countNew(events);
      next.newArrivals += fresh; next.alreadyCounted += counted;
      this.save(next); return;
    }
    // Rows, aggregate meta and this cursor commit in one transaction, so a crash can only repeat a step, and a
    // repeated step adds nothing because each cell already counted those service dates.
    const applied = this.confidence.apply(events, now, reserve, { keep: BACKFILL_KEEP_WRITES, commit: (counters) => {
      next.newArrivals += counters.arrivals; next.alreadyCounted += counters.duplicates; this.confidence.writeExtra(next);
    } });
    if (!applied) { this.nextStepAt = now + 3600_000; this.save(state); }
  }
  /** The schedule a batch was recorded under, from its immutable archived context, checksum-verified. */
  /** undefined means "not this step" (fetch limit reached); null means the archived schedule is missing or invalid. */
  private async context(contextKey: string, state: BackfillState): Promise<Dataset | null | undefined> {
    if (contextKey === this.contextKey) return this.ds;
    if (this.contexts.has(contextKey)) return this.contexts.get(contextKey)!;
    const split = contextKey.lastIndexOf(':'), version = contextKey.slice(0, split), hash = contextKey.slice(split + 1);
    if (this.contextFetches >= 2) return undefined;
    let ds: Dataset | null = null;
    if (split > 0 && /^[a-f0-9]{64}$/.test(hash)) {
      this.contextFetches++;
      try {
        const versionHash = (await sha(new TextEncoder().encode(version))).slice(0, 24);
        state.contextsRead++;
        const object = await deadline(this.bucket.get(`v1/schedules/${versionHash}/${hash}.json.gz`));
        if (object && object.size <= MAX_CONTEXT_RAW) {
          const raw = await gunzip(await deadline(object.arrayBuffer()), MAX_CONTEXT_RAW);
          if (await sha(raw) === hash) {
            const parsed = parseDataset(JSON.parse(new TextDecoder().decode(raw)));
            if (parsed.meta.feedVersion === version) ds = parsed;
          }
        }
      } catch { ds = null; }
    }
    if (this.contexts.size >= 2) this.contexts.clear();
    this.contexts.set(contextKey, ds);
    return ds;
  }
  /** Health: mode, progress day and counts only. No object keys, cursor, trips or samples. */
  status() {
    const state = this.read();
    if (!state) return { configured: parseBackfillLease(this.setting) !== undefined, state: 'not-started' };
    const { continuity: _c, startAfter: _s, lease: _l, ...counts } = state;
    return { configured: parseBackfillLease(this.setting) !== undefined, ...counts };
  }
}

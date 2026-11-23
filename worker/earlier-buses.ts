import { createEarlierDomain, type EarlierQuery, type EarlierState } from '../src/domain/earlierBuses';
import { localYmd } from '../src/domain/time';
import type { Dataset } from '../src/domain/types';
import type { HistoryStorage } from './history-journal';
import type { SpareWrites } from './arrival-confidence';

export const EARLIER_MAX_BYTES = 1_000_000, EARLIER_MAX_TRIPS = 2000, EARLIER_BATCHES = 24;
const INTERVAL = 300_000;
/** Private daily projection of journal evidence. Reads never fetch, fold, write or access R2. */
export class EarlierBuses {
  private nextAt = 0;
  private lastDay = '';
  private domain;
  constructor(private storage: HistoryStorage, private ds: Dataset, private context: string) {
    this.domain = createEarlierDomain(ds);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_earlier_buses (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
  }
  private read(): EarlierState | undefined {
    const body = this.storage.sql.exec('SELECT body FROM dale_earlier_buses WHERE id=1').toArray()[0]?.body;
    if (!body) return;
    const state = JSON.parse(String(body)) as EarlierState;
    if (state.v !== 1 || state.context !== this.context) return;
    return state;
  }
  answer(query: EarlierQuery, now: number) {
    const state = this.read();
    return state && localYmd(state.through, this.ds.meta.timezone) === localYmd(now, this.ds.meta.timezone)
      ? this.domain.answer(state, query, now) : undefined;
  }
  fold(now: number, reserve: SpareWrites) {
    const today = localYmd(now, this.ds.meta.timezone);
    if (now < this.nextAt && today === this.lastDay) return;
    this.lastDay = today;
    // A new day bypasses yesterday's throttle; retry on collection ticks until today's first commit.
    this.nextAt = now + 30_000;
    try {
      const state = this.read();
      if (state && localYmd(state.through, this.ds.meta.timezone) === today) this.nextAt = now + INTERVAL;
      const oldest = this.storage.sql.exec('SELECT MIN(attempt) AS a FROM dale_history_batches WHERE context_key=?', this.context).toArray()[0]?.a;
      if (oldest === null || oldest === undefined) return;
      const next: EarlierState = state ?? { v: 1, context: this.context, checkpoint: Number(oldest) - 1,
        coverageStart: Number(oldest), through: Number(oldest), gap: false, trips: {} };
      const rows = this.storage.sql.exec('SELECT attempt,context_key,body FROM dale_history_batches WHERE attempt>? ORDER BY attempt LIMIT ?', next.checkpoint, EARLIER_BATCHES).toArray();
      if (!rows.length) return;
      const previousTrips = structuredClone(next.trips);
      for (const row of rows) {
        const attempt = Number(row.attempt);
        if (attempt > now) return;
        // Reset only as the checkpoint enters a new Eastern day, including during paged replay.
        // Keep trip evidence: yesterday's service can run past midnight today.
        if (localYmd(attempt, this.ds.meta.timezone) > localYmd(next.through, this.ds.meta.timezone)) {
          next.coverageStart = attempt;
          next.gap = false;
        } else if (attempt > next.checkpoint + 45_000) next.gap = true;
        const batch = JSON.parse(String(row.body));
        if (batch.omissionReason || (batch.quality && batch.quality.feedState !== 'ok')) next.gap = true;
        if (String(row.context_key) === this.context) this.domain.fold(next, batch, now);
        else next.gap = true;
        next.checkpoint = attempt; next.through = attempt;
      }
      let body = JSON.stringify(next);
      if (new TextEncoder().encode(body).byteLength > EARLIER_MAX_BYTES || Object.keys(next.trips).length > EARLIER_MAX_TRIPS) {
        // Omit this page's derived evidence explicitly, preserving the prior bounded evidence.
        // The checkpoint must pass the page so later polls can still be folded.
        next.trips = this.domain.prune(previousTrips, next.through); next.gap = true;
        body = JSON.stringify(next);
      }
      const size = this.storage.sql.databaseSize;
      if (new TextEncoder().encode(body).byteLength > EARLIER_MAX_BYTES || Object.keys(next.trips).length > EARLIER_MAX_TRIPS
        || !Number.isSafeInteger(size) || size < 0 || size >= 450_000_000 || !reserve(2, now)) return;
      this.storage.transactionSync(() => this.storage.sql.exec('INSERT INTO dale_earlier_buses(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', body));
      // At most one bounded fold per existing 30-second alarm while catching up.
      this.nextAt = now + (rows.length === EARLIER_BATCHES || localYmd(next.through, this.ds.meta.timezone) !== today ? 30_000 : INTERVAL);
    } catch { /* Independent projection failures cannot stop original collection or advance its own checkpoint. */ }
  }
}

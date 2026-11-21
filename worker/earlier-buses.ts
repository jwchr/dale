import { createEarlierDomain, type EarlierQuery, type EarlierState } from '../src/domain/earlierBuses';
import type { Dataset } from '../src/domain/types';
import type { HistoryStorage } from './history-journal';
import type { SpareWrites } from './arrival-confidence';

export const EARLIER_MAX_BYTES = 1_000_000, EARLIER_MAX_TRIPS = 2000, EARLIER_BATCHES = 24;
const INTERVAL = 300_000;
/** Private daily projection of journal evidence. Reads never fetch, fold, write or access R2. */
export class EarlierBuses {
  private nextAt = 0;
  private domain;
  constructor(private storage: HistoryStorage, ds: Dataset, private context: string) {
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
    return state ? this.domain.answer(state, query, now) : undefined;
  }
  fold(now: number, reserve: SpareWrites) {
    if (now < this.nextAt) return;
    this.nextAt = now + INTERVAL;
    try {
      const state = this.read();
      const oldest = this.storage.sql.exec('SELECT MIN(attempt) AS a FROM dale_history_batches').toArray()[0]?.a;
      if (oldest === null || oldest === undefined) return;
      const next: EarlierState = state ?? { v: 1, context: this.context, checkpoint: Number(oldest) - 1,
        coverageStart: Number(oldest), through: Number(oldest), gap: false, trips: {} };
      if (Number(oldest) > next.checkpoint + 45_000) next.gap = true;
      const rows = this.storage.sql.exec('SELECT attempt,context_key,body FROM dale_history_batches WHERE attempt>? ORDER BY attempt LIMIT ?', next.checkpoint, EARLIER_BATCHES).toArray();
      if (!rows.length) return;
      for (const row of rows) {
        const attempt = Number(row.attempt);
        if (attempt > now) return;
        if (attempt > next.checkpoint + 45_000) next.gap = true;
        const batch = JSON.parse(String(row.body));
        if (batch.omissionReason || (batch.quality && batch.quality.feedState !== 'ok')) next.gap = true;
        if (String(row.context_key) === this.context) this.domain.fold(next, batch, now);
        else next.gap = true;
        next.checkpoint = attempt; next.through = attempt;
      }
      const body = JSON.stringify(next), size = this.storage.sql.databaseSize;
      if (new TextEncoder().encode(body).byteLength > EARLIER_MAX_BYTES || Object.keys(next.trips).length > EARLIER_MAX_TRIPS
        || !Number.isSafeInteger(size) || size >= 450_000_000 || !reserve(2, now)) return;
      this.storage.transactionSync(() => this.storage.sql.exec('INSERT INTO dale_earlier_buses(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', body));
      // At most one bounded fold per existing 30-second alarm while catching up.
      if (rows.length === EARLIER_BATCHES) this.nextAt = now + 30_000;
    } catch { /* Independent projection failures cannot stop original collection or advance its own checkpoint. */ }
  }
}

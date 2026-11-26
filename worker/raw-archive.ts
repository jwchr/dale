import bindings from 'gtfs-realtime-bindings';
import type { HistoryArchive, HistoryBucket } from './history-archive';
import type { RegionFilter } from './region-raw';

// Alerts are saved raw only (D84: "All the data, save all the data."); nothing in Dale reads them yet.
export type RawFeed = 'getVehiclePositions' | 'getTripUpdates' | 'getAlerts' | 'rail-getVehiclePositions' | 'rail-getTripUpdates' | 'rail-getAlerts'
  // RailData (D84): one JSON bundle per poll, the two daily answers whole, and per-method names for failures only.
  | 'raildata-poll' | 'raildata-getStationList' | 'raildata-getStationSchedule'
  | 'raildata-getVehicleData' | 'raildata-getTrainSchedule' | 'raildata-getStationMSG';
const isJson = (feed: RawFeed) => feed.startsWith('raildata-');
export interface RawResponse { feed: RawFeed; bytes: Uint8Array<ArrayBuffer>; receivedAt: number;
  /** Original bus bytes are checked for secrets but never saved after filtering. */
  sourceBytes?: Uint8Array<ArrayBuffer>; filtered?: RegionFilter }
interface Counts { count: number; rawBytes: number; gzipBytes: number; identical: number }
interface Manifest extends Counts {
  v: 1; feed: RawFeed; receivedAt: number; sha256: string; gzipSHA256: string;
  upstreamHeaderTimestamp: number | null;
  filtered?: RegionFilter;
}
interface Pending { key: string; manifest: Manifest }
interface Ledger { hour: string; feeds: Partial<Record<RawFeed, Counts>>; events?: Partial<Record<RawFeed, Record<string, number>>> }
export interface RawArchiveState {
  v: 1; credit: { bytes: number; a: number; b: number; writes: number; day: string };
  last: Partial<Record<RawFeed, string>>; lastAt: Partial<Record<RawFeed, number>>; ledgers: Record<string, Ledger>;
  pending: Pending[]; reason: string; failures: number; missing: number; blockedSecrets: number;
  /** When a storage, operation or SQL guard last refused raw saving (absent in older checkpoints). */
  budgetAt?: number;
}
export const newRawArchiveState = (): RawArchiveState => ({ v: 1, credit: { bytes: 0, a: 0, b: 0, writes: 0, day: '' },
  last: {}, lastAt: {}, ledgers: {}, pending: [], reason: 'waiting', failures: 0, missing: 0, blockedSecrets: 0 });
const encode = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const digest = async (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.digest('SHA-256', bytes);
const hash = async (bytes: Uint8Array<ArrayBuffer>) => hex(await digest(bytes));
const hour = (at: number) => new Date(at).toISOString().slice(0, 13);
const totals = (): Counts => ({ count: 0, rawBytes: 0, gzipBytes: 0, identical: 0 });
const BUDGET_REASONS = ['free-storage-budget', 'free-operation-budget', 'sql-write-budget'];
/** A budget stop pauses statewide rail fetches for an hour, then lets one poll try again. The reason
 *  alone stays set until a capture succeeds, which never happens if nothing else is saved (audit DL-006). */
export const rawBudgetPausesRail = (state: RawArchiveState | undefined, now: number) =>
  !!state && BUDGET_REASONS.includes(state.reason) && now - (state.budgetAt ?? 0) < 3_600_000;
/** Starts the hourly rail retry during a budget stop: the next hour's pause begins now, so a retry that
 *  fails upstream or saves nothing still waits an hour instead of trying every minute (Neon Nov24 d, #278). */
export const startRailBudgetRetry = (state: RawArchiveState | undefined, now: number) => {
  if (state && BUDGET_REASONS.includes(state.reason)) state.budgetAt = now;
};
const ledgerKey = (ledger: Ledger) => `raw/v1/${ledger.hour.slice(0, 10)}/ledgers/${ledger.hour.slice(11)}.json`;

async function bounded<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('raw-timeout')), 12_000); })]); }
  finally { clearTimeout(timer); }
}
function headerTimestamp(bytes: Uint8Array): number | null {
  try {
    const value = Number(bindings.transit_realtime.FeedMessage.decode(bytes).header.timestamp);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}
/** Exact known secrets are rejected, never redacted: redaction would alter the original evidence. */
/** Searches the bytes directly: decoding a 32 MiB response into a string for each poll would
 *  double its memory inside the Worker's 128 MB limit (audit DL-007). */
function containsSecret(bytes: Uint8Array, secrets: string[]) {
  const encoder = new TextEncoder();
  return secrets.filter(Boolean).some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
    .some(value => includesBytes(bytes, encoder.encode(value))));
}
function includesBytes(haystack: Uint8Array, needle: Uint8Array) {
  if (!needle.length) return true;
  const last = haystack.length - needle.length;
  for (let at = haystack.indexOf(needle[0]!); at !== -1 && at <= last; at = haystack.indexOf(needle[0]!, at + 1)) {
    let n = 1;
    while (n < needle.length && haystack[at + n] === needle[n]) n++;
    if (n === needle.length) return true;
  }
  return false;
}

/** Private immutable originals. Metadata-only intents are checkpointed together for the whole poll
 * using the relay's existing state. Hourly ledgers and last hashes survive eviction. An interrupted
 * data upload is reconciled by checksum before its manifest/count is acknowledged; missing data
 * is explicitly counted, since bytes not durably received by R2 cannot be reconstructed. */
export class RawArchive {
  constructor(private state: RawArchiveState, private archive: Pick<HistoryArchive, 'reserveRaw'>,
    private bucket: HistoryBucket, private checkpoint: () => Promise<void>) {}

  /** `keepBytes` must remain after this use: storage held back so each open hourly ledger can
   *  always be closed, even once the raw byte stop refuses new originals (Neon, #278). */
  private credit(bytes: number, a: number, b: number, now: number, keepBytes = 0): boolean {
    const c = this.state.credit, day = new Date(now).toISOString().slice(0, 10);
    // SQL grants are daily. Operation grants expire after the UTC day they were bought in:
    // their durable rolling-day reservation must never be reused after it ages out.
    if (c.day !== day) { c.writes = 0; c.a = 0; c.b = 0; c.day = day; }
    const need = bytes + keepBytes;
    let addBytes = c.bytes < need ? Math.ceil((need - c.bytes) / 8_388_608) * 8_388_608 : 0;
    const addA = c.a < a ? Math.max(64, a - c.a) : 0, addB = c.b < b ? Math.max(64, b - c.b) : 0;
    const addWrites = c.writes < 1 ? 128 : 0;
    if (addBytes || addA || addB || addWrites) {
      let reason = this.archive.reserveRaw(addBytes, addA, addB, addWrites, now);
      // At the byte stop a whole 8 MB block may no longer fit; buy only what this step needs, so a ledger
      // whose first close failed can still close (Neon Nov24 c, #278). The byte check fails before any write.
      if (reason === 'free-storage-budget' && addBytes > need - c.bytes) {
        addBytes = need - c.bytes; reason = this.archive.reserveRaw(addBytes, addA, addB, addWrites, now);
      }
      if (reason) {
        // A refusal during a budget stop keeps the stop's start, so bus refusals every poll never push back
        // statewide rail's hourly retry (CodeRabbit, #278). startRailBudgetRetry re-arms it at each retry.
        if (!BUDGET_REASONS.includes(this.state.reason) || this.state.budgetAt === undefined) this.state.budgetAt = now;
        this.state.reason = reason; return false;
      }
      c.bytes += addBytes; c.a += addA; c.b += addB; c.writes += addWrites;
    }
    c.bytes -= bytes; c.a -= a; c.b -= b; c.writes--;
    return true;
  }
  private async put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
    await bounded(this.bucket.put(key, bytes.buffer, { onlyIf: { etagDoesNotMatch: '*' }, sha256: await digest(bytes), storageClass: 'Standard',
      httpMetadata: { contentType, cacheControl: 'private, no-store' } }));
    await this.verify(key, bytes.byteLength, await hash(bytes));
  }
  private async verify(key: string, size: number, sha256: string) {
    const object = await bounded(this.bucket.get(key));
    if (!object || object.size !== size) throw new Error('raw-size');
    const bytes = new Uint8Array(await bounded(object.arrayBuffer()));
    if (bytes.byteLength !== size || await hash(bytes) !== sha256) throw new Error('raw-checksum');
  }
  private acknowledge(item: Pending) {
    const m = item.manifest, h = hour(m.receivedAt);
    const current = this.state.ledgers[h] ??= { hour: h, feeds: {} };
    const counts = current.feeds[m.feed] ??= totals();
    for (const name of ['count', 'rawBytes', 'gzipBytes', 'identical'] as const) counts[name] += m[name];
    this.state.pending = this.state.pending.filter(p => p !== item);
  }
  /** Only safe totals leave the private checkpoint. Hashes, keys and bodies stay private. */
  status() {
    return { configured: true, reason: this.state.reason, failures: this.state.failures, missing: this.state.missing,
      blockedSecrets: this.state.blockedSecrets, pending: this.state.pending.length,
      hoursUTC: Object.values(this.state.ledgers) };
  }
  /** Fixed codes only, never upstream error text. Oversized streams have no saved/truncated original. */
  recordFailure(feed: RawFeed, code: string, at: number) {
    const safe = ['response-too-large', 'request-ceiling', 'authentication-cooldown', 'sql-write-budget', 'access-denied', 'rate-limited', 'http-error', 'empty-response',
      'timed-out', 'network-error', 'invalid-token', 'invalid-response', 'redirect-refused', 'configuration-missing', 'token-limit'].includes(code) ? code : 'unknown-error';
    const h = hour(at), ledger = this.state.ledgers[h] ??= { hour: h, feeds: {} };
    const events = (ledger.events ??= {})[feed] ??= {};
    events[safe] = (events[safe] ?? 0) + 1;
    this.state.failures++;
    if (safe === 'response-too-large') this.state.missing++;
  }
  async capture(responses: RawResponse[], now: number, secrets: string[]): Promise<void> {
    const failuresBefore = this.state.failures, blockedBefore = this.state.blockedSecrets;
    // Stage receipt comparisons until credit and recovery allow the new intents to commit.
    const last = { ...this.state.last }, lastAt = { ...this.state.lastAt };
    // Prepare bounded originals independently; a bad/failed feed never prevents the other.
    const prepared: { item: Pending; gzip: Uint8Array<ArrayBuffer> }[] = [];
    for (const response of responses) {
      if (this.state.pending.some(p => p.manifest.feed === response.feed && p.manifest.receivedAt === response.receivedAt)) continue;
      if (this.state.pending.filter(p => p.manifest.feed === response.feed).length >= 8) { this.state.missing++; continue; }
      if (containsSecret(response.sourceBytes ?? response.bytes, secrets)) { this.state.blockedSecrets++; this.state.reason = 'secret-response-rejected'; continue; }
      try {
        const gzip = new Uint8Array(await new Response(new Blob([response.bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        const sha256 = await hash(response.bytes);
        if (lastAt[response.feed] === response.receivedAt && last[response.feed] === sha256) continue;
        const manifest: Manifest = { v: 1, feed: response.feed, receivedAt: response.receivedAt,
          count: 1, rawBytes: response.bytes.byteLength, gzipBytes: gzip.byteLength, sha256, gzipSHA256: await hash(gzip),
          identical: last[response.feed] === sha256 ? 1 : 0,
          upstreamHeaderTimestamp: isJson(response.feed) ? null : headerTimestamp(response.bytes), ...(response.filtered ? { filtered: response.filtered } : {}) };
        last[response.feed] = sha256; lastAt[response.feed] = response.receivedAt;
        prepared.push({ item: { key: `raw/v1/${new Date(response.receivedAt).toISOString().slice(0, 10)}/${response.feed}/${response.receivedAt}-${sha256}.${isJson(response.feed) ? 'json' : 'pb'}.gz`, manifest }, gzip });
      } catch { this.state.failures++; }
    }
    // Recovery runs first and buys no new bytes: each original's manifest was reserved when it
    // was prepared, so a full raw byte budget can never strand a receipt without its manifest.
    const recovering = this.state.pending.slice();
    if (recovering.length) {
      if (!this.credit(0, 2 * recovering.length, 2 * recovering.length, now)) return;
      await this.checkpoint();
      for (const item of recovering) {
        try {
          const object = await bounded(this.bucket.get(item.key));
          if (!object) { this.state.missing++; this.state.pending = this.state.pending.filter(p => p !== item); continue; }
          await this.verifyObject(object, item.manifest.gzipBytes, item.manifest.gzipSHA256);
          await this.put(item.key + '.manifest.json', encode(JSON.stringify(item.manifest)), 'application/json');
          this.acknowledge(item);
        } catch { this.state.failures++; }
      }
    }
    // An hour closes only when nothing from it is pending, including originals received in it this
    // poll before the clock crossed the hour (Neon, #278).
    const closingHours = new Set(Object.keys(this.state.ledgers).filter(h => h < hour(now)
      && !this.state.pending.some(p => hour(p.manifest.receivedAt) === h)
      && !prepared.some(p => hour(p.item.manifest.receivedAt) === h)));
    if (!prepared.length && !closingHours.size) {
      // Save recovered acknowledgments even when nothing new is due.
      if (recovering.length && this.credit(0, 0, 0, now)) await this.checkpoint();
      return;
    }
    // Finished hours close on their own reservation, so new originals waiting for budget never hold
    // them open. Their bytes were kept back when their originals were reserved (keepBytes below).
    const closing = closingHours.size > 0 && this.credit(closingHours.size * 4096, closingHours.size, closingHours.size, now);
    // New originals/manifests and readbacks, keeping 4096 bytes for every ledger still open afterwards.
    const stillOpen = new Set([...Object.keys(this.state.ledgers).filter(h => !(closing && closingHours.has(h))),
      ...prepared.map(p => hour(p.item.manifest.receivedAt))]);
    const bytes = prepared.reduce((sum, p) => sum + p.gzip.byteLength + 4096, 0);
    const admitted = prepared.length > 0 && this.credit(bytes, 2 * prepared.length, 2 * prepared.length, now, stillOpen.size * 4096);
    if (!closing && !admitted) {
      // New originals wait for budget; recovered acknowledgments still need saving.
      if (recovering.length && this.credit(0, 0, 0, now)) await this.checkpoint();
      return;
    }
    if (admitted) {
      this.state.last = last; this.state.lastAt = lastAt;
      this.state.pending.push(...prepared.map(p => p.item));
    }
    await this.checkpoint();
    // Pending originals from an older hour must be reconciled before closing it. Ledgers
    // remain in the checkpoint until readback, so a crash retries the exact same body.
    if (closing) for (const h of closingHours) {
      const ledger = this.state.ledgers[h]!;
      try {
        await this.put(ledgerKey(ledger), encode(JSON.stringify(ledger)), 'application/json');
        delete this.state.ledgers[h];
      } catch { this.state.failures++; }
    }
    if (prepared.length && !admitted) {
      this.state.reason = this.state.pending.length || this.state.failures > failuresBefore ? 'archive-error' : this.state.reason;
      return;
    }
    const results = await Promise.allSettled(prepared.map(async ({ item, gzip }) => {
      await this.put(item.key, gzip, 'application/gzip');
      await this.put(item.key + '.manifest.json', encode(JSON.stringify(item.manifest)), 'application/json');
      this.acknowledge(item);
    }));
    for (const result of results) if (result.status === 'rejected') this.state.failures++;
    // A capture that saved nothing new has not shown the budget is back: keep a budget stop, so rail still
    // waits its hour instead of polling every minute while every fetch fails or repeats (Neon Nov24 d, #278).
    const stillStopped = !prepared.length && BUDGET_REASONS.includes(this.state.reason);
    this.state.reason = this.state.pending.length || this.state.failures > failuresBefore ? 'archive-error' : this.state.blockedSecrets > blockedBefore ? 'secret-response-rejected' : stillStopped ? this.state.reason : 'ready';
  }
  private async verifyObject(object: { size: number; arrayBuffer(): Promise<ArrayBuffer> }, size: number, sha256: string) {
    if (object.size !== size) throw new Error('raw-size');
    const bytes = new Uint8Array(await bounded(object.arrayBuffer()));
    if (bytes.byteLength !== size || await hash(bytes) !== sha256) throw new Error('raw-checksum');
  }
}

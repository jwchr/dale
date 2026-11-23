import bindings from 'gtfs-realtime-bindings';
import type { HistoryArchive, HistoryBucket } from './history-archive';

export type RawFeed = 'getVehiclePositions' | 'getTripUpdates' | 'rail-getVehiclePositions' | 'rail-getTripUpdates';
export interface RawResponse { feed: RawFeed; bytes: Uint8Array<ArrayBuffer>; receivedAt: number }
interface Counts { count: number; rawBytes: number; gzipBytes: number; identical: number }
interface Manifest extends Counts {
  v: 1; feed: RawFeed; receivedAt: number; sha256: string; gzipSHA256: string;
  upstreamHeaderTimestamp: number | null;
}
interface Pending { key: string; manifest: Manifest }
interface Ledger { hour: string; feeds: Partial<Record<RawFeed, Counts>>; events?: Partial<Record<RawFeed, Record<string, number>>> }
export interface RawArchiveState {
  v: 1; credit: { bytes: number; a: number; b: number; writes: number; day: string };
  last: Partial<Record<RawFeed, string>>; lastAt: Partial<Record<RawFeed, number>>; ledgers: Record<string, Ledger>;
  pending: Pending[]; reason: string; failures: number; missing: number; blockedSecrets: number;
}
export const newRawArchiveState = (): RawArchiveState => ({ v: 1, credit: { bytes: 0, a: 0, b: 0, writes: 0, day: '' },
  last: {}, lastAt: {}, ledgers: {}, pending: [], reason: 'waiting', failures: 0, missing: 0, blockedSecrets: 0 });
const encode = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const digest = async (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.digest('SHA-256', bytes);
const hash = async (bytes: Uint8Array<ArrayBuffer>) => hex(await digest(bytes));
const hour = (at: number) => new Date(at).toISOString().slice(0, 13);
const totals = (): Counts => ({ count: 0, rawBytes: 0, gzipBytes: 0, identical: 0 });
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
function containsSecret(bytes: Uint8Array, secrets: string[]) {
  const text = new TextDecoder().decode(bytes);
  return secrets.filter(Boolean).some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
    .some(value => text.includes(value)));
}

/** Private immutable originals. Metadata-only intents are checkpointed together for the whole poll
 * using the relay's existing state. Hourly ledgers and last hashes survive eviction. An interrupted
 * data upload is reconciled by checksum before its manifest/count is acknowledged; missing data
 * is explicitly counted, since bytes not durably received by R2 cannot be reconstructed. */
export class RawArchive {
  constructor(private state: RawArchiveState, private archive: Pick<HistoryArchive, 'reserveRaw'>,
    private bucket: HistoryBucket, private checkpoint: () => Promise<void>) {}

  private credit(bytes: number, a: number, b: number, now: number): boolean {
    const c = this.state.credit, day = new Date(now).toISOString().slice(0, 10);
    // SQL grants are daily. Operation grants expire after the UTC day they were bought in:
    // their durable rolling-day reservation must never be reused after it ages out.
    if (c.day !== day) { c.writes = 0; c.a = 0; c.b = 0; c.day = day; }
    const addBytes = c.bytes < bytes ? Math.ceil((bytes - c.bytes) / 8_388_608) * 8_388_608 : 0;
    const addA = c.a < a ? Math.max(64, a - c.a) : 0, addB = c.b < b ? Math.max(64, b - c.b) : 0;
    const addWrites = c.writes < 1 ? 128 : 0;
    if (addBytes || addA || addB || addWrites) {
      const reason = this.archive.reserveRaw(addBytes, addA, addB, addWrites, now);
      if (reason) { this.state.reason = reason; return false; }
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
      if (containsSecret(response.bytes, secrets)) { this.state.blockedSecrets++; this.state.reason = 'secret-response-rejected'; continue; }
      try {
        const gzip = new Uint8Array(await new Response(new Blob([response.bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        const sha256 = await hash(response.bytes);
        if (lastAt[response.feed] === response.receivedAt && last[response.feed] === sha256) continue;
        const manifest: Manifest = { v: 1, feed: response.feed, receivedAt: response.receivedAt,
          count: 1, rawBytes: response.bytes.byteLength, gzipBytes: gzip.byteLength, sha256, gzipSHA256: await hash(gzip),
          identical: last[response.feed] === sha256 ? 1 : 0,
          upstreamHeaderTimestamp: headerTimestamp(response.bytes) };
        last[response.feed] = sha256; lastAt[response.feed] = response.receivedAt;
        prepared.push({ item: { key: `raw/v1/${new Date(response.receivedAt).toISOString().slice(0, 10)}/${response.feed}/${response.receivedAt}-${sha256}.pb.gz`, manifest }, gzip });
      } catch { this.state.failures++; }
    }
    const recovering = this.state.pending.slice();
    const closingHours = new Set([...Object.keys(this.state.ledgers), ...recovering.map(p => hour(p.manifest.receivedAt))].filter(h => h < hour(now)));
    if (!prepared.length && !recovering.length && !closingHours.size) return;
    // Reserve for both originals/manifests, readbacks and any closed hourly ledger.
    const bytes = prepared.reduce((sum, p) => sum + p.gzip.byteLength + 4096, 0) + closingHours.size * 4096;
    const objects = 2 * (prepared.length + recovering.length) + closingHours.size;
    if (!this.credit(bytes, objects, objects, now)) return;
    if (recovering.length) {
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
      // Recovery consumed a checkpoint; debit another before committing the new intent.
      if (!this.credit(0, 0, 0, now)) return;
    }
    this.state.last = last; this.state.lastAt = lastAt;
    this.state.pending.push(...prepared.map(p => p.item));
    await this.checkpoint();
    // Pending originals from an older hour must be reconciled before closing it. Ledgers
    // remain in the checkpoint until readback, so a crash retries the exact same body.
    for (const ledger of Object.values(this.state.ledgers).filter(l => l.hour < hour(now)
      && !this.state.pending.some(p => hour(p.manifest.receivedAt) === l.hour))) {
      try {
        await this.put(ledgerKey(ledger), encode(JSON.stringify(ledger)), 'application/json');
        delete this.state.ledgers[ledger.hour];
      } catch { this.state.failures++; }
    }
    const results = await Promise.allSettled(prepared.map(async ({ item, gzip }) => {
      await this.put(item.key, gzip, 'application/gzip');
      await this.put(item.key + '.manifest.json', encode(JSON.stringify(item.manifest)), 'application/json');
      this.acknowledge(item);
    }));
    for (const result of results) if (result.status === 'rejected') this.state.failures++;
    this.state.reason = this.state.pending.length || this.state.failures > failuresBefore ? 'archive-error' : this.state.blockedSecrets > blockedBefore ? 'secret-response-rejected' : 'ready';
  }
  private async verifyObject(object: { size: number; arrayBuffer(): Promise<ArrayBuffer> }, size: number, sha256: string) {
    if (object.size !== size) throw new Error('raw-size');
    const bytes = new Uint8Array(await bounded(object.arrayBuffer()));
    if (bytes.byteLength !== size || await hash(bytes) !== sha256) throw new Error('raw-checksum');
  }
}

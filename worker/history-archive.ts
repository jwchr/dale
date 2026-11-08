import { HistoryJournal, type ArchiveReceipt, type HistoryStorage } from './history-journal';

interface ArchiveObject { size: number; arrayBuffer(): Promise<ArrayBuffer> }
export interface HistoryBucket {
  put(key: string, body: ArrayBuffer, options: { onlyIf: { etagDoesNotMatch: string }; sha256: ArrayBuffer; storageClass: 'Standard'; httpMetadata: { contentType: string; cacheControl: string } }): Promise<unknown>;
  get(key: string): Promise<ArchiveObject | null>;
}
const BYTE_LIMIT = 9_000_000_000, A_LIMIT = 500_000, B_LIMIT = 2_000_000;
const DAY = 86400_000;
interface ArchiveState { v: 1; reservedBytes: number; verifiedObjects: number; failures: number; reason: string; lastAttemptAt?: number; lastSuccessAt?: number; nextAt?: number }
const initial = (): ArchiveState => ({ v: 1, reservedBytes: 0, verifiedObjects: 0, failures: 0, reason: 'waiting' });
const date = (now: number) => new Date(now).toISOString().slice(0, 10);
const encode = (text: string) => new TextEncoder().encode(text);
const sha = async (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.digest('SHA-256', bytes);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('archive-timeout')), 12_000); })]); }
  finally { clearTimeout(timer!); }
}
async function verifyLossless(compressed: Uint8Array<ArrayBuffer>, raw: Uint8Array<ArrayBuffer>) {
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let offset = 0;
  try {
    for (;;) {
      const part = await deadline(reader.read()); if (part.done) break;
      if (offset + part.value.byteLength > raw.byteLength) throw new Error('archive-expanded-size');
      for (let i = 0; i < part.value.byteLength; i++) if (part.value[i] !== raw[offset + i]) throw new Error('archive-content-mismatch');
      offset += part.value.byteLength;
    }
    if (offset !== raw.byteLength) throw new Error('archive-truncated');
  } finally { await reader.cancel().catch(() => {}); }
}

/** Same-account private R2, with immutable objects and readback before any hot prune.
 * Reservations are persisted BEFORE external I/O, including failed/ambiguous calls.
 * No list/head/delete, multipart upload, public URL or new credential is used. */
export class HistoryArchive {
  private pending?: Promise<void>;
  constructor(private storage: HistoryStorage, private journal: HistoryJournal, private bucket: HistoryBucket) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_archive_meta (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS dale_archive_days (day TEXT PRIMARY KEY, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL) WITHOUT ROWID');
  }
  private read(): ArchiveState {
    const row = this.storage.sql.exec('SELECT body FROM dale_archive_meta WHERE id=1').toArray()[0];
    if (!row) return initial();
    const state = JSON.parse(String(row.body)) as ArchiveState;
    if (state.v !== 1 || !Number.isSafeInteger(state.reservedBytes) || state.reservedBytes < 0
      || !Number.isSafeInteger(state.verifiedObjects) || !Number.isSafeInteger(state.failures)) throw new Error('archive-state-invalid');
    return state;
  }
  private write(state: ArchiveState) {
    this.storage.sql.exec('INSERT INTO dale_archive_meta(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(state));
  }
  private totals(now: number) {
    //34 UTC date buckets include boundary/in-flight margin beyond32days.
    const row = this.storage.sql.exec('SELECT COALESCE(SUM(class_a),0) AS a,COALESCE(SUM(class_b),0) AS b FROM dale_archive_days WHERE day>=?', date(now - 33 * DAY)).toArray()[0]!;
    return { a: Number(row.a), b: Number(row.b) };
  }
  private reserve(bytes: number, now: number) {
    if (!this.journal.reserveStorageWrites(8, now)) return false;
    return this.storage.transactionSync(() => {
      const state = this.read(), totals = this.totals(now);
      if (state.reservedBytes + bytes > BYTE_LIMIT || totals.a + 2 > A_LIMIT || totals.b + 2 > B_LIMIT) {
        state.reason = state.reservedBytes + bytes > BYTE_LIMIT ? 'free-storage-budget' : 'free-operation-budget';
        state.nextAt = now + DAY; this.write(state); return false;
      }
      state.reservedBytes += bytes; state.lastAttemptAt = now; state.reason = 'archiving';
      this.storage.sql.exec('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,2,2) ON CONFLICT(day) DO UPDATE SET class_a=class_a+2,class_b=class_b+2', date(now));
      this.write(state); return true;
    });
  }
  private success(now: number) {
    const state = this.read(); state.verifiedObjects++; state.lastSuccessAt = now; state.failures = 0; state.reason = 'ready'; delete state.nextAt; this.write(state);
  }
  private failure(now: number) {
    if (!this.journal.reserveStorageWrites(2, now)) return;
    this.storage.transactionSync(() => {
      const state = this.read(); state.failures++; state.reason = 'archive-error'; state.nextAt = now + Math.min(3600_000, 30_000 * 2 ** Math.min(state.failures, 7)); this.write(state);
    });
  }
  private async upload(body: string, kind: 'schedule' | 'batch', version: string, now: number, attempt?: number, contextManifestKey?: string): Promise<ArchiveReceipt | undefined> {
    const raw = encode(body), rawDigest = await sha(raw), rawSHA256 = hex(rawDigest);
    const versionHash = hex(await sha(encode(version))).slice(0, 24);
    const key = kind === 'schedule' ? `v1/schedules/${versionHash}/${rawSHA256}.json.gz`
      : `v1/${date(attempt!)}/batches/${attempt}-${rawSHA256}.json.gz`;
    const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    if (!this.reserve(compressed.byteLength + 4096, now)) return;
    // Conditional create preserves the first immutable version on crash/retry.
    await deadline(this.bucket.put(key, compressed.buffer, { onlyIf: { etagDoesNotMatch: '*' }, sha256: await sha(compressed), storageClass: 'Standard',
      httpMetadata: { contentType: 'application/gzip', cacheControl: 'private, no-store' } }));
    const object = await deadline(this.bucket.get(key));
    if (!object || object.size > raw.byteLength + 65_536 || object.size > 20_000_000) throw new Error('archive-object-size');
    const readback = new Uint8Array(await deadline(object.arrayBuffer()));
    if (readback.byteLength !== object.size) throw new Error('archive-object-truncated');
    await verifyLossless(readback, raw);
    const gzipSHA256 = hex(await sha(readback)), manifestKey = key + '.manifest.json';
    const manifest = encode(JSON.stringify({ v: 1, kind, feedVersion: version, attempt, rawSHA256, rawBytes: raw.byteLength,
      gzipSHA256, gzipBytes: readback.byteLength, contextManifestKey }));
    if (manifest.byteLength > 4096) throw new Error('archive-manifest-size');
    const manifestDigest = await sha(manifest);
    await deadline(this.bucket.put(manifestKey, manifest.buffer, { onlyIf: { etagDoesNotMatch: '*' }, sha256: manifestDigest, storageClass: 'Standard',
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' } }));
    const receiptObject = await deadline(this.bucket.get(manifestKey));
    if (!receiptObject || receiptObject.size !== manifest.byteLength) throw new Error('archive-manifest-missing');
    const receiptBytes = new Uint8Array(await deadline(receiptObject.arrayBuffer()));
    if (hex(await sha(receiptBytes)) !== hex(manifestDigest)) throw new Error('archive-manifest-mismatch');
    return { key, manifestKey, rawSHA256, gzipSHA256, rawBytes: raw.byteLength, gzipBytes: readback.byteLength, ...(contextManifestKey ? { contextManifestKey } : {}) };
  }
  async flush(now: number): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.run(now).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run(now: number) {
    if ((this.read().nextAt ?? 0) > now) return;
    try {
      for (let i = 0; i < 2; i++) {
        if (i > 0 && !this.journal.canCatchUpArchive(now)) break;
        const next = this.journal.nextUnarchived(); if (!next) break;
        const context = this.journal.scheduleContext(next.contextKey);
        let contextReceipt = context.receipt;
        if (!contextReceipt) {
          const expectedHash = next.contextKey.split(':').pop();
          if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || hex(await sha(encode(context.body!))) !== expectedHash)
            throw new Error('archive-context-checksum');
          contextReceipt = await this.upload(context.body!, 'schedule', next.feedVersion, now);
          if (!contextReceipt) break;
          this.journal.acknowledgeSchedule(next.contextKey, contextReceipt, () => this.success(now));
        }
        const receipt = await this.upload(next.body, 'batch', next.feedVersion, now, next.attempt, contextReceipt.manifestKey);
        if (!receipt) break;
        this.journal.acknowledgeBatch(next.attempt, receipt, () => this.success(now));
      }
    } catch { this.failure(now); }
  }
  status(now: number) {
    const state = this.read(), totals = this.totals(now);
    const sqlWriteBudgetRemaining = this.journal.storageWritesRemaining(now);
    const oldestUnarchivedAt = this.journal.oldestUnarchivedAt();
    return { configured: true, ...state, ...(sqlWriteBudgetRemaining < 8 ? { reason: 'sql-write-budget' } : {}), sqlWriteBudgetRemaining,
      classAReserved32Days: totals.a, classBReserved32Days: totals.b,
      oldestUnarchivedAt, backlogAgeMs: oldestUnarchivedAt === null ? 0 : Math.max(0, now - oldestUnarchivedAt),
      byteLimit: BYTE_LIMIT, classALimit32Days: A_LIMIT, classBLimit32Days: B_LIMIT };
  }
}

import type { HistoryStorage } from './history-journal';
import type { ArchiveReader } from './arrival-backfill';
import { A_LIMIT, B_LIMIT } from './history-archive';

export const OWNER_HISTORY_PATH = '/v1/owner/history';
const KEY = /^v1\/(\d{4}-\d{2}-\d{2})\/batches\/(\d{13})-([a-f0-9]{64})\.json\.gz$/;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && day(Date.parse(s)) === s;
const validCursor = (s: string) => validKey(s.replace(/\.manifest\.json$/, ''));
const validKey = (s: string) => { const m = KEY.exec(s); return !!m && validDay(m[1]!) && day(Number(m[2])) === m[1]; };
export type OwnerQuery = { kind: 'hot'; after: number } | { kind: 'list'; day: string; after?: string } | { kind: 'object'; key: string };
export function ownerQuery(url: URL): OwnerQuery | undefined {
  if (url.href.length > 512 || [...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) return;
  const p = url.searchParams;
  if (p.has('key')) return p.size === 1 && validKey(p.get('key')!) ? { kind: 'object', key: p.get('key')! } : undefined;
  if (p.has('day')) {
    const date = p.get('day')!, after = p.get('after');
    if (!validDay(date) || [...p.keys()].some(k => !['day', 'after'].includes(k))
      || (after !== null && (!validCursor(after) || !after.startsWith(`v1/${date}/batches/`)))) return;
    return { kind: 'list', day: date, ...(after ? { after } : {}) };
  }
  const after = p.get('after') ?? '0';
  return p.size <= 1 && [...p.keys()].every(k => k === 'after') && /^\d{1,13}$/.test(after)
    ? { kind: 'hot', after: Number(after) } : undefined;
}
/** Verify with WebCrypto rather than prefix-sensitive string equality. No credential is returned or logged. */
export async function ownerAuthorization(request: Request, secret?: string): Promise<Response | undefined> {
  const deny = (status: number) => Response.json({ error: status === 404 ? 'Not found' : 'Unauthorized' }, { status,
    headers: { 'cache-control': 'private, no-store', 'vary': 'Authorization', 'x-content-type-options': 'nosniff' } });
  if (!secret) return deny(404);
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 1024) return deny(401);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode('dale-owner-history-auth-v1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`Bearer ${secret}`));
  if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(supplied))) return deny(401);
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const pick = (v: unknown, keys: string[]) => Object.fromEntries(Object.entries(object(v)).filter(([k, value]) => keys.includes(k) && ['string', 'number', 'boolean'].includes(typeof value)));
/** A new whitelist, not a raw export: even future rider fields cannot enter this response. */
export function corridorHistory(raw: unknown) {
  const b = object(raw), records = Array.isArray(b.records) ? b.records : [];
  return { ...pick(b, ['v', 'feedVersion', 'contextKey', 'receivedAt', 'omissionReason']),
    quality: pick(b.quality, ['source', 'feedState', 'generatedAt', 'updateFeedState', 'updateGeneratedAt', 'duplicates', 'rejected', 'conflicts', 'outOfOrder']),
    records: records.filter(r => ['163', '164', '165', '165T'].includes(String(object(r).route))).map(r => {
      const row = object(r), observation = object(row.observation);
      return { ...pick(row, ['source', 'feedVersion', 'generatedAt', 'receivedAt', 'route', 'direction', 'serviceDate']),
        observation: { ...pick(observation, ['tripInstanceId', 'vehicleId', 'observedAt', 'lat', 'lon']),
          ...(observation.stopCall ? { stopCall: pick(observation.stopCall, ['status', 'stopIndex', 'stopId']) } : {}) } };
    }) };
}

/** Never polls, writes bus evidence, changes a checkpoint, or puts/deletes an R2 object. */
export class OwnerHistory {
  constructor(private storage: HistoryStorage, private bucket?: ArchiveReader) {}
  private reserve(a: number, b: number, now: number, spare: (units: number, now: number) => boolean) {
    // Shared persistent R2 ledger; leave half the cap for collection. No I/O before reservation.
    if (!spare(2, now)) return false;
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT COALESCE(SUM(class_a),0) AS a,COALESCE(SUM(class_b),0) AS b FROM dale_archive_days WHERE day>=?', day(now - 33 * 86400_000)).toArray()[0]!;
      if (Number(row.a) + a > A_LIMIT / 2 || Number(row.b) + b > B_LIMIT / 2) return false;
      this.storage.sql.exec('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET class_a=class_a+excluded.class_a,class_b=class_b+excluded.class_b', day(now), a, b);
      return true;
    });
  }
  async read(query: OwnerQuery, now: number, spare: (units: number, now: number) => boolean): Promise<Response> {
    const headers = { 'cache-control': 'private, no-store', 'vary': 'Authorization', 'x-content-type-options': 'nosniff' };
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
    try {
      if (query.kind === 'hot') {
        const rows = this.storage.sql.exec('SELECT attempt,body FROM dale_history_batches WHERE attempt>? ORDER BY attempt LIMIT 4', query.after).toArray();
        return json({ v: 1, scope: 'retained-hot-batches', batches: rows.map(r => ({ attempt: Number(r.attempt), ...corridorHistory(JSON.parse(String(r.body))) })),
          nextAfter: rows.length === 4 ? Number(rows[rows.length - 1]!.attempt) : null });
      }
      if (!this.bucket) return json({ error: 'archive-unavailable' }, 503);
      if (!this.reserve(query.kind === 'list' ? 1 : 0, query.kind === 'object' ? 1 : 0, now, spare)) return json({ error: 'free-budget' }, 503);
      // Each request does one bounded R2 operation. A timeout never triggers a retry here.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([(async () => {
          if (query.kind === 'list') {
            const listing = await this.bucket!.list({ prefix: `v1/${query.day}/batches/`, limit: 20, ...(query.after ? { startAfter: query.after } : {}) });
            const listed = listing.objects.map(o => o.key).filter(k => validCursor(k) && k.startsWith(`v1/${query.day}/batches/`));
            const keys = listed.filter(validKey);
            // Advance past manifests too, including pages containing only manifests.
            return json({ v: 1, keys, truncated: listing.truncated, nextAfter: listing.truncated ? listed.at(-1) ?? null : null });
          }
          const obj = await this.bucket!.get(query.key);
          if (!obj) return json({ error: 'not-found' }, 404);
          if (obj.size > 256_000) throw Error('size');
          const bytes = await obj.arrayBuffer();
          if (bytes.byteLength !== obj.size) throw Error('size');
          const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          try {
            for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 128_000) throw Error('size'); chunks.push(part.value); }
          } finally { await reader.cancel().catch(() => {}); }
          const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
          if (digest !== KEY.exec(query.key)![3]) throw Error('checksum');
          return json({ v: 1, batch: corridorHistory(JSON.parse(new TextDecoder().decode(raw))) });
        })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 5000); })]);
        return result;
      } finally { if (timer) clearTimeout(timer); }
    } catch { return json({ error: 'history-unavailable' }, 503); }
  }
}

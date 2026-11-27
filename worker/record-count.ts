/** How many records each saved answer held, shown on /v1/collection so a check fails on a source that
 *  saves empty answers instead of passing because saves happen (Control Center, Nov 26, 2026, after
 *  BUSDV2 saved 0 vehicles for hours). Counts only: no IDs, positions or text reach the status page. */
export interface RecordCount {
  /** When the counted answer was received. */
  at: number;
  /** Records in the readable answers; null when none of them could be read. */
  records: number | null;
  /** Answers of this kind inside one poll bundle, and how many of them failed. */
  answers?: number; failed?: number;
  /** Set when the answer was larger than COUNT_MAX_BYTES and left uncounted (it is still saved). */
  tooLarge?: true;
}

/** Counting decodes and parses the answer in Worker memory, so larger answers are not counted
 *  (Neon Nov27 a). The largest real JSON answers average about 2 MiB (hour ledgers, Nov 26 to 27). */
export const COUNT_MAX_BYTES = 16 * 1024 * 1024;

/** A list's length, or the summed lengths of an object's top-level lists ('@' keys such as JSON-LD
 *  @context left out). An object with no list is one record; an empty object, null or a bare value none. */
export function jsonRecords(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  const lists = Object.entries(value).filter(([key, item]) => !key.startsWith('@') && Array.isArray(item)) as [string, unknown[]][];
  if (lists.length) return lists.reduce((sum, [, item]) => sum + item.length, 0);
  return Object.keys(value).length ? 1 : 0;
}

/** RSS counts its items; JSON as above; anything else is unreadable (null). */
export function textRecords(text: string): number | null {
  const body = text.replace(/^﻿/, '').trimStart();
  if (body.startsWith('<')) return /<rss\b/i.test(body) ? (body.match(/<item\b/gi) ?? []).length : null;
  try { return jsonRecords(JSON.parse(body)); } catch { return null; }
}

interface BundleEntry { method?: unknown; source?: unknown; kind?: unknown; mode?: unknown; status?: unknown; text?: unknown }

/** Counts for one saved JSON answer. A poll bundle ({ responses: [...] }) is counted per kind of answer
 *  inside it, keyed `<stream>/<method, source or kind>[:mode]`; any other answer, and a bundle that cannot be
 *  read or holds no named answer, is keyed by its stream. */
export function countJson(stream: string, bytes: Uint8Array, at: number): Record<string, RecordCount> {
  if (bytes.byteLength > COUNT_MAX_BYTES) return { [stream]: { at, records: null, tooLarge: true } };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { [stream]: { at, records: null } }; }
  if (!stream.endsWith('-poll')) return { [stream]: { at, records: textRecords(text) } };
  let bundle: unknown;
  try { bundle = JSON.parse(text); } catch { return { [stream]: { at, records: null } }; }
  const entries = bundle && typeof bundle === 'object' && Array.isArray((bundle as { responses?: unknown }).responses)
    ? (bundle as { responses: BundleEntry[] }).responses : undefined;
  if (!entries) return { [stream]: { at, records: null } };
  const out: Record<string, RecordCount> = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const name = [entry.method ?? entry.source ?? entry.kind, entry.mode].filter(part => typeof part === 'string' && part).join(':');
    if (!name) continue;
    const count = out[`${stream}/${name}`] ??= { at, records: null, answers: 0, failed: 0 };
    count.answers!++;
    if (entry.status !== 'ok') { count.failed!++; continue; }
    // A base64 entry (bytes that are not UTF-8) is kept but cannot be counted.
    const records = typeof entry.text === 'string' ? textRecords(entry.text) : null;
    if (records !== null) count.records = (count.records ?? 0) + records;
  }
  // An empty bundle still replaces the last count, so the status page shows 0, not an old number.
  return Object.keys(out).length ? out : { [stream]: { at, records: 0 } };
}

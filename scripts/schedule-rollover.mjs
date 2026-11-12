// Schedule rollover gates (D68). Pure and offline-testable; aggregate numbers only.
// Plain Node runs this during preparation and deployment, so import only .ts files
// whose own imports carry extensions (schedule-compare imports only time.ts).
import { addDays } from '../src/domain/time.ts';
import { isServiceActive } from './schedule-compare.mjs';

// Mirrors worker/history-journal.ts ensureContext; tests/unit/scheduleRollover.test.ts keeps them equal.
export const CONTEXT_MAX_BYTES = 16_000_000, CONTEXT_PART_CHARS = 32_000;
/** Normal collection and archiving for about ten minutes while the deferred update lands. */
export const ROLLOVER_WRITE_HEADROOM = 600;
export const ROLLOVER_COVERAGE_DAYS = 7;
/** Physical SQLite growth exceeds the context's text bytes (rows, pages, manifest, indexes):
 * count the context twice and keep a fixed margin for collection while the update lands. */
export const ROLLOVER_DATABASE_FACTOR = 2, ROLLOVER_DATABASE_MARGIN_BYTES = 16_000_000;

/** Same chunking as ensureContext: 32,000 UTF-16 units, never splitting a surrogate pair. */
export function contextPartCount(body) {
  let parts = 0;
  for (let start = 0; start < body.length;) {
    let end = Math.min(start + CONTEXT_PART_CHARS, body.length);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xD800 && last <= 0xDBFF) end--;
    parts++; start = end;
  }
  return parts;
}

/** Corridor trips active on each service date from today through today + days; throws on any empty date. */
export function requireCoverage(ds, today, days = ROLLOVER_COVERAGE_DAYS) {
  if (!/^\d{8}$/.test(today ?? '')) throw new Error('rollover-coverage-date');
  const perDate = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    perDate.push(ds.trips.filter(t => isServiceActive(ds.calendars[t.serviceId], date)).length);
  }
  if (perDate.some(n => n <= 0)) throw new Error('rollover-coverage-gap');
  return { from: today, to: addDays(today, days), minTripsPerDate: Math.min(...perDate) };
}

/**
 * Refuses unless the running collector can admit the new context exactly as ensureContext
 * will (bytes, journal bytes, database bytes, daily write units) with headroom to spare.
 * `checkpoint` is an enabledCheckpoint() result from the CURRENT enabled collector.
 */
export function rolloverCapacity(checkpoint, text) {
  const whole = n => Number.isSafeInteger(n) && n >= 0;
  const bytes = Buffer.byteLength(text), parts = contextPartCount(text), writeUnits = 2 * parts + 4;
  const c = checkpoint;
  if (!c || !['bytes', 'byteLimit', 'databaseByteLimit', 'reservedWrites', 'dailyWriteReservationLimit'].every(k => whole(c[k]))
    || (c.databaseBytes !== undefined && !whole(c.databaseBytes))) throw new Error('rollover-capacity-unknown');
  const summary = { contextBytes: bytes, contextParts: parts, contextWriteUnits: writeUnits, contextByteLimit: CONTEXT_MAX_BYTES,
    journalBytes: c.bytes, journalByteLimit: c.byteLimit, databaseBytes: c.databaseBytes ?? null, databaseHeadroomBytes: ROLLOVER_DATABASE_FACTOR * bytes + ROLLOVER_DATABASE_MARGIN_BYTES, databaseByteLimit: c.databaseByteLimit,
    reservedWrites: c.reservedWrites, writeHeadroom: ROLLOVER_WRITE_HEADROOM, dailyWriteReservationLimit: c.dailyWriteReservationLimit };
  const ok = bytes <= CONTEXT_MAX_BYTES && c.bytes + bytes <= c.byteLimit
    && (c.databaseBytes === undefined || c.databaseBytes + ROLLOVER_DATABASE_FACTOR * bytes + ROLLOVER_DATABASE_MARGIN_BYTES < c.databaseByteLimit)
    && c.reservedWrites + writeUnits + ROLLOVER_WRITE_HEADROOM <= c.dailyWriteReservationLimit;
  return { ok, summary };
}

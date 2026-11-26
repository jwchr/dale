// Schedule rollover gates (D68). Pure and offline-testable; aggregate numbers only.
// Plain Node runs this during preparation and deployment, so import only .ts files
// whose own imports carry extensions (schedule-compare imports only time.ts).
import { addDays } from '../src/domain/time.ts';
import { isServiceActive } from './schedule-compare.mjs';

// Mirrors worker/history-journal.ts ensureContext; tests/unit/scheduleRollover.test.ts keeps them equal.
export const CONTEXT_MAX_BYTES = 16_000_000, CONTEXT_PART_CHARS = 32_000;
/** Normal collection and archiving for about ten minutes while the deferred update lands. */
export const ROLLOVER_WRITE_HEADROOM = 600;
/** D82: NJ Transit's weekly file can end about six days out; five days ahead still leaves a daily retry window. */
export const ROLLOVER_COVERAGE_DAYS = 5;
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

/**
 * Last regular end date of any corridor trip's calendar. One-off added dates (a holiday run) are left out:
 * they say nothing about whether the regular week is covered. So is a calendar that runs on no weekday
 * (a holiday-only service): its end date can sit far out without any regular trips (Neon Nov25 j).
 */
export function lastServiceDate(ds) {
  let last = '';
  for (const t of ds.trips) {
    const cal = ds.calendars[t.serviceId];
    if (cal?.end && cal.days?.some(Boolean) && (!cal.start || cal.start <= cal.end) && cal.end > last) last = cal.end; // inverted range runs no day (Neon Nov25 k)
  }
  return last;
}

/**
 * Corridor trips active on each service date from today through today + days; throws on any empty date.
 * A file that reaches a full week out is checked on all seven weekdays (Neon Nov24 h): five days ahead
 * alone skips Sunday when run on Monday, and Saturday when run on Sunday.
 */
export function requireCoverage(ds, today, days = ROLLOVER_COVERAGE_DAYS) {
  if (!/^\d{8}$/.test(today ?? '')) throw new Error('rollover-coverage-date');
  const span = Math.max(days, lastServiceDate(ds) >= addDays(today, 6) ? 6 : days);
  const perDate = [];
  for (let i = 0; i <= span; i++) {
    const date = addDays(today, i);
    perDate.push(ds.trips.filter(t => isServiceActive(ds.calendars[t.serviceId], date)).length);
  }
  if (perDate.some(n => n <= 0)) throw new Error('rollover-coverage-gap');
  return { from: today, to: addDays(today, span), minTripsPerDate: Math.min(...perDate) };
}

/** Refuses a new file that ends before the live one (Neon Nov24 h): the live file stays, and the next daily run retries. */
export function requireNoShorter(current, next) {
  const currentEnd = lastServiceDate(current), nextEnd = lastServiceDate(next);
  if (nextEnd < currentEnd) throw new Error('rollover-would-shorten');
  return { currentEnd, nextEnd };
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

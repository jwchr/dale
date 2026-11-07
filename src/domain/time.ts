// Service-day time handling. GTFS times count from "noon minus 12 hours" on the service date in the
// agency timezone, so 25:10:00 is 1:10 AM the next calendar day. A printed timetable instead gives
// wall-clock times, which differ from the GTFS reading on the nights the clocks change.

/** Intl formatters are slow to build and are needed thousands of times per timetable: build each once. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, options)));
  return f;
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
export function tzOffsetMinutes(instant: number, timeZone: string): number {
  const parts = formatter(`offset|${timeZone}`, 'en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - (instant - (instant % 1000))) / 60000);
}

/**
 * Epoch ms of local wall-clock time y-m-d h:m in `timeZone`. Around a clock change it follows the
 * usual "compatible" rule: a repeated time (fall back) is the first one; a skipped time (spring
 * forward) moves forward by the gap, so 2:10 AM becomes 3:10 AM.
 */
export function zonedWallTime(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Offsets a day either side: far enough to straddle the instant even in zones up to UTC±14.
  const before = guess - tzOffsetMinutes(guess - 24 * 3600_000, timeZone) * 60000;
  const after = guess - tzOffsetMinutes(guess + 24 * 3600_000, timeZone) * 60000;
  const shows = (t: number) => t + tzOffsetMinutes(t, timeZone) * 60000 === guess;
  const valid = [before, after].filter(shows);
  return valid.length ? Math.min(...valid) : before;
}

export function parseYmd(ymd: string): [number, number, number] {
  return [Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)), Number(ymd.slice(6, 8))];
}

/** How a dataset's service-day seconds read: GTFS "noon minus 12 h", or printed wall-clock time. */
export type TimeBase = 'gtfs' | 'wall';

/**
 * Epoch ms for a service-day time. 'gtfs': seconds since noon minus 12 h on the service date.
 * 'wall': the clock time printed, so 25:10 is 1:10 AM on the next calendar day whatever the clocks did.
 */
export function serviceTimeToInstant(serviceDate: string, seconds: number, timeZone: string, base: TimeBase = 'gtfs'): number {
  if (base === 'wall') {
    const [y, m, d] = parseYmd(addDays(serviceDate, Math.floor(seconds / 86400)));
    const rest = seconds % 86400;
    return zonedWallTime(y, m, d, Math.floor(rest / 3600), Math.floor((rest % 3600) / 60), timeZone) + (rest % 60) * 1000;
  }
  const [y, m, d] = parseYmd(serviceDate);
  const noon = zonedWallTime(y, m, d, 12, 0, timeZone);
  return noon - 12 * 3600_000 + seconds * 1000;
}

/** Whether the clocks go back or ahead between two instants (a ride through the 2 AM change); undefined if neither. */
export function clockChangeBetween(from: number, to: number, timeZone: string): 'back' | 'ahead' | undefined {
  const a = tzOffsetMinutes(from, timeZone);
  const b = tzOffsetMinutes(to, timeZone);
  return b < a ? 'back' : b > a ? 'ahead' : undefined;
}

/** Local wall-clock hour (0-23) of an instant, correct on clock-change days. */
export function localHour(instant: number, timeZone: string): number {
  return Number(formatter(`hour|${timeZone}`, 'en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(instant))) % 24;
}

/** YYYYMMDD of the local calendar date of `instant` in `timeZone`. */
export function localYmd(instant: number, timeZone: string): string {
  const s = formatter(`ymd|${timeZone}`, 'en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
  return s.replaceAll('-', '');
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = parseYmd(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Day of week for YYYYMMDD: 0 = Monday .. 6 = Sunday (GTFS calendar order). */
export function weekdayIndex(ymd: string): number {
  const [y, m, d] = parseYmd(ymd);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** "7:05 AM" in the agency timezone; 12-hour clock in both languages per owner decision D05. */
export function formatTime12(instant: number, timeZone: string, lang: 'en' | 'es' = 'en'): string {
  return formatter(`time|${timeZone}|${lang}`, lang === 'es' ? 'es-US' : 'en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(instant))
    .replace(/ | /g, ' ');
}

/** "HH:MM:SS" (possibly >= 24) to seconds. */
export function parseGtfsTime(s: string): number {
  const match = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(s.trim());
  const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  if (!Number.isSafeInteger(seconds)) throw new Error('Invalid GTFS time');
  return seconds;
}

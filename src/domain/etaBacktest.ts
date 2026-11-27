// True ETA research (#102): reconstruct observed stop arrivals from official history samples and
// compare simple delay baselines on held-out days. Research only: nothing here reaches riders.
// Each prediction uses only service days strictly before the day it predicts, so no future data leaks.
import type { VehicleObservation } from './lock';

/** One observed arrival at a stop, bounded by the samples around it. */
export interface ObservedArrival {
  tripInstanceId: string;
  stopIndex: number;
  stopId: string;
  /** First official sample reporting the bus stopped at this stop. */
  observedAt: number;
  /** Latest earlier sample of the same trip that was not stopped here; the arrival lies after it. Undefined when none. */
  notBefore?: number;
}

/** Reconstruct arrivals from explicit official stop calls only. Positions without a stop call never become arrivals. */
export function observedArrivals(samples: readonly VehicleObservation[]): ObservedArrival[] {
  const byTrip = new Map<string, VehicleObservation[]>();
  for (const s of samples) {
    const list = byTrip.get(s.tripInstanceId);
    if (list) list.push(s); else byTrip.set(s.tripInstanceId, [s]);
  }
  const out: ObservedArrival[] = [];
  for (const [trip, list] of byTrip) {
    list.sort((a, b) => a.observedAt - b.observedAt);
    const seen = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const call = list[i]!.stopCall;
      if (!call || call.status !== 'stopped_at' || seen.has(call.stopIndex)) continue;
      seen.add(call.stopIndex);
      let notBefore: number | undefined;
      for (let j = i - 1; j >= 0; j--) {
        const earlier = list[j]!;
        // Only an explicit stop call elsewhere (or approaching this stop) proves the bus had not arrived; a sample
        // without one is unknown, so it is skipped rather than used as a lower bound.
        if (earlier.stopCall && earlier.observedAt < list[i]!.observedAt) { notBefore = earlier.observedAt; break; }
      }
      out.push({ tripInstanceId: trip, stopIndex: call.stopIndex, stopId: call.stopId, observedAt: list[i]!.observedAt, ...(notBefore !== undefined ? { notBefore } : {}) });
    }
  }
  return out;
}

/** A scheduled-vs-observed pair, grouped by a caller-chosen key such as "165|stop|weekday|17". */
export interface DelaySample {
  key: string;
  /** YYYY-MM-DD service date in the agency timezone. */
  serviceDate: string;
  scheduledAt: number;
  observedAt: number;
}

export type Baseline = 'schedule' | 'rolling28' | 'allHistory';
export const BASELINES: readonly Baseline[] = ['schedule', 'rolling28', 'allHistory'];
/** Fewer earlier days than this and a history baseline abstains instead of guessing. */
export const MIN_HISTORY = 5;

export interface BaselineScore {
  baseline: Baseline;
  predicted: number;
  abstained: number;
  /** Mean, median and 90th-percentile absolute error, in seconds; null when nothing was predicted. */
  mae: number | null;
  medianAbs: number | null;
  p90Abs: number | null;
  /** Share of predicted samples whose observed delay fell inside the 10th-90th percentile interval; null for schedule or no intervals. */
  coverage80: number | null;
}

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY_MS;

/** Linear-interpolated quantile of an already sorted list. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) throw new Error('empty');
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** A real calendar date in YYYY-MM-DD form; rejects shapes like 2026-02-30 that Date.UTC would roll over. */
function realDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Score each baseline on every sample, chronologically: only strictly earlier service days inform a prediction. */
export function backtest(samples: readonly DelaySample[]): BaselineScore[] {
  const valid = samples.filter(s => realDate(s.serviceDate) && Number.isFinite(s.scheduledAt) && Number.isFinite(s.observedAt));
  const byKey = new Map<string, { day: number; delay: number }[]>();
  for (const s of valid) {
    const list = byKey.get(s.key) ?? [];
    list.push({ day: dayNumber(s.serviceDate), delay: (s.observedAt - s.scheduledAt) / 1000 });
    byKey.set(s.key, list);
  }
  return BASELINES.map(baseline => {
    const errors: number[] = [];
    let abstained = 0, inside = 0, intervals = 0;
    for (const list of byKey.values()) {
      for (const target of list) {
        if (baseline === 'schedule') { errors.push(Math.abs(target.delay)); continue; }
        const history = list.filter(h => h.day < target.day && (baseline === 'allHistory' || target.day - h.day <= 28))
          .map(h => h.delay).sort((a, b) => a - b);
        // MIN_HISTORY counts earlier service days, not samples: five trips from one day are one day (Neon DEEP Nov 26, C1-10).
        if (new Set(list.filter(h => h.day < target.day && (baseline === 'allHistory' || target.day - h.day <= 28)).map(h => h.day)).size < MIN_HISTORY) { abstained++; continue; }
        errors.push(Math.abs(target.delay - quantile(history, 0.5)));
        intervals++;
        if (target.delay >= quantile(history, 0.1) && target.delay <= quantile(history, 0.9)) inside++;
      }
    }
    errors.sort((a, b) => a - b);
    return {
      baseline, predicted: errors.length, abstained,
      mae: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
      medianAbs: errors.length ? quantile(errors, 0.5) : null,
      p90Abs: errors.length ? quantile(errors, 0.9) : null,
      coverage80: intervals ? inside / intervals : null,
    };
  });
}

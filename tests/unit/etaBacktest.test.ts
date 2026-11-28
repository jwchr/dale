import { describe, expect, it } from 'vitest';
import { backtest, observedArrivals, quantile, MIN_HISTORY, type DelaySample } from '../../src/domain/etaBacktest';
import type { VehicleObservation } from '../../src/domain/lock';

const obs = (t: number, stopIndex?: number): VehicleObservation => ({
  tripInstanceId: 'T1@2026-11-02', vehicleId: '5001', observedAt: t, lat: 40.9, lon: -74.0,
  ...(stopIndex !== undefined ? { stopCall: { stopId: `S${stopIndex}`, stopIndex, status: 'stopped_at' as const } } : {}),
});

describe('observedArrivals', () => {
  it('takes the first explicit stop call and bounds it by the previous other sample', () => {
    const got = observedArrivals([obs(3000, 2), obs(1000), obs(4000, 2), obs(2000, 1), obs(5000)]);
    expect(got).toEqual([
      // The 1000 sample has no stop status, so it does not bound the first arrival.
      { tripInstanceId: 'T1@2026-11-02', stopIndex: 1, stopId: 'S1', observedAt: 2000 },
      { tripInstanceId: 'T1@2026-11-02', stopIndex: 2, stopId: 'S2', observedAt: 3000, notBefore: 2000 },
    ]);
  });
  it('never turns a plain position into an arrival', () => {
    expect(observedArrivals([obs(1000), obs(2000)])).toEqual([]);
  });
  it('leaves the lower bound unknown when the first sample is already at the stop', () => {
    expect(observedArrivals([obs(1000, 4)])[0]).not.toHaveProperty('notBefore');
  });
});

describe('quantile', () => {
  it('interpolates', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(() => quantile([], 0.5)).toThrow();
  });
});

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;
const sample = (n: number, delaySec: number, key = 'k'): DelaySample => ({ key, serviceDate: day(n), scheduledAt: 0, observedAt: delaySec * 1000 });

describe('backtest', () => {
  it('needs five earlier service days, not five samples from one day (Neon DEEP Nov 26, C1-10)', () => {
    // Six trips a day under one key: day 2 has six earlier samples but only one earlier day.
    const samples = [1, 2, 3, 4, 5, 6].flatMap(d => Array.from({ length: 6 }, () => sample(d, 60)));
    const [, rolling] = backtest(samples);
    expect(rolling).toMatchObject({ predicted: 6, abstained: 30 });
  });
  it('uses only strictly earlier days and abstains without enough history', () => {
    // Steady 120 s late every day: history baselines learn it, schedule does not.
    const samples = Array.from({ length: 10 }, (_, i) => sample(i + 1, 120));
    const [schedule, rolling, all] = backtest(samples);
    expect(schedule).toMatchObject({ baseline: 'schedule', predicted: 10, abstained: 0, mae: 120 });
    expect(rolling).toMatchObject({ baseline: 'rolling28', predicted: 10 - MIN_HISTORY, abstained: MIN_HISTORY, mae: 0, coverage80: 1 });
    expect(all).toMatchObject({ predicted: 10 - MIN_HISTORY, mae: 0 });
  });
  it('does not leak a same-day or later observation into a prediction', () => {
    // Days 1-5 on time, day 6 has two samples 600 s late: each is predicted from days 1-5 only.
    const samples = [...Array.from({ length: 5 }, (_, i) => sample(i + 1, 0)), sample(6, 600), sample(6, 600)];
    const rolling = backtest(samples)[1]!;
    expect(rolling).toMatchObject({ predicted: 2, mae: 600, coverage80: 0 });
  });
  it('rolling window forgets days older than 28 and keys never mix', () => {
    const old = Array.from({ length: 5 }, (_, i) => ({ ...sample(1, 900), serviceDate: `2026-09-0${i + 1}` }));
    const recent = Array.from({ length: 5 }, (_, i) => sample(i + 10, 60));
    const target = sample(20, 60);
    const other = Array.from({ length: 6 }, (_, i) => sample(i + 1, 3000, 'other'));
    const [, rolling, all] = backtest([...old, ...recent, target, ...other]);
    // Rolling: the target sees only the 5 recent days (median 60), exact.
    expect(rolling!.medianAbs).toBe(0);
    // All history mixes in the 900 s days, so its median for the target differs.
    expect(all!.predicted).toBeGreaterThan(rolling!.predicted);
  });
  it('drops malformed samples and returns null metrics when nothing is predicted', () => {
    const scores = backtest([{ key: 'k', serviceDate: 'bad', scheduledAt: 0, observedAt: 0 }, ...Array.from({ length: 6 }, () => ({ key: 'k', serviceDate: '2026-02-30', scheduledAt: 0, observedAt: 0 }))]);
    expect(scores.every(s => s.predicted === 0 && s.mae === null && s.coverage80 === null)).toBe(true);
  });
});

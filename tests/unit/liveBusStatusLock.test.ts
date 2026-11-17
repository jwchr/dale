import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveBusStatus } from '../../src/ui/LiveBusStatus';
import { strings } from '../../src/ui/i18n';
import { mapStrings } from '../../src/ui/mapStrings';
import { LIVE_SOURCE } from '../../src/domain/liveBus';

const now = 1_800_000_000_000;
const dep = { tripInstanceId: 't@20270115', stopIndex: 0, tripId: 't', serviceDate: '20270115', pattern: { stopIds: ['a', 'b'] }, route: {} };
const report = (vehicleId: string, ageMs: number) => ({ tripInstanceId: dep.tripInstanceId, vehicleId, observedAt: now - ageMs, lat: 40, lon: -74 });
const render = (lockVehicleId: string | undefined, observations: ReturnType<typeof report>[]) => renderToStaticMarkup(createElement(LiveBusStatus, {
  state: 'available', dep: dep as never, now, t: strings.en, lang: 'en', tz: 'America/New_York', lockStatus: 'stale', lockVehicleId,
  snapshot: { v: 1, source: LIVE_SOURCE, feedVersion: 'x', tripInstanceId: dep.tripInstanceId, receivedAt: now - 5000, vehicles: { state: 'ok' }, updates: { state: 'unavailable' }, observations, predictions: [], skippedStops: [] } as never,
}));

describe('LiveBusStatus with a locked bus', () => {
  it('never shows a declined bus as live', () => {
    // Locked on A; the rider just declined B, which is the only fresh report on the trip.
    const html = render('A', [report('B', 10_000), report('A', 600_000)]);
    expect(html).not.toContain('live-glow');
    expect(html).toContain(strings.en.live.missing);
    expect(html).not.toContain(strings.en.live.age(10));
  });
  it('still shows the locked bus live', () => {
    expect(render('A', [report('A', 10_000), report('B', 5_000)])).toContain('live-glow');
  });
});

describe('line diagram gap', () => {
  it('uses the singular for one hidden stop', () => {
    expect(mapStrings.en.between(1)).toBe('1 other listed stop');
    expect(mapStrings.es.between(1)).toBe('1 otra parada indicada');
    expect(mapStrings.en.between(2)).toBe('2 other listed stops');
  });
});

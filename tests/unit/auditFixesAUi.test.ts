import { beforeEach, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { createBusSession } from '../../src/domain/busLock';
import { departuresOn } from '../../src/domain/schedule';
import type { Fix, Milestone } from '../../src/domain/tripProgress';
import { BusLockPanel } from '../../src/ui/BusLockPanel';
import { StripMap } from '../../src/ui/StripMap';
import { strings } from '../../src/ui/i18n';
import { liveDataset } from '../helpers/liveBus';

// Exercise the actual component/effect with queued state updates, as React batches
// updates in one effect. This does not claim browser or physical GPS validation.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0,
  pending: [] as (() => void)[], effects: [] as (() => void)[],
  phone: undefined as Fix | undefined,
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useMemo: (factory: () => unknown) => factory(),
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {
      hooks.pending.push(() => {
        hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
      });
    }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock('../../src/ui/usePhoneFix', () => ({ usePhoneFix: (enabled: boolean) => ({ phone: enabled ? hooks.phone : undefined, gps: 'on' }) }));
vi.mock('../../src/ui/useRouteGeometry', () => ({ useRouteGeometry: () => undefined }));
vi.mock('../../src/ui/useScreenWakeLock', () => ({ useScreenWakeLock: () => ({ status: 'off' }) }));
vi.mock('../../src/ui/StreetMap', () => ({ StreetMap: () => null }));
vi.mock('../../src/ui/WaitingMap', () => ({ WaitingMap: () => null }));
vi.mock('../../src/ui/RideMode', () => ({ RideMode: () => null }));
vi.mock('../../src/ui/SkinBackdrop', () => ({ mapIsDark: () => false }));

beforeEach(() => {
  hooks.states = []; hooks.stateIndex = 0; hooks.pending = []; hooks.effects = []; hooks.phone = undefined;
});

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

it('ranks nearest stops in meters', () => {
  const ds = structuredClone(liveDataset);
  // Independent small-angle spherical fixture: north=100 m, east=90 m at this latitude.
  // The assertion concerns ranking, with ample margin for the approximation.
  const lat = 40.8, lon = -74, metersPerDegree = Math.PI * 6371000 / 180;
  ds.stops = [
    { id: 'A', name: 'Stop A', lat: lat - 100 / metersPerDegree, lon },
    { id: 'B', name: 'Stop B', lat, lon: lon - 90 / (metersPerDegree * Math.cos(lat * Math.PI / 180)) },
    { id: 'off-trip', name: 'Unserved closer stop', lat, lon },
    { id: 'unknown', name: 'Stop with no location' },
  ];
  ds.patterns = [{ ...ds.patterns[0]!, stopIds: ['A', 'B', 'unknown'] }];
  ds.trips = [{ ...ds.trips[0]!, patternId: ds.patterns[0]!.id, times: [30000, 30600, 31200] }];
  const dep = departuresOn(ds, { stopId: 'A', date: '20261104' })[0]!;
  const session = createBusSession(dep, dep.departs, 'nearest-test');
  session.lock.last = { tripInstanceId: dep.tripInstanceId, vehicleId: 'synthetic', observedAt: dep.departs, lat, lon };
  const view = BusLockPanel({
    ds, session, alightIndex: 2, now: dep.departs, t: strings.en, lang: 'en', keepAwake: false,
    onKeepAwake: vi.fn(), onEvent: vi.fn(), onAdvanceDemo: vi.fn(), onUnlock: vi.fn(),
    gateText: () => undefined, badge: () => null, onOpenBackup: vi.fn(), onAlternatives: vi.fn(), onPenn: vi.fn(),
  });
  expect(text(view)).toContain(strings.en.busLock.near('Stop B'));
  expect(text(view)).not.toContain(strings.en.busLock.near('Stop A'));
  expect(text(view)).not.toContain(strings.en.busLock.near('Unserved closer stop'));
});

it('retains simultaneous GPS milestones', () => {
  const ds = structuredClone(liveDataset);
  ds.stops = ['A', 'B', 'C', 'D'].map((id, i) => ({ id, name: id, lat: 40.8 + i * .01, lon: -74 }));
  ds.patterns = [{ ...ds.patterns[0]!, stopIds: ['A', 'B', 'C', 'D'] }];
  ds.trips = [{ ...ds.trips[0]!, patternId: ds.patterns[0]!.id, times: [30000, 30600, 31200, 31800] }];
  const dep = departuresOn(ds, { stopId: 'A', date: '20261104' })[0]!;
  const now = dep.departs + 1200_000;
  const session = createBusSession(dep, now, 'milestones-audit-test');
  session.lock.status = 'tracked';
  session.lock.last = { tripInstanceId: dep.tripInstanceId, vehicleId: 'synthetic', observedAt: now - 1000, lat: ds.stops[1]!.lat!, lon: -74 };
  hooks.phone = { lat: ds.stops[2]!.lat!, lon: -74, at: now, accuracyM: 10 };
  hooks.states[0] = { milestones: [], follow: true };
  const render = () => {
    hooks.stateIndex = 0;
    StripMap({ ds, session, alightIndex: 3, now, t: strings.en, lang: 'en' });
    for (const effect of hooks.effects.splice(0)) effect();
    for (const update of hooks.pending.splice(0)) update();
  };
  const expected: Milestone[] = [
    { index: 1, at: now - 1000, source: 'bus_gps' },
    { index: 2, at: now, source: 'phone_gps' },
  ];
  render();
  expect(hooks.states[0]).toMatchObject({ milestones: expected, follow: true });
  expect(hooks.pending).toEqual([]);
  hooks.states = []; // New component instance must initialize from the per-session kept map.
  render();
  expect(hooks.states[0]).toMatchObject({ milestones: expected, follow: true });
  hooks.phone = { ...hooks.phone, lat: ds.stops[1]!.lat!, at: now + 1 };
  render();
  expect(hooks.states[0]).toMatchObject({ milestones: expected });

  // Both fixes at the same new stop produce one milestone in this effect run.
  session.id = 'milestones-audit-same-stop';
  hooks.states = [{ milestones: [], follow: true }];
  render();
  expect(hooks.states[0]).toMatchObject({ milestones: [expected[0]] });
});

it('keeps the phone mark when the bus fix is already further along', () => {
  const ds = structuredClone(liveDataset);
  ds.stops = ['A', 'B', 'C', 'D'].map((id, i) => ({ id, name: id, lat: 40.8 + i * .01, lon: -74 }));
  ds.patterns = [{ ...ds.patterns[0]!, stopIds: ['A', 'B', 'C', 'D'] }];
  ds.trips = [{ ...ds.trips[0]!, patternId: ds.patterns[0]!.id, times: [30000, 30600, 31200, 31800] }];
  const dep = departuresOn(ds, { stopId: 'A', date: '20261104' })[0]!;
  const now = dep.departs + 1200_000;
  const session = createBusSession(dep, now, 'milestones-bus-ahead');
  session.lock.status = 'tracked';
  session.lock.last = { tripInstanceId: dep.tripInstanceId, vehicleId: 'synthetic', observedAt: now, lat: ds.stops[2]!.lat!, lon: -74 };
  hooks.phone = { lat: ds.stops[1]!.lat!, lon: -74, at: now, accuracyM: 10 };
  hooks.states[0] = { milestones: [], follow: true };
  hooks.stateIndex = 0;
  StripMap({ ds, session, alightIndex: 3, now, t: strings.en, lang: 'en' });
  for (const effect of hooks.effects.splice(0)) effect();
  for (const update of hooks.pending.splice(0)) update();
  expect(hooks.states[0]).toMatchObject({ milestones: [
    { index: 2, at: now, source: 'bus_gps' },
    { index: 1, at: now, source: 'phone_gps' },
  ] });
});

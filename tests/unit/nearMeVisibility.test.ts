import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { demoDataset } from '../../src/data/demo';
import type { Dataset } from '../../src/domain/types';
import { NearMe } from '../../src/ui/NearMe';
import { strings } from '../../src/ui/i18n';

// Run the real component's effects with persistent refs and React's cleanup order.
// No DOM/browser claim: this tests permission-request counts and stale callback handling.
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], refIndex: 0, effectIndex: 0,
  dependencies: [] as unknown[][],
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (void | (() => void))[],
  pending: [] as number[], state: undefined as unknown,
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useState: (initial: unknown) => [hooks.state ??= initial, (next: unknown) => { hooks.state = next; }],
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const i = hooks.effectIndex++, previous = hooks.dependencies[i];
    if (!previous || dependencies.some((value, j) => !Object.is(value, previous[j]))) hooks.pending.push(i);
    hooks.dependencies[i] = dependencies;
    hooks.effects[i] = effect;
  },
}));

const locate = vi.fn<(success: PositionCallback, error: PositionErrorCallback) => void>();
beforeEach(() => {
  hooks.refs = []; hooks.dependencies = []; hooks.effects = []; hooks.cleanups = []; hooks.pending = [];
  hooks.state = undefined;
  locate.mockReset();
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: locate } });
  vi.stubGlobal('document', { activeElement: { id: 'stop-search' }, body: {} });
});
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup?.();
  vi.unstubAllGlobals();
});

function flushEffects(indices: number[]) {
  for (const i of indices) hooks.cleanups[i]?.();
  for (const i of indices) hooks.cleanups[i] = hooks.effects[i]!();
}
function render(ds: Dataset, visible: boolean, lang: 'en' | 'es', autoAsk = true) {
  hooks.refIndex = 0; hooks.effectIndex = 0;
  NearMe({ ds, visible, t: strings[lang], autoAsk, onPick: () => {} });
  flushEffects(hooks.pending.splice(0));
}
const refresh = (ds: Dataset) => ({ ...ds, stops: [...ds.stops] });

for (const lang of ['en', 'es'] as const) {
  it(`defers late stop data and every hidden refresh until the same dataset is shown (${lang})`, async () => {
    const withoutLocations = { ...demoDataset, stops: demoDataset.stops.map(({ lat: _lat, lon: _lon, ...stop }) => stop) };
    render(withoutLocations, true, lang);
    await Promise.resolve();
    render(demoDataset, false, lang);
    await Promise.resolve();
    const latest = refresh(demoDataset);
    render(latest, false, lang);
    await Promise.resolve();
    expect(locate).not.toHaveBeenCalled();
    render(latest, true, lang);
    await Promise.resolve();
    expect(locate).toHaveBeenCalledOnce();
    render(latest, false, lang); render(latest, true, lang);
    await Promise.resolve();
    expect(locate).toHaveBeenCalledOnce();
  });

  it(`does not consume a queued shortcut when hidden before its microtask (${lang})`, async () => {
    render(demoDataset, true, lang);
    render(demoDataset, false, lang);
    await Promise.resolve();
    expect(locate).not.toHaveBeenCalled();
    render(demoDataset, true, lang);
    await Promise.resolve();
    expect(locate).toHaveBeenCalledOnce();
  });

  it(`does not retry an unfinished request on a hidden refresh or accept its late result (${lang})`, async () => {
    render(demoDataset, true, lang);
    await Promise.resolve();
    const latest = refresh(demoDataset);
    render(latest, false, lang);
    await Promise.resolve();
    expect(locate).toHaveBeenCalledOnce();
    locate.mock.calls[0]![0]({ coords: { latitude: 40.8701, longitude: -74.04, accuracy: 25 } } as GeolocationPosition);
    expect(hooks.state).toEqual({ status: 'idle' });
    render(latest, true, lang);
    await Promise.resolve();
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it(`asks once under StrictMode replay, then never repeats a denied shortcut (${lang})`, async () => {
    render(demoDataset, true, lang);
    flushEffects(hooks.effects.map((_, i) => i));
    await Promise.resolve();
    expect(locate).toHaveBeenCalledOnce();
    locate.mock.calls[0]![1]({ code: 1 } as GeolocationPositionError);
    expect(hooks.state).toEqual({ status: 'denied' });
    render(refresh(demoDataset), false, lang);
    render(demoDataset, true, lang);
    await Promise.resolve();
    expect(locate).toHaveBeenCalledOnce();
  });

  it(`never asks automatically without a shortcut, even after a hidden refresh (${lang})`, async () => {
    render(demoDataset, false, lang, false);
    render(refresh(demoDataset), true, lang, false);
    await Promise.resolve();
    expect(locate).not.toHaveBeenCalled();
  });
}

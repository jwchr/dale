import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommutePicker, FavoriteCommutePicker } from '../../src/ui/CommutePicker';
import { changeFavoriteStops } from '../../src/domain/cityStops';
import { returnLeg } from '../../src/domain/direction';
import { favoriteLeg, loadFavorites, saveFavorites, type Favorite } from '../../src/domain/favorites';
import { compareCommute, favoriteKey } from '../../src/domain/commuteChanges';
import { CommuteChanges } from '../../src/ui/CommuteChanges';
import { parseDataset } from '../../src/domain/dataset';
import { strings } from '../../src/ui/i18n';
import { cityDataset, missingReturnDataset } from '../helpers/cityStops';

describe('saved-stop recovery', () => {
  for (const lang of ['en', 'es'] as const) for (const end of ['from', 'to'] as const) {
    it(`${lang}/${end}: opens city choices when the saved stop is absent`, () => {
      const ds = cityDataset(), t = strings[lang];
      const html = renderToStaticMarkup(createElement(CommutePicker, {
        ds, t, lang, initialFrom: end === 'from' ? 'absent' : '1', initialTo: end === 'to' ? 'absent' : '3',
        routeIds: [], end, level: 'stop', onSave: () => false, onCancel: () => {},
      }));
      expect(html).toContain(`${end === 'from' ? t.commuteFrom : t.commuteToLabel}: ${t.cityPicker.city}`);
      expect(html).toContain('city-choice');
      expect(html).toContain(t.cityPicker.cancel);
    });
  }
});

const favorite: Favorite = { id: 'saved-trip', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: [],
  leave: { out: { walkMin: 7, cushionMin: 2 }, back: { walkMin: 3, cushionMin: 1 } } };

describe('reversed favorite recovery', () => {
  it('provides a valid schedule that can load the recovery flow', () => {
    const ds = missingReturnDataset();
    expect(parseDataset(ds)).toBe(ds);
    expect(returnLeg(ds, favorite.fromStopId, favorite.toStopId, favorite.routeIds)).toBeUndefined();
  });

  for (const lang of ['en', 'es'] as const) it(`${lang}: opens a usable picker and saves a return without changing the forward leg`, () => {
    const ds = missingReturnDataset(), onSaved = vi.fn(), original = structuredClone(favorite);
    expect(returnLeg(ds, favorite.fromStopId, favorite.toStopId, favorite.routeIds)).toBeUndefined();
    const picker = FavoriteCommutePicker({ ds, favorite, reversed: true, t: strings[lang], lang,
      end: 'from', level: 'stop', onCancel: () => {}, onSaved });
    expect(picker.type).toBe(CommutePicker);
    const props = picker.props as Parameters<typeof CommutePicker>[0];
    expect([props.initialFrom, props.initialTo]).toEqual(['3', '2']);
    const html = renderToStaticMarkup(picker);
    expect(html).toContain('commute-picker');
    expect(html).toContain('PORT AUTHORITY BUS TERMINAL');
    expect(html).toContain(strings[lang].cityPicker.cancel);
    expect(onSaved).not.toHaveBeenCalled();
    expect(props.onSave('3', '1')).toBe(true);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ ...favorite, returnStops: { fromStopId: '3', toStopId: '1' } }, true);
    const saved = onSaved.mock.calls[0]![0] as Favorite;
    let raw = '';
    saveFavorites({ setItem: (_key, value) => { raw = value; } }, [saved]);
    expect(loadFavorites({ getItem: () => raw })).toEqual([saved]);
    expect(favoriteLeg(ds, saved, false)).toEqual({ fromStopId: '2', toStopId: '3', routeIds: [] });
    expect(favoriteLeg(ds, saved, true)).toEqual({ fromStopId: '3', toStopId: '1', routeIds: [] });
    const reopened = FavoriteCommutePicker({ ...props, favorite: saved, reversed: true, onSaved });
    expect(reopened.props).toMatchObject({ initialFrom: '3', initialTo: '1' });
    // The briefing and home use the same saved pair, even though it cannot be inferred.
    const briefing = renderToStaticMarkup(createElement(CommuteChanges, {
      ds, now: Date.parse('2026-11-04T11:00:00Z'), t: strings[lang], lang, tz: ds.meta.timezone,
      notices: [], favorites: [saved], durable: true, reversedIds: new Set([saved.id]),
      dismiss: async () => {}, onTimetable: () => {}, onReselect: () => {},
    }));
    expect(briefing).toContain(strings[lang].commuteChanges.briefing.timetable);
    expect(briefing).not.toContain(strings[lang].commuteChanges.briefing.reselect);
    expect(favorite).toEqual(original);
  });

  it('stores a source-supported missing return separately from the forward leg', () => {
    expect(changeFavoriteStops(missingReturnDataset(), favorite, '3', '1', true)).toEqual({
      ...favorite, returnStops: { fromStopId: '3', toStopId: '1' },
    });
  });

  it('keeps the existing inferred-return picker and save behavior', () => {
    const ds = cityDataset(), onSaved = vi.fn();
    const picker = FavoriteCommutePicker({ ds, favorite, reversed: true, t: strings.en, lang: 'en',
      end: 'from', level: 'stop', onCancel: () => {}, onSaved });
    expect(picker.type).toBe(CommutePicker);
    const props = picker.props as Parameters<typeof CommutePicker>[0];
    expect([props.initialFrom, props.initialTo]).toEqual(['3', '5']);
    expect(props.onSave('3', '5')).toBe(true);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ ...favorite, fromStopId: '3', toStopId: '5',
      leave: { out: favorite.leave!.back, back: favorite.leave!.out } }, false);
  });

  it('rejects unknown, wrong-side, unserved and route-filtered pairs without saving', () => {
    const ds = missingReturnDataset(), onSaved = vi.fn();
    const picker = FavoriteCommutePicker({ ds, favorite, reversed: true, t: strings.en, lang: 'en',
      end: 'from', level: 'stop', onCancel: () => {}, onSaved });
    const props = picker.props as Parameters<typeof CommutePicker>[0];
    for (const [from, to] of [['absent', '1'], ['3', 'absent'], ['3', '2'], ['5', '3'], ['3', '3']]) {
      expect(props.onSave(from!, to!)).toBe(false);
    }
    expect(changeFavoriteStops(ds, { ...favorite, routeIds: ['missing'] }, '3', '1', true)).toBeUndefined();
    const pattern = ds.patterns.find(p => p.id === 'return')!;
    pattern.noPickup = [0];
    expect(props.onSave('3', '1')).toBe(false);
    pattern.noPickup = []; pattern.noDropOff = [1];
    expect(props.onSave('3', '1')).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('preserves generated forward labels, route filters and later explicit return edits', () => {
    const ds = missingReturnDataset(), route = ds.patterns.find(p => p.id === 'return')!.routeId;
    const f = { ...favorite, routeIds: [route], label: `${ds.stops.find(s => s.id === '2')!.name} → ${ds.stops.find(s => s.id === '3')!.name}` };
    const saved = changeFavoriteStops(ds, f, '3', '1', true)!;
    expect(saved).toEqual({ ...f, returnStops: { fromStopId: '3', toStopId: '1' } });
    // When service to the old home reappears, never silently replace the confirmed pair.
    const restored = cityDataset();
    expect(favoriteLeg(restored, saved, true)).toEqual({ ...saved.returnStops, routeIds: [route] });
    expect(changeFavoriteStops(restored, saved, '3', '5', true)).toEqual({ ...f, returnStops: { fromStopId: '3', toStopId: '5' } });
    const removed = structuredClone(ds); removed.stops = removed.stops.filter(s => s.id !== '1');
    expect(favoriteLeg(removed, saved, true)?.toStopId).toBe('1');
    expect(changeFavoriteStops(removed, saved, '3', '1', true)).toBeUndefined();
  });

  for (const returnStops of [null, [], 'bad', {}, { fromStopId: '3', toStopId: '' }, { fromStopId: 3, toStopId: '1' }]) {
    it(`drops only malformed return stops on reload: ${JSON.stringify(returnStops)}`, () => {
      expect(loadFavorites({ getItem: () => JSON.stringify([{ ...favorite, returnStops }]) })).toEqual([favorite]);
    });
  }

  it('compares the explicit return schedule and changes the notice key when that selection changes', () => {
    const ds = missingReturnDataset(), saved = changeFavoriteStops(ds, favorite, '3', '1', true)!;
    expect(favoriteKey(saved)).not.toBe(favoriteKey(favorite));
    expect(favoriteKey(favorite)).toBe(JSON.stringify([favorite.id, '2', '3', []]));
    const next = structuredClone(ds); next.meta.feedVersion += '-updated';
    const trip = next.trips.find(t => t.id === 'return-trip')!;
    trip.times = trip.times.map(t => t + 180); trip.arrivals = trip.arrivals!.map(t => t === null ? null : t + 180);
    expect(compareCommute(ds, next, saved, '20261104')).toMatchObject({ kind: 'timetable',
      after: [expect.objectContaining({ direction: 'back', stops: ['3', '1'] })] });
    next.stops = next.stops.filter(s => s.id !== '1');
    expect(compareCommute(ds, next, saved, '20261104')?.kind).toBe('selection');
  });
});

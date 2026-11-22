import { describe, expect, it } from 'vitest';
import { activeDuring, advisoryScope, alertsStatus, commuteBriefing, exactGateChange, sourceAge, type AlertsCheck, type BriefingSelection, type GateAssignment } from '../../src/domain/commuteBriefing';
import { advanceCommuteChanges } from '../../src/domain/commuteChanges';
import { createCommuteChangeStore, parseCommuteChangeState } from '../../src/data/commuteChangeStore';
import { returnLeg } from '../../src/domain/direction';
import { serviceTimeToInstant } from '../../src/domain/time';
import { commuteBriefingStrings } from '../../src/ui/commuteBriefingStrings';
import { liveDataset } from '../helpers/liveBus';
import { expressDataset } from '../helpers/express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommuteChanges } from '../../src/ui/CommuteChanges';
import { CommuteBriefing } from '../../src/ui/CommuteBriefing';
import type { CommuteChange } from '../../src/domain/commuteChanges';
import { strings } from '../../src/ui/i18n';
import { parseDataset } from '../../src/domain/dataset';

const now = Date.parse('2026-11-21T08:00:00-05:00');
const favorite = { id: 'fictional', label: 'Fictional commute', fromStopId: '1', toStopId: '3', routeIds: [] as string[] };
const selection: BriefingSelection = { ...favorite, date: '20261126' };
const fixture = () => structuredClone(liveDataset);

describe('commute briefing: sourced calendar and selected scope', () => {
  it('uses additions/removals, never assumes Sunday or derives a holiday label', () => {
    const ds = fixture();
    const holiday = commuteBriefing(ds, selection);
    expect(holiday.state).toBe('scheduled');
    expect(holiday.departures.map(d => d.tripId)).toEqual(['T2', 'T4']); // Previous service day's >24:00 remains valid.
    ds.calendars.WK!.removed.push('20261125'); ds.calendars.HOL!.added = [];
    expect(commuteBriefing(ds, selection).state).toBe('no-service');
    expect(commuteBriefing(ds, { ...selection, date: '20270501' }).state).toBe('unknown');
    expect(holiday.validity.every(v => v.start <= v.end)).toBe(true); // No exception-only sentinel dates.
  });
  it('filters the exact variant, boarding stop, direction and explicit window without inventing a commute time', () => {
    const ds = fixture(), ordinary = { ...selection, date: '20261123' };
    const full = commuteBriefing(ds, ordinary);
    expect(full.departures.map(d => d.tripId)).toEqual(['T1','T3']);
    const route = full.departures[1]!.route.id;
    const start = full.departures[1]!.departs;
    expect(commuteBriefing(ds, { ...ordinary, routeIds: [route], window: { start, end: start + 1 } }).departures.map(d => d.tripId)).toEqual(['T3']);
    expect(commuteBriefing(ds, { ...ordinary, window: { start, end: start } }).state).toBe('unknown');
    expect(commuteBriefing(ds, { ...ordinary, window: { start: start + 1, end: start + 2 } }).state).toBe('no-service');
    expect(commuteBriefing(ds, { ...ordinary, fromStopId: 'absent' }).state).toBe('unknown');
    expect(commuteBriefing(ds, { ...ordinary, routeIds: ['absent'] }).state).toBe('unknown');
    expect(commuteBriefing(ds, { ...ordinary, routeIds: [route, 'absent'] }).state).toBe('unknown');
    expect(commuteBriefing(ds, { ...ordinary, fromStopId: '3', toStopId: '1' }).state).toBe('unknown');
  });
  for (const replacement of ['weekend', 'added', 'removed'] as const) {
    it(`does not let an unrelated ${replacement} calendar cover expired weekday service`, () => {
      const ds = fixture(), date = '20261123';
      ds.calendars.WK!.end = '20261120';
      ds.calendars.OTHER = replacement === 'weekend'
        ? { ...structuredClone(ds.calendars.WK!), end: '20261130', days: [false,false,false,false,false,false,true] }
        : { start: '99991231', end: '00010101', days: [false,false,false,false,false,false,false],
          added: replacement === 'added' ? [date] : [], removed: replacement === 'removed' ? [date] : [] };
      ds.trips.push({ id: 'other-service', patternId: ds.trips[0]!.patternId, serviceId: 'OTHER', times: [36000,36600,37200] });
      const result = commuteBriefing(ds, { ...selection, date });
      expect(result.state).toBe('unknown');
      expect(result.departures).toHaveLength(replacement === 'added' ? 1 : 0);
    });
  }
  it('keeps partial expiry and unproven calendar replacements unknown, even with current departures', () => {
    const ds = fixture(), date = '20261123';
    ds.calendars.NEW = { ...structuredClone(ds.calendars.WK!), start: date };
    ds.calendars.WK!.end = '20261120';
    ds.trips.push({ id: 'new-service', patternId: ds.trips[0]!.patternId, serviceId: 'NEW', times: [36000,36600,37200] });
    expect(commuteBriefing(ds, { ...selection, date }).state).toBe('unknown');
    ds.calendars.WK!.removed.push(date);
    // An explicit exception in the expired service's own calendar does prove its status for this date.
    ds.trips = ds.trips.filter(t => t.id !== 'T2'); // No previous-day overnight coverage in this assertion.
    expect(commuteBriefing(ds, { ...selection, date }).state).toBe('scheduled');
    delete ds.calendars.WK;
    expect(commuteBriefing(ds, { ...selection, date }).state).toBe('unknown');
  });
  it('exception-only service supplies coverage only on its own explicit dates', () => {
    const ds = fixture(); ds.trips = ds.trips.filter(t => t.serviceId === 'HOL');
    expect(commuteBriefing(ds, selection).state).toBe('scheduled');
    expect(commuteBriefing(ds, { ...selection, date: '20261127' }).state).toBe('unknown');
    ds.calendars.HOL!.added = []; ds.calendars.HOL!.removed = [selection.date];
    expect(commuteBriefing(ds, selection).state).toBe('no-service');
  });
  it('distinguishes both saved legs and broader, unrelated and ambiguous advisories', () => {
    const ds = fixture();
    ds.stops.push({ id: 'return-stop', name: 'Fictional return', twin: '1' });
    ds.patterns.push({ id: 'back', routeId: ds.routes[0]!.id, directionId: 1, headsign: 'Fictional home', stopIds: ['3','return-stop'] });
    ds.trips.push({ id: 'back', patternId: 'back', serviceId: 'WK', times: [61200,63600] });
    const back = returnLeg(ds, '1', '3', []);
    expect(back).toEqual({ fromStopId: '3', toStopId: 'return-stop' });
    const query = { ...selection, date: '20261123' };
    expect(commuteBriefing(ds, { ...query, ...back }).departures.map(d => d.tripId)).toEqual(['back']);
    expect(advisoryScope([{}], ds, query)).toBe('match'); // Explicit agency-wide selector.
    expect(advisoryScope([{ routeId: ds.routes[0]!.id }], ds, query)).toBe('match');
    expect(advisoryScope([{ stopId: '2' }], ds, query)).toBe('match');
    expect(advisoryScope([{ directionId: 1 }], ds, query)).toBe('unrelated');
    expect(advisoryScope([{ routeId: 'other' }], ds, query)).toBe('unrelated');
    expect(advisoryScope([{ stopId: 'elsewhere' }], ds, query)).toBe('unrelated');
    expect(advisoryScope([{ ambiguous: true }], ds, query)).toBe('uncertain');
    expect(advisoryScope([], ds, query)).toBe('uncertain');
  });
  it('cannot rule out advisories when missing stops, routes or a direct pattern prevent scoping', () => {
    const ds = fixture();
    for (const query of [{ ...selection, fromStopId: 'absent' }, { ...selection, routeIds: ['absent'] },
      { ...selection, fromStopId: '3', toStopId: '1' }]) {
      for (const selectors of [[{}], [{ ambiguous: true }], [{ routeId: 'other' }]]) {
        expect(advisoryScope(selectors, ds, query)).toBe('uncertain');
      }
    }
  });
  it('printed warnings never produce holiday departure times; uncovered dates remain unknown', () => {
    const ds = fixture(); ds.meta.transcribed = { issued: '20260701', documentId: 'fictional' };
    delete ds.meta.realtime;
    const result = commuteBriefing(parseDataset(ds), selection);
    expect(result.state).toBe('printed-holiday'); expect(result.departures).toEqual([]);
    expect(commuteBriefing(ds, { ...selection, date: '20270503' }).state).toBe('unknown');
    for (const query of [{ ...selection, fromStopId: 'absent' }, { ...selection, toStopId: 'absent' },
      { ...selection, routeIds: ['absent'] }, { ...selection, window: { start: now, end: now } },
      { ...selection, window: { start: NaN, end: now } }]) {
      const result = commuteBriefing(ds, query);
      expect(result.state).toBe('unknown'); expect(result.departures).toEqual([]);
    }
    ds.calendars.WK!.end = '20261120';
    expect(commuteBriefing(ds, selection).state).toBe('unknown');
  });
  for (const [date, serviceDate, seconds] of [['20261122','20261121',88200], ['20261101','20261101',5400], ['20270314','20270314',5400], ['20270313','20270314',600]] as const) {
    it(`preserves Eastern service identity on ${date}, including DST and >24:00`, () => {
      const ds = fixture();
      ds.trips = [{ id: 'night', patternId: ds.trips[0]!.patternId, serviceId: 'only', times: [seconds,seconds+600,seconds+1200] }];
      ds.calendars = { only: { start: serviceDate, end: serviceDate, added: [serviceDate], removed: [], days: [false,false,false,false,false,false,false] } };
      const result = commuteBriefing(ds, { ...selection, date });
      expect(result.departures).toHaveLength(1);
      expect(result.departures[0]!.serviceDate).toBe(serviceDate);
      expect(result.departures[0]!.departs).toBe(serviceTimeToInstant(serviceDate, seconds, ds.meta.timezone));
    });
  }
  it('active periods use instants and half-open boundaries, including both repeated hours', () => {
    const first = Date.parse('2026-11-01T01:30:00-04:00'), second = Date.parse('2026-11-01T01:30:00-05:00');
    const period = { start: first, end: second };
    expect(activeDuring(period, { start: first, end: second })).toBe(true);
    expect(activeDuring(period, { start: second, end: second + 1 })).toBe(false);
    expect(activeDuring(period, { start: first - 1, end: first })).toBe(false);
    expect(activeDuring({ start: NaN }, { start: first, end: second })).toBe(false);
    expect([period].filter(p => activeDuring(p, { start: first, end: second + 1 }))).toHaveLength(1);
  });
});

describe('briefing clocks and unavailable alerts', () => {
  it('does not substitute receipt time for source time; age grows without a request', () => {
    for (const at of [undefined, '', 'invalid', now + 1, Infinity, NaN]) expect(sourceAge(at, now)).toBeUndefined();
    const built = '2026-11-20T08:00:00-05:00';
    expect(sourceAge(built, now)).toBe(86400000);
    expect(sourceAge(built, now + 60000)).toBe(86460000);
  });
  for (const state of ['disabled','unverified','timeout','denied','429','malformed','offline','failed'] as const) {
    it(`${state}: exact bilingual unavailable message, even after an attempted check`, () => {
      expect(alertsStatus({ state, attemptedAt: now }, now)).toBe('unavailable');
      expect(commuteBriefingStrings.en.alerts).toBe("Couldn't check current alerts");
      expect(commuteBriefingStrings.es.alerts).toBe('No se pudieron consultar las alertas actuales');
    });
  }
  it('only fresh verified known coverage allows empty; stale, expired and invalid timestamps stay unavailable', () => {
    const fresh: AlertsCheck = { state: 'success', verified: true, covered: true, checkedAt: now, updatedAt: now - 1000, expiresAt: now + 60000, matching: 0 };
    expect(alertsStatus(fresh, now)).toBe('empty');
    expect(alertsStatus({ ...fresh, matching: 1 }, now)).toBe('notices');
    for (const patch of [{ verified: false }, { covered: false }, { checkedAt: now + 1 }, { updatedAt: now - 61000 }, { checkedAt: NaN }, { expiresAt: now }, { matching: -1 }]) {
      expect(alertsStatus({ ...fresh, ...patch }, now)).toBe('unavailable');
    }
    expect(alertsStatus(fresh, now + 61000)).toBe('unavailable');
  });
  it('only official successive same-trip/date assignments can prove a gate change', () => {
    const before: GateAssignment = { tripId: 'fictional-trip', serviceDate: '20261121', gate: 'A', observedAt: now-2000, source: 'Fictional official assignment', kind: 'official' };
    const after = { ...before, gate: 'B', observedAt: now-1000 };
    expect(exactGateChange(before, after, before, now)).toEqual({ before, after });
    for (const patch of [{ tripId: 'other' }, { serviceDate: '20261120' }, { kind: 'published' as const }, { source: '' }, { observedAt: now+1 }]) {
      expect(exactGateChange(before, { ...after, ...patch }, before, now)).toBeUndefined();
    }
    expect(exactGateChange(undefined, after, before, now)).toBeUndefined();
  });
  it('ignores gate whitespace while preserving real changes and their original evidence', () => {
    const before: GateAssignment = { tripId: 'fictional-trip', serviceDate: '20261121', gate: '301', observedAt: now - 2000, source: 'Fictional official assignment', kind: 'official' };
    for (const gate of ['301 ', ' 301', '\t301\n']) {
      expect(exactGateChange(before, { ...before, gate, observedAt: now - 1000 }, before, now)).toBeUndefined();
      expect(exactGateChange({ ...before, gate }, { ...before, observedAt: now - 1000 }, before, now)).toBeUndefined();
    }
    const after = { ...before, gate: ' 302 ', observedAt: now - 1000 };
    expect(exactGateChange(before, after, before, now)).toEqual({ before, after });
  });
});

describe('existing notice store metadata compatibility', () => {
  const updated = () => { const ds = fixture(); ds.meta.feedVersion = 'fictional-v2'; ds.meta.builtAt = '2026-11-21T12:00:00Z'; ds.trips[0]!.times[0]! += 180; return ds; };
  const noticeState = () => advanceCommuteChanges(advanceCommuteChanges(undefined, fixture(), [favorite], now), updated(), [favorite], now);
  it('retains source clocks across subsequent versions and accepts legacy records without guessing age', () => {
    const state = noticeState(); expect(state.notices).toHaveLength(1);
    const sources = state.notices[0]!.sources!;
    expect(sources.before.builtAt).toBe(liveDataset.meta.builtAt);
    expect(sources.after.builtAt).toBe(updated().meta.builtAt);
    const ds = updated(); ds.meta.feedVersion = 'fictional-v3'; ds.meta.builtAt = '2026-11-21T12:30:00Z';
    expect(advanceCommuteChanges(state, ds, [favorite], now).notices[0]!.sources).toEqual(sources);
    delete state.notices[0]!.sources;
    expect(parseCommuteChangeState(state)?.notices).toEqual(state.notices);
    expect(sourceAge(parseCommuteChangeState(state)?.notices[0]?.sources?.after.builtAt, now)).toBeUndefined();
    (state.notices[0] as unknown as { sources: unknown }).sources = { after: {} };
    expect(parseCommuteChangeState(state)).toBeUndefined();
  });
  it('dismissal/reload and another tab preserve metadata without touching locks or favorite order', async () => {
    let raw: unknown = noticeState(); const initial = structuredClone(raw);
    const persistence = { read: async () => structuredClone(raw), write: async (value: unknown) => { raw = structuredClone(value); } };
    const first = createCommuteChangeStore(persistence), second = createCommuteChangeStore(persistence);
    const favorites = [favorite, { ...favorite, id: 'second' }], snapshot = JSON.stringify(favorites);
    const lock = { tripId: 'locked-fictional', serviceDate: '20261121', stopId: '1' }, savedLock = JSON.stringify(lock);
    const state = (await first.advance(updated(), favorites, now))!.state;
    await second.dismiss(state.notices[0]!.id);
    expect((await first.advance(fixture(), favorites, now))!.state.notices).toEqual([]);
    expect((await createCommuteChangeStore(persistence).advance(updated(), favorites, now))!.state.notices).toEqual([]);
    expect(JSON.stringify(favorites)).toBe(snapshot); expect(JSON.stringify(lock)).toBe(savedLock);
    const blocked = createCommuteChangeStore({ read: async () => initial, write: async () => { throw Error('blocked'); } });
    expect((await blocked.advance(updated(), [favorite], now))!.durable).toBe(false);
    expect((await blocked.dismiss(state.notices[0]!.id))!.state.notices).toEqual([]);
    expect(parseCommuteChangeState(raw)?.baseline.meta.feedVersion).toBe('fictional-v2');
  });
});

describe('bilingual briefing rendering without a network source', () => {
  for (const lang of ['en','es'] as const) {
    for (const missing of ['fromStopId', 'toStopId', 'routeIds'] as const) {
      it(`${lang}/${missing}: missing selections offer reselection without broken timetable actions`, () => {
        const ds = fixture(), t = strings[lang], b = t.commuteChanges.briefing;
        const saved = { ...favorite, [missing]: missing === 'routeIds' ? ['absent'] : 'absent' };
        const html = renderToStaticMarkup(createElement(CommuteBriefing, {
          ds, selection: { ...saved, date: '20261123' }, now, t, lang, onTimetable: () => {}, onReselect: () => {},
        }));
        expect(html).toContain(b.unknown);
        expect(html).toContain(b.reselect);
        expect(html).not.toContain(b.timetable);
        if (missing !== 'routeIds') {
          const scope = html.match(/<p class="briefing-scope">(.*?)<\/p>/)![1]!;
          expect(scope).toContain(b.missingStop);
          expect(scope).not.toContain(b.missing);
          expect(scope).toContain(ds.stops.find(s => s.id === (missing === 'fromStopId' ? saved.toStopId : saved.fromStopId))!.name);
        }
        const notice: CommuteChange = { id: 'fictional-selection', favoriteId: saved.id, favoriteKey: 'fictional-key', kind: 'selection',
          fromVersion: 'fictional-before', toVersion: 'fictional-after', before: [], after: [] };
        const notices = renderToStaticMarkup(createElement(CommuteChanges, {
          ds, now, t, lang, tz: ds.meta.timezone, notices: [notice], favorites: [saved],
          durable: true, dismiss: async () => {}, reversedIds: new Set<string>(), onTimetable: () => {}, onReselect: () => {},
        }));
        expect(notices).not.toContain(b.timetable);
        expect(notices).toContain(b.reselect);
      });
    }
    it(`${lang}: known selections keep timetable actions when only date coverage is unknown`, () => {
      const ds = fixture(), t = strings[lang], b = t.commuteChanges.briefing;
      const html = renderToStaticMarkup(createElement(CommuteBriefing, {
        ds, selection: { ...selection, date: '20270503' }, now, t, lang, onTimetable: () => {}, onReselect: () => {},
      }));
      expect(html).toContain(b.unknown);
      expect(html).toContain(b.timetable);
    });
    it(`${lang}: selected and all-route summaries show 165 once without changing route identities`, () => {
      const ds = expressDataset(), before = JSON.stringify(ds);
      for (const routeIds of [[], ['R165', 'R165T'], ['R165T']]) {
        const html = renderToStaticMarkup(createElement(CommuteBriefing, {
          ds, selection: { fromStopId: 'D1', toStopId: 'PABT', date: '20261104', routeIds },
          now, t: strings[lang], lang, onTimetable: () => {}, onReselect: () => {},
        }));
        expect(html).toContain('<p class="briefing-scope">165 · ');
        expect(html).not.toContain('165T');
        expect(html).not.toContain('165 / 165');
      }
      expect(JSON.stringify(ds)).toBe(before);
    });
    it(`${lang}: missing route labels preserve the explicitly saved scope, including mixed routes`, () => {
      const ds = fixture(), t = strings[lang], b = t.commuteChanges.briefing;
      const render = (routeIds: string[]) => renderToStaticMarkup(createElement(CommuteBriefing, {
        ds, selection: { ...selection, date: '20261123', routeIds }, now, t, lang, onTimetable: () => {}, onReselect: () => {},
      }));
      for (const routeIds of [['absent'], ['absent', 'another-absent'], [ds.routes[0]!.id, 'absent']]) {
        const html = render(routeIds);
        expect(html).toContain(b.missingRoute);
        expect(html).not.toContain(b.allRoutes);
        expect(html).toContain(b.unknown);
        expect(html).toContain(b.reselect);
        if (routeIds.length === 2 && routeIds[0] !== 'absent') expect(html).toContain(`${ds.routes[0]!.shortName} / ${b.missingRoute}`);
      }
      // With no saved route filter and no known pattern, the all-routes label is still accurate.
      ds.patterns = []; ds.trips = [];
      expect(render([])).toContain(b.allRoutes);
    });
    for (const kind of ['selection','uncomparable'] as const) {
      it(`${lang}/${kind}: only an existing favorite offers a recovery action`, () => {
        const t = strings[lang], b = t.commuteChanges.briefing;
        const notice: CommuteChange = { id: 'fictional-notice', favoriteId: favorite.id, favoriteKey: 'fictional-key', kind,
          fromVersion: 'fictional-before', toVersion: 'fictional-after', before: [], after: [] };
        const render = (present: boolean) => renderToStaticMarkup(createElement(CommuteChanges, {
          ds: fixture(), now, t, lang, tz: 'America/New_York', notices: [notice], favorites: present ? [favorite] : [],
          durable: true, dismiss: async () => {}, reversedIds: new Set<string>(), onTimetable: () => {}, onReselect: () => {},
        }));
        expect(render(true)).toContain(b.reselect);
        const orphan = render(false);
        expect(orphan).not.toContain(b.reselect);
        expect(orphan).not.toContain(b.timetable);
        expect(orphan).toContain(t.commuteChanges.dismiss);
        expect(orphan).toContain(t.commuteChanges[kind]);
      });
    }
  }
  for (const lang of ['en','es'] as const) it(`${lang}: calendar, unavailable alerts and notice clocks coexist with native controls`, () => {
    const ds = fixture(), t = strings[lang], b = t.commuteChanges.briefing;
    ds.meta.source = 'Fictional <script>not executable</script>';
    ds.meta.feedVersion = 'fictional-next'; ds.trips[0]!.times[0]! += 60;
    const state = advanceCommuteChanges(advanceCommuteChanges(undefined, fixture(), [favorite], now), ds, [favorite], now);
    const html = renderToStaticMarkup(createElement(CommuteChanges, {
      ds, now, notices: state.notices, favorites: [favorite], durable: true, dismiss: async () => {},
      t, lang, tz: ds.meta.timezone, reversedIds: new Set<string>(), onTimetable: () => {}, onReselect: () => {},
    }));
    expect(html).toContain(b.alerts.replaceAll("'", '&#x27;'));
    expect(html).toContain(b.publicationUnknown);
    expect(html).toContain(b.checkUnknown);
    expect(html).toContain('fictional-next');
    expect(html).toContain('<select'); expect(html).toContain('<summary>'); expect(html).toContain('<button');
    expect(html).toContain('https://www.njtransit.com/travel-alerts-to');
    expect(html).toContain('&lt;script&gt;not executable&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('role="alert"'); // No unsolicited live announcement or focus-taking popup.
  });
});

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error ESM script module
import { compareSchedules, plainVerdict, windowDays, isServiceActive as checkActive } from '../../scripts/schedule-compare.mjs';
import { isServiceActive } from '../../src/domain/schedule';
import { addDays } from '../../src/domain/time';
import { liveDataset } from '../helpers/liveBus';
import type { Dataset } from '../../src/domain/types';

const clone = (patch?: (ds: Dataset) => void) => { const ds = structuredClone(liveDataset); patch?.(ds); return ds; };
const TODAY = '20261112';

describe('read-only schedule check comparison', () => {
  it('reports identical schedules with no differing service dates', () => {
    const s = compareSchedules(liveDataset, clone((ds) => { ds.meta.feedVersion = 'bbbbbbbbbbbb'; }), { today: TODAY, days: 30 });
    expect(s.serviceDates).toMatchObject({ compared: 32, different: 0, firstDifferentDate: null, firstDifferences: [] });
    expect(s.trips).toMatchObject({ onlyDeployed: 0, onlyCandidate: 0, coreChanged: 0 });
    expect(s.deployed.tripsToday).toBeGreaterThan(0);
    expect(plainVerdict(s)).toContain('identical');
  });
  it('finds the first service date where a changed departure time applies, not before', () => {
    const candidate = clone((ds) => {
      const t1 = ds.trips.find((t) => t.id === 'T1')!;
      ds.calendars.OLD1 = { ...structuredClone(ds.calendars[t1.serviceId]!), end: '20261115' };
      ds.calendars.NEW = { ...structuredClone(ds.calendars[t1.serviceId]!), start: '20261116' };
      ds.trips.push({ ...structuredClone(t1), id: 'T1-new', serviceId: 'NEW', times: t1.times.map((x) => x + 300) });
      t1.serviceId = 'OLD1';
    });
    const s = compareSchedules(liveDataset, candidate, { today: TODAY, days: 30 });
    expect(s.serviceDates.firstDifferentDate).toBe('20261116');
    expect(s.serviceDates.firstDifferences[0]).toMatchObject({ date: '20261116', onlyDeployed: 1, onlyCandidate: 1, changed: 0 });
    expect(s.trips.onlyCandidate).toBe(1);
    expect(plainVerdict(s)).toContain('first differ on 20261116');
  });
  it('flags a changed trip with the same ID and a candidate with no trips today', () => {
    const changed = clone((ds) => { ds.trips.find((t) => t.id === 'T1')!.times[1]! += 60; });
    expect(compareSchedules(liveDataset, changed, { today: TODAY, days: 7 }).trips.coreChanged).toBe(1);
    const empty = clone((ds) => { for (const cal of Object.values(ds.calendars)) { cal.start = '20261201'; cal.added = []; } });
    expect(plainVerdict(compareSchedules(liveDataset, empty, { today: TODAY, days: 7 }))).toContain('No comparison possible');
    const later = clone((ds) => { for (const cal of Object.values(ds.calendars)) { cal.start = '20261116'; cal.added = []; } });
    expect(plainVerdict(compareSchedules(liveDataset, later, { today: TODAY, days: 7 }))).toContain('no trips on Dale\'s routes for today');
  });
  it('treats an arrival-only change as a differing service date', () => {
    const changed = clone((ds) => { const t = ds.trips.find((x) => x.id === 'T1')!; t.arrivals = t.times.map((x, i) => i === t.times.length - 1 ? x - 120 : x); });
    const s = compareSchedules(liveDataset, changed, { today: TODAY, days: 7 });
    expect(s.trips).toMatchObject({ coreChanged: 0, arrivalsOnlyChanged: 1 });
    expect(s.serviceDates.firstDifferentDate).not.toBeNull();
    expect(s.serviceDates.firstDifferences[0]).toMatchObject({ changed: 1, onlyDeployed: 0, onlyCandidate: 0 });
  });
  it('never calls two empty schedules identical', () => {
    const none = clone((ds) => { for (const cal of Object.values(ds.calendars)) { cal.start = '20271201'; cal.end = '20271231'; cal.added = []; } });
    const s = compareSchedules(none, none, { today: TODAY, days: 7 });
    expect(s.serviceDates).toMatchObject({ different: 0, deployedTripDays: 0, candidateTripDays: 0 });
    expect(plainVerdict(s)).toContain('No comparison possible');
  });
  it('separates a trip-ID-only renumbering from a real timetable change', () => {
    const renamed = clone((ds) => { for (const t of ds.trips) t.id = t.id + '-r'; });
    const s = compareSchedules(liveDataset, renamed, { today: TODAY, days: 7 });
    expect(s.serviceDates.different).toBeGreaterThan(0);
    expect(s.serviceDates.idOnlyDates).toBe(s.serviceDates.different);
    expect(s.serviceDates.firstTimetableDifferentDate).toBeNull();
    expect(s.serviceDates.firstDifferences[0]).toMatchObject({ timetableSame: true });
    expect(plainVerdict(s)).toContain('only trip IDs differ');
    const retimed = clone((ds) => { const t = ds.trips.find((x) => x.id === 'T1')!; t.times = t.times.map((x) => x + 60); });
    const r = compareSchedules(liveDataset, retimed, { today: TODAY, days: 7 });
    expect(r.serviceDates.firstTimetableDifferentDate).toBe(r.serviceDates.firstDifferentDate);
    expect(plainVerdict(r)).toContain('the timetable itself first differs');
  });
  it('detects changed headsigns, stop sequences and stop name, code or coordinates', () => {
    const headsign = clone((ds) => { ds.patterns[0]!.headsign = 'Elsewhere'; });
    expect(compareSchedules(liveDataset, headsign, { today: TODAY, days: 7 }).trips.coreChanged).toBeGreaterThan(0);
    const sequences = clone((ds) => { const p = ds.patterns[0]!; p.stopSequences = p.stopIds.map((_, i) => (i + 1) * 10); });
    expect(compareSchedules(liveDataset, sequences, { today: TODAY, days: 7 }).trips.coreChanged).toBeGreaterThan(0);
    const moved = clone((ds) => { const st = ds.stops.find((x) => x.lat !== undefined)!; st.lat = st.lat! + 0.001; });
    const m = compareSchedules(liveDataset, moved, { today: TODAY, days: 7 });
    expect(m.stops.changed).toBe(1);
    expect(plainVerdict(m)).toContain('Stop details differ: 1 changed');
    const cityOnly = clone((ds) => { ds.stops[0]!.city = 'Somewhere'; });
    expect(compareSchedules(liveDataset, cityOnly, { today: TODAY, days: 7 }).stops.changed).toBe(0);
  });
  it('sizes the window to the later calendar end, between 60 and 366 days', () => {
    expect(windowDays(liveDataset, liveDataset, TODAY)).toBe(169); // fixture calendar ends 20270430
    const far = clone((ds) => { for (const cal of Object.values(ds.calendars)) cal.end = '20291231'; });
    expect(windowDays(liveDataset, far, TODAY)).toBe(366);
    const near = clone((ds) => { for (const cal of Object.values(ds.calendars)) cal.end = '20261120'; });
    expect(windowDays(near, near, TODAY)).toBe(60);
  });
  it('outputs only aggregate counts, dates and feed versions, never IDs, times or names', () => {
    const different = clone((ds) => {
      ds.trips.find((x) => x.id === 'T1')!.times[1]! += 60;
      ds.trips.push({ ...structuredClone(ds.trips[0]!), id: 'NEWTRIP' });
      ds.trips = ds.trips.filter((x) => x.id !== 'T3');
      const st = ds.stops.find((x) => x.lat !== undefined)!; st.lat = st.lat! + 0.001;
    });
    const summary = compareSchedules(liveDataset, different, { today: TODAY, days: 7 });
    expect(summary.serviceDates.firstDifferences.length).toBeGreaterThan(0);
    const text = JSON.stringify(summary) + plainVerdict(summary);
    expect(text).not.toContain('NEWTRIP');
    for (const ds of [liveDataset, different]) {
      for (const t of ds.trips) for (const time of t.times) expect(text).not.toContain(`:${time},`);
      for (const t of ds.trips) expect(text).not.toContain(`"${t.id}"`);
      for (const st of ds.stops) { expect(text).not.toContain(`"${st.id}"`); expect(text).not.toContain(st.name); }
    }
    expect(() => compareSchedules(liveDataset, liveDataset, { today: 'today', days: 7 })).toThrow();
  });
  it('uses exactly the app\'s service-day rule, including removals and additions', () => {
    for (const cal of [...Object.values(liveDataset.calendars), { days: [false, false, false, false, false, true, true] as Dataset['calendars'][string]['days'], start: '20261101', end: '20261130', added: ['20261126'], removed: ['20261129'] }]) {
      for (let i = -5; i < 40; i++) { const d = addDays('20261101', i); expect(checkActive(cal, d)).toBe(isServiceActive(cal, d)); }
    }
  });
  it('runs only as its own manual mode with NJ Transit credentials and no Cloudflare credentials or deploy', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/live-worker.yml', import.meta.url), 'utf8');
    const step = workflow.split(/\n      - /).find((s) => s.includes('run: node scripts/check-schedule.mjs'))!;
    expect(step).toContain("if: inputs.history_collection == 'schedule-check'\n");
    expect(step).toContain('NJT_API_USERNAME'); expect(step).not.toMatch(/CLOUDFLARE_|deploy-live-worker|worker:prepare|stop-history/);
    for (const s of workflow.split(/\n      - /).filter((x) => /worker:prepare|deploy-live-worker|stop-history/.test(x))) expect(s).not.toContain('schedule-check');
    const script = readFileSync(new URL('../../scripts/check-schedule.mjs', import.meta.url), 'utf8');
    expect(script).not.toMatch(/writeFileSync|CLOUDFLARE|wrangler|console\.log\([^)]*token/);
  });
  it('prints only the fixed phase line when it fails, never the underlying error', () => {
    const env = { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale',
      HISTORY_COLLECTION_MODE: 'schedule-check', DALE_WORKER_URL: 'https://PRIVATE_SENTINEL_HOST.invalid', NJT_API_USERNAME: 'PRIVATE_SENTINEL_USER', NJT_API_PASSWORD: 'PRIVATE_SENTINEL_PASS' };
    for (const [patch, phase] of [[{ HISTORY_COLLECTION_MODE: 'qualify-enabled' }, 'preflight'], [{}, 'deployed-schedule-read']] as const) {
      const r = spawnSync(process.execPath, ['scripts/check-schedule.mjs'], { env: { ...env, ...patch }, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim()).toBe(`Schedule check failed at ${phase}. No credentials, token or response details are logged. Nothing was changed.`);
    }
  });
});

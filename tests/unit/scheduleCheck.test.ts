import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error ESM script module
import { compareSchedules, plainVerdict, isServiceActive as checkActive } from '../../scripts/schedule-compare.mjs';
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
    expect(plainVerdict(compareSchedules(liveDataset, empty, { today: TODAY, days: 7 }))).toContain('no trips on Dale\'s routes for today');
  });
  it('outputs only aggregate counts, dates and feed versions, never IDs, times or names', () => {
    const text = JSON.stringify(compareSchedules(liveDataset, liveDataset, { today: TODAY, days: 7 }));
    for (const ds of [liveDataset]) {
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
});

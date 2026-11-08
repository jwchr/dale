import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { buildDataset, filterCsvByColumn, interpolate, parseCsv, parseGtfsTime } from '../../scripts/gtfs-lib.mjs';
import { departuresOn, tripStopTimes } from '../../src/domain/schedule';
import { formatTime12 } from '../../src/domain/time';
import type { Dataset } from '../../src/domain/types';

const dir = join(__dirname, '../fixtures/gtfs-mini');
const files: Record<string, string> = Object.fromEntries(
  readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
);

describe('GTFS build', () => {
  it.each(['7:90:00', '07:00:99', '-1:10:00', '7.5:10:00', '7:10', '9007199254740992:00:00'])('rejects malformed source times instead of silently changing the schedule: %s', value => {
    expect(() => parseGtfsTime(value)).toThrow();
  });
  it('accepts missing intermediate times and next-day GTFS hours without coercing bad values', () => {
    expect(parseGtfsTime('')).toBeUndefined(); expect(parseGtfsTime('25:10:00')).toBe(90600);
  });
  it('parses quoted CSV with BOM, embedded commas and doubled quotes', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n');
    expect(rows).toEqual([{ a: 'x, y', b: 'say "hi"' }]);
  });

  it('pre-filters big files by column, quoted lines included', () => {
    const text = 'trip_id,stop_id\r\nA,1\r\nB,2\r\n"A",3\r\n';
    expect(filterCsvByColumn(text, 'trip_id', new Set(['A']))).toBe('trip_id,stop_id\nA,1\n"A",3');
  });

  it('keeps or drops a record whole when a quoted field holds a line break', () => {
    const text = 'trip_id,stop_headsign,stop_id\r\nA,"Line one\r\nline two",1\r\nB,"x\r\nA,5",2\r\nA,"say ""hi""",3\r\n';
    expect(parseCsv(filterCsvByColumn(text, 'trip_id', new Set(['A'])))).toEqual([
      { trip_id: 'A', stop_headsign: 'Line one\nline two', stop_id: '1' },
      { trip_id: 'A', stop_headsign: 'say "hi"', stop_id: '3' },
    ]);
    expect(parseCsv(filterCsvByColumn('trip_id,stop_headsign\r\nA,"a\r\n\r\nb"\r\n', 'trip_id', new Set(['A'])))).toEqual([{ trip_id: 'A', stop_headsign: 'a\n\nb' }]);
  });

  it('fails loudly on an unclosed or stray quote instead of dropping the rows after it', () => {
    expect(() => filterCsvByColumn('trip_id,stop_id\nA,1\nB,"oops\nA,3\nA,4', 'trip_id', new Set(['A']))).toThrow(/unclosed quote.*line 3$/);
    const rows = Array.from({ length: 20 }, (_, i) => `A,${i}`).join('\n');
    expect(() => filterCsvByColumn(`trip_id,stop_id\nB,Joe"s\n${rows}`, 'trip_id', new Set(['A']))).toThrow(/line 2$/);
  });

  it('interpolates blank intermediate times', () => {
    expect(interpolate([0, undefined, undefined, 300])).toEqual([0, 100, 200, 300]);
    expect(() => interpolate([undefined, 10])).toThrow();
  });

  const ds: Dataset = buildDataset(files, { routeShortNames: ['165', '165t'], feedVersion: 'fx', builtAt: 'x' });

  it('keeps only corridor routes and the stops they use', () => {
    expect(ds.routes.map((r) => r.shortName).sort()).toEqual(['165', '165T']);
    expect(ds.stops.map((s) => s.id).sort()).toEqual(['1', '2', '3']);
    expect(ds.stops.find((s) => s.id === '3')?.terminal).toBe('PABT');
    expect(ds.stops.find((s) => s.id === '2')?.name).toBe('MAIN ST, AT ELM');
    expect(ds.meta).toMatchObject({ demo: false, timezone: 'America/New_York' });
  });

  it('flags filled-in times as estimates and never a time the feed gave', () => {
    expect(ds.trips.find((t) => t.id === 'T1')?.estimated).toEqual([1]);
    expect(ds.trips.find((t) => t.id === 'T2')).not.toHaveProperty('estimated');
    const [late, filled] = departuresOn(ds, { stopId: '2', date: '20261104' });
    expect([late?.estimated, filled?.estimated]).toEqual([false, true]);
    expect(tripStopTimes(ds, filled!).map((x) => x.estimated)).toEqual([false, true, false]);
  });

  it('keeps the express as its own pattern', () => {
    expect(ds.patterns).toHaveLength(2);
    const express = ds.patterns.find((p) => p.routeId === '11');
    expect(express?.stopIds).toEqual(['1', '3']);
  });

  it('merges calendar and calendar_dates, including calendar_dates-only services', () => {
    expect(ds.calendars.WK?.removed).toEqual(['20261126']);
    expect(ds.calendars.HOL).toMatchObject({ added: ['20261126'], days: [false, false, false, false, false, false, false] });
  });

  it('produces a schedule the app can query: interpolated stop, after-midnight trip, holiday service', () => {
    const tz = ds.meta.timezone;
    const at = (date: string, stop: string) => departuresOn(ds, { stopId: stop, date }).map((d) => formatTime12(d.departs, tz));
    // 12:20 AM is Tuesday's 24:20 trip; 7:20 AM is the interpolated midpoint of 7:00 and 7:40.
    expect(at('20261104', '2')).toEqual(['12:20 AM', '7:20 AM']);
    expect(at('20261105', '1')).toEqual(['12:10 AM', '7:00 AM', '7:05 AM']); // 24:10 from Wednesday's service
    expect(at('20261126', '1')).toEqual(['12:10 AM', '8:00 AM']); // holiday: only HOL plus Wednesday's late trip
  });
});


describe('canonical live schedule eligibility', () => {
  it('rejects corridor frequency trips for the exact-trip pilot, without rejecting unrelated routes', () => {
    const options = { routeShortNames: ['165', '165T'], splitVariants: true, scheduledOnly: true };
    for (const exact of ['0', '1']) {
      expect(() => buildDataset({ ...files, 'frequencies.txt': 'trip_id,start_time,end_time,headway_secs,exact_times\nT1,07:00:00,09:00:00,600,' + exact }, options)).toThrow(/frequency-based/);
    }
    expect(() => buildDataset({ ...files, 'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nother,07:00:00,09:00:00,600' }, options)).not.toThrow();
  });
  const asCsv = (rows: Record<string, string>[]) => {
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return [keys.join(','), ...rows.map((row) => keys.map((key) => '"' + (row[key] ?? '').replaceAll('"', '""') + '"').join(','))].join('\n');
  };
  it('preserves canonical trip IDs while splitting 165T headsign variants from route 165', () => {
    const source = { ...files, 'trips.txt': asCsv(parseCsv(files['trips.txt']).map((t: Record<string, string>) => t.trip_id === 'T1' ? { ...t, trip_headsign: '165T NEW YORK TURNPIKE EXPRESS' } : t)) };
    const ds: Dataset = buildDataset(source, { routeShortNames: ['165', '165T'], splitVariants: true });
    const trip = ds.trips.find((t) => t.id === 'T1')!, pattern = ds.patterns.find((p) => p.id === trip.patternId)!;
    expect(ds.routes.find((r) => r.id === pattern.routeId)).toMatchObject({ shortName: '165T', feedRouteId: '10' });
    expect(pattern.variant).toBe('T'); expect(trip.id).toBe('T1');
  });
  it('never offers boarding at a drop-off-only stop or alighting at a pickup-only stop', () => {
    const source = { ...files, 'stop_times.txt': asCsv(parseCsv(files['stop_times.txt']).map((s: Record<string, string>) => ({ ...s,
      pickup_type: s.trip_id === 'T1' && s.stop_id === '2' ? '1' : '0',
      drop_off_type: s.trip_id === 'T1' && s.stop_id === '3' ? '1' : '0',
    }))) };
    const ds: Dataset = buildDataset(source, { routeShortNames: ['165', '165T'], splitVariants: true });
    expect(departuresOn(ds, { stopId: '2', date: '20261104' }).some((d) => d.tripId === 'T1')).toBe(false);
    expect(departuresOn(ds, { stopId: '1', toStopId: '3', date: '20261104' }).some((d) => d.tripId === 'T1')).toBe(false);
    expect(ds.patterns.find((p) => p.id === ds.trips.find((t) => t.id === 'T1')?.patternId)?.stopSequences).toEqual([1, 2, 3]);
  });
});

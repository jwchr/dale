import { describe, expect, it } from 'vitest';
import { COUNT_MAX_BYTES, countJson, jsonRecords, textRecords } from '../../worker/record-count';

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('record counts for the status page', () => {
  it('counts lists, the lists inside an object, and treats a list-free object as one record', () => {
    expect(jsonRecords([1, 2, 3])).toBe(3);
    expect(jsonRecords([])).toBe(0);
    expect(jsonRecords({ STATION_2CHAR: 'NY', ITEMS: [{}, {}] })).toBe(2);
    expect(jsonRecords({ '@context': ['x', 'y'], features: [{}] })).toBe(1);
    expect(jsonRecords({ properties: { periods: [{}] } })).toBe(1);
    expect(jsonRecords({})).toBe(0);
    expect(jsonRecords(null)).toBe(0);
  });

  it('counts RSS items, reads JSON past a byte-order mark, and refuses anything else', () => {
    expect(textRecords('<?xml version="1.0"?><rss><channel><item>a</item><item>b</item></channel></rss>')).toBe(2);
    expect(textRecords('<rss><channel></channel></rss>')).toBe(0);
    expect(textRecords('﻿ [1,2]')).toBe(2);
    expect(textRecords('<html>Maintenance</html>')).toBeNull();
    expect(textRecords('Service Unavailable')).toBeNull();
  });

  it('counts a plain answer by its stream and a poll bundle per kind of answer, with failures', () => {
    expect(countJson('busdv-getLocations:BUS', bytes([{}, {}]), 5)).toEqual({ 'busdv-getLocations:BUS': { at: 5, records: 2 } });
    const traffic = bytes({ v: 1, responses: [
      { source: 'crossingTimes', status: 'ok', text: '[{},{}]' },
      { source: 'njtAdvisories', status: 'ok', text: '<rss><item/></rss>' },
      { source: 'panynjAlerts', status: 'timed-out' }] });
    expect(countJson('traffic-poll', traffic, 7)).toEqual({
      'traffic-poll/crossingTimes': { at: 7, records: 2, answers: 1, failed: 0 },
      'traffic-poll/njtAdvisories': { at: 7, records: 1, answers: 1, failed: 0 },
      'traffic-poll/panynjAlerts': { at: 7, records: null, answers: 1, failed: 1 } });
    const rail = bytes({ v: 1, responses: [
      { method: 'getTrainSchedule', station: 'NY', status: 'ok', text: '{"ITEMS":[{},{},{}]}' },
      { method: 'getTrainSchedule', station: 'NP', status: 'ok', text: '{"ITEMS":[{}]}' },
      { method: 'getStationMSG', status: 'ok', base64: '/w==' }] });
    expect(countJson('raildata-poll', rail, 9)).toEqual({
      'raildata-poll/getTrainSchedule': { at: 9, records: 4, answers: 2, failed: 0 },
      'raildata-poll/getStationMSG': { at: 9, records: null, answers: 1, failed: 0 } });
    const weather = bytes({ v: 1, responses: [{ kind: 'alerts', id: 'NJ', status: 'ok', text: '{"features":[]}' }] });
    expect(countJson('weather-poll', weather, 1)).toEqual({ 'weather-poll/alerts': { at: 1, records: 0, answers: 1, failed: 0 } });
  });

  it('puts no station, URL or text from a bundle in the counts', () => {
    const out = JSON.stringify(countJson('raildata-poll', bytes({ responses: [{ method: 'getTrainSchedule', station: 'SECRETSTATION', url: 'https://example.invalid/x', status: 'ok', text: '{"ITEMS":[{"TRAIN_ID":"9999"}]}' }] }), 1));
    expect(out).not.toMatch(/SECRETSTATION|example\.invalid|9999/);
  });

  it('marks unreadable answers as unknown instead of zero', () => {
    expect(countJson('busdv-getBusRoutes:BUS', new Uint8Array([0xff, 0xfe]), 1)).toEqual({ 'busdv-getBusRoutes:BUS': { at: 1, records: null } });
    expect(countJson('traffic-poll', bytes('not json'), 1)).toEqual({ 'traffic-poll': { at: 1, records: null } });
    expect(countJson('traffic-poll', bytes({ v: 1 }), 1)).toEqual({ 'traffic-poll': { at: 1, records: null } });
  });
  it('counts an empty bundle as 0 and leaves an answer over the size limit uncounted (Neon Nov27 a)', () => {
    expect(countJson('weather-poll', bytes({ v: 1, responses: [] }), 1)).toEqual({ 'weather-poll': { at: 1, records: 0 } });
    expect(countJson('weather-poll', bytes({ v: 1, responses: [{ status: 'ok', text: '[1]' }] }), 1)).toEqual({ 'weather-poll': { at: 1, records: 0 } });
    const big = new Uint8Array(COUNT_MAX_BYTES + 1).fill(0x20); big[0] = 0x5b; big[big.length - 1] = 0x5d;
    expect(countJson('raildata-getStationSchedule', big, 1)).toEqual({ 'raildata-getStationSchedule': { at: 1, records: null, tooLarge: true } });
    expect(countJson('raildata-getStationSchedule', big.subarray(1), 1)['raildata-getStationSchedule']).toEqual({ at: 1, records: null });
    const fits = new Uint8Array(COUNT_MAX_BYTES).fill(0x20); fits[0] = 0x5b; fits[fits.length - 1] = 0x5d;
    expect(countJson('raildata-getStationSchedule', fits, 1)).toEqual({ 'raildata-getStationSchedule': { at: 1, records: 0 } });
  });
});

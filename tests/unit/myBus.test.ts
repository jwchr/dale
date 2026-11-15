import { describe, expect, it } from 'vitest';
import { myBusPhone, myBusSms, myBusStop, MYBUS_WEB } from '../../src/domain/myBus';
import { departuresOn } from '../../src/domain/schedule';
import { liveDataset } from '../helpers/liveBus';

function fixture() {
  const ds = structuredClone(liveDataset);
  const dep = departuresOn(ds, { stopId: '2', toStopId: '3', routeIds: ['10'], date: '20261104' })[0]!;
  return { ds, dep };
}

describe('official MyBus handoff', () => {
  it('keeps the exact boarding code and direction, including leading zeroes', () => {
    const { ds, dep } = fixture();
    ds.stops.find(s => s.id === '2')!.code = '00302';
    expect(myBusStop(ds, dep)).toEqual({ code: '00302', name: 'MAIN ST, AT ELM', headsign: dep.pattern.headsign });
    // An across-the-street stop, even with a plausible code, is never substituted.
    ds.stops.find(s => s.id === '2')!.twin = '4';
    expect(myBusStop(ds, dep)?.code).toBe('00302');
  });
  it.each(['', '165', '123456', ' 30002', '30002 ', '30002&body=other', '٣٠٠٠٢'])('rejects unpublished/unsafe code %j without falling back to the internal ID', code => {
    const { ds, dep } = fixture();
    ds.stops.find(s => s.id === '2')!.code = code;
    expect(myBusStop(ds, dep)).toBeUndefined();
    expect(myBusSms(code, 'android')).toBeUndefined();
  });
  it('rejects demo, printed, and noncanonical schedules', () => {
    const { ds, dep } = fixture();
    ds.meta.demo = true;
    expect(myBusStop(ds, dep)).toBeUndefined();
    ds.meta.demo = false;
    ds.meta.transcribed = { documentId: 'fixture', issued: '20261104' };
    expect(myBusStop(ds, dep)).toBeUndefined();
    delete ds.meta.transcribed;
    delete ds.meta.realtime;
    expect(myBusStop(ds, dep)).toBeUndefined();
  });
  it('fails closed for stale or inconsistent trip, pattern, side, or boarding restrictions', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.ds.trips = []; },
      (f: ReturnType<typeof fixture>) => { f.dep = { ...f.dep, stopIndex: -1 }; },
      (f: ReturnType<typeof fixture>) => { f.dep = { ...f.dep, stopIndex: 2 }; },
      (f: ReturnType<typeof fixture>) => { f.dep = { ...f.dep, tripInstanceId: 'wrong' }; },
      (f: ReturnType<typeof fixture>) => { f.dep = { ...f.dep, pattern: { ...f.dep.pattern, directionId: 1 } }; },
      (f: ReturnType<typeof fixture>) => { f.dep = { ...f.dep, pattern: { ...f.dep.pattern, stopIds: ['1', '4', '3'] } }; },
      (f: ReturnType<typeof fixture>) => { f.ds.patterns.find(p => p.id === f.dep.pattern.id)!.noPickup = [1]; },
    ]) {
      const f = fixture(); change(f);
      expect(myBusStop(f.ds, f.dep)).toBeUndefined();
    }
  });
  it('uses a generic official web form and explicit composition URLs, never a sending endpoint', () => {
    expect(MYBUS_WEB).toBe('https://www.njtransit.com/my-bus-to');
    expect(myBusSms('00302', 'android')).toBe('sms:69287?body=00302');
    expect(myBusSms('00302', 'apple')).toBe('sms:69287');
    expect(myBusSms('00302', 'other')).toBeUndefined();
    expect(myBusPhone('Android', 'Linux', 5)).toBe('android');
    expect(myBusPhone('iPhone', 'iPhone', 5)).toBe('apple');
    expect(myBusPhone('desktop Safari', 'MacIntel', 5)).toBe('apple');
    expect(myBusPhone('desktop Safari', 'MacIntel', 0)).toBe('other');
  });
});

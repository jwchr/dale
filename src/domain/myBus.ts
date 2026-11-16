import { tripInstanceId, type Dataset, type Departure } from './types';

export const MYBUS_WEB = 'https://www.njtransit.com/my-bus-to';
export const MYBUS_NUMBER = '69287';
export type MyBusPhone = 'android' | 'apple' | 'other';

/** Only the published code at this exact canonical boarding position, never an internal ID. */
export function myBusStop(ds: Dataset, dep: Departure) {
  if (ds.meta.demo || ds.meta.transcribed || ds.meta.realtime?.provider !== 'njt-bus-g2') return undefined;
  const trip = ds.trips.find(t => t.id === dep.tripId);
  const pattern = ds.patterns.find(p => p.id === trip?.patternId);
  const i = dep.stopIndex;
  if (!pattern || pattern.id !== dep.pattern.id || pattern.routeId !== dep.route.id
    || dep.tripInstanceId !== tripInstanceId(dep.tripId, dep.serviceDate)
    || !Number.isInteger(i) || i < 0 || i >= pattern.stopIds.length - 1 || pattern.noPickup?.includes(i)
    || pattern.stopIds[i] !== dep.pattern.stopIds[i] || pattern.directionId !== dep.pattern.directionId) return undefined;
  const stop = ds.stops.find(s => s.id === pattern.stopIds[i]);
  if (!stop?.code || !/^[0-9]{5}$/.test(stop.code)) return undefined;
  return { code: stop.code, name: stop.name, headsign: pattern.headsign };
}

/** Device hints choose a conservative handoff, never claim that an SMS app is installed. */
export function myBusPhone(userAgent: string, platform: string, maxTouchPoints: number): MyBusPhone {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'apple';
  return /Android/i.test(userAgent) ? 'android' : 'other';
}

/** RFC 5724 body on Android; Apple's documented scheme supports the recipient only. */
export function myBusSms(code: string, phone: MyBusPhone): string | undefined {
  if (!/^[0-9]{5}$/.test(code) || phone === 'other') return undefined;
  return `sms:${MYBUS_NUMBER}${phone === 'android' ? `?body=${encodeURIComponent(code)}` : ''}`;
}

// The rider's own phone position, shared by ride mode (StripMap) and the home map (#101). Opt-in only: it runs
// only while `enabled` (the rider tapped to turn it on) and the screen using it is open. The position stays in
// memory on this phone; nothing is stored, logged or sent.
import { useEffect, useRef, useState } from 'react';
import type { Fix } from '../domain/tripProgress';

export type GpsState = 'off' | 'asking' | 'on' | 'denied' | 'unsupported' | 'failed';

export function usePhoneFix(enabled: boolean, now: number): { phone?: Fix; gps: GpsState } {
  const [phone, setPhone] = useState<Fix | undefined>();
  const [gps, setGps] = useState<GpsState>(enabled ? 'asking' : 'off');
  // A fix is stamped with Dale's own clock when it arrives (the same clock the timetable is read with).
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    if (!enabled) { setGps('off'); return; }
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setGps('unsupported'); return; }
    setGps('asking');
    const id = navigator.geolocation.watchPosition(
      // The fix's own age is kept (a cached or delayed fix is not "now"), on Dale's clock.
      (pos) => { setGps('on'); setPhone({ lat: pos.coords.latitude, lon: pos.coords.longitude, at: nowRef.current - Math.max(0, Date.now() - (pos.timestamp || Date.now())), accuracyM: pos.coords.accuracy }); },
      (e) => setGps(e.code === e.PERMISSION_DENIED ? 'denied' : 'failed'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => { navigator.geolocation.clearWatch(id); setPhone(undefined); };
  }, [enabled]);
  return { phone, gps };
}

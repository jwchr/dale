import type { BusSession } from './busLock';
import { DEFAULT_TIMING } from './lock';

/** Loss means an actual previously received fix aged out; never infer a whole-agency outage. */
export function gpsLost(session: BusSession, now: number): boolean {
  const last = session.lock.last;
  return !!last && (now - last.observedAt > DEFAULT_TIMING.staleAfterMs || (!!session.officialFeed && session.officialFeed.state !== 'ok'))
    && !['cancelled', 'ended', 'needs_confirmation'].includes(session.lock.status);
}
export function offerAlternatives(session: BusSession, now: number): boolean {
  if (session.phase === 'passed') return true;
  if (!['viewing', 'waiting'].includes(session.phase)) return false;
  return gpsLost(session, now) || session.lock.status === 'cancelled'
    || (session.phase === 'waiting' && (now >= session.departure.departs
      || session.reports.some((r) => r.kind === 'passed_without_stopping')));
}

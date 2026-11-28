// One-tap trip update (issue #61): a short message the rider sends through their own messaging app.
// Dale prepares the text only; it sends nothing, and the text carries no position, only the stops and
// scheduled times the rider already chose. It says what the rider reported, never a live claim.
import type { BusSession } from './busLock';
import { tripStopTimes } from './schedule';
import type { Dataset } from './types';

export type TripUpdate =
  | { kind: 'planning' }
  | { kind: 'waiting' }
  /** Waiting past the scheduled time with the bus not here yet: `lateMin` minutes after it. */
  | { kind: 'not_here'; lateMin: number }
  | { kind: 'passed' }
  | { kind: 'arrived' }
  /** On board; `to` and `at` when the rider set where they get off and the trip lists a time there. */
  | { kind: 'onboard'; to?: { stopId: string; at: number; estimated: boolean } }
  | { kind: 'off' }
  | { kind: 'left' }
  /** Only when NJ Transit itself cancelled the trip. */
  | { kind: 'cancelled' };

export interface TripUpdateText {
  update: TripUpdate;
  route: string;
  /** The rider's boarding stop and the bus's scheduled time there. */
  stopId: string;
  departs: number;
  estimated: boolean;
  demo: boolean;
}

export function tripUpdate(ds: Dataset, session: BusSession, alightIndex: number, now: number): TripUpdateText {
  const dep = session.departure;
  const base = { route: dep.route.shortName, stopId: dep.stopIndex === null ? '' : dep.pattern.stopIds[dep.stopIndex]!, departs: dep.departs, estimated: dep.estimated, demo: !!ds.meta.demo };
  const passed = session.reports.some((r) => r.kind === 'passed_without_stopping' && r.stopIndex === dep.stopIndex);
  const update: TripUpdate = session.lock.status === 'cancelled' ? { kind: 'cancelled' }
    : ['viewing', 'following', 'passed'].includes(session.phase) ? { kind: 'planning' }
      : session.phase === 'waiting'
        ? passed ? { kind: 'passed' } : now >= dep.departs ? { kind: 'not_here', lateMin: Math.floor((now - dep.departs) / 60_000) } : { kind: 'waiting' }
        : session.phase === 'arrived' ? { kind: 'arrived' }
          : session.phase === 'onboard' ? onboard()
            : session.phase === 'ended' ? { kind: 'off' } : { kind: 'left' };
  return { ...base, update };

  function onboard(): TripUpdate {
    if (!(alightIndex > (dep.stopIndex ?? -1))) return { kind: 'onboard' };
    const at = tripStopTimes(ds, dep)[alightIndex];
    return at ? { kind: 'onboard', to: { stopId: at.stopId, at: at.at, estimated: at.estimated } } : { kind: 'onboard' };
  }
}

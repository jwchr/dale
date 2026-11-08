import type { StationChoice } from './journeyGuide';

export type RailDay = 'weekday' | 'weekend';
export type RailDirection = 'outbound' | 'return';
export type RailStation = StationChoice | 'secaucus' | 'penn';
/** Wall-clock minutes from the start of a timetable day, not a current prediction or service date. */
export interface RailCall {
  station: RailStation;
  minute: number;
  event: 'departure' | 'arrival' | 'call';
  mayLeaveEarly?: boolean;
}
export interface RailLeg {
  line: 'pascack-valley' | 'penn-connection';
  train?: string;
  from: RailCall;
  to: RailCall;
}
export interface RailExample {
  id: string;
  day: RailDay;
  direction: RailDirection;
  train: string;
  anderson?: number;
  essex?: number;
  secaucusPvl: number;
  secaucusPenn: number;
  penn: number;
  pvlMayLeaveEarly?: boolean;
}
export interface RailTimetable {
  // A future official adapter needs an explicit current-service contract before this can change.
  kind: 'sample';
  source: { document: string; asOf: string; complete: false };
  examples: readonly RailExample[];
}
export interface RailJourney {
  id: string;
  kind: 'sample';
  legs: [RailLeg, RailLeg];
  durationMin: number;
  transferGapMin: number;
}

/** Separate from live bus departures/locks. No clock-based "next train", date inference or ranking
 * against real buses. These are the printed paired connections, not a transfer-buffer planner. */
export function railExamples(timetable: RailTimetable, station: StationChoice, direction: RailDirection, day: RailDay): RailJourney[] {
  return timetable.examples.flatMap(row => {
    const home = row[station];
    if (row.direction !== direction || row.day !== day || home === undefined) return [];
    const outbound = direction === 'outbound';
    const times = outbound ? [home, row.secaucusPvl, row.secaucusPenn, row.penn] : [row.penn, row.secaucusPenn, row.secaucusPvl, home];
    if (times.some((time, i) => !Number.isInteger(time) || time < 0 || time >= 2880 || (i > 0 && time < times[i - 1]!))) return [];
    const pvl: RailLeg = { line: 'pascack-valley', train: row.train,
      from: { station: outbound ? station : 'secaucus', minute: outbound ? home : row.secaucusPvl, event: 'departure' },
      to: { station: outbound ? 'secaucus' : station, minute: outbound ? row.secaucusPvl : home, event: 'call', ...(row.pvlMayLeaveEarly ? { mayLeaveEarly: true } : {}) },
    };
    const penn: RailLeg = { line: 'penn-connection',
      from: { station: outbound ? 'secaucus' : 'penn', minute: outbound ? row.secaucusPenn : row.penn, event: 'departure' },
      to: { station: outbound ? 'penn' : 'secaucus', minute: outbound ? row.penn : row.secaucusPenn, event: 'arrival' },
    };
    return [{ id: `${row.id}-${station}`, kind: timetable.kind, legs: outbound ? [pvl, penn] : [penn, pvl],
      durationMin: times[3]! - times[0]!, transferGapMin: times[2]! - times[1]! } satisfies RailJourney];
  });
}

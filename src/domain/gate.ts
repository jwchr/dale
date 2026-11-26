// Port Authority gate for one exact departure. Sources, best first:
//   posted  - NJ Transit DepartureVision assignment for this trip instance (getBusDV.lanegate)
//   usual   - the gate this route pattern used at this time on comparable days, learned from history
//   published - NJ Transit's own printed gate rule for this service type and time (a rule, not this trip's assignment)
//   unknown - nothing reliable; the UI says "Gate not confirmed" and links to the official board
// A gate is never inferred from the route number alone.

import type { PublishedGates, TripInstanceId } from './types';

export interface GatePosting {
  tripInstanceId: TripInstanceId;
  boardingIndex: number;
  ageMs: number;
  gate: string;
  door?: string;
  observedAt: number;
  source: 'njt-departurevision' | 'demo';
}

export interface UsualGate {
  patternId: string;
  /** Inclusive local minutes after midnight. */
  fromMin: number;
  toMin: number;
  dayType: 'weekday' | 'saturday' | 'sunday';
  gate: string;
  door?: string;
  /** How many observed departures support this, for honesty in the UI. */
  samples: number;
}

export type GateAnswer =
  | { status: 'posted'; gate: string; door?: string; observedAt: number; ageMs?: number; source: GatePosting['source'] }
  | { status: 'usual'; gate: string; door?: string; samples: number }
  | { status: 'published'; gate: string; door?: string; source: string; effective: string }
  | { status: 'unknown' };

/** Only bounded numeric gate/door forms are usable; other agency text is not a gate. */
export function parseLaneGate(raw: string | undefined | null): { gate: string; door?: string } | null {
  if (typeof raw !== 'string' || raw.length > 8 || !raw) return null;
  const s = raw;
  const m = /^(\d{1,3})(?:\s*[-/]\s*(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return m[2] ? { gate: m[1]!, door: m[2] } : { gate: m[1]! };
}

export function gateFor(
  tripId: TripInstanceId,
  patternId: string,
  localMinutes: number,
  dayType: UsualGate['dayType'],
  postings: GatePosting[],
  usual: UsualGate[],
  published?: PublishedGates,
  /** Pattern variant (T, P, R, RF...) for published rules; omit for unmarked local trips. */
  variant?: string,
  boardingIndex = 0,
): GateAnswer {
  const posted = postings
    .filter((p) => p.tripInstanceId === tripId && p.boardingIndex === boardingIndex && Number.isFinite(p.ageMs) && p.ageMs >= 0 && p.ageMs < 120_000)
    .sort((a, b) => b.observedAt - a.observedAt)[0];
  if (posted) return { status: 'posted', gate: posted.gate, door: posted.door, observedAt: posted.observedAt, ageMs: posted.ageMs, source: posted.source };
  const u = usual
    .filter((x) => x.patternId === patternId && x.dayType === dayType && localMinutes >= x.fromMin && localMinutes <= x.toMin)
    .sort((a, b) => b.samples - a.samples)[0];
  if (u && u.samples >= 5) return { status: 'usual', gate: u.gate, door: u.door, samples: u.samples };
  const rule = publishedGateFor(published, variant ?? 'local', localMinutes, dayType);
  if (rule) return rule;
  return { status: 'unknown' };
}

/**
 * NJ Transit's printed gate rule for a service type at a clock time. `serviceMinutes` is minutes since the
 * service day began (1500 = 1:00 AM after midnight); printed windows are wall-clock, so it is wrapped to a day.
 * `dayType` is the service day's type, so a 12:30 AM bus after Friday's service still follows Friday's rules.
 */
export function publishedGateFor(
  published: PublishedGates | undefined,
  service: string,
  serviceMinutes: number,
  dayType: UsualGate['dayType'],
): Extract<GateAnswer, { status: 'published' }> | undefined {
  if (!published) return undefined;
  const wall = ((Math.round(serviceMinutes) % 1440) + 1440) % 1440;
  const rule = published.rules.find((r) => {
    if (r.service !== service || !r.dayTypes.includes(dayType)) return false;
    if (r.fromMin === undefined || r.toMin === undefined) return true;
    return r.fromMin <= r.toMin ? wall >= r.fromMin && wall <= r.toMin : wall >= r.fromMin || wall <= r.toMin;
  });
  return rule ? { status: 'published', gate: rule.gate, door: rule.door, source: published.source, effective: published.effective } : undefined;
}

/** A change worth a notification: a new posting for the same trip with a different gate or door. */
export function gateChanged(prev: GateAnswer, next: GateAnswer): boolean {
  if (next.status !== 'posted') return false;
  if (prev.status === 'posted') return prev.gate !== next.gate || (prev.door ?? '') !== (next.door ?? '');
  if (prev.status === 'usual' || prev.status === 'published') return prev.gate !== next.gate;
  return false;
}

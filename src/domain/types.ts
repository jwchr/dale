// Core transit types. IDs are the feed's own strings; never a route label like "165" alone.

export interface Dataset {
  meta: DatasetMeta;
  routes: Route[];
  stops: Stop[];
  patterns: Pattern[];
  trips: Trip[];
  calendars: Record<string, ServiceCalendar>;
  /** NJ Transit's published Port Authority gate rules (from a printed timetable), when no live gate is known. */
  publishedGates?: PublishedGates;
  /** NJ Transit's printed cash fares and fare zones (from a printed timetable). Absent = no fare is shown. */
  publishedFares?: PublishedFares;
}

/** Fares by number of zones traveled, as printed. Each time a rider crosses a zone boundary they pay for another zone. */
export interface PublishedFares {
  /** Where the fares were read, shown to the rider. */
  source: string;
  /** YYYYMMDD the printed fares took effect. */
  effective: string;
  /** Zone band per stop id, counted from New York = 1 along the line: [lo, hi], with lo < hi when the stop is drawn on a boundary. */
  stopZones: Record<string, [number, number]>;
  /** Stop ids in New York; a trip touching one uses the to/from New York table. */
  newYorkStopIds: string[];
  /** Cents by zones traveled ("2", "3", ...). "reduced" is children 5-11 and seniors 62 and older. */
  withinNewJersey: { adult: Record<string, number>; reduced: Record<string, number> };
  toFromNewYork: { adult: Record<string, number>; reduced: Record<string, number> };
}

/** Gate rules NJ Transit prints by service type and time of day. A rule applies by the departure's clock time at the terminal. */
export interface PublishedGates {
  /** Where the rules were read, shown to the rider. */
  source: string;
  /** YYYYMMDD the printed gate change took effect. */
  effective: string;
  rules: PublishedGateRule[];
}

export interface PublishedGateRule {
  /** "local" for unmarked trips, else the timetable's trip marker (T, P, R, RF...). */
  service: string;
  dayTypes: ('weekday' | 'saturday' | 'sunday')[];
  /** Inclusive wall-clock minutes after midnight; toMin < fromMin wraps past midnight. Omitted = all day. */
  fromMin?: number;
  toMin?: number;
  gate: string;
  door?: string;
}

export interface DatasetMeta {
  /** True for the invented demo dataset. The UI must show a DEMO banner whenever this is true. */
  demo: boolean;
  source: string;
  feedVersion: string;
  builtAt: string;
  /** Canonical static feed compatible with the approved live bus service. */
  realtime?: { provider: 'njt-bus-g2' };
  stopCities?: { source: string; url: string; retrievedAt: string; state: 'verified' | 'unavailable' };
  timezone: string; // agency timezone, e.g. America/New_York
  /** Set when the data was typed in from a printed timetable rather than built from NJ Transit's data feed. The UI must say so. */
  transcribed?: { issued: string; documentId: string };
}

export interface Route {
  id: string;
  shortName: string; // "165T"
  longName: string;
  /** Original GTFS route ID when variants share a route in the source feed. */
  feedRouteId?: string;
  color?: string;
}

export interface Stop {
  id: string;
  city?: string;
  /** Provider spelling retained when an owner-verified display correction is applied. */
  sourceName?: string;
  code?: string; // NJ Transit five-digit stop code when published
  name: string;
  /** Absent in datasets transcribed from printed timetables, which carry no coordinates. */
  lat?: number;
  lon?: number;
  /** The stop for the opposite direction at the same place (across the street), when the source says so. Both stops point at each other. */
  twin?: string;
  /** Key of a note the UI shows to riders boarding here (see i18n `stopNotes`). */
  noteId?: string;
  /** Terminal id when this stop is a terminal with gates, e.g. "PABT". */
  terminal?: string;
}

/** One ordered stop sequence for a route and direction (a "service pattern"; 165T is its own pattern). */
export interface Pattern {
  id: string;
  routeId: string;
  directionId: 0 | 1;
  headsign: string;
  stopIds: string[];
  /** Original GTFS sequences and non-ordinary pickup/drop-off restrictions. */
  stopSequences?: number[];
  noPickup?: number[];
  noDropOff?: number[];
  /** The printed timetable's trip marker for this pattern (T, P, R, RF, F, FP); absent for unmarked local trips. */
  variant?: string;
}

export interface Trip {
  id: string;
  patternId: string;
  serviceId: string;
  /** Departure seconds on the service day, aligned to pattern.stopIds; may exceed 86400. GTFS: after noon minus 12 h. Printed timetables: the printed clock time (see `tripTimeAt`). */
  times: number[];
  /** Explicit GTFS scheduled arrival seconds; null is missing/invalid, never copied from departure. */
  arrivals?: (number | null)[];
  /** Indices into `times` the build script filled in because the feed left them blank: Dale's estimates, not NJ Transit data. Omitted when none. */
  estimated?: number[];
}

export interface ServiceCalendar {
  /** Monday..Sunday */
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  start: string; // YYYYMMDD
  end: string;
  added: string[];
  removed: string[];
}

/** A scheduled trip on a specific service date: the unit we lock onto. */
export type TripInstanceId = string; // `${tripId}@${serviceDate}`

export function tripInstanceId(tripId: string, serviceDate: string): TripInstanceId {
  return `${tripId}@${serviceDate}`;
}

export interface Departure {
  tripInstanceId: TripInstanceId;
  tripId: string;
  serviceDate: string;
  route: Route;
  pattern: Pattern;
  stopIndex: number;
  /** Scheduled departure at the chosen stop (epoch ms). */
  departs: number;
  /** True when `departs` is Dale's estimate (see Trip.estimated), so the UI must label it. */
  estimated: boolean;
  /** Scheduled arrival at the pattern's last stop (epoch ms). */
  arrivesEnd: number;
}

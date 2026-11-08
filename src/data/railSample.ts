import type { RailTimetable } from '../domain/railTimetable';

/** Owner-approved sample timetable. Visually checked against PV-combined.pdf, pages 1–4.
 * Regular 8/30/26 examples are NOT valid current service during the Portal override.
 * Absent stops stay absent. Conditional late train 2101 is deliberately not included.
 * No source API, current date, feed, rider position, track or invented connection train ID. */
export const sampleRailTimetable: RailTimetable = {
  kind: 'sample', source: { document: 'PV-combined.pdf', asOf: '2026-08-30', complete: false },
  examples: [
    { id: 'weekday-1602', day: 'weekday', direction: 'outbound', train: '1602', anderson: 349, essex: 352, secaucusPvl: 369, secaucusPenn: 376, penn: 389, pvlMayLeaveEarly: true },
    { id: 'weekday-1604', day: 'weekday', direction: 'outbound', train: '1604', anderson: 396, essex: 399, secaucusPvl: 416, secaucusPenn: 421, penn: 434, pvlMayLeaveEarly: true },
    { id: 'weekday-1608', day: 'weekday', direction: 'outbound', train: '1608', anderson: 434, essex: 437, secaucusPvl: 455, secaucusPenn: 460, penn: 474, pvlMayLeaveEarly: true },
    { id: 'weekday-1605', day: 'weekday', direction: 'return', train: '1605', anderson: 564, essex: 561, secaucusPvl: 547, secaucusPenn: 535, penn: 526 },
    { id: 'weekday-1651', day: 'weekday', direction: 'return', train: '1651', anderson: 598, secaucusPvl: 584, secaucusPenn: 571, penn: 562 },
    { id: 'weekday-1607', day: 'weekday', direction: 'return', train: '1607', anderson: 626, essex: 623, secaucusPvl: 608, secaucusPenn: 595, penn: 586 },
    { id: 'weekend-2100', day: 'weekend', direction: 'outbound', train: '2100', anderson: 403, essex: 406, secaucusPvl: 423, secaucusPenn: 438, penn: 455 },
    { id: 'weekend-2102', day: 'weekend', direction: 'outbound', train: '2102', anderson: 463, essex: 466, secaucusPvl: 483, secaucusPenn: 498, penn: 512 },
    { id: 'weekend-2104', day: 'weekend', direction: 'outbound', train: '2104', anderson: 528, essex: 531, secaucusPvl: 548, secaucusPenn: 558, penn: 572 },
    { id: 'weekend-2103', day: 'weekend', direction: 'return', train: '2103', anderson: 522, essex: 519, secaucusPvl: 503, secaucusPenn: 496, penn: 487 },
    { id: 'weekend-2107', day: 'weekend', direction: 'return', train: '2107', anderson: 642, essex: 639, secaucusPvl: 623, secaucusPenn: 604, penn: 595 },
    { id: 'weekend-2111', day: 'weekend', direction: 'return', train: '2111', anderson: 763, essex: 760, secaucusPvl: 743, secaucusPenn: 736, penn: 727 },
  ],
};

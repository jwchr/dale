# Plan for Codex to check before building: fares on official route 165 stops (#31 step 2, Nov 20, 2026)

Jeff approved this on Nov 20, 2026: match the official NJ Transit stops to the printed route 165 fare-zone list, and show "zone X or Y" wherever a match is not certain. NJ Transit's schedule file has no fare data (#231), so the printed timetable (`data/t0165/transcription.json`, D42) stays the only fare source. Codex cannot answer on issues here, so the plan is reviewed in this pull request.

## What exists

- The printed timetable gives fare zone bands for its 20 timepoints per direction (`fares.zones`), with two adjacent bands where the map puts a stop on a boundary, and the printed cash fare tables. `src/domain/fare.ts` already turns two bands into a fare range and never narrows it.
- The official schedule the Worker serves has every stop but no `publishedFares`, so today no fare shows on it.

## The change

1. **Where.** A pure function in `scripts/` (with unit tests) run at Worker preparation, next to the route geometry step. It reads the transcription and the official schedule and adds `publishedFares` keyed by official stop IDs. The app and `fare.ts` need no change except item 5.
2. **Anchor the timepoints.** For each official route 165 stop pattern, in stop order, a printed timepoint anchors to an official stop only when exactly one stop in that pattern matches both cross streets of the printed "where" (normalized: case, punctuation, St/Ave/Rd/Blvd abbreviations, N./S.), in the printed town (the stop's town from `stop-cities`), and the anchors keep the printed order. Port Authority anchors to the official PABT stop(s), which also become `newYorkStopIds`. Ambiguous or missing matches stay unanchored.
3. **Zones for every other stop.** A stop between two anchored timepoints gets the union of their two bands plus the bands of every printed timepoint between them that did not anchor (Codex, #238: a skipped boundary timepoint such as reference 15, zones 4 to 5, keeps its two-zone uncertainty). If both are the same single zone, that is the zone; if they differ, the rider sees both fares ("zone X or Y"). A union wider than two adjacent zones gets no zone (no fare shown). Stops before the first or after the last anchor get no zone. A stop seen in several patterns or both directions keeps the union only if it stays within two adjacent zones, otherwise no zone.
4. **Fail safe.** If fewer than 16 of the 20 timepoints anchor in either direction, the whole step adds no fares and the preparation log says so. The log adds aggregate counts only: anchors per direction and stops with one zone, two zones, or none. No stop IDs, names or coordinates.
5. **Only on route 165.** NJ Transit zones are per route, so a fare must not show for a 163, 164 or other route trip between the same stops. Add `routeIds` to `PublishedFares`: every route ID the printed table covers in that dataset, including the express variants (Codex, #238: the printed data has `R165` and `R165T`, and the Worker's `splitVariants` gives express patterns IDs like `<feed route>:T`). `fareBetween` returns nothing unless every route on the rider's leg is in that list. The printed dataset lists its own 165 and 165T IDs, so today's printed fares keep working.
6. **Shown with its source.** The existing fare note (printed timetable, effective date) stays; add "Zones matched by Dale from the printed map" in English and Spanish.
7. **Tests, synthetic stops only:** exact anchors; a misspelled or duplicated cross street stays unanchored; a stop between two zones shows both fares; a three-zone gap shows none; the 16-anchor floor; a skipped boundary timepoint keeps its two zones; printed and official 165T trips keep their fares while a 163 or 164 trip between zoned stops shows no fare; both directions disagreeing.

## How it ships

Fares come from Worker preparation, so they go live only at the next weekly rollover, after this plan check, the code review (Codex: money shown to riders and a Worker change) and green tests. Then check the rollover log counts and a fare on the live site on a narrow phone in English and Spanish.

Please flag: any way a rider could see a single fare where the printed map supports two, any way a fare could show for a route the printed table does not cover, and whether 16 of 20 is the right floor.

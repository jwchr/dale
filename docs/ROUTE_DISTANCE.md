# Observed bus route distance (#113)

This feature reports approximate remaining **route** distance from an actual NJ Transit bus GPS observation. Before boarding, the target is the selected boarding stop. On board, the target is the rider's selected destination. It does not use rider GPS, move with a timetable, predict arrival, confirm a stop, choose a different bus or change either arrival clock.

## Source and identity

The existing static preparation downloads one G2 ZIP. `buildRouteGeometry` derives a separate version-bound delivery asset from that same ZIP, joining each exact `trip_id` to its own `shape_id` and ordered stop calls. Trips sharing a stop pattern can have different shapes. Source `shape_dist_traveled` is only an interpolation parameter; its units are not assumed to be meters. Original road-path lengths are calculated in meters and retained through bounded simplification (4m screening tolerance). Stop mappings must be within100m of published stop coordinates. Missing, conflicting or invalid mappings are omitted.

`/v1/geometry?feedVersion=…` is a static read-only response. It does not invoke the feed actor, authenticate or fetch NJ Transit. It rejects other feed versions. The browser shares one bounded optional request per endpoint/version per opening; failures remain unavailable for that opening. Geometry is capped at4MB decoded,256shapes,2000trips and50000points. The source ZIP full SHA-256 must match the canonical feed-version prefix. An older archive cannot fill missing geometry in a different deployed feed.

The existing coalesced departures snapshot can include one exact-trip GPS observation. Original vehicle/observation timestamps are preserved. Ambiguous vehicles, contradictory latest fixes and unresolved dates supply no coordinates. This adds no upstream request or browser polling interval. Waiting/onboard use the existing accepted official lock history and exact vehicle identity.

## Rider behavior

A compact label shows `≈ 2.9 mi away · NJT GPS 15s` (English/Spanish). On board it names the remaining distance to the destination. Geometry, trip/date, stop order and vehicle must agree. Projection farther than100m off the route, ambiguous nearby route legs separated by more than100m of route progress, or a position beyond the target produce no distance. An explicit validated `stopped_at` observation can resolve a nearby repeated route leg; proximity alone cannot.

A missing feed keeps only the last qualified observed distance, marked Last GPS and continuing to age. Beyond120seconds it is stale even if later receipts repeat the same source timestamp. New off-route evidence does not make an old distance look current. Pending vehicle replacement, cancellation, closed rides and known lock stop changes suppress the display. No report yields a schedule-derived or straight-line distance.

## Recorder and release boundaries

Geometry is not a Dataset field and is never passed to `createFeedClass`, `HistoryJournal` or the archive. Canonical JSON bytes, `historyContextKey`, context size and the journal's reservations/write budgets are unchanged for the same canonical input. Tests compare original JSON/hash and ensure static delivery never touches the actor. The collection interval and all collector/archive limits remain unchanged.

Source tests use synthetic inputs. A private older local archive experiment may establish implementation size/coverage, never current-feed acceptance. The builder must not run real preparation, authentication/downloads, a Worker update, collector stop/restart or a collection-coupled workflow mode. Exact-head CI, independent HIGH full-diff review and the separate operator's data/deployment/public gates remain required. Publishing the frontend alone does not establish availability: the operator must qualify matched current geometry and GPS on the actual deployed backend while preserving the running recorder.

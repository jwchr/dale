# Plan for Codex to check before building: route distance part 2 (Nov 20, 2026)

Route distance has been off since the first enabled schedule (D68 geometry-off fallback). `docs/ROUTE_DISTANCE.md` describes the diagnostic. This is the fix chosen from its counts. Codex cannot answer on issues in this repo, so the plan is reviewed here as a pull request.

## What the counts show

Rollover run 44708502804 (Nov 20, schedule `5274ffd221b7`), diagnostic v2, aggregate counts only:
- 81 of 81 shapes valid; all 81 measure in feet (`shapeUnitFeet` 81).
- 1,770 of 1,770 trips rejected for `tripStopDistance`; 0 matched.
- For every rejected trip the first far stop lies on the shape line (`farFirstNearShapeLine` 1,770) and most stops are far (`farTripMostStops` 1,770), so terminal stops placed away from shape ends are not the cause.
- The ratio of the stop's `stop_times` measure to the shape measure at its nearest point is 1/5280 for 1,557 trips (`farRatioX0_000189`), other for 188, unknown for 25.

So NJ Transit's `stop_times.shape_dist_traveled` is in miles while `shapes.shape_dist_traveled` is in feet. Every check other than the unit is already passing.

## The change (only `scripts/route-geometry.mjs` and its tests)

1. **One unit factor per schedule file, from a closed list.** Candidates: 1 (same units), 5280 (stop times in miles, shapes in feet), 1/5280, 1000, 1/1000, 3.28084, 0.3048, 1609.344, 1/1609.344. No fitted or free-form factor.
2. **Choose it by the strict check, not by the diagnostic.** For each candidate, run the existing per-trip checks with the stop measure multiplied by the factor (sequence, stop order, measure in range, never backward, every stop within 100 m of its mapped point). Pick the factor that matches the most trips. Ties and factor 1 keep today's behavior: factor 1 wins any tie. A non-1 factor is used only if it matches at least 90% of the trips that have a shape and pattern; otherwise geometry stays off with the existing `no-matched-trips` reason. One factor for the whole file; never a different factor per trip.
3. **Nothing else loosens.** The 100 m stop check, the size limits, the source SHA check and the off-means-404 behavior stay exactly as they are. Trips that still fail under the chosen factor are left out (no distance for those trips), as today.
4. **The output is unchanged in form.** `stopMeters` stay road meters measured along the shape, so the Worker and the app need no change. Add one aggregate count to the diagnostic line, `unitFactor` as an index into the closed list (no IDs, no coordinates), printed with the success summary as well, so the deploy log says which factor was used.
5. **Tests (synthetic only):** a feed in feet/miles matches with 5280; a same-unit feed still uses 1; a feed where a scaled factor fixes fewer than 90% stays off; a tie prefers 1; mixed units across trips are not given per-trip factors; diagnostic output stays integers with fixed keys.

## How it ships

Geometry is built at Worker preparation, so it goes live only with the next weekly rollover (D68), after this plan, the code review (Codex, risky: live-feed change) and green tests. That rollover's log must show matched trips and the factor; then check one real ride on the public site shows the distance and that it is plausible against the printed route. If the count is low or anything looks wrong, the rollover still ships the schedule with geometry off (the existing D68 fallback). No new NJ Transit request, storage or paid service.

Please flag: any way a wrong factor could produce a believable but wrong distance, whether 90% is the right floor, and anything in the diagnostic that could leak feed rows.

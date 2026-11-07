# Rider workflow and efficiency audit — 2026-11-07

Scope: owner-authorized #89/D54 release and focused review of the surrounding current code. This is the author's audit, not independent approval or a claim that all code is bug-free.

## Confirmed findings addressed in this branch

- **Ambiguous clocks on upcoming rows.** Large boarding estimates, generic “Scheduled” boarding times, and destination arrivals appeared together without location names. The owner reasonably interpreted them as mismatched buses. Exact public trip/stop comparison showed the screenshot's165T had scheduled Lawrence boarding10:29AM/destination11:01AM versus official predictions about10:36AM/11:15AM; the following local's scheduled destination was noon. Trips were not swapped in that check. Paired location columns now independently qualify live versus scheduled evidence and show original schedules below. This validates the association, not whether NJ Transit's prediction will be accurate on a real ride.
- **Arrival/departure conflation.** Canonical conversion previously kept only departure-or-arrival times, so terminal dwell could become a scheduled arrival. Explicit arrivals now remain separate; unknown canonical arrival stays unknown. Predictions never become actual events just because time passes.
- **Destination lookup repeated work.** `destinationsFrom` called the full wrong-side/nearby scan for every target. It now builds reachable downstream sets once. On the existing590-stop corridor, single local Node measurements at three household stops were roughly30–49ms before and0.31–0.45ms after, with identical membership/order. These are diagnostic laptop measurements, not a phone performance guarantee. Unit checks compare the independent original guard across fixture/demo origins.
- **Hidden countdown work.** Polling already paused in the background, but UI clock ticks continued. They now pause too, with current time refreshed on visibility return. Existing bounded polling remains shared.
- **Malformed source clocks.** Both time parsers accepted out-of-range minute/second fields and could normalize them into plausible different times. One strict parser now rejects malformed fields while accepting valid after-midnight GTFS hours and absent intermediate timepoints.
- **New result persistence recovery.** One minimal destination result has strict scalar validation and explicit source; malformed or future-dated dismissal data cannot suppress valid new results. Dismissal prevents a resumed lock from resurrecting the old result. Existing trip/vehicle/date/favorite identities remain fixed.

- **Photo changed during initial loading.** Browser testing exposed a separate loading/main remount choosing a different background. The selection now belongs to the app opening and is reused across those views, including retries.

## Product improvements still worth doing

1. **Complete the household bus-versus-train comparison (#80).** Compare catchable door-to-Penn journeys on every service day, including walks, waiting and the Secaucus connection. Use current effective rail schedules and explicit transfer/ticket steps. Rail live access and current timetable validation remain dependencies; do not publish superseded connections.
2. **Official fallback (#96).** When Dale cannot safely match a live trip, give the rider a direct, voluntary official MyBus fallback for their public stop number. Do not imply Dale has recovered a live estimate or silently switch buses.
3. **A comparison that answers “which gets me there sooner?”** Across165T/163/164/165 and eventually rail, show arrival plus evidence source for each complete journey. A live bus with an unknown destination ETA cannot honestly receive a definitive fastest badge based on another trip's schedule.
4. **Connection confidence without promises.** In the guide, make the transfer location, next action, ticket coverage and missed-connection recovery explicit. Any suggested margin must be described as planning tolerance, never a guaranteed connection.
5. **Physical stop matching (#94).** Current release supplies verified public numbers and boardable headsigns. Sign photos/scanning should add a user-confirmed match, without uploading private location or inventing a stop number from an internal ID.
6. **Measure before adding more tracking.** Real rides and bounded M0 evidence are needed to quantify forecast errors, missing date coverage and whether NJ Transit actually supplies STOPPED_AT. One latest local result is not a route reliability dataset or actual-arrival archive.

## Engineering/model efficiency

Reuse the existing Worker, one global upstream snapshot/pacing and current caches; do not add another scheduler, collector, AI dispatcher or runtime model call. Freeze one coherent tested head and send a single complete review packet to one non-author reviewer. Only re-review after actual changes/findings. Batch source inspection and preserve a compact handoff with exact versions/results. No paid credits or additional model service is required by this release.

## Remaining acceptance

Full local verification, exact-head green CI, independent review, separate non-author merge, backend/site publication and actual normal-flow verification remain separate gates. Synthetic browser fixtures prove rendering/state handling, not current NJ Transit timing accuracy. Physical phones, outdoor contrast, real transfers and real rides require owner acceptance.

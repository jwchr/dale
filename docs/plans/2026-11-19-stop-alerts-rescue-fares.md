# Plans for Codex to check before building (Nov 19, 2026)

Owner priority, Nov 19, 2026: #176, #32 and #31. Each plan is checked by Codex before code is written. Codex cannot answer on issues in this repo, so the plans are reviewed here as a pull request.

## #176

**Plan for step C, alerts on a locked phone:** build exactly the design in `docs/LOCKED_STOP_ALERTS.md` plus the build requirements in the comment above (a lower stage never replaces a higher one, a long-past prediction counts as none, and the rest).
1. Worker: `POST /v1/ride-alerts` and `DELETE /v1/ride-alerts/:id`, accepted only from the Dale origin, size-limited. One stored push subscription per ride, deleted when the ride ends or expires (short hard expiry). No rider location is ever sent; the Worker uses only the official bus position it already has.
2. The stage check runs in the Worker's existing alarm loop using the same `rideGuide`/`stopAlertStep` code the phone uses, so the phone and the push agree. Alerts must keep working when history collection is off.
3. Web push with VAPID keys set as Cloudflare secrets by the owner. No new paid service.
4. Phone: opt-in, explain that it needs notification permission and, on iPhone, Dale on the home screen. Test button. English and Spanish.
5. Tests: synthetic only; stage order, duplicate suppression, expiry, delete, origin and size checks, and no stored data after a ride ends.
6. Deploy only with a manual Worker run after telling the owner.

Please flag: anything in the design that leaks a rider's identity or location, abuse of the new write routes, push subscription storage risks, and anything that would break the free-tier write budget shared with history collection.

## #32

**Step 1, wider schedule (data pipeline, risky):** extend `scripts/build-gtfs.mjs` and the schedule the Worker serves to the routes that can actually get a rider home from the corridor (start: 163, 164, 165, 165T plus 166, 167, 168 and any route sharing a stop with them, chosen by stop overlap in the official NJ Transit GTFS, not by guessing). Keep stop coordinates, and fare zone data if the official GTFS has it (verify first; if absent, say so, never derive zones from distance). Measure the size increase and keep the phone download small (load extra routes only when Rescue opens). Ships only with a weekly rollover after review, with the owner told first.
**Step 2, Rescue uses it:** `src/domain/rescue.ts` ranks same-line last chance plus alternatives by arrival time, transfers and walk. A walk between two stops is shown only as straight-line distance labeled "not a verified walk"; never "no options" when data is missing, say what is missing instead. Live data for an alternative only when the Worker has it; otherwise labeled scheduled.
**Step 3, discoverability:** the owner never noticed the "Get me the fuck home" chip; make it visible on Home in the Household look, English and Spanish.
Tests on synthetic GTFS: route selection by stop overlap, missing data messages, ranking, no false no-options.

Please flag: data terms or size risks of serving more routes, schedule rollover breakage, and anything that could show an invented connection as real.

## #31

Depends on step 1 in #32 (wider official schedule with stop coordinates and, if the official GTFS has it, fare zone data).
1. **Boarding stop by GPS:** the existing opt-in "Stops near me" uses the official coordinates the Worker schedule already carries, for every route served. One position, used on the phone and dropped; never stored, logged or sent. The rider still confirms stop and direction.
2. **Fare zones:** only from authoritative data: the official GTFS fare tables if present, otherwise the printed fare table the app already has. At a zone border, show both possibilities, never a guess. No zone map unless official boundary geometry exists.
3. English and Spanish; tests with synthetic stops at borders, missing coordinates and missing fares.

Please flag: any path where phone location could leave the device, and any place a fare could be shown that the source does not support.

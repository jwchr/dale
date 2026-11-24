# Chase the bus, step 1 (#252), November 24, 2026

Owner request (Jeff, Nov 21, 2026, after chasing a 165 express by car): "If you
miss the bus, and we get in the car, let's figure out a way to map it and chase
it. And keep updating me." Step 1 is the "just left" row and following that bus.
Rider GPS to the car, catch-up stop suggestions and car navigation (Tessie) are
step 2, planned separately, because they add rider location and a secret.

## What the rider sees

- At a stop's departure list, under the buses still to come, a "Just left" row
  lists up to 3 trips on the same route and direction whose scheduled time at
  this stop was 1 to 30 minutes ago. English and Spanish, 12-hour times.
- Each row shows the scheduled time at this stop and, only when NJ Transit
  reports the trip, where it is now (next stop name) and the age of that fix.
  A trip NJ Transit is not reporting shows "not reporting", never "left" or
  "cancelled". A scheduled time in the past does not prove the bus left.
- Tapping a row opens Follow Bus for that exact trip instance, the same screen
  and lock as today. The map keeps the bus and its next stops in view, with the
  NJ Transit predicted time at each remaining stop and its age. Arrival at the
  last stop (Port Authority on inbound trips) is shown as NJ Transit reports it.
- Large text, no typing needed. A one-line note says it is for passengers, not
  for the driver.

## How it works (no new Worker endpoint, no new NJ Transit calls)

- Candidate trips come from the official schedule the app already has
  (`/v1/schedule`): same route, direction and stop, scheduled 1 to 30 minutes
  before now on the Eastern service date, including after-midnight trips.
- Live position per candidate uses the existing `/v1/live?trip=&date=` answer,
  at most 3 requests per refresh, refreshed with the same pacing as Follow Bus.
  The Worker's NJ Transit budget is unchanged (it polls on its own schedule).
- Locking uses the existing `createBusSession` with the rider's stop as the
  selected stop (the builder checks which existing rider phase fits a bus
  already past that stop, and adds none without saying so in the PR), so
  `src/domain/lock.ts` rules hold:
  exact trip only, never switches buses, every position carries its age,
  "not reporting" after the existing stale and vanish timings.
- Earlier buses (#250) stays a separate, read-only history list; its public
  answer has no trip identifiers by design, so it is not used to lock.
- Demo data shows the DEMO banner as everywhere else.

## Failure cases to test

- No candidate trips (late night, last bus): row hidden, no empty box.
- Candidate trip not reporting, stale fix, fix older than the vanish timing.
- A trip that reports a stop before the rider's stop (late bus that has not
  actually left): shown as "still coming", with its fix age, not as "left".
- Overnight trips (scheduled 24:xx) and the service-date boundary in Eastern time.
- `/v1/live` errors or times out: rows keep the scheduled time and say live
  position is unavailable.
- Narrow phone (360 px), large text, Spanish, keyboard focus order.

## Acceptance

- Unit tests in `tests/unit/` for candidate selection (window edges at 1 and
  30 minutes, overnight, direction, max 3) and for the "still coming" versus
  "past this stop" decision from the reported stop index.
- E2E in `tests/e2e/` on Pixel 7 with pinned `?now=`: the row appears, a tap
  opens Follow Bus locked to that trip, "not reporting" shows for a silent trip,
  English and Spanish.
- `npm run verify` passes. Screens checked at 360 px in English and Spanish.

## Not in step 1

Rider GPS, distance from the car, catch-up stop suggestions, last-chance alert,
Tessie or map navigation hand-off, locking a bus from anywhere off the stop
list. Each needs its own plan; Tessie needs a secret Jeff sets himself.

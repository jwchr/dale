# Tunnel and bridge traffic (#251): plan before building

Nov 24, 2026. Docs only: nothing here is built, tested or live.

Owner direction (Jeff, Nov 24, 2026, relayed by the Control Center): "show a small line plus a separate screen to open to see live traffic at the tunenl, reported delay, incidents along the route... plus id on't know if we can calculate an new estimate". The original request is [#251](https://github.com/jwchr/dale/issues/251) (Nov 21, 2026: a 30-minute Lincoln Tunnel delay held up the 163, 164 and 165; he also wants history to find the best times to travel). Simple rule (Jeff, Nov 24, 2026): keep the full feature, but spread it across one small line and one screen so nothing is overwhelming.

## What the rider sees

1. **One small line on the home screen**, under the next buses, only when the rider's trip crosses the Hudson: "Lincoln Tunnel to NY: 32 min, 5 more than usual · Port Authority, 1 min ago" / "Túnel Lincoln a NY: 32 min, 5 más de lo normal · Port Authority, hace 1 min". Normal traffic reads "normal"; a closure or missing data says so ("Lincoln Tunnel data unavailable"), never a guess. Tapping it opens the crossing screen.
2. **Crossing screen** (one screen, three short sections, each with source and age):
   - **Crossings now:** Lincoln Tunnel and George Washington Bridge (upper and lower levels), both directions, live minutes against the usual minutes for this time, closed flags.
   - **Posted delays:** the Port Authority's own messages for these crossings, including XBL bus lane openings and closures.
   - **Along your route:** incidents and construction near the roads this trip's bus actually drives, nearest first, at most 5 with "Show all".
   A short note says crossing times measure car traffic; buses in the XBL bus lane (weekday mornings to New York) can skip part of that queue.
3. **No changed arrival times at first** (see "A new estimate" below). Settings gain nothing.

Before building the screens, a mock-up of the line and the crossing screen goes to Jeff for his OK (Nov 24 design check).

## Sources (checked Nov 24, 2026, about 5:15 PM ET)

Primary public sources first (Jeff, Nov 24, 2026). Free public government data with no account needs no approval; anything needing a sign-up waits for Jeff.

| Source | What it gives | Key? | Checked |
|---|---|---|---|
| Port Authority crossing times, `https://www.panynj.gov/bin/portauthority/crossingtimesapi.json` (used by panynj.gov's own crossing pages) | 14 rows: each crossing and direction with live travel time, usual travel time, speed, closed flag, a clock time ("5:15 PM") | No | Yes: fetched; JSON, `cache-control: max-age=60`, 14 rows, fields `routeTravelTime`, `routeTravelTimeHist`, `isCrossingClosed`, `isDataAvailable`, `timeStamp` |
| Port Authority crossing alerts, `crossingtimesalertapi.json?start_date=MM/DD/YYYY` | Posted delay and closure messages, including XBL | No | By the research helper only (not re-checked by me); its records include a staff name, which Dale must drop |
| 511NJ RSS (NJDOT, with NJ Turnpike Authority and Port Authority items), `https://511nj.org/client/rest/rss/RSSAllNJActiveEvents` and the incident and construction feeds listed at [511nj.org/rss](https://511nj.org/rss) | Incidents, congestion, construction, with a point per item; updated every 1 to 2 minutes per [511NJ FAQ](https://511nj.org/faqs) | No | Yes: fetched; 410 items |
| TRANSCOM data feed ([xcmdata.org](https://data1.xcmdata.org/DEWeb/Pages/index)) | Fullest upstream source (events and travel times from 16 agencies) | Free sign-up | Not checked; only if Jeff registers himself |
| 511NY | Events, cameras; no travel times under its Sept 2026 terms | Free sign-up | Low value here; not needed |
| NYC DOT traffic speeds | Tunnel links | No | Unusable: newest reading Nov 20, tunnel tubes at 0 mph |

The Port Authority and 511NJ endpoints are public website feeds without a developer page. Terms of use for automated reading are not checked; Dale reads them at most once a minute, only while someone is looking, credits each source by name, and stops if an agency asks. The NJ Turnpike Authority's own alert feed sits behind a bot check, so Dale does not use it (its incidents already appear in 511NJ).

## How it works

- **Worker, read-through only.** A new `GET /v1/crossings` on the existing Worker fetches the Port Authority JSON and the 511NJ RSS when asked, keeps each answer in Cloudflare's edge cache for 60 seconds, and returns a small normalized answer. No background poller, no extra NJ Transit calls, no storage in this step. The browser never calls the agencies directly (their cross-site rules are not checked, and one cached Worker read keeps the load on them to about one request a minute).
- **Normalized answer.** Per crossing and direction: live minutes, usual minutes, extra minutes (live minus usual, never below zero for display), closed, data available, observed time, fetched time, source name. Per incident: type, road, short description, point, start time, source, fetched time. Staff names, colors and other display fields are dropped. Text is shown as the agency wrote it, labeled with its source, and not translated by a machine; the Spanish screen labels Dale's own words and leaves agency text as "(in English, from 511NJ)".
- **Clock time without a date.** The Port Authority gives "5:15 PM" only. Dale reads it as Eastern time on the fetch date; a reading more than 5 minutes ahead of the fetch is taken as the previous day (around midnight). A reading more than 10 minutes old is shown as stale with its age; more than 30 minutes, as unavailable. Both daylight-saving changes are tested.
- **Which crossing a trip uses** comes from the trip's own route shape, never from its route number (Product rules: nothing inferred from a route number). A pattern whose shape passes within about 300 meters of a crossing's New Jersey approach uses that crossing. The 163, 164, 165 and 165T show the Lincoln Tunnel line; a trip with no crossing shows no line.
- **"Along your route"** keeps 511NJ items within about 500 meters of the trip's remaining shape (or the whole shape when no bus is locked), in both states' parts of the route that 511NJ covers.
- **Failure.** Any source down, slow (5-second timeout), malformed or stale shows that section as unavailable with its last good age; the other sections still show. No made-up delay. A closed crossing says "Closed (Port Authority)".

## A new estimate (later, only if it proves better)

Jeff asked whether Dale can calculate a new arrival estimate. It can try, but only shows one if the data proves it helps:

1. **Collect first.** Save the crossing times (live and usual, per minute only while the line is being viewed, or per 5 minutes in the background if budget allows) in the private history archive with the bus history Dale already keeps (D60, D77). This is a separate, risky step under `docs/HISTORY_COLLECTION.md`: it uses the existing write and storage guards and free limits, never paid overflow.
2. **Backtest** with [#102](https://github.com/jwchr/dale/issues/102): for buses still before the tunnel, compare NJ Transit's own prediction against "NJ Transit prediction plus today's extra tunnel minutes" (and smarter versions) using archived actual arrivals at Port Authority, by hour, weekday and XBL hours.
3. **Show it only if it wins**, clearly beating NJ Transit's prediction on held-out days. It then appears as a second, labeled time ("Dale estimate with tunnel traffic: 6:21 PM") next to NJ Transit's, never replacing it, with its method one tap away. If it doesn't win, Dale keeps showing the traffic as context only and says so.

The history also answers Jeff's original question in #251 (best times to travel by day and season) once enough weeks are saved; that report is a later step.

## Build order (small PRs)

1. **This plan** (docs only). Reviews: CodeRabbit and Neon (risky: an outside data source in the Worker and, later, history).
2. **Worker `/v1/crossings`** with made-up test feeds shaped like the real ones (no recorded agency responses in this public repo), edge cache, timeouts, date handling, staff-name removal, and the free-limit check. Risky: Worker. Neon before deploy; deploy only with Jeff's go-ahead.
3. **Home line and crossing screen**, EN/ES, after Jeff OKs the mock-up; narrow phone, enlarged text, both styles checked on the real screen.
4. **Crossing history** (risky: history collection), then **backtest**, then the **estimate** only if it wins.

## Acceptance tests

1. Unit: normalizing the Port Authority rows (live, usual, extra, closed, data missing), clock times across midnight and both DST changes, stale and unavailable ages, staff names never in the output.
2. Unit: crossing detection from shapes (a Lincoln Tunnel shape, a GWB shape, a shape with no crossing; never from the route number); incident filtering near the shape; at most 5 shown, nearest first.
3. Worker: one agency fetch per minute however many phones ask (edge cache); a slow or failing source never delays the bus feed and returns that section as unavailable; malformed XML or JSON never crashes the Worker; the answer carries source names and ages; no NJ Transit calls added.
4. E2E with pinned clock and made-up feeds: the line shows only for crossing trips, reads normal, delayed, closed and unavailable correctly in English and Spanish, and opens the crossing screen; the crossing screen's three sections each show source and age.
5. Real screen check at narrow phone width in both languages and two styles before calling it done.

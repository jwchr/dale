# Live trains from NJ Transit RailData (#80)

Owner decision 2026-11-16: NJ Transit's live rail feed first; printed timetables only as the labeled backup.

## Source
- Production host `https://raildata.njtransit.com`, method `getTrainSchedule19Rec` (next departures at one station). Field names and types come from the production schema `https://raildata.njtransit.com/swagger/RailData/swagger.json` (fetched 2026-11-18): the scalar fields Dale reads are nullable strings; `ITEMS`, `STATIONMSGS`, `CAPACITY` and `STOPS` are nullable arrays.
- The schema does not state the time layout or zone. Dale reads `DD-Mon-YYYY hh:mm:ss AM/PM` in New York time, the layout the open-source `jtarrio/raildata` Go client (Apache-2.0, v0.0.8) parses. A row whose time does not match, or names a clock time skipped in spring or repeated in fall, is dropped and counted (`skippedRows`), never guessed. The first real answers confirm or refute this; until then it is unverified.
- The same client's samples show the response's `STATIONNAME` is a short form (New York Penn Station answers "New York"). Dale matches only `STATION_2CHAR`. This is the likely reason four stations failed the Nov 17 check, which required the full name; the Nov 18 check names the failed test.

## Stations
Anderson Street (AS) and Essex Street (EX) with line PV, Secaucus Lower Level (TS) with PV, Secaucus Upper Level (SE) and New York Penn (NY) with no line filter. The two Secaucus levels are separate stations and are never merged.

## Limits
- At most one agency request per station per minute, shared by every rider (cached in the one Durable Object): five stations stay under 7,200 a day, below NJ Transit's 40,000.
- Rows sent but none readable are `unavailable` (`unexpected-schema`), never shown as "no departures". A 401 or 403 clears the token without reading the body.
- A failed answer is also kept for the minute, so a broken feed is never hammered. A refused token costs that station its minute: one schedule request, the token dropped, no immediate retry.
- A rate limit (HTTP 429 or NJ Transit's "Daily usage limit" message) pauses every station for 15 minutes, saved in storage so a restart keeps the pause. The token is kept, so the pause never spends the daily token allowance.
- The per-station minute lives in the object's memory. A restart (for example a deployment) can allow one extra request per station; persisting every attempt would cost a storage write per station per minute on the Free plan, so it is not done.
- Token requests: NJ Transit allows 10 a day and recommends one. The Worker reuses one token for up to 23 hours and requests at most 3 a day, at least an hour apart. Each request is counted in storage before it is sent. The manual rail check (`docs/RAIL_API_CHECK.md`) uses the same account, so it keeps room for its own.
- Agency bodies, messages, headers and tokens never leave `rail.ts`; failures are reported by fixed codes only. An `Invalid token.` body counts as a refused token whatever its HTTP status.
- Each answer is `state: "ok"` with `receivedAt` (Dale's receipt time), or `state: "unavailable"` with a fixed `reason` and `receivedAt: null`.

## What a rider sees
- Only what NJ Transit sends: train number, line, destination, scheduled time, track only when NJ Transit names one, NJ Transit's own status words, its delay in seconds and when it last changed the row. GPS, car capacity, colors and messages are dropped.
- NJ Transit's row times are local clock strings with no stated freshness, so the Train screen (next pull request) shows the age of each answer that has a receipt time and says when live trains are unavailable.
- A board NJ Transit has replaced with a fullscreen station message (`STATIONMSGS` entry with `MSG_TYPE` "fullscreen" and empty `ITEMS`, per RailData V2.1 section 7 as quoted in review) is `unavailable` with reason `service-message`, not an empty board. Dale never shows agency message text.
- Secaucus Lower Level (TS) tracks 1 to 4 are shown as signed for riders (G, F, H, E), per RailData V2.1 Appendix II as quoted in review and the `jtarrio/raildata` SpecialTracks table. No other station is translated. No connection is ever guaranteed.
- Not live until the Worker is deployed (owner told first).

# Handoff: current state

Updated 2026-11-13. Repository `jwchr/dale`; public app https://jwchr.github.io/dale/. Rules: `CLAUDE.md` ("How we work"). History lives in git and the GitHub issues, not here.

## Built and live
- Public app: main after #152 (merged 2026-11-13 about 6:01 AM ET); its ci run with the Pages deploy (43413632968) succeeded at 6:08 AM ET. The builder's sandbox cannot open github.io, so the live page itself was not viewed. #150 replaced the small caret on each city sign with a CHANGE / CAMBIAR tag; the owner approved its screenshots.
- See bus stop sign (#152, D69, `docs/STOP_SIGN.md`): the real photographed NJ Transit sign, sharp and with its printed logos. Dale writes on it the public stop number and every Dale route boarding there, the rider's bus highlighted with a navy "Your bus" / "Tu autobús" tag; screen readers hear the same routes. Reviewed by CodeRabbit and an owner-run Gemini 4 Argon review, no findings on the final version.
- Schedule (#143, owner decision 2026-11-12): the app opens on NJ Transit's official bus schedule served by Dale's private Worker (`/v1/schedule`, NJ Transit data stays server-side). The printed route 165/165T timetable (owner-supplied PDF, typed in; `data/t0165/transcription.json`, rebuilt by `npm run timetable`) stays one tap away; choosing it is remembered. Printed and official stops use different IDs, so commutes saved with the printed timetable are never mapped silently: a one-time card, then a small reminder until the rider taps Done, offers Find my stop. Printed limits: 20 timepoints per direction, no stop coordinates, no holiday times.
- Home: saved commutes in the rider's order with paired From/To city signs (city-first stop chooser; both city names share one size and each stays on one line, centered in the sign's green space), icon Reverse, Leave by / Get me home / See bus stop sign, compact departure cards with route badge and countdown, Port Authority gate labelled posted / usual / printed rule / not confirmed. Five skins (Turnpike, Parkway, NYC night, Garden State, Clean). English and Spanish everywhere; 12-hour times.
- Top bar: bigger DALE! wordmark, the slogan "When you ride NJ Transit, you need all the help you can get!" with a small version and update time ("am"/"pm") under it, and settings. At large text the slogan block takes its own row (#139, #141). Bus/Train and Find a stop share the row half and half; the September sunset photo shows the skyline at the bottom.
- Trip tools: all-day timetable (7 days, after-midnight, DST notes), trip screen with printed fares and zones, boarding check, first-ride guide, last same-line return and last-bus calendar reminder, Get me home, backup buses, missed-stop help, saved backup plans, share-a-trip-update text, personal report history (on the phone only).
- Bus Lock: exact-bus lock that never switches buses silently, waiting/arrived/boarded/left states, ride mode with strip map and street map (self-hosted OpenStreetMap), kept on the phone across refreshes. Live GPS works only where the live pilot is active and matched; otherwise everything is labelled scheduled.
- Train: Bus/Train selector, Penn-style board with sample (not current) Pascack Valley times via Secaucus, trip checklist kept on the phone.
- Offline: service worker keeps the last schedule and says how old it is.
- Live bus pilot (#89, `docs/LIVE_BUS_PILOT.md`): private Cloudflare Worker relay on the Free plan with exact trip/date matching, source age and scheduled fallback. Private corridor history collection (#91) is ON at 30-second pacing.
- Weekly schedule rollover (#148, D68) ran successfully on 2026-11-13 00:02-00:08 UTC (Actions run 43333818465): the Worker now serves NJ Transit schedule `e84f5ae3b53b` (service dates 2026-11-09 to 2026-11-23) and includes the live bus day fix (#145, D67). Proof: new context stored; native collection and verified archiving advanced under it; observations 39,036 to 39,397 within about five minutes (they had been flat at 39,036 from 3:01 PM to 7:01 PM ET on a weekday, so before #145 weekday GPS positions were not saved); verified archive objects 13,035 to 13,047. Next rollover pins: `expected_worker_version=1f582daa-b8dc-415e-8a32-3c284189456d`, `canonical_context_key=e84f5ae3b53b:1f4785c84ba5d07fe0bf709273395def8f4cc57627927977a8ab6838a8721559` (run `qualify-enabled` first to confirm them).
- Route distance stays off (owner-confirmed geometry-off fallback, D68). The first real geometry diagnostic (same run) is `no-matched-trips` with `tripStopDistance` 1,044 of 1,044 trips: all 81 shapes are valid, but every trip has a stop more than 100 m from its mapped point on the shape. Unknown whether that is a unit mismatch between `shapes.txt` and `stop_times.txt` measures or Port Authority stops sitting away from where shapes start; diagnostic v2 (this pull request) adds aggregate counts that tell those causes apart. They print only when geometry fails, as it did for every trip in the last run; a rollover that matches at least one trip prints no counts (`docs/ROUTE_DISTANCE.md`).

## Waiting on the owner
- Whether the app should stay publicly reachable (anyone with the link can open it today) or be limited to the household.
- Phone tests of #152 (See bus stop sign: stop number, routes, "Your bus", Spanish "Tu autobús") and #150 (CHANGE tag on the city signs).
- Phone test on Jeff's and Diego's phones: install to the home screen, save a commute, reverse it, open a trip from Port Authority, use it offline.
- Optional: protect `main` on GitHub (require a pull request and the `test` check, no force pushes or deletions). Only the owner can change it; not required for the rules.
- Gate cards (GATE-02): photos and floor/escalator notes from Port Authority; no official source found.

## Next (order the owner approved 2026-11-13; details in #153)
1. Road-shaped distance, part 1: aggregate geometry diagnostic v2 (this pull request). Its counts print at the next rollover only if geometry fails again (no trip matched).
2. Road-shaped distance, part 2: the fix, chosen from those counts. Never straight-line distance.
3. Find my stop: town list first.
4. Big-text name banner fix ("HACKENSACK" splitting at 200% text).
5. Schedule-change alerts (#151; open product questions are in the issue).
6. Stop alerts 3, 2 and 1 stops before getting off.
7. Simpler travel screens (#113). 8. Easier stop picking (#103). 9. Opening slogans and seasonal touches (rest of #106).
10. Date-bound: weekly rollover before 2026-11-23 (around Nov 20), even if earlier items are unfinished. Tell the owner first, `qualify-enabled`, then `rollover-enabled` with the pins above.
11. DST check before 2027-03-14 (read-only). 12. Remove the gate-card notice when Port Authority advisory 2176177 ends.
13-18. Quality sweeps: accessibility (axe) of main screens in both languages; 305/320 px and 200% text on every screen; Spanish completeness test; offline test for saved commutes; flaky tests under load; slow-connection load speed.
19. Rules cleanup: correct older docs that disagree with CLAUDE.md "How we work". 20. Weekly read-only server health check (`inspect`), reporting only problems.
- Blocked: re-add `.github/workflows/branch-cleanup.yml` after GitHub Support answers; gate cards (owner's Port Authority photos); train timetables (#80, last).

## Known problems
- At 200% text in wide fonts, the saved-commute LED sign (the dark name banner) can split "HACKENSACK" leaving one letter alone on a line; not covered by tests yet.
- DST: the official schedule is now the default (#143). Check how NJ Transit's GTFS encodes 00:00-02:59 on clock-change dates before the next change, March 14, 2027.
- The Port Authority gate card shows NJ Transit's construction advisory 2176177; remove it when the advisory ends.
- The builder's sandbox cannot delete branches (git returns HTTP 403), so merged branches pile up. `scripts/branch-cleanup.mjs` (tested) selects and deletes merged branches safely; the workflow that runs it is out of #142 because every commit containing it hit a GitHub-side "unexpected error" startup failure (Support ticket open, request ID 4007:33BC50:227B926:26A3EEF:6AF5A77C). It returns in its own pull request.
- The builder's sandbox blocks github.io, so the "confirm Pages after merge" step needs a browser outside it or an environment network change.

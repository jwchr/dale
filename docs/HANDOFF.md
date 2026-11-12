# Handoff: current state

Updated 2026-11-12. Repository `jwchr/dale`; public app https://jwchr.github.io/dale/. Rules: `CLAUDE.md` ("How we work"). History lives in git and the GitHub issues, not here.

## Built and live
- Public app v0.3.294 (main after #145, Pages deploy succeeded 2026-11-12 3:05 PM ET; the builder's sandbox cannot open github.io, so the live page itself was not viewed). #145 changes only the Worker, so the app looks the same; the owner confirmed #141's look on his phone.
- Schedule (#143, owner decision 2026-11-12): the app opens on NJ Transit's official bus schedule served by Dale's private Worker (`/v1/schedule`, NJ Transit data stays server-side). The printed route 165/165T timetable (owner-supplied PDF, typed in; `data/t0165/transcription.json`, rebuilt by `npm run timetable`) stays one tap away; choosing it is remembered. Printed and official stops use different IDs, so commutes saved with the printed timetable are never mapped silently: a one-time card, then a small reminder until the rider taps Done, offers Find my stop. Printed limits: 20 timepoints per direction, no stop coordinates, no holiday times.
- Home: saved commutes in the rider's order with paired From/To city signs (city-first stop chooser; both city names share one size and each stays on one line, centered in the sign's green space), icon Reverse, Leave by / Get me home / See bus stop sign, compact departure cards with route badge and countdown, Port Authority gate labelled posted / usual / printed rule / not confirmed. Five skins (Turnpike, Parkway, NYC night, Garden State, Clean). English and Spanish everywhere; 12-hour times.
- Top bar: bigger DALE! wordmark, the slogan "When you ride NJ Transit, you need all the help you can get!" with a small version and update time ("am"/"pm") under it, and settings. At large text the slogan block takes its own row (#139, #141). Bus/Train and Find a stop share the row half and half; the September sunset photo shows the skyline at the bottom.
- Trip tools: all-day timetable (7 days, after-midnight, DST notes), trip screen with printed fares and zones, boarding check, first-ride guide, last same-line return and last-bus calendar reminder, Get me home, backup buses, missed-stop help, saved backup plans, share-a-trip-update text, personal report history (on the phone only).
- Bus Lock: exact-bus lock that never switches buses silently, waiting/arrived/boarded/left states, ride mode with strip map and street map (self-hosted OpenStreetMap), kept on the phone across refreshes. Live GPS works only where the live pilot is active and matched; otherwise everything is labelled scheduled.
- Train: Bus/Train selector, Penn-style board with sample (not current) Pascack Valley times via Secaucus, trip checklist kept on the phone.
- Offline: service worker keeps the last schedule and says how old it is.
- Live bus pilot (#89, `docs/LIVE_BUS_PILOT.md`): private Cloudflare Worker relay on the Free plan with exact trip/date matching, source age and scheduled fallback. Deployed Worker version `ca1159e3-cf70-4532-9c10-bad2bd63672e`, schedule context `6c4dc1e76d06`. Private corridor history collection (#91) verified ON by a read-only `qualify-enabled` run on 2026-11-12 3:01 PM ET (30-second pacing; 39,036 observations; 12,552 verified archive objects). That run's rollback reference digest is `ca961d48ea1b6e1410b16074b09c4c7153f513c0e59ef2bcc054d58d307bfdf3` (full reference in the run log, Actions run 43295998296).
- Live bus day fix (#145, D67): merged but **not deployed**. An omitted NJ Transit trip date resolves from the report's own timestamp when exactly one active service day's trip window (minus 3 h / plus 3 h) contains it; undated cancellations stay unknown. Weekday rows keep saying "Scheduled only" until the Worker update lands. Whether NJ Transit puts a timestamp on every report is unverified.
- Route-distance source (#113, `docs/ROUTE_DISTANCE.md`) is published, but the deployed Worker has no current geometry, so no live distance is shown yet. Geometry failures now print an allowlisted reason and counts (#138).

## Waiting on the owner
- Whether the app should stay publicly reachable (anyone with the link can open it today) or be limited to the household.
- Phone test on Jeff's and Diego's phones: install to the home screen, save a commute, reverse it, open a trip from Port Authority, use it offline.
- Optional: protect `main` on GitHub (require a pull request and the `test` check, no force pushes or deletions). Only the owner can change it; not required for the rules.
- Gate cards (GATE-02): photos and floor/escalator notes from Port Authority; no official source found.

## Next (order chosen by the owner; full list in #144)
1. Schedule rollover (owner chose option A, D68): `rollover-enabled` is built on branch `claude/schedule-rollover` and pending review (risky: CodeRabbit plus one independent review). After merge, tell the owner, then run it with the current pins; it also deploys #145 and, if geometry builds, route distance (otherwise distance stays off and the geometry diagnostic prints, owner confirmed). The geometry diagnostic (#138) has still never run against the real feed. Then run it about weekly.
2. Stop sign photo: Jeff's own stop photo with the real stop number and routes (`docs/STOP_SIGN.md`); screenshots before merging.
3. Find my stop: town list first.
4. Check whether history kept the weekday live reports that were rejected as `date-unknown`.
5. Two test timing fixes (`live-bus.spec.ts` offline lock, `journey-signs.spec.ts` resize re-fit).
6. Re-add `.github/workflows/branch-cleanup.yml` once GitHub Support answers.
7. Later: big-text name banner, rest of #106, #113, #103, stop alerts, gate cards, train timetables (#80, last).

## Known problems
- **Deployed official schedule expires after Nov 13.** The read-only schedule check (Actions run 43324583765) showed the deployed schedule (6c4dc1e76d06) covers service dates 2026-11-06 to 2026-11-13 only; NJ Transit's current file (e84f5ae3b53b) covers 2026-11-09 to 2026-11-23 with the same 1,044 trip IDs on Dale's routes, 6 trips retimed and 1 stop swapped. NJ Transit replaces this rolling ~2-week file at least weekly, so `preserve-enabled` (which refuses any changed file) cannot keep up. The rollover mode that fixes this is built and pending review (Next 1). Until it runs, from Nov 14 the app shows "This schedule ended Nov 13" on the official schedule; the printed 165/165T timetable remains one tap away. Collection keeps polling meanwhile, but once the deployed schedule has no active service date it cannot match buses, so no new matched GPS positions are saved until the rollover runs.
- At 200% text in wide fonts, the saved-commute LED sign (the dark name banner) can split "HACKENSACK" leaving one letter alone on a line; not covered by tests yet.
- DST: the official schedule is now the default (#143). Check how NJ Transit's GTFS encodes 00:00-02:59 on clock-change dates before the next change, March 14, 2027.
- The Port Authority gate card shows NJ Transit's construction advisory 2176177; remove it when the advisory ends.
- The builder's sandbox cannot delete branches (git returns HTTP 403), so merged branches pile up. `scripts/branch-cleanup.mjs` (tested) selects and deletes merged branches safely; the workflow that runs it is out of #142 because every commit containing it hit a GitHub-side "unexpected error" startup failure (Support ticket open, request ID 4007:33BC50:227B926:26A3EEF:6AF5A77C). It returns in its own pull request.
- The builder's sandbox blocks github.io, so the "confirm Pages after merge" step needs a browser outside it or an environment network change.

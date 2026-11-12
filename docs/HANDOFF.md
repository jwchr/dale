# Handoff: current state

Updated 2026-11-11. Repository `jwchr/dale`; public app https://jwchr.github.io/dale/. Rules: `CLAUDE.md` ("How we work"). History lives in git and the GitHub issues, not here.

## Built and live
- Public app v0.3.284 (main after #141, Pages deploy succeeded 2026-11-11). The owner checked it on his phone and confirmed it looks right.
- Schedule: NJ Transit's printed route 165/165T timetable (owner-supplied PDF, typed in; `data/t0165/transcription.json`, rebuilt by `npm run timetable`). Limits: 20 timepoints per direction, no stop coordinates, no holiday times (warning shown on NJ Transit holidays). The official bus GTFS is reachable but not yet the published schedule (M2).
- Home: saved commutes in the rider's order with paired From/To city signs (city-first stop chooser; both city names share one size and each stays on one line, centered in the sign's green space), icon Reverse, Leave by / Get me home / See bus stop sign, compact departure cards with route badge and countdown, Port Authority gate labelled posted / usual / printed rule / not confirmed. Five skins (Turnpike, Parkway, NYC night, Garden State, Clean). English and Spanish everywhere; 12-hour times.
- Top bar: bigger DALE! wordmark, the slogan "When you ride NJ Transit, you need all the help you can get!" with a small version and update time ("am"/"pm") under it, and settings. At large text the slogan block takes its own row (#139, #141). Bus/Train and Find a stop share the row half and half; the September sunset photo shows the skyline at the bottom.
- Trip tools: all-day timetable (7 days, after-midnight, DST notes), trip screen with printed fares and zones, boarding check, first-ride guide, last same-line return and last-bus calendar reminder, Get me home, backup buses, missed-stop help, saved backup plans, share-a-trip-update text, personal report history (on the phone only).
- Bus Lock: exact-bus lock that never switches buses silently, waiting/arrived/boarded/left states, ride mode with strip map and street map (self-hosted OpenStreetMap), kept on the phone across refreshes. Live GPS works only where the live pilot is active and matched; otherwise everything is labelled scheduled.
- Train: Bus/Train selector, Penn-style board with sample (not current) Pascack Valley times via Secaucus, trip checklist kept on the phone.
- Offline: service worker keeps the last schedule and says how old it is.
- Live bus pilot (#89, `docs/LIVE_BUS_PILOT.md`): private Cloudflare Worker relay on the Free plan with exact trip/date matching, source age and scheduled fallback. Private corridor history collection (#91, `docs/HISTORY_COLLECTION.md`) was last recorded as ON at 30-second pacing. The builder has not re-checked either in production this session.
- Route-distance source (#113, `docs/ROUTE_DISTANCE.md`) is published, but the deployed Worker has no current geometry, so no live distance is shown yet. Geometry failures now print an allowlisted reason and counts (#138).

## Waiting on the owner
- Whether the app should stay publicly reachable (anyone with the link can open it today) or be limited to the household.
- Phone test on Jeff's and Diego's phones: install to the home screen, save a commute, reverse it, open a trip from Port Authority, use it offline.
- Optional: protect `main` on GitHub (require a pull request and the `test` check, no force pushes or deletions). Only the owner can change it; not required for the rules.
- Gate cards (GATE-02): photos and floor/escalator notes from Port Authority; no official source found.

## Next (order chosen by the owner, 2026-11-11)
1. M2: publish the official bus GTFS for 163/164/165/165T and compare it with the printed timetable.
2. Route distance: one preserve-enabled preparation run to read the new geometry diagnostic, then fix the cause in its own pull request. A Worker run is a risky change; the owner has the risks explained and must say yes before it runs.
3. Rail timetable preview (#80): NJ Transit published Pascack Valley and Secaucus/Penn timetables effective November 15. Use the right edition per date and never present unconfirmed service as current. Real rail access is still unverified (one authentication attempt on 2026-11-09 returned `http-error`).

## Known problems
- At 200% text in wide fonts, the saved-commute LED sign (the dark name banner) can split "HACKENSACK" leaving one letter alone on a line; not covered by tests yet.
- DST: check how NJ Transit's GTFS encodes 00:00-02:59 on clock-change dates before the feed replaces the printed timetable (M2).
- The Port Authority gate card shows NJ Transit's construction advisory 2176177; remove it when the advisory ends.
- The builder's sandbox cannot delete branches (git returns HTTP 403), so merged branches pile up. `scripts/branch-cleanup.mjs` (tested) selects and deletes merged branches safely; the workflow that runs it is out of #142 because every commit containing it hit a GitHub-side "unexpected error" startup failure (Support ticket open, request ID 4007:33BC50:227B926:26A3EEF:6AF5A77C). It returns in its own pull request.
- The builder's sandbox blocks github.io, so the "confirm Pages after merge" step needs a browser outside it or an environment network change.

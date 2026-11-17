# Handoff: current state

Updated 2026-11-17. Repository `jwchr/dale`; public app https://jwchr.github.io/dale/. Rules: `CLAUDE.md` ("How we work"). History lives in git and the GitHub issues, not here.

## Built and live
- Public app: main after #174 (ride screen fits narrow phones at large text: the LED board stacks when tight, and the stop list's Get off here tag wraps instead of pushing the page wide; checked with GitHub's wider DejaVu Sans font too). The builder's sandbox cannot open github.io, so the live page itself has not been viewed from here.
- Nov 16 merges (Codex's weekend work, reviewed and merged by the builder): big-text saved-commute name banner never strands one letter (#156); Find a stop starts with towns and still searches stops directly (#157); all-day timetable scrolls inside its own box on narrow phones (#161); Resume/Forget buttons fit at large text (#169); schedule-change notices on saved trips, kept until dismissed (#162, #151); optional "Check NJ Transit directly" MyBus website and text-draft handoff on the locked-bus card and the load-error screen (#164, #96); optional rotating opening slogans, Jeff's eight verbatim (#165); optional bilingual labels under the main buttons (#167); optional personal home photo kept only in the browser, re-encoded so location metadata is dropped (#168); five Hackensack Tour guide cards (#166); tests for picker accessibility, offline use and English/Spanish key completeness (#158, #159, #160); audit doc pointer (#163). Settings saved in one open tab are no longer undone by another tab (#167, race fix in #155).
- Owner polish (#155): no picture-style menu on the stop sign (always the automatic New Jersey season), change link beside the stop number, capital LED boxes, corner CHANGE tag, alternating home cards (lighter first), black source notes, one Save trip button pinned at the bottom, ON TIME under NEXT, ride map keeps the route ahead in view. Port Authority stops stay separate (owner decision).
- Stop sign photo (#152, D69): the real NJ Transit sign with this stop's routes and number.
- Schedule (#143): the app opens on NJ Transit's official bus schedule served by Dale's private Worker (`/v1/schedule`). The printed route 165/165T timetable stays one tap away; printed and official stops use different IDs, so printed commutes are never mapped silently.
- Home, trip tools, Bus Lock, Train preview and offline behavior as before: saved commutes in the rider's order, five skins, English and Spanish, 12-hour times, exact-bus lock that never switches buses silently, service-worker offline copy with its age.
- Live bus pilot (#89, `docs/LIVE_BUS_PILOT.md`) on the Free plan; private corridor history collection (#91) ON at 30-second pacing.
- Weekly schedule rollover (#148, D68) last ran 2026-11-13 (Actions run 43333818465): the Worker serves NJ Transit schedule `e84f5ae3b53b` (service dates 2026-11-09 to 2026-11-23). Next rollover pins: `expected_worker_version=1f582daa-b8dc-415e-8a32-3c284189456d`, `canonical_context_key=e84f5ae3b53b:1f4785c84ba5d07fe0bf709273395def8f4cc57627927977a8ab6838a8721559` (run `qualify-enabled` first to confirm them).
- Route distance stays off (geometry-off fallback, D68): the last diagnostic was `no-matched-trips`, `tripStopDistance` 1,044 of 1,044 trips. Diagnostic v2 (#154, `scripts/route-geometry.mjs`, `docs/ROUTE_DISTANCE.md`) adds aggregate counts that separate a units mismatch between `shapes.txt` and `stop_times.txt` from terminal stops sitting away from the shape ends; delivered geometry is unchanged.

## Waiting on the owner
- Live train data (#80; owner decision 2026-11-16: NJ Transit's live rail feed first, printed timetables only as the labeled backup). The second one-shot rail check (run 43999082745, owner's go-ahead) got HTTP 500 on both token requests (not 401/403/429); cause unknown. The owner is checking whether his NJ Transit developer account lists Rail Data and Rail GTFS / GTFS-RT access. No further rail run without a new go-ahead.
- Printed Pascack Valley timetable (effective 2026-11-15) and the Secaucus to New York Penn trains, for the train backup; the owner will supply them later.
- Before 2026-11-22: which review path applies once CodeRabbit's free usage ends (D71).
- Phone test on Jeff's and Diego's phones: install, save a commute, reverse it, open a trip from Port Authority, use it offline; also try the new optional settings (slogans, bilingual buttons, home photo) and a MyBus text draft without sending.
- Whether the app should stay publicly reachable or be limited to the household.
- Gate cards (GATE-02): photos and floor/escalator notes from Port Authority.
- Optional: protect `main` on GitHub. Do not make the `test` check required as things stand: docs-only pull requests, drafts included, never start the workflow (D70), so a required `test` check would stay pending forever and block them. To require a check, first add an always-running gate job that passes for docs-only changes, and require that gate instead of `test`. A draft pull request that does start the workflow reports the skipped `test` job as passed.

## Next
1. Weekly rollover before 2026-11-23 (plan around Nov 20): tell the owner first, `qualify-enabled`, then `rollover-enabled` with the pins above. The #154 counts print in that run only if geometry fails again (no trip matched).
2. Route distance part 2: the fix chosen from the #154 counts (never straight-line distance).
3. Trains from the owner's two Pascack Valley stations (#80): the live rail feed once a token is accepted (Worker adapter, risky-change review, owner told before going live), with printed timetables as the labeled backup.
4. Docs cleanup and D71 review levels (#173, in review).
5. Re-add `.github/workflows/branch-cleanup.yml` once GitHub Support answers.
6. Later, from the owner's Nov 13 order (#153): stop alerts 3, 2 and 1 stops before getting off; #113 simpler travel screens; #103 easier stop picking; rest of #106 (rider stop photos); rest of #99 (optional on-device GPS tour content and the optional five-second town Welcome cards with an off setting); gate cards; DST check before 2027-03-14 (read-only); remove the gate-card notice when advisory 2176177 ends; weekly read-only server health check (`inspect`), reporting only problems.

## Known problems
- Safari/iPhone is not qualified: Codex's WebKit runs hit test-setup limits (offline reload, keyboard scrolling) and existing route-strip overflow at 305 px / 200% text. Needs a real iPhone check.
- Tour guide: the "brown Belleville stone" detail on the Johnson Public Library card comes from the library's history page, which the builder's sandbox cannot open; the other new facts were confirmed by web search.
- Settings are saved as one whole record. Since #167/#171 a tab adopts and never writes back another tab's saves, but truly simultaneous saves from two tabs, or a save made in the same instant another tab opens, can still overwrite one setting (#171 review r4593163990).
- Home photo: an already-open tab keeps showing the previous photo until refresh if the browser does not deliver the change notice (#168).
- MyBus on iPhone opens Messages to 69287 and asks the rider to paste the copied stop code (Apple documents no prefilled body); Android gets a prefilled draft. This differs from the "prefilled draft" wording in #96; the owner has been told.
- When several merges land at once, an older Pages deploy can fail with a collision while the newest succeeds (seen 2026-11-16 on `a95f315`); harmless.
- DST: check how NJ Transit's GTFS encodes 00:00-02:59 on clock-change dates before March 14, 2027 (Codex's synthetic check found no converter mismatch, but agency encoding is unverified).
- The Port Authority gate card shows NJ Transit's construction advisory 2176177; remove it when the advisory ends (still active on 2026-11-15).
- The builder's sandbox cannot delete branches (HTTP 403, rechecked 2026-11-16), so merged branches pile up. `scripts/branch-cleanup.mjs` is ready; its workflow returns in its own pull request (GitHub Support ticket, request ID 4007:33BC50:227B926:26A3EEF:6AF5A77C).
- The builder's sandbox blocks github.io, so "confirm Pages after merge" needs a browser outside it or an environment network change.

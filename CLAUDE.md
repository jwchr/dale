# Dale: development rules for Claude (local folder and storage keys still `arriba`)

**Goal:** the most useful, trustworthy North Jersey to Manhattan NJ Transit bus app with the least engineering.
Read `docs/V1_CONTRACT.md` (what V1 is) and `docs/HANDOFF.md` (where things stand) at the start of every session and after compaction. The 805-line master spec v1.3 is an archive; do not load it unless an issue links to a section of it.

## Product rules (owner decisions; see docs/DECISIONS.md)
- Household tool first (Jeff and Diego), built so it could go public later. No accounts in V1.
- Never invent live data. Every live bus, gate, zone or estimate carries its source and age; unknown is a valid answer. A bus that stops reporting is "not reporting", never "cancelled", unless NJ Transit says so.
- Exact-bus lock never switches buses silently (`src/domain/lock.ts`). Favorites keep the rider's order. A gate is never inferred from a route number.
- English and Spanish for every string (`src/ui/i18n.ts`); 12-hour times in both.
- Demo data must show the DEMO banner (`meta.demo`). Real data comes only from NJ Transit feeds via `scripts/build-gtfs.mjs` and, from M3, the Worker; until M2 the printed-data exceptions are the owner-supplied route 165 timetable (D42, `scripts/build-timetable.mjs`) and the bounded supplied bus/rail documents authorized in D49 (#80; not yet published), which must keep printed-source attribution (D50 moves the persistent top notice into Settings → Data source).
- Independent app: never use NJ Transit or Port Authority logos as Dale's branding, or imply endorsement. Only exception (D69): the photographed real stop sign in "See bus stop sign" keeps its printed logos so riders can recognize it.

## Data and privacy
- D51/D52: bus credentials are verified (#87) and the owner requests the bounded live bus pilot (#89) on the existing Free Cloudflare plan. Require verified exact trip/date matching, source age and explicit scheduled fallback; no paid upgrade, archive, rail or shared-report access follows from this pilot. See docs/LIVE_BUS_PILOT.md.
- D60/#91 separately authorizes private indefinite corridor history, background collection and actual agency cadence measurement. Jeff explicitly approved same-account R2 within Free usage; Project Control created private `dale-history`. Preserve original evidence/context; hot cleanup requires verified durable data+manifest readback. Enforce persistent storage/operation/write limits, no automatic paid overflow or new vendor. Independent HIGH review, separate release/activation and actual production evidence remain required. See docs/HISTORY_COLLECTION.md.
- NJ Transit data terms apply (server-side storage, 40,000 requests/day per API, attribution, latency disclosure). The owner reported NJ Transit's OK for archiving on 2026-10-31; keep the archive corridor-only and private.
- This repository is public. Never commit NJ Transit credentials, tokens, recorded feed responses, rider locations or personal data. Credentials live only in repository or Cloudflare secrets set by the owner.

## Engineering
- **Deliver the complete owner-approved outcome. Visual polish and ease of use are acceptance requirements, not optional follow-up.** A functional implementation is unfinished when its approved appearance, graphics, layout or usability is missing. Do not replace a requested full design with borrowed colors/tokens or another partial interpretation, and do not describe that as delivery.
- **Approved design references control visual acceptance.** Compare the actual rendered screens with the approved mock-up/source, including graphics, typography, spacing, hierarchy and interaction. Use available space efficiently; preserve useful features while removing unnecessary gaps, redundant rows and long scrolling. Verify real narrow-phone layouts, English/Spanish, enlarged text, touch targets and keyboard use. Functional tests alone do not establish visual completion.
- **Owner approval is required for design-direction, roadmap or approved-scope changes.** Do not independently substitute a design, cut requested features/graphics, or move unfinished approved work to a later phase. Internal implementation steps may be small; shipping a partial outcome requires the owner's explicit agreement. If genuinely blocked, identify the exact blocker and remaining work rather than silently stopping early.
- Keep one web app (`src/`) and, from M3, one Worker (`worker/`); no new packages until two real consumers exist.
- Domain logic is pure TypeScript in `src/domain/` with unit tests in `tests/unit/`; UI flows in `tests/e2e/` (Playwright, Pixel 7, pinned `?now=`).
- Run `npm run verify` locally before every push and batch related fixes into one push. CI runs on pull requests and main only.
- Use standard libraries (GTFS-Realtime bindings, MapLibre) over custom parsers when the need arrives; record license and version.

## How we work (owner approved 2026-11-11; same text in every app)

This section replaces every earlier review, merge, operator, steward, queue and model-routing rule in this repository. Where another file disagrees with it, this section wins: correct that file.

1. **One builder per app.** Claude builds. ChatGPT or Codex builds only when Claude is out of usage and the owner says so. Never two builders on one app at once. No overseer, steward, coordinator or scheduled build task.
2. **Read first.** At the start of every session and after every compaction, read this file and `docs/HANDOFF.md`, then check the real state on GitHub. Do not ask the owner to repeat what is written there.
3. **One change at a time.** At most one open pull request per app. Finish it or close it before starting another. One feature is one GitHub issue. Do not invent work to fill an empty queue.
4. **Plain English on top.** The owner is not a developer. Every pull request description starts with two short parts for him: "What this does for you" and "How to try it" (step by step, in the app), or "Nothing for you to test."
5. **Checks before merging.**
   - The full automated tests pass on the final commit, and the GitHub check is green on that same commit.
   - CodeRabbit has reviewed the final version. Every serious finding is fixed, or answered with a reason. If CodeRabbit is unavailable, use one Gemini 4 Argon review instead and tell the owner. Buy nothing.
   - Risky changes also get one independent review from Gemini 4 Argon, or from Codex when it is available. Risky means: money or billing; secrets or credentials; private, personal or client data; deleting or overwriting files or records; data pipelines and migrations; workflows, deploys and repository settings; these rules; anything hard to undo; anything you are unsure about.
   - Check every review finding against the code before acting on it. Reviewers miss real bugs and report false ones.
   - The checks under "This app" below.
6. **The builder merges.** When the checks pass, squash-merge your own pull request, delete the branch, confirm the app really updated, update `docs/HANDOFF.md`, and tell the owner in one or two plain sentences what changed and how to try it. He tries visible changes in the real app after they are live. If he says something is wrong, fix it or undo it the same day.
7. **The owner stays out of GitHub.** Never ask him to open GitHub, read review comments, type a comment or click merge. Ask him only about product choices (give options and a recommendation), money, accounts and passwords, and hands-on tests. Ask in the chat, in plain language, one question at a time. If your session can edit his Shared To-Do List, record the question there too.
8. **Safety stops.** Stop that one piece of work and ask first before: spending money; sending a message to anyone but the owner; deleting or overwriting real data; touching secrets; using real client material. Never commit credentials, personal data, or client names, footage or addresses. A new session never clears a stop by itself. Unrelated safe work continues.
9. **Spending caps.** No new paid services, API keys or upgrades. Gemini reviews use Argon only, inside the owner's prepaid balance, with auto-reload off. Keep GitHub Actions under the owner's $10 monthly cap: run tests locally before pushing and batch fixes into one push.
10. **Short status file.** `docs/HANDOFF.md` holds only: what is built and live; what is waiting on the owner; what is next; known problems. Update it in place after every merge. No diary and no history. Ideas that are not approved work belong in the owner's Idea Inbox, not here.
11. **Say what is true.** State plainly what is built, tested, live and unverified. Never claim that work is running in the background, and never give a time estimate without evidence.

### This app: Dale
- Before every push run `npm run verify`.
- CodeRabbit does not start by itself here (`.coderabbit.yaml`). Request one `@coderabbitai full review` when the pull request is ready, and never a duplicate.
- After a merge, open the public Pages site and confirm the change is there, on a narrow phone layout, in English and Spanish.
- Worker deploys, live-feed changes and history collection are risky changes. They also keep the conditions written in `docs/LIVE_BUS_PILOT.md` and `docs/HISTORY_COLLECTION.md`.

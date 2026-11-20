# Dale: development rules for Claude (local folder and storage keys still `arriba`)

**Goal:** the most useful, trustworthy North Jersey to Manhattan NJ Transit bus app with the least engineering.
Read `docs/V1_CONTRACT.md` (what V1 is) and `docs/HANDOFF.md` (where things stand) at the start of every session and after compaction, then check the real state on GitHub. The 805-line master spec v1.3 is an archive; do not load it unless an issue links to a section of it.

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
- Use standard libraries (GTFS-Realtime bindings, MapLibre) over custom parsers when the need arrives; record license and version.

## How we work
Jeff's shared rules for every chat (permission, reviews and when a change is risky, PR limits, safety stops, spending, keeping the chat small, compaction at 60% instead of handoffs, SSOT) live only in `~/.claude/CLAUDE.md`, which Claude Code loads automatically. That file controls; do not copy its rules here, change them there. This section adds only Dale's own rules.

- **Codex plan checks go in a pull request.** Codex does not answer `@codex` on issues here (no cloud environment; seen Nov 17 and Nov 19, 2026), so put a plan in `docs/plans/` on a docs-only PR and ask `@codex review` there.
- **Codex here.** Codex does not load `~/.claude/CLAUDE.md`: before Codex builds or reviews here, the session that starts it gives it that file's text, or it does not start.
- **Checks before merging.** `npm run verify` passes locally before every push, and the GitHub `test` check is green on the final commit. Docs-only pull requests (only `docs/**` or Markdown) do not start that check (D70); for them the local tests are the test requirement. Open pull requests as drafts while building. CI runs on pull requests and main only.
- **CodeRabbit here.** It does not start by itself (`.coderabbit.yaml`). The shared rules' one review per pull request is requested here as `@coderabbitai full review` when the pull request is ready.
- **Risky in Dale** also means Worker deploys, live-feed changes and history collection; they keep the conditions in `docs/LIVE_BUS_PILOT.md` and `docs/HISTORY_COLLECTION.md`.
- **The builder merges.** When the checks pass, squash-merge, delete the branch, open the public Pages site and confirm the change on a narrow phone layout in English and Spanish, update `docs/HANDOFF.md`, and tell the owner in one or two plain sentences what changed and how to try it.
- **Short status file.** `docs/HANDOFF.md` holds only: what is built and live; what is waiting on the owner; what is next; known problems. Update it in place after every merge. No diary and no history. Ideas that are not approved work go to the owner's Idea Inbox.

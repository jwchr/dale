# Dale: development rules for Claude (local folder and storage keys still `arriba`)

**Goal:** the most useful, trustworthy North Jersey to Manhattan NJ Transit bus app with the least engineering.
Read `docs/V1_CONTRACT.md` (what V1 is) and `docs/HANDOFF.md` (where things stand) at the start of every session and after compaction. The 805-line master spec v1.3 is an archive; do not load it unless an issue links to a section of it.

## Product rules (owner decisions; see docs/DECISIONS.md)
- Household tool first (Jeff and Diego), built so it could go public later. No accounts in V1.
- Never invent live data. Every live bus, gate, zone or estimate carries its source and age; unknown is a valid answer. A bus that stops reporting is "not reporting", never "cancelled", unless NJ Transit says so.
- Exact-bus lock never switches buses silently (`src/domain/lock.ts`). Favorites keep the rider's order. A gate is never inferred from a route number.
- English and Spanish for every string (`src/ui/i18n.ts`); 12-hour times in both.
- Demo data must show the DEMO banner (`meta.demo`). Real data comes only from NJ Transit feeds via `scripts/build-gtfs.mjs` and, from M3, the Worker; until M2 the printed-data exceptions are the owner-supplied route 165 timetable (D42, `scripts/build-timetable.mjs`) and the bounded supplied bus/rail documents authorized in D49 (#80; not yet published), which must keep printed-source attribution (D50 moves the persistent top notice into Settings → Data source).
- Independent app: never use NJ Transit or Port Authority logos, or imply endorsement.

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

## Autonomous development (copied from VPM and Life Dashboard policy, 2026-10-30/31)
- **Safety holds:** pause only the affected operation on a credible security, privacy, cost, irreversible-action or data-integrity concern; one `🚨 ACTION REQUIRED — SAFETY HOLD` note naming the single owner decision needed; a new run never clears a hold by itself.
- **Review routing:** follow `docs/REVIEW_POLICY.md` (D58, amended by D64 and D65). A non-author verifies risk. CodeRabbit reviews every PR, plus one Gemini review tiered by risk (D65): Gemini Pro for easy changes, Gemini 4 Argon for harder ones, Gemini 4 Carbon for the most serious (secrets, deploys, the history recorder, rider privacy, irreversible actions). Jeff lifted the Gemini hold on 2026-11-11; once Codex returns it may take the Argon or Carbon slot. Unsure means the higher tier. Do not spawn another reviewer.
- **Merging:** a PR merges only with green CI on the exact head and qualified independent review covering the current head/base, full diff and current PR description. Every finding is fixed or answered and accepted by the non-author reviewer/operator. The author never reviews or merges their own change. The separate operator rechecks all gates and squash merges with the expected head SHA. A merge is not a deployment claim; check the Pages URL separately. No automatic approval/merge, paid review upgrade or new service.
- **Queue:** at most one implementation PR in flight. Never create an issue just to fill an empty queue, never duplicate an issue that already has a branch or PR, and claim before building (one issue comment).
- **Models:** Sonnet/high for docs, tests and mechanical changes (`routine-sonnet` subagent); Opus/high for data pipeline, lock, gate, privacy and architecture. No paid credits or new services without the owner.
- **Unattended runs:** none yet. A scheduled Dale steward starts only after Life Dashboard issue #13 proves a full unattended cycle (owner decision 10).
- State plainly what is built, tested, deployed and unverified. Owner wants short, plain answers; escalate only real blockers (credentials, money, device testing, product decisions).

# Rail history plan (#261)

Dale should privately keep the train boards it reads, including reported delays and gaps.
Use the existing bus history storage and collection owner, with no new service or paid upgrade.
Continuous coverage needs requests when nobody has the Train screen open. Share those requests
with the boards instead of running a second rail reader. Prove the combined Free budget first.
This is a plan only. It does not turn on collection, deploy anything or prove current live service.

## Authority and evidence

- [Issue #261](https://github.com/jwchr/dale/issues/261) replaces D63's ban on continuous rail collection for the five existing stations. Other safeguards remain.
- Follow [CLAUDE.md](../../CLAUDE.md), [D60, D63 and D73](../DECISIONS.md), [bus history](../HISTORY_COLLECTION.md) and the [live pilot](../LIVE_BUS_PILOT.md).
- Research is repository-only. Terms and Free limits below are recorded repo facts, not newly verified provider promises. Confirm them before activation.
- Keep this proposal here; update the canonical decision/history docs when implementation is approved, rather than creating a second rulebook.

## What Dale reads now

- `worker/rail.ts` posts to the fixed RailData `getTrainSchedule19Rec` method using the existing server credentials and a shared rail token.
- Stations: Anderson Street (AS), Essex Street (EX), Secaucus lower level (TS), Secaucus upper level (SE), New York Penn (NY).
- AS/EX/TS request the PV line; SE/NY have no line filter. Keep the two Secaucus levels distinct. Do not expand stations or methods.
- Reads are demand-driven. Each station has a 60-second memory cache and concurrent requests share one load. There is no continuous rail history today.
- Restart loses the board cache and station pacing; token mint counts and the global rate-limit pause survive. Persist board pacing before adding background reads.
- The theoretical steady-state board ceiling is 5 × 1,440 = 7,200 calls/day, plus tokens. Today idle stations make none; restart pacing is not a durable daily ceiling.
- Tokens refresh after 23 hours, with at most 3 mint attempts per rolling 24 hours, at least an hour apart. Rate limits pause all stations for 15 minutes.
- Responses have a 12-second deadline and 524,288-byte cap. Up to 40 rows become train ID, line/code, destination, scheduled time, track, status, seconds late and last-modified time.
- Receipt time is separate from agency last-modified time. GPS, capacity, colors and station-message text are discarded; unreadable rows are counted. Fullscreen messages mean unavailable, not an empty board.

## Collection and retained evidence

- Extend the existing singleton and its native bus alarm. One serialized rail refresh owner serves both demand and background work, at most once per station per 60 seconds.
- Target continuous five-station coverage, including overnight. A foreground request reuses the same result and never adds a duplicate upstream read or history event.
- This adds idle-period calls compared with today's demand-only reader. If Free capacity cannot support the target, report the blocker; do not silently substitute demand-only coverage.
- Reserve a stable poll identity, station pacing and shared budget durably before network work. Never record a cache hit as another agency observation.
- Store versioned, allowlisted original rail fields before display cleanup, plus their normalized interpretation. Preserve source time strings, numeric delay text, status and original track alongside TS's signed track.
- Retain station/line filter, method/schema/parser version, request/receipt clocks, source label, row order, counts and per-poll presence, including unchanged rows and rejected-row reasons.
- Allowlist only board evidence needed for the fields above. Never archive whole HTTP bodies, credentials, tokens, headers, arbitrary messages, GPS, capacity or rider data.
- Missing, malformed, stale, future or regressing clocks remain explicit quality states. Keep bounded evidence for rejected allowed fields; oversize omissions never count as successfully retained rows.
- Repeated observations retain presence and receipt clocks even when source content is unchanged. Distinguish repeated content, source updates, conflicts and failed requests.
- Use station + train ID + explicit scheduled departure date/time for a board occurrence, not train number alone. No unverified cross-station trip or connection join.
- Retain rail configuration/parser/timezone context by checksum before its evidence. Bus G2 context does not describe rail; version rail context separately and preserve old versions.
- Rail predictions and delay reports are not measured arrivals. Disappearance never proves departure, arrival or cancellation. #260 and confidence calculations remain separate work.
- Keep originals indefinitely in private same-account `dale-history`. Public health may add totals, clocks, coverage and fixed reasons only, with no train IDs, keys or raw history.
- D73 permits aggregate counts, not raw archive release or automatic rail statistics publication. Preserve source/age, exact-bus identity and English/Spanish product rules.

## Free budget alongside bus history

Use the existing persistent shared ledgers, not a fresh allowance for rail. Include other account consumers and operator access before admission.

| Resource | Existing bound and planning consequence |
| --- | --- |
| Agency calls | Bus: at most 5,760 feed calls/day plus auth. Rail target: 7,200 board calls/day plus at most 3 token attempts. Confirm how the 40,000/day per-API allowance groups these calls and other consumers. |
| SQLite writes | App ledger: 75,000/day; documented Free allowance: 100,000 rows/day account-wide. Bus normal cycle reserves 69,120/day, leaving only 5,880 before context, errors, controls and other features. |
| Separate rail cycles | 7,200 × the existing 24-unit collection/archive/prune cycle = 172,800 extra units/day. Reject this design. Even one separate cycle/minute adds 34,560. |
| Shared batches | Fold rail evidence into the existing 30-second journal/archive cycle; target no per-board SQL row, archive object or alarm. Count every additional pacing, checkpoint, token and failure write explicitly. |
| R2 operations | One bus batch/cycle reserves 5,760 A and 5,760 B/day, or 195,840 each over 34 UTC buckets, before contexts/retries. Shared caps stay 500,000 A and 2,000,000 B; rail cannot reset them. |
| R2 storage | Shared reservation ceiling 9,000,000,000 bytes; reserve gzip + 4,096 manifest bytes per transaction, including ambiguous retries. Finite space means finite collection runway, not finite retention. |
| Hot storage | Shared 250 MB payload and 500 MB actual SQLite guards; six-hour verified hot window. Existing 128,000-byte bundle and 256,000-byte dedupe bounds need explicit combined sizing. |
| Account compute | Recorded Free allowances: 100,000 DO requests/day, 13,000 GB-s/day, 5 million SQL rows read/day, 5 GB SQL total. One continuously active 128 MB object already uses about 11,060 GB-s/day. |

- Preserve the bus budget and evidence first. Do not raise limits, drop bus rows or pretend five maximum-size rail responses fit one 128 KB bundle.
- Before building the batching change, calculate worst-case allowlisted rail bytes for 40 rows × 5 stations plus bus maximums and context. Define lossless bounded chunking and charge its extra rows/operations before accepting it.
- Exercise a synthetic full day and 34-day ledger window, including rollover, retries and other enabled folds. If combined writes cannot fit, redesign batching within the same owner before activation.
- Measure gzip bytes/day, physical SQLite growth, request counts, duration and rows read/written privately after deployment. Runway is remaining shared bytes / measured daily reservations; label sample dates and retry overhead.
- Do not promise an unlimited archive, provider billing hard cap or compression ratio. No new vendor, secret, bucket, paid overflow or automatic upgrade.

## Rail terms to confirm before activation

- D63 records generic account approval, not every rail entitlement. Confirm this account may continuously use this exact method and its five existing station filters.
- Confirm rail-specific request accounting, token guidance, rate-limit resets and whether the recorded 40,000/day rule applies separately to RailData and bus G2.
- Confirm private indefinite storage of allowlisted originals and context, plus later derived aggregate publication, is covered by the rail agreement. Bus archival approval alone is insufficient evidence.
- D73 records server-side storage permission, attribution/non-endorsement requirements and disclosure when latency exceeds one minute. Confirm these apply to this rail product, including stale or unknown source clocks.
- Record the applicable terms/version and operator confirmation in the canonical decision record without credentials or feed samples. Resolve uncertainty before enabling rail recording; do not contact anyone automatically.

## Failure, stop and time behavior

- Commit evidence, dedupe/presence checkpoint and completion count atomically. On crash after a response but before commit, mark an interrupted unknown interval; never claim that unavailable response was recovered.
- Resume committed work idempotently without double counting. Persist pacing across eviction; retries cannot renew an attempt, erase pending gaps or bypass a reserved quota.
- Reuse conditional-create, content-hash archive keys and data/context/manifest readback from `history-archive.ts`. Acknowledge only in a transaction after verification; retain unarchived local evidence on every failure.
- Never overwrite/delete archived objects or manifests. Prune only verified hot copies. Partial upload, checksum failure or ambiguous timeout retains reservations and retries with bounded backoff.
- Preserve existing one-minute failure caching, no immediate auth retry, shared token limits and persisted 15-minute rate pause. No catch-up burst or fabricated backfill after an outage.
- Terms/configuration failures leave rail recording off. Byte/write/operation admission failures pause rail before consuming bus headroom; expose the gap and reason. Unreadable shared ledgers fail closed for affected writes.
- Provide a separate rail recording switch, initially off. Stopping it prevents background rail reads and history writes while retaining all evidence; existing demand boards and bus collection keep their own controls.
- Do not change production switches in this task. Any shared-stop recovery uses the existing reviewed process; no automatic deploy, rollback, purge or paid recovery.
- Store epoch clocks plus original agency time strings and `America/New_York` context. Never turn receipt date into a rail service date or last-modified time.
- Preserve `parseRailTime` rejection of nonexistent spring and ambiguous fall wall times. Handle overnight departures with explicit dates, reused train numbers, calendar changes and parser/configuration rollover without merging occurrences.

## Tests and rollout

1. Obtain the docs-only plan review first. Confirm rail terms and current shared account usage; no live feed probing or deployment is part of this plan task.
2. Build synthetic tests for all five station filters, shared demand/alarm reads, restart pacing, tokens, 429 pauses, empty/fullscreen boards, partial/invalid/oversize rows and all quality states.
3. Test midnight, delayed trains crossing midnight, spring/fall DST, train-number reuse and context rollover. No invented arrival, cancellation or connection follows from a missing row.
4. Inject crashes before/after reservation, response, SQL commit, each R2 write/readback and acknowledgment. Prove no duplicate completion, lost committed evidence, overwritten objects or premature hot cleanup.
5. Test bus-plus-rail maximum bundles, chunk reassembly, six-hour backlog, exhausted shared limits, UTC budget boundaries, 34-day operations, archive outages and rail-only stop/restart. Prove bus reservations remain available.
6. Check all public responses/logs contain no new history identities, keys, payloads, coordinates or secrets. Use synthetic fixtures only. Run `npm run verify` for implementation; independent risky-change review must pass.
7. Use the existing reviewed-main deployment path after separate owner approval. Preserve bus namespace, bucket, context, counters and enabled state. Deploy rail recording off and verify unchanged bus collection/archive progress.
8. After explicit owner activation approval, enable bounded rail collection. Privately verify actual boards, shared-request counts, immutable readbacks and measured combined budget through overnight service; report gaps honestly.
9. Keep enabled only while measured limits and evidence checks pass. A rail-specific failure pauses that piece and records the reason; any proposed production scope change goes to Jeff. No raw data enters git, logs or a public endpoint.

Acceptance: actual private rail evidence and verified archive readback advance without duplicate polls or bus regression, within shared Free limits. A merged plan or passing local test does not establish this.

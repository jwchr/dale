# How sure are we? Measured arrival patterns (#91, #101)

This is the data side of the "How sure are we?" card (mock-up `docs/design/mockups/03-follow-bus.jpg`). The card itself is a later pull request. Nothing here changes the app yet.

## What is measured

For one scheduled stop time (route, direction, stop, scheduled time of day, and type of service day), Dale counts how early or late buses really arrived on past days.

- **Arrival** means the same thing as in the ETA backtest (`docs/ETA_BACKTEST.md`): the first sample in Dale's private history where NJ Transit's own feed says the bus is `stopped_at` that stop. If the bus is still stopped at the next sample, it is the same arrival.
- **How late** is that arrival time minus NJ Transit's scheduled time for that trip and stop. Only official scheduled times count. A time that Dale estimated (the printed timetable's gaps) is skipped and counted.
- **Day type** is weekday, Saturday, or Sunday-holiday. It comes from the trip's NJ Transit service calendar, not from guessing.
- **Minimum evidence** is 5 service days, the same abstain rule as the backtest. Below 5 the answer is "Building confidence" with the count so far, and no chart or record.
- **One arrival per scheduled time per service day.** Each stored cell keeps a bitmap of the service dates it already counted. Replaying the same history adds nothing.

Each answer has:

- 32 one-minute buckets: "more than 10 minutes early", then each minute from 10 early to 20 late, then "20 or more late".
- 8 five-minute buckets built from the same counts: under 10 early, six 5-minute bins from 10 early to 20 late, then 20 or more late. The mock-up's "12:00 to 12:04" style labels come from these plus the scheduled time.
- The record book: worst (latest), best (closest to on time) and earliest arrival, each with minutes, service date and clock time.
- First and last service date counted, and how many arrivals had a known "bus was not yet there" sample before them (a rough measure of how precise the arrival time is).

## What is public

`GET /v1/arrival-confidence?route=165T&stop=<stopId>&dir=<0|1>&sched=HH:MM&day=weekday|saturday|sunday`

- Exactly those five parameters, each once. `sched` is the GTFS service-day time, so after-midnight trips use 24:10 and so on (00:00 to 47:59). The stop must be on that route and direction in Dale's schedule. Anything else is a 400, refused at the edge before the Durable Object is touched. URLs over 512 characters are refused.
- Read-only. It reads one SQLite row. It never polls NJ Transit and never refreshes live data.
- `200` answers are cached for 10 minutes (`public, max-age=600`). Errors are `no-store`. If the stored aggregates cannot be read the answer is `503 {"v":1,"state":"unavailable"}`, never a guess.

Ready answer (shortened: the real `oneMinute` list always has 32 entries):

```json
{
  "v": 1, "state": "ready", "samples": 23, "minimumSamples": 5,
  "query": { "route": "165T", "direction": 0, "stopId": "1", "scheduled": "07:00", "dayType": "weekday" },
  "measurement": "first-official-stopped-at-sample",
  "source": "NJ Transit GTFS-RT G2, measured by Dale",
  "firstServiceDate": "2026-11-09", "lastServiceDate": "2026-12-11",
  "oneMinute": [
    { "fromMinute": null, "toMinute": -10, "count": 0 },
    { "fromMinute": -10, "toMinute": -9, "count": 0 },
    { "fromMinute": 2, "toMinute": 3, "count": 6 },
    { "fromMinute": 20, "toMinute": null, "count": 1 }
  ],
  "fiveMinute": [
    { "fromMinute": null, "toMinute": -10, "count": 0 },
    { "fromMinute": -10, "toMinute": -5, "count": 0 },
    { "fromMinute": -5, "toMinute": 0, "count": 3 },
    { "fromMinute": 0, "toMinute": 5, "count": 14 },
    { "fromMinute": 5, "toMinute": 10, "count": 4 },
    { "fromMinute": 10, "toMinute": 15, "count": 1 },
    { "fromMinute": 15, "toMinute": 20, "count": 0 },
    { "fromMinute": 20, "toMinute": null, "count": 1 }
  ],
  "worst": { "minutes": 22, "delaySeconds": 1340, "serviceDate": "2026-11-26", "arrivedAt": 1795871540000 },
  "best": { "minutes": 0, "delaySeconds": 10, "serviceDate": "2026-11-17", "arrivedAt": 1794920410000 },
  "earliest": { "minutes": -3, "delaySeconds": -200, "serviceDate": "2026-12-02", "arrivedAt": 1796216200000 },
  "uncertainty": { "boundedSamples": 21, "meanWindowSeconds": 34 }
}
```

`fromMinute` is inclusive and `toMinute` exclusive; `null` means open-ended. `minutes` truncates toward zero. `source` comes from the live relay's own attribution string.

Not enough evidence yet:

```json
{ "v": 1, "state": "insufficient", "samples": 3, "minimumSamples": 5,
  "query": { "route": "165T", "direction": 0, "stopId": "1", "scheduled": "07:00", "dayType": "weekday" } }
```

**Nothing here exposes what `/v1/collection` protects.** Stored cells and answers hold only counts, service dates, delay seconds and the clock time of three record arrivals. There are no vehicle IDs, coordinates, trip IDs, per-trip rows, samples, archive keys or cursors. The vehicle ID and coordinates are dropped when a private batch is read (`batchSamples`), before any arithmetic. Unit tests walk every output field against an allowlist and check that a synthetic vehicle ID and coordinate never appear in stored rows, answers or health. `/v1/collection` adds an `arrivalConfidence` block with counts and limits only.

**Data terms (D73).** This endpoint publishes derived aggregate statistics (counts of how late buses were), not the feed itself and not any position. The owner approved showing them on 2026-11-20, after a check against NJ Transit's Data Feed Agreement, which allows serving the data from Dale's own server. The card must not imply the counts are accurate, complete or timely, and must not imply NJ Transit endorses Dale; it names NJ Transit's GPS as the source and says the counts are past patterns, not a promise. The endpoint answers 404 until the Worker setting `ARRIVAL_CONFIDENCE` is `public`; setting it is a Worker change and keeps the risky-change review.

## How it is stored and updated

Two small SQLite tables in the existing Durable Object:

- `dale_arrival_rows`: one row per route, direction, day type and scheduled hour (at most 4 routes x 2 x 3 x 48 = 1,152 rows). Each row holds the cells for that hour, keyed by scheduled minute and stop.
- `dale_arrival_meta`: two rows, the live fold state (checkpoint, a 30-minute "still stopped" memory and counters) and the backfill state.

**Live fold.** Inside the existing collection alarm, after the poll, archive flush and hot prune, once an hour (every 5 minutes while catching up) Dale reads up to 240 new private batches from the 6-hour hot table and adds their arrivals. It runs last and never throws into collection. It writes only from spare daily write budget (`reserveSpareWrites`): every remaining 30-second poll of the day, the rollover margin and the caller's own reserve are kept first. If there is no spare budget, the database is near its guard, or the aggregates reach their cap, it waits and keeps its checkpoint, so nothing is lost while the batches are still in the hot table. If the hot table moved past the checkpoint (collection paused or a long refusal), it counts a `possibleGaps` and starts fresh from the oldest retained batch. Batches recorded under an older schedule are skipped and counted (`otherSchedule`); the backfill can recover them. The first fold uses its first 15 retained minutes only to learn which buses were already stopped.

**Limits.** A row stops growing at 1 MB (new arrivals for it are refused and counted). All aggregates stop at 100 MB. Nothing is added once the SQLite database reaches 450 MB, which keeps the collector's own 500 MB guard clear.

## Cost estimate

- **Writes.** Each fold touches about 10 to 20 rows plus 2 state writes. At 24 folds a day that is about 300 to 500 of the roughly 5,900 spare units per day. Normal collection uses about 69,100 of the 75,000 daily units.
- **Storage.** About 300 to 400 bytes per cell, plus about 46 bytes per cell per year for the service-date bitmap. With about 75,000 cells (every corridor stop time on all three day types) that is about 30 MB in the first year, under the 100 MB cap.
- **R2.** The live fold makes no R2 calls. The backfill is below.
- **Requests.** The endpoint makes no NJ Transit request.

## Backfill from the private archive (written, not run)

`worker/arrival-backfill.ts` replays archived batches from 2026-11-08 forward through the same arrival rule and the same cells. It is manual, bounded and idempotent:

- It runs only while a plain-text Worker setting `ARRIVAL_BACKFILL` holds a lease: `dry-run:<deadline ms>` or `apply:<deadline ms>`. The deadline must be in the future and at most 48 hours away when the lease first starts. A lease never restarts after it finishes or expires. A new lease string starts over at 2026-11-08.
- Each step (at most once per collection alarm) lists one day's batch keys, reads at most 120 objects, checks each object's SHA-256 against its key, and replays it with the schedule it was recorded under. That is the current schedule or its immutable archived copy, checksum-verified. A schedule that is not already in memory is loaded only as the first object of a step, so a step loads at most one.
- One 5-second deadline covers the whole step: the listing, the batch reads and the schedule load. When it runs out mid-read, that is treated like an R2 error below.
- **R2 trouble is retried, never skipped.** A timeout or an R2 error leaves the cursor just before the unread object, and the step backs off: 1 minute, doubling to 1 hour. The lease deadline bounds the retries. Only data that is really missing, altered or invalid is counted and passed (`unreadable`, `checksumFailures`, `contextUnavailable`). `retryableFailures` counts the retries.
- A step reserves its R2 operations in the same 34-day ledger as the archive and may use at most half of each free cap. It writes only from spare daily budget and keeps 2,500 units for live folds and a rollover. Every row it writes is reserved first, including the reservation's own journal row, the R2 ledger row and its state row. A test checks this step by step in both modes.
- **Dry run** writes no aggregate rows. It only saves its own progress, so it prints only counts: steps, list calls, objects read, batches replayed, checksum failures, unreadable objects, schedules read, samples, arrivals derived, how many would be new and how many are already counted, and skip reasons. "Would be new" is an upper bound: it does not remember dates across steps.
- **Apply** commits each step's rows, the aggregate state and its own cursor in one transaction. A crash can only repeat a step, and a repeated step adds nothing because each cell already holds those service dates. The tests replay a full apply and get 0 new and all "already counted".
- **Cost.** About 13 days of archive (about 37,000 batch objects) is about 350 list calls (Class A) and about 37,000 reads (Class B), well inside half of the free caps (250,000 A and 1,000,000 B per 34 days) next to collection's own use of about 196,000 A. Writes are about 25 units per step, about 7,500 in all, so it takes about 2 to 3 days of spare budget.
- Progress shows in `/v1/collection` under `arrivalConfidence.backfill`: mode, state, day and the counts above. No keys, cursor, trips or samples.

### How to run it (operator steps, after review)

There is no script or workflow for this yet. Writing one (a lease set and cleared like `scripts/test-history-cadence.mjs` does for `HISTORY_CADENCE_TEST_UNTIL`) is follow-up work.

1. Deploy this code with the normal manual Worker run, after telling the owner. Until a lease is set, the backfill does nothing.
2. Set the Worker setting `ARRIVAL_BACKFILL` (plain text) to `dry-run:<now + about 24 hours, in ms>`. Changing the Worker's settings restarts the Durable Object, the same as the cadence test.
3. Watch `/v1/collection` until `arrivalConfidence.backfill.state` is `done`. Read the counts. Checksum failures, unreadable objects or unavailable schedules should be zero or explained.
4. Set `ARRIVAL_BACKFILL` to `apply:<now + up to 48 hours, in ms>` and watch until `done`.
5. Remove the `ARRIVAL_BACKFILL` setting. `scripts/deploy-live-worker.mjs` refuses to deploy while an unknown setting is present, so clear it before any other Worker run.

## Rollout

1. Independent review (Codex: this is a Worker data pipeline and a new public endpoint).
2. Owner decision on the data terms question above.
3. Deploy only with the next manual Worker run after telling the owner. Live folds start on their own from the hot table.
4. Backfill after review, dry run first, as above.
5. The UI card is a separate pull request.

## Known limits

- Two trips with the same route, direction, stop, scheduled minute and day type on the same date count as one.
- A timetable change that moves a trip's time starts a new cell. Old cells stay until a later cleanup.
- Day type for a calendar that lists only dates (no weekdays) uses those dates: NJ Transit holidays mean Sunday-holiday, otherwise the most common day type.
- `possibleGaps` can count after a planned collection pause. It is a signal, not an error.
- The arrival time is the first official `stopped_at` sample, so it can be up to one poll (30 seconds) after the bus really arrived. `uncertainty.meanWindowSeconds` shows the typical gap.
- Only routes 163, 164, 165 and 165T are counted.

Code: `src/domain/arrivalConfidence.ts` (pure math), `worker/arrival-confidence.ts` (live fold and endpoint), `worker/arrival-backfill.ts` (backfill). Tests: `tests/unit/arrivalConfidence.test.ts`, `tests/unit/arrivalConfidenceWorker.test.ts`. All test data is synthetic.

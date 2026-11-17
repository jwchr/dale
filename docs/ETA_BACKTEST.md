# True ETA research: backtest plan (#102)

Owner go-ahead: Jeff, builder chat, 2026-11-17 ("Do number 2, number 3, number 5. Number 7."; number 3 was #102). Research only: nothing here changes what riders see.

## Goal

Before Dale shows any "smarter" arrival estimate, prove on held-out days that it beats the simple baselines. If it does not, riders keep the schedule and live NJ Transit data they see today.

## Step 1: tool (this change)

`src/domain/etaBacktest.ts`, pure and unit tested on synthetic data only:

- `observedArrivals(samples)`: observed stop arrivals come only from official samples whose explicit stop call says the bus is stopped at that stop. The first such sample is the arrival. The latest earlier sample of the same trip, not at that stop, bounds it from below (`notBefore`), so sampling uncertainty stays visible. A plain position never becomes an arrival.
- `backtest(samples)` scores three baselines on delay samples grouped by a caller-chosen key (for example route, stop, weekday or weekend, and hour):
  - `schedule`: predicts zero delay.
  - `rolling28`: median delay over the previous 28 days for the same key.
  - `allHistory`: median delay over all earlier days for the same key.
- **No leakage:** a prediction uses only service days strictly before the day it predicts.
- **Abstain:** history baselines abstain with fewer than 5 earlier samples.
- **Metrics:** count predicted and abstained, mean / median / 90th-percentile absolute error in seconds, and how often the observed delay fell inside the 10th-90th percentile range (target about 80%).

## Step 2: run on the private history (separate, risky change)

- Reading the private corridor archive (#91, R2 `dale-history`) is a data-pipeline change: independent review (Codex, or Argon if Codex is unavailable) before it runs.
- It runs in a manual GitHub Action with read-only access and prints only aggregate scores per key. No samples, vehicle IDs or raw archive data are printed, committed or published.
- Scheduled times come from the same schedule version (`feedVersion`) the samples were recorded under.

## Step 3: richer models, only if earned

Weather (NOAA/NWS, no key), incidents (511NJ) and peer buses come later. Each must beat `rolling28` on the same held-out days, segment by segment, before it is considered. No paid API and no new service.

## Honest limits

- The archive started in November 2026. Seasonal and year-to-year comparisons need more than one year.
- Stop-call coverage depends on what NJ Transit reports. Stops the feed never marks as "stopped at" cannot be scored and are counted as missing, never guessed.

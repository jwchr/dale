# Earlier buses today (#250), November 21, 2026

- Data path: existing paced collector → private history journal → bounded,
  transactional daily projection → read-only `/v1/earlier-buses` → bus picker
  and Bus Lock. No extra NJ Transit call, poll owner, R2 read or new archive writer.
- Preserve NJ Transit stop predictions alongside existing journal trip changes;
  keep the existing batch byte limit and quality-only overflow behavior.
- GPS means first official STOPPED_AT sample, not an exact arrival instant.
  Label it as a sample, not the exact instant of arrival.
  Keep predictions distinct from observations; missing evidence stays unknown.
- Only a trip with observed progress at or beyond the requested stop qualifies
  as passed. Absence from the live feed never means departure or cancellation.
- Use exact trip/service-date keys privately, Eastern calendar today, GTFS
  overnight/DST conversion, and the schedule context that produced the evidence.
- Public whitelist: route, direction, scheduled stop/Port Authority times,
  observed/predicted times, minutes late, source and source timestamp (age).
  No vehicle/trip identifiers, coordinates, rider data or raw journal access.
  The selected stop is agency infrastructure, never a rider's GPS location.
- This is an owner-requested exception to totals-only public history: no raw
  export is part of this bounded UI endpoint. The separate owner-only read
  door is documented in [OWNER_HISTORY.md](../OWNER_HISTORY.md).
- NJ Transit terms still apply: attribution and latency disclosure on every
  result, using D73's source/latency disclosures. The original archive stays
  private. The owner's #250 request supplies the bounded product scope; local
  implementation does not authorize a production activation.
- Default `EARLIER_BUSES` absent/off: endpoint 404 and projection disabled.
  Only `EARLIER_BUSES=public` enables it, at an owner-approved Worker deploy.
- Fold at most 24 journal batches per pass, every five minutes (catch-up every
  existing 30-second alarm), reserving spare writes without taking collection/archive headroom.
  Checkpoint and projection commit together; replay merges earliest GPS and
  newest predictions idempotently. Retry cannot double count or lose a fold.
- Projection: one SQLite row, maximum 1 MB and 2,000 exact trip instances;
  two Eastern calendar days, bounded current schedule context. Refuse overflow
  without advancing checkpoint; old context is never joined to a new schedule.
  Existing 450 MB headroom guard precedes writes; archives are untouched.
- Return last five qualifying departures only; one primary-key projection read,
  short client cache, bounded query and response. No new upstream requests;
  NJ Transit's 40,000/day ceiling remains under the existing collector budget.
- Cloudflare Free: retain documented collection limits (75,000 reserved SQL
  writes/day, 500 MB database guard, R2 9 GB/500k A/2m B rolling reservations).
  See HISTORY_COLLECTION.md for account-wide request/read/CPU/storage limits;
  fresh headroom must be verified at deploy, no automatic paid overflow.
- Activation can reconstruct only retained hot evidence (normally six hours).
  Show coverage start and unavailable states; never claim complete-day history
  or fetch archives on public demand. Continuous projection retains today's
  earlier trips after hot cleanup. Rollover coverage is explicit.
- UI: compact Household cards, every displayed earlier bus opens its own
  scheduled stop and Port Authority times, observed GPS sample or expected
  prediction, plus source/age. Exact actual time stays unknown where the feed
  supplies only a first-stopped sample. EN/ES, 12-hour clocks and native
  keyboard disclosures. The exported `EarlierBusDetails` takes one exact bus
  record and never touches the lock. #252's just-left/chase row is absent from
  this checkout; it must reuse this disclosure with its exact record, never
  match by route alone. That integration is not claimed as built here.
- Owner-only history door: secret absent means off, authorization checked at
  router and object, read-only paged corridor observations from retained hot
  batches and immutable archives. No rider records or upstream poll. See the
  single operational contract in OWNER_HISTORY.md; tests cover missing,
  wrong/right auth, whitelist, pagination, checksum and free-budget denial.
- Narrow layout correction: allow the earlier-bus panel's heading and every
  descendant to wrap, including Spanish at 305/320 px and 200% text. Do not
  clip overflow. Existing commute-notice assertions stay unchanged.
- Lock regression: compare saved identity, lock and rider actions while
  excluding only routine `officialFeed` metadata. The original whole-record
  equality assertion wrongly rejected a legitimate missing-feed status update.
- Verify synthetic domain/Worker tests, pinned-time EN/ES e2e and `npm run verify`.
  Leave uncommitted for Claude's PR and independent risky-change reviews;
  local verification is neither deploy approval nor production evidence.

Sources: [NJT terms](https://developer.njtransit.com/terms/),
[Cloudflare Free limits](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Activation also needs a reviewed change to the deployment binding allowlist
(`scripts/deploy-live-worker.mjs`); it currently rejects unknown variables.
This task leaves deployment configuration and existing production gates intact.

Follow-up validation, November 21:
- TypeScript and all 1,261 unit tests (89 files, including both real local
  Worker runtime suites) pass with writable Wrangler configuration/log/registry
  paths under /tmp and `VITEST_MAX_WORKERS=2`.
- Production test-app build and Worker dry-run bundle pass using in-worktree
  `.wrangler/check` as the output directory.
- Full `npm run verify` reaches worker:check, then the sandbox denies writing
  its configured `../.wrangler/check/README.md`. No script or assertion was
  weakened for this environment.
- Playwright attempts fail before test code: Chromium's macOS
  MachPortRendezvous registration is denied. Browser host is unavailable and
  native Chrome reports no controllable window. EN/ES phone and keyboard/a11y
  regressions are written/discovered but need the lead's outside-sandbox run
  and visual check. No E2E pass or deployment is claimed.

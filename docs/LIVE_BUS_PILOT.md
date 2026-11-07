# Live bus pilot (#89)

Owner D52 prioritizes connecting approved bus data to the tracker. Credentials succeeded for both approved bus APIs in #87 / PR #88 (manual run 42329610547, merged revision 4920e2c). Rail access remains pending. This slice is a provisional bus pilot, not completion of the 72-hour M0 investigation or real-ride acceptance.

## Rider path and honest fallback

After backend verification/activation, **Live buses · 163 / 164 / 165** opens the current G2 static schedule. The first visit requires selecting actual boarding/destination stops. Printed 165 favorites/locks remain separately available: G2 uses `.g2` suffixed favorite/lock keys, without rewriting existing stop IDs. The explicit source choice is remembered. Settings, language and other private notes keep their existing keys.

Lock one scheduled departure to poll its exact canonical trip/date, and the already-locked vehicle when present. Fresh official vehicle reports update the existing lock/history/map; explicit absolute stop-time predictions are separate from scheduled times. Nothing automatically chooses another departure or accepts a replacement vehicle. Missing service dates, unsupported trip relationships, ambiguous matches and stale feeds stay unknown. Official cancellations alone cancel a trip. A deleted/missing vehicle is not a cancellation.

On a checked feed gap or aged GPS, the existing source/age warning and **ESTIMATED POSITION ONLY** appear. The marker can advance from expected timetable times, without asserting arrival, passed stops or ahead/behind. A bus never observed and now overdue remains location-unknown rather than being animated past its waiting rider. Previously received observations keep their original timestamps. Recovery reuses the same lock and vehicle.

The waiting map reuses the existing self-hosted street map and lazy failure boundary; it never requests phone GPS. Route lines join published stops and are not exact road geometry. Known skipped stops pause automatic ride/get-off guidance and remain a warning for that trip; do not assume an omission or failed feed undid a reported change. Personal reports remain on the phone and are not shared by this service.

A validated G2 static schedule is saved separately for offline use, with its saved age. Live packets are not stored in that browser schedule cache. Live polling stops in hidden pages and aborts on lock/source teardown. An expired or incompatible schedule never causes a silent demo or trip replacement. Printed 165 backup and bundled guides remain reachable on first-use network failure.

## Server and limits

One Worker (`dale-live`) and one SQLite-backed Durable Object (`BusFeed`, singleton `corridor-v1`) on the existing **Free plan**. No account upgrade, domain change, paid service, cron, push, rider-report endpoint or 72-hour archive. Source contract: official NJ Transit GTFSG2 multipart POST endpoints. Vehicle positions and trip updates are the two real consumers of maintained MobilityData GTFS bindings; no custom binary parser.

The private object persists the token, pacing metadata and one bounded normalized corridor snapshot. It never archives raw feed bodies or a personal trace. Token reuse is capped at 20 hours (docs typically say 24 hours, subject to change); denied credentials impose a one-hour authentication cooldown. Snapshot data is discarded across static-feed versions while token/pacing state survives. Polling is on demand, globally serialized/coalesced, at most once per 30 seconds: up to 5,760 feed calls/day plus rare authentication across the G2 API, below the documented 40,000/day API budget even with multiple viewers. Free quotas fail closed; do not upgrade automatically.

Network requests use `redirect: manual` and reject every 3xx before reading the body, so credentials never follow a redirect. Cloudflare Workers does not support the standard `redirect: error` mode: it throws during Request construction before sending anything ([runtime Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/)). The local Worker fixture constructs the native Request from the actual outbound init before supplying its synthetic response, covering that compatibility boundary. Requests have deadlines through body read and cap each real-time response at 8 MiB.

A one-time persisted transport-version migration releases only the known legacy pre-network authentication `network-error` with no token. It preserves the global poll timestamp, existing tokens, genuine denials and failures from the fixed transport; the new version is saved before any retry. This avoids another hour of cooldown for an old request that could never leave the Worker, without resetting ongoing authentication failures. Each normalized feed is capped at 700,000 UTF-8 bytes before the single private state row is replaced. Vehicle timestamps, update timestamps and feed-generation timestamps remain distinct from receipt time. Only full feeds are supported initially; differential/incomplete/invalid feeds are unknown. Service dates and route/direction IDs must agree with current canonical static data. Unknown stop selectors or contradictory stop ID/sequence are not guessed. Times too large to render safely are rejected.

The public API exposes only health metadata, the normalized static corridor schedule, exact trip snapshots and aggregate freshness/matching status. No credential/token endpoint, arbitrary upstream URL, write/report path or rider location. Browser CORS is limited to `https://jwchr.github.io`; polling is server-paced even for non-browser callers. Request logging/observability and Wrangler telemetry are disabled. CORS is not treated as authentication. Fixed upstream destinations and redirect refusal prevent this becoming a credentialed proxy.

Official free hosting limits were checked: [SQLite Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Larger decode work runs inside the Durable Object; the edge router serves a pre-serialized schedule and delegates live requests. Validate the actual account's resource usage before claiming operational acceptance.

## Deployment and activation

Use [Cloudflare’s current granular Worker permissions](https://developers.cloudflare.com/workers/authorization/) for the deployment credential; a per-Worker Editor token can deploy an existing Worker.

The dashboard’s initial Hello World placeholder is recorded as `worker/provisioning-stub.mjs` for independent review. It has no NJ Transit secrets or requests; do not activate the app against it. The actual deployment replaces it and disables observability. This initial provisioning permits a token restricted to Dale rather than account-wide Workers access.

Only the manual **Deploy live bus pilot** workflow on reviewed/merged **main**. `NJT_API_USERNAME` / `NJT_API_PASSWORD` already exist in GitHub repository secrets. Deployment additionally requires owner-set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token should be short-lived and use Individual Workers Editor scoped only to the dedicated `dale-live` Worker, without DNS, billing or other Worker access. Provision the empty dedicated Worker through the owner-signed-in dashboard before creating the restricted token; a per-Worker token cannot create a new Worker. The owner must create/approve that credential. Public repository variable `DALE_WORKER_URL` holds the verified expected Workers URL. Do not put credentials in `VITE_` variables.

The workflow uses pinned official Actions, installs dependencies without secrets, and downloads G2 static data into runner memory. The existing tested GTFS builder preserves canonical trip IDs, splits express variants, retains original stop sequences and excludes non-ordinary pickup/drop-off points from suggested trips. Only the normalized corridor dataset is generated for the Worker; the raw ZIP is not an artifact or repository file. A synthetic local bundle can never be deployed through this workflow; the production entry rejects its version marker.

An ephemeral mode-0600 JSON file supplies only the NJ Transit secrets to Wrangler and is deleted afterward. Secret values, raw CLI errors and API bodies are not printed or uploaded. GitHub's deployment API token is not a Worker binding. The deployment verifies the generated feed version, current feed states and one fresh matched bus through the actual tracker endpoint before declaring readiness for activation. If no fresh bus matches, leave app activation off and investigate the exact mismatch privately.

After this passes, set public repository variable `DALE_LIVE_API_URL` to that same verified URL and rerun the current main CI/Pages run. Pages builds read that variable; test builds always use an intercepted synthetic endpoint. Verify the public app's actual report source/time/vehicle and feed-loss behavior separately before saying it is live. No raw recordings or credentials in review packets, tests, logs, public artifacts or git.

Rollback: clear `DALE_LIVE_API_URL`, rebuild Pages and stop invoking/delete only the dedicated `dale-live` Worker after explicit destructive-action approval if needed. Printed 165 data and private saved commutes remain. Do not touch other Workers or websites in the account.

## Validation and remaining acceptance

Synthetic protobuf decoding, private HTTP failure/timeout cases, token reuse and concurrency/pacing, feed-version isolation, strict trip/stop matching, pickup restrictions, real local Cloudflare/SQLite runtime, GPS loss/recovery, ambiguity, replacement confirmation, cancellation, skipped stops, offline cache, visible-page polling, phone layout and axe checks. Full `npm run verify`, exact-head CI and independent non-author review remain mandatory before push/merge.

Actual live deployment/report verification, sustained 72-hour data-quality evidence and the owner's real phone rides are separate acceptance steps. Gates, rail, service alerts, shared reports and background notifications are not connected by this pilot. A live bus position does not establish a guaranteed arrival or connection.

## Reuse and licenses

Reuses `lock`, `busLock`, `rideGuide`, schedule/calendar/time code, existing warnings, MapLibre/PMTiles and the existing GTFS parser/converter. The shared map error/lazy wrapper now has waiting and riding consumers. No custom protobuf, ETA model or fare inference.

- `gtfs-realtime-bindings` 2.2.0, maintained [MobilityData project](https://github.com/MobilityData/gtfs-realtime-bindings), Apache-2.0: actual vehicle-position and trip-update decoding; server-only.
- `protobufjs` 8.8.1 (BSD-3-Clause) and `long` 5.3.2 (Apache-2.0), pinned by the lockfile, runtime transitive dependencies; notices in `public/licenses.txt`.
- `wrangler` 4.158.0 (MIT OR Apache-2.0), development-only: local Worker/SQLite integration tests, bundle verification and deployment. No paid plan.

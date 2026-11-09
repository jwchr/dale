# Bounded rail capability check (#80)

Owner handoff [6723623618](https://github.com/jwchr/dale/issues/80#issuecomment-6723623618), renewed sole-builder claim6729634922 and existing operator custody PC-DALE80-CUSTODY-20261109-01 authorize this one-shot verification. Rail-specific entitlement is owner-reported, not yet authenticated. The app continues to show historical samples. This does not authorize current rail integration, continuous polling/collection, recorder changes, a new service, credentials or spending.

## Secure run, after independent review and merge

Use the existing `.github/workflows/bus-api-check.yml` workflow, now named **Transit API connection check**. Bus remains its default, with its original two authentication requests and two-minute limit. The existing independent release operator owns the one rail run, using the reviewed main ref and explicit inputs `scope=rail` and `rail_token_window_confirmed=true`. The operator first checks prior rail-run receipts and confirms no rail token check in the past24hours, no unresolved token/quota attempt and no competing run. If that cannot be established, do not assert the confirmation or dispatch. An interrupted/timed-out run may already have minted a token: inspect its receipt before considering any later attempt; do not retry blindly. The confirmation is an operator attestation, not an automated global account-usage proof.

Both official rail PDFs limit getToken/isValidToken to10 accesses/day and recommend once/day. This check requests at most one token for each product, never calls isValidToken and has no retries or alternate host. It must not be scheduled. Existing workflow concurrency is retained, with no cancellation of an active run. A later operator action is not authorized merely because the workflow exists.

Pinned checkout/setup actions, contents-read permission, exact workflow SHA checkout, main/repository/manual-event guards and existing `NJT_API_USERNAME`/`NJT_API_PASSWORD` secret injection remain. No npm install, GitHub token injection, local secret retrieval/copy, PR secret use, response artifact upload or VITE secret exists. The rail selection additionally requires the explicit confirmation; unknown scopes fail without a request. Only the separate operator dispatches reviewed main, never the author or PR branch.

## Verified official contracts and host

Read November8,2026:

- [Official developer portal documentation asset](https://developer.njtransit.com/registration/appDocumentation.js?v=1.0.5) identifies RailData and GTFS-RAIL, multipart username/password token requests and linked documentation.
- [RailData V2.1](https://developer.njtransit.com/registration/files/NJTRANSIT_RailData_API_V2_1.pdf) documents production `https://raildata.njtransit.com`, `/api/TrainData/getToken`, station list, next19departures and source fields. Its station appendix gives AS/Anderson Street, EX/Essex Street, TS/Secaucus Lower Lvl, SE/Secaucus Upper Lvl and NY/New York Penn Station. The line appendix identifies PV/Pascack Valley.
- [Rail GTFS/GTFSRT V1](https://developer.njtransit.com/registration/files/NJTRANSIT_Rail_GTFSRT_V1.pdf) documents the same production host and `/api/GTFSRT/getToken`.
- The production [Swagger index](https://raildata.njtransit.com/swagger/index.html) links its [RailData schema](https://raildata.njtransit.com/swagger/RailData/swagger.json) and [GTFS schema](https://raildata.njtransit.com/swagger/GTFS/swagger.json). Both were fetched successfully and agree on multipart token fields and Authenticated/UserToken response fields.

The newer portal examples instead use `raildata.njt.gov`. A public documentation GET there failed local DNS during inspection; this is not evidence of an agency-wide outage. The checker allowlists only the independently documented, schema-verified `raildata.njtransit.com` production host, with redirect:error. It never tries the failing hostname, development host, guessed endpoints or credential-bearing fallback redirects. Authentication has not been inferred from accessible public schemas.

## Hard request and data boundaries

Maximum8 sequential requests:

1. TrainData getToken, once.
2. GTFSRT getToken, once. This product is authentication-only here; its feed coverage stays unknown.
3. TrainData getStationList, only with its accepted token.
4. At most five getTrainSchedule19Rec queries, each only after the exact documented code/name pair is uniquely confirmed in that station list: AS, EX, TS, SE, NY. The household stations and Secaucus lower level request linePV; upper level/Penn use the documented empty-line option. Secaucus levels are not conflated; station names/codes are never guessed from a near match.

Each request and body read has a15second deadline. Authentication bodies are capped at16KiB, the station list256KiB and each station sample512KiB. Rail job limit is3minutes. Overflow, malformed JSON/schema, duplicate/mismatched station identities, redirects and unexpected API responses fail closed with a fixed status. Quota evidence (HTTP429 or the documented daily-limit response) stops further requests immediately. Access rejection does not retry; one independently approved product can succeed while the other is denied.

Tokens and agency rows exist only transiently in process memory; they are never returned, printed or stored. No full GTFS/RT feed, GPS coordinates, message text, train IDs, tracks, rider data or raw exceptions leave the checker. This is not an archive or a current timetable ingestion.

## Interpret the sanitized result

- `products`: fixed authentication outcome per product; accepted credentials are not proof of a usable feed or app integration.
- `stationCoverage` and per-station status: exact identity/schema confirmation, empty-at-check, station-not-listed, identity-unconfirmed, unexpected-schema or a bounded transport/API failure. Empty data does not establish no service or cancellation.
- `rows`/`pvlRows`: counts within this one next19 response, not full line/day/calendar coverage. Source TRAIN_ID and SCHED_DEP_DATE must be nonempty strings; this is field-shape confirmation, not validated travel dates or trip matching.
- `modifiedTimeFields`/`gpsTimeFields`: counts of source timestamp fields present. The documented strings do not establish timezone or freshness. `sourceTime=timezone-and-freshness-unverified` never converts receipt time into an agency timestamp or live prediction.
- `receivedAt`: this process's ISO receipt/check time, separate from all source fields. `gtfsFeed=not-requested-coverage-unknown` states the deliberately unrequested stage.
- Exit0 requires both products authenticated and all five exact station samples schema-confirmed or empty-at-check. An empty-at-check success is capability/schema evidence only. Other outcomes fail the workflow with sanitized evidence. No automatic reattempt follows failure.

A later current-service adapter still needs verified source timestamp/timezone semantics, canonical station/trip identities, full schedules/calendars/overrides, connection buffers and independent review. No sample is promoted to a current departure, bus/train ranking, platform or guaranteed connection by this check.

Synthetic-only security tests cover scope/dispatch guards, unchanged bus default, exact hosts/fields/request counts, denial flags, absent/ambiguous identity, empty/malformed schemas, quotas, oversized/stalled bodies, secret echoes and timer cleanup. Complete npm run verify, exact-head CI, independent HIGH review and separate reviewed-main merge precede the operator's one-shot run; real entitlement/coverage remains unverified until its actual receipt exists.

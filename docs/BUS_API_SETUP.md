# Approved bus API connection check

D51 / issue #87. Owner approval and encrypted credentials were confirmed November 6, 2026. This check answers whether the supplied API credentials are accepted. It does not connect live data to the rider-facing app.

## Run

After independent review and merge, open Actions → **Transit API connection check** (keep scope **bus**) → **Run workflow**, choosing **main**. The job and script both refuse other branches/events/repositories. Repository secrets are `NJT_API_USERNAME` and `NJT_API_PASSWORD`; never add a `VITE_` prefix, print their values or put them in the site build. GitHub secret values cannot be retrieved for local testing. The password may be the developer dashboard password, but the supplied documentation distinguishes API credentials without explicitly confirming they are the same. A successful API request is the test.

The job uses Node 22 with no npm install, a read-only GitHub token and pinned official checkout/setup actions. It makes at most two requests: one authentication request per approved bus API, with no retry, feed download, polling or archive. Each request/body read has a 15-second deadline; authentication bodies are capped at 16 KiB and discarded. Redirects are refused so credentials cannot follow a redirect to another host. No request/response body, credential, token or raw error text is printed or saved. Only API names and these fixed outcomes appear:

| Outcome | Meaning / next step |
| --- | --- |
| `authenticated` | NJ Transit explicitly accepted authentication and supplied a nonempty token. This does not establish feed freshness, trip matching or live app readiness. |
| `configuration-missing` | One or both encrypted repository secrets are missing/empty; the checker sends no requests. |
| `access-denied` | API rejected authentication or access (including HTTP 401/403). Confirm the API credentials and approval for that API; do not retry guesses. |
| `rate-limited` | HTTP 429. Stop and wait rather than minting more tokens. |
| `http-error` | Other unsuccessful HTTP response; no body logged. Check NJ Transit service availability. |
| `unexpected-response` | Missing/invalid success flag or token, invalid JSON, or oversized response. Inspect the current official contract privately before changing parsing. |
| `timed-out` | Authentication or body read exceeded 15 seconds. No automatic retry. |
| `network-error` | Connection, TLS, redirect or response-stream failure. No raw error logged. |

The workflow fails unless **both** approved bus APIs authenticate. Operational wording is English; these messages do not enter the bilingual rider UI. Synthetic fixtures alone are used in tests. No real NJ Transit credentials or recorded responses belong in test fixtures.

## Verified contract and reuse

Reuse Node's built-in fetch, FormData, AbortController, stream reader and test tooling already in Dale. No custom cryptography, token store, parser dependency, new service or paid plan. The official live Swagger schemas and the owner-supplied **BUSDATA Web API V1** / **BUS GTFS/GTFSRT Web API G2** documents agree on multipart `username` / `password` fields and `Authenticated` / `UserToken` response fields:

- [BUSDV2 official schema](https://pcsdata.njtransit.com/swagger/BUSDV2/swagger.json): `/api/BUSDV2/authenticateUser`.
- [GTFSG2 official schema](https://pcsdata.njtransit.com/swagger/GTFSG2/swagger.json): `/api/GTFSG2/authenticateUser`.

Both production requests go only to `https://pcsdata.njtransit.com`. Do not copy the PDFs' localhost examples. The documents describe tokens as typically valid for 24 hours, subject to change; future polling must reuse a token and refresh deliberately, not authenticate for every feed request. GTFS-RT describes running trips; future schedules still require static GTFS.

## Next boundary

Successful authentication enables the scoped M0 feed investigation and M2 validation. A private Worker must normalize verified live data, keep credentials server-side, match exact trips and show source/age/uncertainty before the app can use live predictions. Schedules remain labeled fallback and future planning. The default bus scope does not call any rail endpoint. Newer owner-reported rail approval and its separately gated one-shot verification are documented in `RAIL_API_CHECK.md`; neither approval nor public documentation proves entitlement. No 72-hour recording or storage is introduced by this check.

Rollback: stop running the manual workflow (or remove it); no schedule, saved commute or app behavior is changed by this slice.

# Dale live bus relay

Issue #89 / D52. Implementation and deployment procedure: `docs/LIVE_BUS_PILOT.md`.

One free-plan Worker and one private SQLite-backed Durable Object. Canonical G2 schedule, paced/coalesced requests, token reuse and strict trip/date matching. #91 collection defaults off. The approved private `dale-history` R2 binding retains immutable lossless originals/context; data+manifest checksum/readback receipts are required before six-hour hot cleanup. Free-budget pauses preserve unarchived evidence; no R2 delete/expiration or automatic paid upgrade. No raw systemwide archive, rider tracking, rail polling or automatic deployment. Credentials remain owner-set secrets. Code/local tests are not production activation. See `docs/HISTORY_COLLECTION.md`.

`npm run worker:check` makes a synthetic fixture and verifies the bundle without deployment. The unit suite also exercises the real local Cloudflare/SQLite runtime with an entirely synthetic upstream. Production rejects the synthetic feed version. The manual reviewed-main workflow must prepare the official G2 feed before it can deploy.

## Stop alerts while the phone is locked (#176 step C)

Design: `docs/LOCKED_STOP_ALERTS.md`. Code: `ride-alerts.ts` (rules, ride table, routes, per-alarm check) and `web-push.ts` (payload-less VAPID push, WebCrypto only). Routes, all JSON and `no-store`; POST and DELETE require Dale's Origin:

- `GET /v1/ride-alerts/config`: availability and the VAPID public key derived from the private key.
- `POST /v1/ride-alerts`: register a pending ride (household code, push endpoint on a known push service, trip, date, vehicle, stop indexes, language). At most 20 rides; one per push subscription.
- `POST /v1/ride-alerts/:id/activate`, `GET /v1/ride-alerts/:id/latest`, `POST /v1/ride-alerts/:id/ack`, `POST /v1/ride-alerts/:id/notice-ack`, `DELETE /v1/ride-alerts/:id?reason=got_off|unlocked`.

Owner-set secrets, by name only: `VAPID_PRIVATE_KEY` (P-256 private JWK) and `HOUSEHOLD_CODE_HASH` (SHA-256 hex of the normalized household code). Without both, every ride route answers 503 and config says not available. Rides live in the same SQLite object; health shows only the count of active rides. With history collection off, an alarm runs only while a ride is active or pending, polls no faster than the shared 30-second pace and stops when no ride remains; with collection on, rides use the collector's own polls.

Actual live readiness and real-ride acceptance must be checked separately from compilation, tests and merging. See issue #89's deployment evidence for current status.

# Dale live bus relay

Issue #89 / D52. Implementation and deployment procedure: `docs/LIVE_BUS_PILOT.md`.

One free-plan Worker and one private SQLite-backed Durable Object. Canonical G2 schedule, paced/coalesced requests, token reuse and strict trip/date matching. #91 collection defaults off. The approved private `dale-history` R2 binding retains immutable lossless originals/context; data+manifest checksum/readback receipts are required before six-hour hot cleanup. Free-budget pauses preserve unarchived evidence; no R2 delete/expiration or automatic paid upgrade. No raw systemwide archive, rider tracking, rail polling or automatic deployment. Credentials remain owner-set secrets. Code/local tests are not production activation. See `docs/HISTORY_COLLECTION.md`.

`npm run worker:check` makes a synthetic fixture and verifies the bundle without deployment. The unit suite also exercises the real local Cloudflare/SQLite runtime with an entirely synthetic upstream. Production rejects the synthetic feed version. The manual reviewed-main workflow must prepare the official G2 feed before it can deploy.

Actual live readiness and real-ride acceptance must be checked separately from compilation, tests and merging. See issue #89's deployment evidence for current status.

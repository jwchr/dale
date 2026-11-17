# Stop alerts while the phone is locked (#176 step C): design

Status: design for independent review. No code exists. Steps A and B (chime, spoken line and phone notification while Dale is open) are live since #177. This step lets the same 3, 2 and 1 stop alerts reach a rider whose phone is locked or whose browser is in the background. First draft: #176 comment 6936433085. Revised after Codex and CodeRabbit review on #188.

## What it never does

- It never sends the rider's location anywhere. Dale watches the locked bus, not the rider.
- It never claims the stop is near unless the server checked a fresh position of the locked bus. When it cannot check, it says so (CLAUDE.md: unknown is a valid answer).
- It never alerts from a stale, ambiguous or unmatched bus position, or while NJ Transit reports skipped stops on the trip. The rules are the same as on screen (`src/domain/rideGuide.ts`, `src/domain/stopAlert.ts`, and the skipped-stop check in `src/ui/RideMode.tsx`).
- It never switches buses. Alerts follow only the exact trip instance, service date and vehicle the rider locked (`src/domain/lock.ts`).
- It never keeps a ride after the ride ends, and never archives or logs one.

## Consent

- A new setting, separate from today's "Phone notification": "Alerts when my phone is locked", off by default. Turning it on explains, in English and Spanish, that while a bus is locked Dale's server keeps a short-lived ride record (trip, stops, language and a push address from the browser) and deletes it when the ride ends; then it asks for notification permission and a push subscription.
- Riders who already turned on "Phone notification" keep today's while-open alerts only. Nothing is sent to the server until they turn on the new setting themselves.
- It also needs the household code (the same code as `docs/RIDER_GPS.md`, entered or scanned once per phone).

## Flow

1. **Register a ride.** When the rider taps "I boarded" on a locked bus with the new setting on, the app first drops any earlier push subscription and creates a fresh one, so every ride has its own push address and a push still queued for an old ride can never be delivered. It then sends one `POST /v1/ride-alerts` with: the household code, the push subscription, trip instance, service date, locked vehicle, the boarding stop index, the alighting stop index, and the language. The server answers with a new ride id: 128 random bits from a cryptographic source. Before the ride counts as registered, the app writes a small record the service worker can read (IndexedDB, origin-private): ride id, push endpoint, language, and the highest stage shown so far. If that write fails, the app deletes the ride on the server at once and keeps steps A and B only. The record is replaced by the next ride and deleted when the ride ends.
2. **Admission checks, all in the single `BusFeed` Durable Object** (one instance, so counts live in its SQLite storage and survive restarts):
   - the household code is valid (constant-time comparison against the hash stored as a Worker secret); without it nothing is stored, so outsiders cannot use up ride slots;
   - the trip instance is active today in the schedule, and the boarding and alighting indexes are on that trip in that order;
   - the push endpoint is HTTPS on a known browser push service host (Google, Mozilla, Apple, Microsoft), so the Worker can never be pointed at an arbitrary address;
   - one active ride per push subscription (a new ride for the same subscription replaces the old one) and at most 20 in total. Because only household phones hold the code, the household cannot be crowded out by strangers.
3. **Store.** One row per active ride: id, subscription, trip, date, vehicle, boarding index, alighting index, language, last stage shown, service-change flag, service-change notice state (none, pending or sent), last push time and expiry. Expiry is the trip's scheduled arrival at the alighting stop plus 30 minutes, never more than 3 hours after creation. The last stage shown starts as "riding" (rank 0) rather than empty: `stopAlertStep` treats an empty previous stage as a silent baseline, so starting at "riding" means a ride registered when the bus is already 3 stops away or closer still gets one alert for the current stage on the next check.
4. **Watch.** In its existing alarm loop, after fresh vehicle positions and trip updates arrive, the Durable Object checks each active ride with no extra NJ Transit requests:
   - If NJ Transit's trip update lists skipped stops on that trip, the ride's service-change flag is set and kept (in storage, so it survives restarts) for the rest of the ride. While it is set, no stop countdown is sent, the same as on screen. The notice state becomes pending, and one push announces it; like stages, the notice is recorded as sent only after the push service answers 201, and a pending notice is retried on the next alarm, including after a restart.
   - Otherwise it runs `rideGuide` with the ride's boarding and alighting indexes and the latest position, then `stopAlertStep` with the last stage shown.
5. **Send, then record.** When the stage moves forward into 3 stops, 2 stops, 1 stop, last-stop-next or "ask now", the Durable Object sends a web push with a short `TTL` (60 seconds) and a `Topic` set to the ride id, so the push service drops an undelivered push after a minute and replaces an older undelivered push for the same ride with the newer one. Only after the push service answers 201 does it record the stage as shown.
   - A push that definitely failed (network error, 5xx, 429) leaves the stage unrecorded; the next alarm retries while that stage is still current.
   - A push that was accepted but whose answer was lost is retried too, so a rider can receive the same stage twice. The service worker removes that duplicate (step 7). The guarantee is at least once per stage while the stage is current, never a stage the bus has moved past.
6. **Payload-less push.** The push carries no data, so it needs only a VAPID-signed request (RFC 8292), not message encryption.
7. **Check on arrival.** A push carries no data and the browser does not show the service worker its `Topic`, so the `push` handler reads the ride record from step 1, confirms its endpoint matches the browser's current push subscription, and fetches `GET /v1/ride-alerts/:id/latest` (`Cache-Control: no-store`). With no matching record it shows the silent "Your Dale stop alert has ended." and asks the server to delete the ride. The server recomputes the answer at that moment rather than replaying a stored line:
   - **active and fresh:** the ride's current stage, the line to show and the age of the bus position it came from (under 2 minutes). The handler compares the stage with the highest stage shown, stored in the ride record (not the notifications on screen, which the rider may have dismissed). A new, higher stage is shown with sound and saved to the record; a repeated or lower stage replaces the notification silently, so a duplicate push never buzzes twice, even after a dismissal or a service-worker restart. Because the line is the current stage, a delayed earlier push shows the newer stage instead of an out-of-date one.
   - **service change** (NJ Transit reports skipped stops on this trip): "Stops on this trip changed. Open Dale."
   - **active but not checkable** (no fresh position or ambiguous): "Dale can't check your bus right now. Open Dale." Never a claim that the stop is near.
   - **ended** (the server answers 410 with a reason: unlocked, got off, arrived, passed or expired): browsers require a visible notification for each push, so the handler shows a silent "Your Dale stop alert has ended."
   - **fetch failed** (offline, timeout, server error): "Dale can't check your bus right now. Open Dale." in the ride's language. Not the stop line, because nothing was checked.
8. **End.** When the rider taps "I got off", unlocks, or turns the setting off, the phone first drops its push subscription, so no further alert can reach it even if the server never hears about it, then deletes its ride record and sends `DELETE /v1/ride-alerts/:id`. If that request fails (offline), the delete is saved on the phone and retried whenever Dale opens or the network returns; meanwhile the setting shows as off with "Removing your ride from Dale's server...". The row is deleted on that `DELETE`, at expiry, when the stage reaches arrived or passed, or when the push service answers 404 or 410 (which it does for a dropped subscription, so an unacknowledged delete still ends at the next push attempt). A short tombstone (id and reason, no subscription) is kept until expiry so `latest` can answer "ended" in step 7.

## Owner step

- VAPID needs a P-256 key pair. The builder generates it outside the repository and never commits or prints the private key.
- Jeff stores the private key as a Cloudflare secret, `VAPID_PRIVATE_KEY`, with step-by-step help. The public key is not secret and ships in the app.
- The household code's hash is the same Worker secret planned in `docs/RIDER_GPS.md`.
- If either secret is missing, the route answers "not available" and the app keeps steps A and B only.

## Privacy and limits

- A push endpoint is a capability URL. It is stored only for the life of one ride, is never logged, archived or shown in health output, and is deleted when the ride ends.
- If a delete cannot reach the server, the ride row (trip, stop indexes and a push address that no longer works) can stay until the next push attempt or its expiry, at most 3 hours after creation. The setting's explanation says so.
- The boarding and alighting stop indexes are stored for the life of the ride only, because the server needs them to count stops; they are never archived. This is why the setting has its own consent.
- Writes per ride: one create, one delete and at most six stage updates, well inside the Free plan's Durable Object limits.
- No new vendor and nothing paid: browser push services are free and are reached only through the subscription the rider's own browser created.

## Honest limits, shown in the app

- Alerts depend on live bus GPS reaching the Worker. When the bus stops reporting, no countdown is sent, the same as on screen; the app says so beside the setting.
- A push the phone does not receive within 60 seconds is dropped by design, so a rider with no signal may miss a stage rather than get it late.
- iPhone needs Dale added to the Home Screen (iOS 16.4 or later). The push service, not Dale, decides how fast a notification arrives.
- Like all of Dale's live data, alerts share the Worker's free daily request allowance (see `docs/RIDER_GPS.md`, "Remaining risk Jeff should know about").

## Tests before release (planned; none written yet)

- Unit: the server's stage decision matches the app's for the same positions, including stale, ambiguous, off-route and skipped-stop cases, and the service-change flag surviving a restart; a ride registered inside 3 stops alerts once; send-then-record with a failed push, a lost answer (duplicate) and a restart; the household code, endpoint host allow list and caps; expiry, tombstones and 404/410 deletion.
- Unit: a service-change notice whose push fails, then a restart, then a retry that sends it once.
- Browser: the service worker's cases in step 7 (fresh, service change, not checkable, ended, fetch failed, no matching record); a duplicate after the rider dismissed the first notification stays silent; a push for a replaced ride is never shown; an offline opt-out is retried later. In English and Spanish.
- Household on-road test on an Android phone and an iPhone before the feature is described as working.

## Gates

- Risky change (secrets, live server, rider data): Codex review (Argon if Codex is unavailable), plus CodeRabbit.
- Jeff is told before the Worker deploy; the release uses `preserve-enabled`, keeping history collection unchanged.
- Jeff stores `VAPID_PRIVATE_KEY` and the household code hash himself; no secret passes through chat or the repository.

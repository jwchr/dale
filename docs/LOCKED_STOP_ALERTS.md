# Stop alerts while the phone is locked (#176 step C): design

Status: design for independent review. No code exists. Steps A and B (chime, spoken line and phone notification while Dale is open) are live since #177. This step lets the same 3, 2 and 1 stop alerts reach a rider whose phone is locked or whose browser is in the background. First draft: #176 comment 6936433085.

## What it never does

- It never sends the rider's location anywhere. Dale watches the locked bus, not the rider.
- It never alerts from a stale, ambiguous or unmatched bus position. The rules are the same as on screen (`src/domain/rideGuide.ts`, `src/domain/stopAlert.ts`).
- It never switches buses. Alerts follow only the exact trip instance, service date and vehicle the rider locked (`src/domain/lock.ts`).
- It never keeps a ride after the ride ends, and never archives or logs one.

## Flow

1. **Opt in.** The existing "Phone notification" setting (off by default) gains a line, in English and Spanish, saying that while a bus is locked Dale's server will send the alerts even with the phone locked, and what that stores. Turning it on asks the browser for notification permission and a push subscription.
2. **Register a ride.** When the rider taps "I boarded" on a locked bus with that setting on, the app sends one `POST /v1/ride-alerts` with: the push subscription, trip instance, service date, locked vehicle, the alighting stop index, and the language. The server answers with a new ride id: 128 random bits from a cryptographic source, which is the only handle to the ride.
3. **Server checks before storing:**
   - the trip instance is active today in the schedule and the alighting stop index is on that trip after the current position;
   - the push endpoint is HTTPS on a known browser push service host (Google, Mozilla, Apple, Microsoft), so the Worker can never be pointed at an arbitrary address;
   - at most 20 active rides in total; a new ride for the same subscription replaces the old one;
   - at most 10 ride creations per hour per network address (kept in memory only).
4. **Store.** The `BusFeed` Durable Object keeps one SQLite row per active ride: id, subscription, trip, date, vehicle, alighting index, language, highest stage alerted, last push time and expiry. Expiry is the trip's scheduled arrival at the alighting stop plus 30 minutes, never more than 3 hours after creation.
5. **Watch.** In its existing alarm loop, after fresh vehicle positions arrive, the Durable Object runs the same `rideGuide` and `stopAlertStep` rules as the app for each active ride. It makes no extra NJ Transit requests.
6. **Alert.** When the stage moves forward into 3 stops, 2 stops, 1 stop, last-stop-next or "ask now", the Durable Object first records the new stage in the row, then sends a web push. Recording first means a retry or restart never sends the same stage twice.
7. **Payload-less push.** The push carries no data, so it needs only a VAPID-signed request (RFC 8292), not message encryption. The service worker's `push` handler fetches `GET /v1/ride-alerts/:id/latest` and shows that line, in the ride's language. If the fetch fails, it shows "Your stop is coming up. Open Dale." in that language. `latest` answers only for an active ride id and sends `Cache-Control: no-store`.
8. **End.** The row is deleted on `DELETE /v1/ride-alerts/:id` (the rider taps "I got off", unlocks, or turns the setting off), at expiry, when the stage reaches arrived or passed, or when the push service answers 404 or 410.

## Owner step

- VAPID needs a P-256 key pair. The builder generates it outside the repository and never commits or prints the private key.
- Jeff stores the private key as a Cloudflare secret, `VAPID_PRIVATE_KEY`, with step-by-step help. The public key is not secret and ships in the app.
- If the secret is missing, the route answers "not available" and the app keeps steps A and B only.

## Privacy and limits

- A push endpoint is a capability URL. It is stored only for the life of one ride, is never logged, archived or shown in health output, and is deleted when the ride ends.
- Writes per ride: one create, one delete and at most five stage updates, well inside the Free plan's Durable Object limits.
- No new vendor and nothing paid: browser push services are free and are reached only through the subscription the rider's own browser created.

## Honest limits, shown in the app

- Alerts depend on live bus GPS reaching the Worker. When the bus stops reporting, nothing is sent, the same as on screen; the app says so beside the setting.
- iPhone needs Dale added to the Home Screen (iOS 16.4 or later). The push service, not Dale, decides how fast a notification arrives.
- Like all of Dale's live data, alerts share the Worker's free daily request allowance (see `docs/RIDER_GPS.md`, "Remaining risk").

## Tests before release

- Unit: the server's stage decision matches the app's for the same positions, including stale, ambiguous, skipped-stop and off-route cases; a stage is never pushed twice after a retry; expiry and 404/410 deletion; endpoint host allow list; the caps.
- Browser: the service worker shows the fetched line, and the generic line when the fetch fails, in English and Spanish.
- Household on-road test on an Android phone and an iPhone before the feature is described as working.

## Gates

- Risky change (secrets, live server, rider data): Codex review (Argon if Codex is unavailable), plus CodeRabbit.
- Jeff is told before the Worker deploy; the release uses `preserve-enabled`, keeping history collection unchanged.
- Jeff stores `VAPID_PRIVATE_KEY` himself; no secret passes through chat or the repository.

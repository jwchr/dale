# Rider-shared bus position (#105): design and threat model

Status: **design for the owner's OK. No code exists.** Owner go-ahead to design it: Jeff, builder chat, 2026-11-17, about 5:45 AM ET ("Do number 2, number 3, number 5. Number 7."; number 5 was this issue). **Decision 1 answered (Nov 17, #105 comment 6961792866): any Dale rider, opt-in, off by default, turned on in Settings with a consent pop-up.** This revision replaces the household code with the abuse limits and public privacy notice that choice needs. Building still needs his answers to the remaining decisions at the end, route distance part 2, an independent review (risky: personal data and Worker), and his heads-up before any live server update.

## The problem

Sometimes NJ Transit's GPS for a bus stops reporting. Today Dale then shows "not reporting" with the last known position and its age, and falls back to the schedule. That is honest, but it leaves the rider waiting downstream with no idea where the bus is.

If a Dale rider is already on that exact bus, their phone knows where the bus is. This feature lets that phone share its position, briefly and anonymously, so the waiting rider sees "Rider-reported position, 40 seconds ago" instead of nothing.

## What it never does

- It never replaces or overrides fresh NJ Transit GPS. Official data always wins.
- It never marks a bus as arrived at a stop, cancelled or on a new trip.
- It never feeds the history archive (#91) or the arrival statistics. One phone's claim is not a measured arrival.
- It never shows who shared the position or where they got on, and it is built not to show where they got off; the one known exception (getting off and moving on along the route at vehicle speed) is under "Remaining risk" below.
- It never runs in the background on its own. A web app can share location only while Dale is open on screen; true locked-phone sharing needs the native app study (#104).

## Flow

1. **Opt in.** Settings gets "Share my bus's position when its GPS drops", off by default. Turning it on explains, in English and Spanish, exactly what is sent and for how long, then asks for location permission.
2. **Confirm the bus.** Sharing is possible only while the rider has Bus Lock on a specific trip and has tapped "I boarded". That is the exact-trip identity the app already uses (#30, #89).
3. **Share only when needed.** While riding, the phone checks the live snapshot it already polls. Only when that trip's official GPS is missing or older than 2 minutes does the phone send its own position, at most once every 30 seconds.
4. **What is sent:** trip instance, service date, latitude and longitude rounded to about 10 meters, the phone's accuracy estimate, and the reading time. Nothing else: no account, name, device ID or path history.
5. **Server checks before accepting a report:**
   - the trip is active today in the schedule;
   - the point lies within 150 meters of that trip's route shape. Route geometry is currently off (#154, D68), so this check depends on route distance part 2; until then the design is blocked, rather than falling back to straight lines between stops, which do not follow streets;
   - accuracy is 100 meters or better;
   - the reading is under 150 seconds old (the phone holds each reading for up to 2 minutes, see step 6);
   - the implied speed from the previous report is under 110 km/h;
   - the report carries a valid ride pass for this trip (see "Abuse limits" below), and the per-trip and per-address limits are not exceeded;
   - official GPS for that trip is not fresh at the moment of the write. The trip's Durable Object handles one request at a time, so this check and the store happen together: a report that arrives after official GPS has returned is rejected, never stored.
   Anything else is dropped silently.
6. **Privacy at the rider's own stops:** the phone knows the rider's boarding stop (the locked departure's stop) and getting-off stop (the saved trip's destination). It sends nothing while the bus could be within 2 stops or 400 meters of either one. The 400 m check counts the reading's accuracy against the rider: the bus is treated as inside the zone whenever the distance to the stop minus the reported accuracy radius is under 400 m (a reading 450 m away with 100 m accuracy is inside), and a reading with no accuracy value is never sent. **Getting off somewhere unplanned:** a rider may leave the bus before the saved stop, so the phone also holds every reading back and sends it only once later readings show the phone kept moving like the bus well past that point. That check needs all three of: (a) the phone has gone at least another 400 m along the trip's route shape, counted conservatively as the progress between the two readings minus both of their accuracy radii (raw positions 400 m apart with 50 m accuracy each count as only 300 m, so the reading stays held); (b) it covered that distance at vehicle speed, within 60 seconds (an average of at least 24 km/h after the accuracy deduction), which a rider who got off and walked or ran along the street cannot sustain; and (c) every reading in between stayed within 150 m of the route. A rider who gets off and walks, runs, or stops, therefore never sends the last 400 m before that stop, and nothing after it (one exception, moving on along the route at vehicle speed, is under "Remaining risk"): once the phone moves more than 150 m from the route, the held readings are dropped, and a reading not cleared this way within 2 minutes (a bus stuck in traffic, or a rider who got off) is dropped too. Tapping "I got off", ending Bus Lock or closing Dale also drops them and ends sharing. The cost is a delay: a report usually reaches waiting riders about a minute late (at most 2 minutes), and its age says so. So a report does not reveal where that rider gets on or off, apart from that one exception. The rider's stops are never sent to the server (sending them would expose exactly what this rule protects), so the phone is the one place this is enforced, and a unit test covers it.
7. **What other riders see:** on the waiting rider's screen, a hollow marker labeled "Rider-reported position" with its age and "may be off by about N m". It disappears 3 minutes after the last report reached the server, or as soon as official GPS returns.

## Data stored

- Only the latest accepted report per trip, held in Durable Object **memory only**: never written to storage, so it uses none of the Free plan's storage writes and is gone if the object restarts.
- It is deleted 3 minutes after the server accepts it, when official GPS returns, or at the trip's scheduled end plus 30 minutes, whichever comes first. While official GPS is fresh, new reports for that trip are rejected (see the write check above), so a deleted report cannot be replaced by a late one.
- **Reading reports needs no code** (any Dale rider can see them), but only for one trip at a time: a separate route takes a trip instance and answers with `Cache-Control: no-store`. Reports never appear in the public live snapshot or its cached response, which stays free of rider locations as `docs/LIVE_BUS_PILOT.md` requires, and there is no route that lists all reports.

## Abuse limits (any rider)

Without accounts (none in V1) nobody can prove they are really on the bus, so the design limits what a false report can do instead of trying to stop every one.

- **Ride pass.** Tapping "I boarded" with sharing on asks the Worker for a pass for that trip: a random value signed by the Worker (HMAC with a Worker secret), naming the trip instance and service date and expiring at the trip's scheduled end plus 30 minutes. It identifies no person or device and is forgotten when the ride ends. Every report must carry a pass for the same trip; the speed check compares a report only with the previous accepted one under the same pass, so the server keeps, per pass, its last accepted position and time in memory only. That per-pass record is deleted when the pass expires, when its ride ends ("I got off", Bus Lock ended), when official GPS returns for the trip, or 3 minutes after the pass's last accepted report, whichever comes first.
- **Limits, all kept in memory only:** at most 3 passes per trip per network address per hour; at most 2 reports per minute per pass; at most 10 accepted reports per trip per minute; at most 20 trips holding a report at once, and at most 3 of them from one network address; at most 120 trip reads per minute per network address (a phone viewing one trip reads it every 30 seconds, 2 reads a minute, so one shared address such as a carrier's or a bus's Wi-Fi covers about 60 viewing phones). When all 20 are held, a report for a 21st trip is refused (nothing already shown is replaced). A trip's slot frees when its report is deleted: 3 minutes after the last accepted report, when official GPS returns, or at the trip's scheduled end plus 30 minutes. A network address is kept in memory for at most 1 hour for these counts, never stored, logged or archived; a shared address (public Wi-Fi, a carrier's) may hit a limit. A sharing phone then shows "not shared right now"; a viewing phone over the read limit shows "Rider reports can't be checked right now" and keeps showing the official GPS state and schedule, never a stale report.
- **Disagreement.** If two passes report positions for the same trip more than 300 m apart (after both accuracy radii) within 1 minute, both are dropped and waiting riders see "Rider reports disagree" for that trip until a consistent report arrives or official GPS returns.
- **What a false report can do:** place the hollow "Rider-reported position" marker within 150 m of that trip's real route, with its age and uncertainty shown, only while official GPS for that trip is missing. One report lasts 3 minutes, but a pass holder who keeps sending plausible false reports can keep the marker up for as long as that trip's official GPS stays missing, at most until the trip's scheduled end plus 30 minutes, when the pass expires (listed under "Remaining risk"). It cannot change the schedule, any ETA, an exact-bus lock, an arrival, a cancellation, the history archive or any other trip.
- **Optional human check (decision 4):** Cloudflare Turnstile, which Cloudflare documents as free with unlimited challenges, could guard the ride-pass request so a script cannot mint passes. It needs a new free Turnstile key pair (a public site key and a secret the owner stores) and loads a Cloudflare script in the app; CLAUDE.md's "no new API keys" rule makes it Jeff's call.
- **Health output** shows only counts (passes issued, reports accepted and dropped by reason, limit hits), never positions, passes or addresses. A sudden rise is the owner's warning sign; the owner can turn the feature off with one Worker setting.

## Public privacy notice (English and Spanish)

Shown in the consent pop-up before sharing turns on, and in Settings, Data source, in both languages:

- **What is sent:** while you ride a locked bus whose NJ Transit GPS has stopped, your phone's position (rounded to about 10 m) with its accuracy and time, at most every 30 seconds, plus a random ride pass that does not identify you or your phone.
- **When it is not sent:** never near the stops where you get on or off, never when NJ Transit's GPS is working, never while Dale is closed, and not after you get off, with one exception: if you get off and, within 2 minutes and with Dale still open, travel on along the bus route in a car, on a bicycle or scooter, or at a full sprint, your phone cannot tell that from the bus and may keep sharing that position. Tapping "I got off" stops sharing at once.
- **Who sees it:** anyone using Dale who is looking at that same trip, as "Rider-reported position" with its age. Not your name, not your stops. Because anyone can read it, a person or program could also save a copy; Dale cannot prevent that.
- **How long Dale keeps it:** the latest report for each trip, in the server's memory only, for at most 3 minutes; and, to check that your next report is plausible, your own last accepted position under your ride pass, also in memory only, deleted when you tap "I got off", end Bus Lock, NJ Transit's GPS returns, or 3 minutes after your last report, whichever comes first (if you get off without tapping, it stays until that 3-minute limit). It is never saved, archived or used for statistics. Your network address is used only to limit abuse and is forgotten within 1 hour.
- **How to stop:** turn the setting off, tap "I got off", end Bus Lock or close Dale.
- Dale is an independent app, not NJ Transit. The notice names who runs it and how to reach them (decision 5).

## Threats and answers

| Threat | Answer |
| --- | --- |
| Someone posts false positions | Ride pass per trip, per-address and per-trip limits, disagreement rule, optional Turnstile; route-shape, speed and age checks limit where a false position can lie; it shows only while official GPS is missing, at most until the trip's scheduled end plus 30 minutes if refreshed, and changes nothing else (see "What a false report can do") |
| Someone collects every rider's reports | No list route; one trip per request; at most 120 trip reads per minute per network address (memory only) and the front-door gate on reads; no rider identity, pass or stop is ever returned. Trip identifiers are public (`/v1/schedule`), so a patient script can still poll trips and keep what it reads for as long as it likes; Dale's 3-minute memory-only retention covers Dale's copy only. Listed under "Remaining risk" and stated in the privacy notice |
| A rider's home or routine is exposed | Reports are only sent while riding a locked bus, never within 2 stops or 400 m of the rider's own boarding or getting-off stop (enforced on the phone; those stops are never sent), never in the public snapshot, and deleted within minutes. The 400 m check subtracts the reading's accuracy radius. Readings are held until later readings show the phone went another 400 m along the route at bus speed (after subtracting both readings' accuracy), so getting off at an unplanned stop and walking or running away reveals nothing either; moving on along the route at vehicle speed is the remaining risk below. Planned unit tests (not written yet; this is a design) check that the phone sends nothing inside either zone (including a reading 450 m from a stop with 100 m accuracy) and nothing within 400 m before, or anywhere after, an unplanned stop where the rider leaves, including when the rider walks on along the route and when two readings 400 m apart each have 50 m accuracy, and record the car case's known behavior |
| Rider confused about whether it is official | A different marker and label in both languages; official GPS always replaces it |
| Battery drain | Sharing only while the official GPS is missing, with Dale open, every 30 seconds at most |
| Cloudflare Free plan or NJ Transit limits | No extra NJ Transit requests; at most 2 writes per minute per sharing phone |
| Wrong bus (rider got on a different bus) | Same exact-trip lock and "I boarded" step; a report that strays from the route shape is dropped |

## Remaining risk Jeff should know about

- **Leaving the bus and riding on in a car, on a bicycle or scooter, or at a sprint along the same route.** The release check needs 400 m along the route within 60 seconds, which rules out walking and ordinary running but not other vehicles or an exceptional sprinter. If a rider gets off and, with Dale still open and sharing on, keeps moving along the bus route that fast, the phone cannot tell that apart from still being on the bus. It would keep sharing that vehicle's position as the bus, which would reveal roughly where the rider got off (to within the last few hundred meters) and show a wrong bus position. Limits: reports last 3 minutes, sharing stops when official GPS returns, when the rider taps "I got off", ends Bus Lock or closes Dale, and when the trip's scheduled end passes. Planned unit tests will record this behavior so it is known, not hidden. Jeff's privacy decision and an independent review come before any building.
- **A sustained false marker.** Someone who obtains a pass for a trip whose official GPS is down can keep refreshing a plausible false position along the route until official GPS returns or the pass expires (the trip's scheduled end plus 30 minutes). Waiting riders would see a labeled rider-reported marker in the wrong place for that long. The disagreement rule hides it only if a real rider on that bus is also sharing.
- **Someone keeps copies of public reports.** Reading needs no code, and trip identifiers are in the public schedule, so a script can poll trip after trip (slowed by the per-address read limit) and store every report it sees, building a record of where riders' buses were when their GPS was down. Each report still shows no rider identity and none of the rider's stops, and readings near those stops are never sent, apart from the riding-on exception above. The privacy notice says so plainly.
- **Someone floods Dale's server.** The Worker runs on Cloudflare's Free plan, whose daily request allowance is shared by everything Dale does. No protection at the front door has been verified, so an outsider sending a flood of requests could use the allowance up and stop Dale's live data, rider reports included, until the daily reset, for every rider. This risk already applies to today's live bus data; open rider reports add a public write route, so it matters more here. Before building, check whether a free Cloudflare protection can cover Dale's Worker address, and verify it if one is added; nothing paid.

## Decisions for Jeff

1. **Who can share and see.** Answered Nov 17: any Dale rider, opt-in (off by default, consent pop-up).
2. **How long a report lives.** 3 minutes after it reaches the server (recommended), or shorter. Its age on screen always counts from the phone's reading time.
3. **Open-app only.** Accept that sharing works only while Dale is open on screen (recommended for now), or wait for the native app study (#104).
4. **Human check.** Add Cloudflare Turnstile to the ride-pass request (free; one new key pair the owner stores), or launch with the limits above only (recommended to start; add Turnstile if health shows abuse).
5. **Contact line in the privacy notice.** Which name and contact the public notice shows for questions (for example a GitHub issues link, which needs no personal email).

## Gates

- Risky change: Codex review (Argon if Codex is unavailable), plus CodeRabbit.
- New Worker write route and storage: Jeff is told before the Worker deploy, and the release keeps history collection unchanged (`preserve-enabled`).
- Front-door protection before either route opens: the candidate is a Cloudflare rate-limiting rule on the Worker's address, if Cloudflare's Free plan offers one there (unverified; nothing paid). It must cover both the report write route and the report read route, and its coverage of each is checked and verified before that route opens. If no free control can be verified, neither route opens, and Jeff is told.
- Real on-road test by the household before it is described as working.

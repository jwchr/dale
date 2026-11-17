# Rider-shared bus position (#105): design and threat model

Status: **design for the owner's OK. No code exists.** Owner go-ahead to design it: Jeff, builder chat, 2026-11-17, about 5:45 AM ET ("Do number 2, number 3, number 5. Number 7."; number 5 was this issue). Building needs his answers to the three decisions at the end, an independent review (risky: personal data and Worker), and his heads-up before any live server update.

## The problem

Sometimes NJ Transit's GPS for a bus stops reporting. Today Dale then shows "not reporting" with the last known position and its age, and falls back to the schedule. That is honest, but it leaves the rider waiting downstream with no idea where the bus is.

If a household rider is already on that exact bus, their phone knows where the bus is. This feature lets that phone share its position, briefly and anonymously, so the waiting rider sees "Rider-reported position, 40 seconds ago" instead of nothing.

## What it never does

- It never replaces or overrides fresh NJ Transit GPS. Official data always wins.
- It never marks a bus as arrived at a stop, cancelled or on a new trip.
- It never feeds the history archive (#91) or the arrival statistics. One phone's claim is not a measured arrival.
- It never shows who shared the position or where they got on, and it is built not to show where they got off; the one known exception (getting off and riding on along the route in another vehicle) is under "Remaining risk" below.
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
   - the household code is valid (see "Household code" below);
   - official GPS for that trip is not fresh at the moment of the write. The trip's Durable Object handles one request at a time, so this check and the store happen together: a report that arrives after official GPS has returned is rejected, never stored.
   Anything else is dropped silently.
6. **Privacy at the rider's own stops:** the phone knows the rider's boarding stop (the locked departure's stop) and getting-off stop (the saved trip's destination). It sends nothing while the bus could be within 2 stops or 400 meters of either one. The 400 m check counts the reading's accuracy against the rider: the bus is treated as inside the zone whenever the distance to the stop minus the reported accuracy radius is under 400 m (a reading 450 m away with 100 m accuracy is inside), and a reading with no accuracy value is never sent. **Getting off somewhere unplanned:** a rider may leave the bus before the saved stop, so the phone also holds every reading back and sends it only once later readings show the phone kept moving like the bus well past that point. That check needs all three of: (a) the phone has gone at least another 400 m along the trip's route shape, counted conservatively as the progress between the two readings minus both of their accuracy radii (raw positions 400 m apart with 50 m accuracy each count as only 300 m, so the reading stays held); (b) it covered that distance at bus speed, under 2 minutes, which a rider who got off and walked along the street cannot do; and (c) every reading in between stayed within 150 m of the route. A rider who gets off and walks, or stops, therefore never sends the last 400 m before that stop, and nothing after it (one exception, riding on in another vehicle, is under "Remaining risk"): once the phone moves more than 150 m from the route, the held readings are dropped, and a reading not cleared this way within 2 minutes (a bus stuck in traffic, or a rider who got off) is dropped too. Tapping "I got off", ending Bus Lock or closing Dale also drops them and ends sharing. The cost is a delay: a report usually reaches waiting riders about a minute late (at most 2 minutes), and its age says so. So a report does not reveal where that rider gets on or off, apart from that one exception. The rider's stops are never sent to the server (sending them would expose exactly what this rule protects), so the phone is the one place this is enforced, and a unit test covers it.
7. **What other riders see:** on the waiting rider's screen, a hollow marker labeled "Rider-reported position" with its age and "may be off by about N m". It disappears 3 minutes after the last report reached the server, or as soon as official GPS returns.

## Data stored

- Only the latest accepted report per trip, held in Durable Object memory and storage under the trip instance.
- It is deleted 3 minutes after the server accepts it, when official GPS returns, or at the trip's scheduled end plus 30 minutes, whichever comes first. While official GPS is fresh, new reports for that trip are rejected (see the write check above), so a deleted report cannot be replaced by a late one.
- **Reading reports needs the household code too.** Reports are served only from a separate route that checks the code on every request and answers with `Cache-Control: no-store`. They never appear in the public live snapshot or its cached response, which stays free of rider locations as `docs/LIVE_BUS_PILOT.md` requires.

## Household code

- Generated once by the builder's tool with a cryptographic random source: 16 characters from a 32-character alphabet (80 bits), shown to the owner once as a QR code to scan on each household phone. Only a hash of it is stored, as a Worker secret the owner sets.
- Rotating it is one owner step: set a new secret. Every phone then asks for the new code.
- Every request's code is checked (a constant-time hash comparison), and a correct code is always accepted while the Worker is answering requests, so nobody else's wrong guesses on a shared address (public Wi-Fi, or a phone carrier that puts many phones behind one address) can lock out or delay the household. Brute force is not a realistic risk: the Worker's Free plan allows at most 100,000 requests a day across everything, and at that rate guessing an 80-bit code would take longer than the age of the universe. Wrong codes are still watched: after 5 in 10 minutes from one network address (the address is kept only in memory for that window), that address's later wrong codes get a plain "try again later" for 1 hour; across all addresses, more than 50 wrong codes in an hour shows the owner a warning in health output. Nothing here ever turns the route off or rejects a correct code. Using up the Worker's daily request allowance is a separate risk, listed under "Remaining risk" below. The write cap of 2 per minute is enforced per code and per address, not per device.
- It is never logged, never archived and never in health output.
- At most 20 trips hold a report at once. A household needs one or two.

## Threats and answers

| Threat | Answer |
| --- | --- |
| Someone outside the household posts or reads positions | 80-bit household code on every write and read, server-side failed-attempt limits and lockout, code rotation by the owner. The route-shape, speed and age checks only limit where a position can lie; they are not authentication |
| A rider's home or routine is exposed | Reports are only sent while riding a locked bus, never within 2 stops or 400 m of the rider's own boarding or getting-off stop (enforced on the phone; those stops are never sent), never in the public snapshot, and deleted within minutes. The 400 m check subtracts the reading's accuracy radius. Readings are held until later readings show the phone went another 400 m along the route at bus speed (after subtracting both readings' accuracy), so getting off at an unplanned stop and walking away reveals nothing either; riding on in another vehicle is the remaining risk below. Planned unit tests (not written yet; this is a design) check that the phone sends nothing inside either zone (including a reading 450 m from a stop with 100 m accuracy) and nothing within 400 m before, or anywhere after, an unplanned stop where the rider leaves, including when the rider walks on along the route and when two readings 400 m apart each have 50 m accuracy, and record the car case's known behavior |
| Rider confused about whether it is official | A different marker and label in both languages; official GPS always replaces it |
| Battery drain | Sharing only while the official GPS is missing, with Dale open, every 30 seconds at most |
| Cloudflare Free plan or NJ Transit limits | No extra NJ Transit requests; at most 2 writes per minute per sharing phone |
| Wrong bus (rider got on a different bus) | Same exact-trip lock and "I boarded" step; a report that strays from the route shape is dropped |

## Remaining risk Jeff should know about

- **Leaving the bus and riding on in a car along the same route.** If a rider gets off and, within 2 minutes and with Dale still open and sharing on, travels at least 400 m further along the bus route in another vehicle, the phone cannot tell that apart from still being on the bus. It would keep sharing that vehicle's position as the bus, which would reveal roughly where the rider got off (to within the last few hundred meters) and show a wrong bus position. Limits: household-only viewers, reports last 3 minutes, sharing stops when official GPS returns, when the rider taps "I got off", ends Bus Lock or closes Dale, and when the trip's scheduled end passes. Planned unit tests will record this behavior so it is known, not hidden. Jeff's privacy decision and an independent review come before any building.
- **Someone floods Dale's server.** The Worker runs on Cloudflare's Free plan, whose daily request allowance is shared by everything Dale does. No protection at the front door has been verified, so an outsider sending a flood of requests could use the allowance up and stop Dale's live data, rider reports included, until the daily reset, even for a household phone with the correct code. This risk already applies to today's live bus data; rider reports do not create it, but they depend on it too. Before building, check whether a free Cloudflare protection can cover Dale's Worker address, and verify it if one is added; nothing paid.

## Decisions for Jeff

1. **Who can share and see.** (a) Household only: each phone scans the household code once; the same code is required to send and to read reports (recommended). (b) Any Dale rider: needs abuse protections far beyond this design and a public privacy notice.
2. **How long a report lives.** 3 minutes after it reaches the server (recommended), or shorter. Its age on screen always counts from the phone's reading time.
3. **Open-app only.** Accept that sharing works only while Dale is open on screen (recommended for now), or wait for the native app study (#104).

## Gates

- Risky change: Codex review (Argon if Codex is unavailable), plus CodeRabbit.
- New Worker write route and storage: Jeff is told before the Worker deploy, and the release keeps history collection unchanged (`preserve-enabled`).
- Real on-road test by the household before it is described as working.

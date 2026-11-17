# Rider-shared bus position (#105): design and threat model

Status: **design for the owner's OK. No code exists.** Owner go-ahead to design it: Jeff, builder chat, 2026-11-17, about 5:45 AM ET ("Do number 2, number 3, number 5. Number 7."; number 5 was this issue). Building needs his answers to the three decisions at the end, an independent review (risky: personal data and Worker), and his heads-up before any live server update.

## The problem

Sometimes NJ Transit's GPS for a bus stops reporting. Today Dale then shows "not reporting" with the last known position and its age, and falls back to the schedule. That is honest, but it leaves the rider waiting downstream with no idea where the bus is.

If a household rider is already on that exact bus, their phone knows where the bus is. This feature lets that phone share its position, briefly and anonymously, so the waiting rider sees "Rider-reported position, 40 seconds ago" instead of nothing.

## What it never does

- It never replaces or overrides fresh NJ Transit GPS. Official data always wins.
- It never marks a bus as arrived at a stop, cancelled or on a new trip.
- It never feeds the history archive (#91) or the arrival statistics. One phone's claim is not a measured arrival.
- It never shows who shared the position, where they got on, or where they got off.
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
   - the reading is under 60 seconds old;
   - the implied speed from the previous report is under 110 km/h.
   Anything else is dropped silently.
6. **What other riders see:** on the waiting rider's screen, a hollow marker labeled "Rider-reported position" with its age and "may be off by about N m". It disappears after 3 minutes without a new report, or as soon as official GPS returns.

## Data stored

- Only the latest accepted report per trip, held in Durable Object memory and storage under the trip instance.
- It is deleted 3 minutes after its reading time, when official GPS returns, or at the trip's scheduled end plus 30 minutes, whichever comes first.
- It is never logged, never archived and never in health output.
- At most 20 trips hold a report at once. A household needs one or two.

## Threats and answers

| Threat | Answer |
| --- | --- |
| Someone outside the household posts fake positions | Household code (decision 1), plus the route-shape, speed and age checks; reports carry a "may be wrong" label |
| A rider's home or routine is exposed | Reports are only sent while riding a locked bus, never at the stops where they get on or off (the first and last 2 stops are not shared), and are deleted within minutes |
| Rider confused about whether it is official | A different marker and label in both languages; official GPS always replaces it |
| Battery drain | Sharing only while the official GPS is missing, with Dale open, every 30 seconds at most |
| Cloudflare Free plan or NJ Transit limits | No extra NJ Transit requests; at most 2 writes per minute per sharing phone |
| Wrong bus (rider got on a different bus) | Same exact-trip lock and "I boarded" step; a report that strays from the route shape is dropped |

## Decisions for Jeff

1. **Who can share and see.** (a) Household only: each phone enters a short household code once (recommended). (b) Any Dale rider: needs abuse protections far beyond this design and a public privacy notice.
2. **How long a report lives.** 3 minutes after the reading (recommended), or shorter.
3. **Open-app only.** Accept that sharing works only while Dale is open on screen (recommended for now), or wait for the native app study (#104).

## Gates

- Risky change: Codex review (Argon if Codex is unavailable), plus CodeRabbit.
- New Worker write route and storage: Jeff is told before the Worker deploy, and the release keeps history collection unchanged (`preserve-enabled`).
- Real on-road test by the household before it is described as working.

# Dale V1 contract

The canonical, short definition of V1. Source: master spec v1.3 (archive) as amended by the independent review of 2026-10-31 and the owner's approvals the same day (`docs/DECISIONS.md`). Each issue links to the requirement ID it serves.

## Who and where
Household tool for Jeff and Diego. Bergen County corridor to and from Port Authority Bus Terminal. QA routes 163, 164, 165, 165T, both directions. Other NJ Transit bus data may load but is not QA'd.

## V1 must do
| ID | Capability | Milestone |
| --- | --- | --- |
| UX-01/02 | Zero-tap home: saved commutes in the rider's order, next 3 or 5 departures, one-tap reverse | M1 ✅ demo, ✅ printed route 165 (D42) with the Port Authority gate on rows that board there, M2 real |
| UX-03 | Stop search by name or code; wrong-side-of-street guard | M1 ✅ demo, ✅ printed route 165: town-first search, every reachable stop, guard through named twins, reverse from across the street |
| UX-04 | All-day timetable, 7 days, holidays, after-midnight trips, DST-safe, 12-hour times | M1 ✅ demo, ✅ printed route 165 (after-midnight, DST as printed with notes, holiday warning: the print has no holiday times), M2 real |
| BUS-01/02 | Exact-bus lock keyed to trip + service date + boarding stop; signal age/history, explicit estimates, waiting reports and foreground screen wake (`docs/BUS_LOCK.md`) | Local UI/domain slice; M3 live + shared reports |
| GATE-01/03 | Port Authority gate and door per departure from NJ Transit DepartureVision; usual gate before posting; gate-change push | M1 ✅ logic, M3 live |
| UX-10 | Stop alerts 3, 2 and 1 stops before getting off, sent by the server from the locked bus (Web Push) | M3 |
| UX-09 | Ticket-before-boarding warning at Port Authority; Tap & Ride guidance in NJ; zone count only from a real fare table | M1 ✅ PABT warning, M4 ✅ printed route 165 cash fare and zone count, ✅ Tap & Ride steps in the guide |
| UX-07 | First-time-rider guide, English and Spanish | M1 ✅ languages, M4 ✅ route 165 first-ride guide |
| GATE-02 | Gate cards (floor, gate, door, nearest escalator or elevator, photo) for corridor gates | M4: needs owner photos and notes from Port Authority (no official source found for floors and escalators) |
| MAP-01/02 | Geographic map (MapLibre + OpenStreetMap); Clean, dark, Turnpike styles | Built (D47: self-hosted OpenStreetMap, light and dark); shows a trip only where stops have coordinates, so the 165 waits for the M2 feed |
| OFF-01 | Offline: last known schedule with its age | M1 ✅ service worker, M4 ✅ network timeout and saved-copy age |

## Not in V1
Native app, widgets, watch, Live Activities; personal identity/location sharing (D44 permits only future separate opt-in to contribute a bus-trip location); Smart ETA model; 511 incidents; indoor live dot; Parkway, subway and atlas skins; personal stats; Casting Director bridge; e-ink display; public launch.

## Owner additions, 2026-11-04

D45 adds GPS-assisted fare zones, a near-home rescue search, last same-line return guidance, capacity observations/history and full-screen get-off guidance. `docs/BUS_LOCK.md` defines the behavior and dependency boundaries. Printed timepoints alone cannot supply route geography, fare boundary polygons, nearby alternatives, exact intermediate-stop counts or current capacity. These additions do not lift the existing live-data/collection hold.

## Owner additions, 2026-11-05

D48 adds the New York Penn journey guide and explicit lost-GPS/estimated-progress warnings, with an alternatives action on signal loss or an unconfirmed due arrival (#79). Scope is the 165T/165 local, 163/164 at Summit & Essex, and Anderson Street / Essex Street (Pascack Valley) via Secaucus. User-opened Uber/Lyft links supply no quotes or bookings. The guide is a manual checklist, never location tracking or confirmation of a connection. Saved choices stay on the phone. A missing signal never cancels a trip or changes its identity.

D49 permits a separate supplied-PDF transcription and scheduled comparison slice (#80); 144 is included only where it serves the same selected corridor stop. Compare the full journey to Penn, including the final leg from Port Authority, the full return chain and user-entered walking time. Static-source authorization does not release M2/M3 live access, recordings, alert or shared-report holds. Do not publish known-superseded rail connections as current service.

## Owner addition, 2026-11-06

D51 confirms approved bus API access and authorizes secure credential setup and staged live integration. #87 checks authentication only from a manual main-branch job; no credentials/tokens/raw responses enter the browser, public artifacts or logs. Live predictions will lead when verified and fresh; schedules remain for fallback and future planning. Rail access is still pending. The existing independent review, privacy, private backend and free-service constraints remain.

D52 prioritizes the provisional live bus tracker (#89) with the existing free Worker architecture, explicit scheduled fallback, source age and unchanged exact-bus identity. Printed commutes remain separately available while riders confirm current GTFS stops. This does not complete sustained M0 evidence, rail access or real-ride acceptance. See `docs/LIVE_BUS_PILOT.md`.

## Owner addition, 2026-11-07

D53 adds a compact scheduled next-165T cue when all displayed departures are local165 buses (#93). Reuse the same confirmed stops, calendar and walking-time constraints, without changing the main rows or the exact bus lock. A 165T that does not serve those stops is not an option.

D54 adds upcoming-first home, clearer physical-stop/destination selection, owner photo backgrounds and a source-qualified destination arrival comparison. Large paired clocks distinguish boarding from destination; each independently identifies live prediction or scheduled fallback. An official STOPPED_AT report confirms an observed stop sample, not the exact instant of arrival. Only explicit rider action creates a rider-confirmed destination time. The city labels use bounded public NJ Transit GIS facts joined by exact stop number, served route and nearby coordinates; unavailable/conflicting labels remain unknown. Broader sign scanning, seasonal/weather backgrounds and bus/train schedule comparison retain their existing dependency boundaries.

## Done means
Tests prove it (`npm run verify`), the Pages build shows it, and for live features the owner's real rides confirm it (M3 acceptance in the review doc).

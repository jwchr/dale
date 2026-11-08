# Rail timetable preview (#80, D57)

The owner requested the train foundation now, using samples from the supplied guide while rail access is pending. This is a separate preview on Train, not another live bus data source.

- `src/data/railSample.ts` holds twelve example columns from the owner-supplied `PV-combined.pdf`, regular timetable dated August 30, 2026. All included cells, train numbers, AM/PM transitions and L markers were visually checked on its four rendered pages. The original PDF is not republished.
- Weekday outbound: 1602,1604,1608. Weekday return: 1605,1651,1607. Weekend outbound: 2100,2102,2104. Weekend return: 2103,2107,2111. Train1651 has no Essex stop. Conditional overnight2101 is excluded. These are selected examples, not all-day coverage or a holiday calendar.
- The known Portal temporary timetable can supersede the regular source. The preview has no current date, "next train", countdown, LIVE badge, bus lock or ranking against real bus options. One compact Sample timetable label and a short current-data status qualify the preview; expandable source details explain coverage. No sample values enter the bus feed or history.
- `railTimetable.ts` normalizes two legs and preserves departure, arrival and station-call semantics. The PVL PDF lists station calls/departures; it does not supply a distinct arrival at Secaucus or the Hackensack destination. A gap between printed times is not a guaranteed connection or a chosen transfer buffer. Missing calls and malformed/backwards times yield no option.
- `RailPreview.tsx` consumes that model and the existing Anderson/Essex/direction choices. Native disclosures expose boarding and transfer steps. Changing preview day never changes the saved checklist, favorites or bus lock. No connection train number, track or fare is invented.

For an eventual official adapter, first establish authorized rail endpoints, current calendar/override coverage, canonical station/trip identity and independent source age for predictions. Replace the sample provider only with a validated current-service contract. The real planner must search all eligible Secaucus connections using the rider's buffer and full return chain; do not simply promote these sample paired columns to current trips. No new polling, credentials or backend is added here.

# Garden State visual source (#113, D62)

The owner-confirmed restoration reference is the actual in-Dale `75fd141` Parkway appearance, explicitly selected November 8: forest-green panels/background, gold-rimmed green signs, timber stop plates and gold accents/badges/wordmark. Garden State reuses that complete treatment while retaining its own saved identity and all current compact/accessible functionality. Other skins remain independently selectable. The historical rendered-reference fixture records the source commit, image checksum and actual surface values; current light/dark preferences remain stored, while scene skins retain their own fixed colors and browser control scheme. This restoration does not claim the separate sleek Household graphics migration is complete.

## Historical Household presentation source (#101; superseded palette)

PR108 originally adapted Garden State from the owner's recovered Dale — Household Transit Site source, version 13, commit `97d3327c0628c0776b9c41125a8efb8aa1c07795` (`app/globals.css`). That separate Household reference uses river-blue controls, warm paper panels, green wayfinding and amber destination boards. The maintained app's native semantics and larger mobile type replace the prototype's very small labels.

At that historical checkpoint, only presentation tokens/treatments were adapted. No prototype simulated feed, example arrival history, household identity, Site services, dependencies or private access configuration was copied. Existing approved background derivatives and fallback artwork remain; no extra image was published. Garden State is available in Settings → Style, retains light/dark support and is the default for a new preference. Existing style choices, functions and canonical Dale! branding are preserved.

Desktop location recovery uses at most one high-accuracy attempt plus one approximate attempt per deliberate tap, never retries a permission denial, ignores late callbacks, and keeps positions in memory only. Device-help copy follows Chrome location permission help and Apple's Mac Location Services instructions; browser Allow alone does not prove the OS can obtain a position. Actual operation on the owner's Mac remains a device acceptance check.

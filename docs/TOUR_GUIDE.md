# Manual Tour guide — first catalog

Owner request #99; sole-builder claim6717291486 follows the selected bounded slice6717257949. This release adds three manually browsed landmark/history cards for the household's Hackensack corridor. On home, open **Tour guide** below the first-ride help; it is also available before a favorite is saved. Full English/Spanish content, readable locations and source links are bundled in the app.

## Source audit (checked November7,2026)

| Card | Fact/location verified | Primary source |
| --- | --- | --- |
| The Green | Downtown square on Main Street north of the courthouse;18th-century militia training ground; Washington's soldiers camped on the Green during the November1776 retreat | [Bergen County Revolutionary War sites](https://bergencountynj.gov/tourism/discovering-history/revolutionary-war-sites-in-bergen-county/), Hackensack section, including the paragraph following the second-courthouse entry |
| Bergen County Courthouse |10 Main Street; completed1912; architect James Riely Gordon; Roman/Italian Renaissance influences, Beaux-Arts design, marble and bronze | [Bergen County cultural/historic sites](https://bergencountynj.gov/tourism/discovering-history/cultural-and-historic-sites/), Bergen County Court House entry |
| Church on the Green | First Reformed Church,42 Court Street; General Enoch Poor and New York mayor Richard Varick buried in the churchyard | [National Register nomination](https://npgallery.nps.gov/GetAsset/0c05460d-9030-4c0d-9dd2-2ff0643ad6d5), PDF page1 location and page10 (continuation item8 page3) burials; independently compared with the County's Church on the Green entry |

The NPS location and burial pages were rendered and visually read. The source PDF/renders remain in the builder's private work folder; they are not republished in this public repository. The app uses short original paraphrases in both languages, with source attribution and verification dates. It copies no source photographs or long passages.

Known source differences were not silently resolved: the County's church-building date is1792 while the National Register describes1791; dates for the Green's original land gift also differ. Those dates are deliberately absent from these cards. No current opening hours, admission, access entitlement or safe walking route is inferred from an old record. Locations are publicly identified landmarks, not private residences; check access before a visit.

## Scope and behavior

- These three locations are clustered around downtown Hackensack's Main/Court streets. The guide explicitly names this area and says that nearby content does not establish bus position or visibility. It does not claim the selected bus passes each landmark or turn a stop-to-stop route line into a street path.
- Native disclosure, headings, articles and independent source links keep keyboard/touch/screen-reader behavior. Links have distinct accessible names, open separately and use `noopener noreferrer`. External sources need a connection; reading bundled cards needs no extra content request.
- No GPS permission, geocoder, automatic proximity trigger, audio, town Welcome card, notification, model call, Worker endpoint, new package or user storage is added. No coordinates are invented. Future geofenced content requires separately verified points and optional fresh/accurate on-device location; municipal Welcome behavior remains separate.
- Favorites, bus selection/lock and checklists remain under existing ownership. Browsing has no trip-state action. The small card surfaces reuse existing theme tokens without adding per-card backdrop blurs or image downloads.
- The broader20–30-place catalog and automatic Tour/Welcome ideas remain queued. This is the first three-place manual catalog, not completion of all #99 scope.

## Verification

Browser regressions cover EN/ES305px at130% text, native Enter/Space disclosure and keyboard links, WCAG2.1AA checks, all three source links/locations, no external requests while reading, retained favorite/exact locked trip and access from an empty home. Complete repository verification, current CI, independently classified/qualified review and separate public acceptance still govern release.

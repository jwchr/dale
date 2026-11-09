# Owner-supplied NYC night background (#113)

The owner requested a Manhattan/Ramble night photograph for the existing NYC night skin, processed that selected image himself and supplied it for this app. Project Control confirmed that direct-human instruction and the specific attachment before claim6730117465. This is separate from the still-unrecovered untouched bus-stop-sign photograph and does not complete the broader Household/sleek migration.

The private full-resolution processed original remains unchanged and unbundled. The delivered `src/assets/ramble-night.webp` normalizes the original display orientation, resizes to960×2078 and encodes WebP with metadata removed. There is no AI generation, retouching, recoloring, added scene or manual crop. Its reviewed SHA256/byte size/dimensions are in `tests/fixtures/nyc-night-photo.json`; the unit test checks the actual binary identity and RIFF chunks for absent EXIF/XMP/ICC metadata. No original filename, EXIF, private path, private photo URL or full-resolution original is placed in the app.

## Existing pipeline and fallback

Only NYC night selects this photograph. Other styles retain their existing one-per-opening Paterson/sunset choice, fixed foreground colors and saved identity. Vite gives the night asset a versioned same-origin `/assets/` URL; the existing service worker can reuse its saved copy. It is not in the initial HTML install/preload list, and no photo library, remote image host, new dependency, provider or service is used.

The existing low-priority asynchronous image loader requests only the selected photograph. Readiness is tied to the exact image URL, so switching styles retains fallback art until its matching image loads and ignores an obsolete load callback. A failed NYC image leaves the original skyline artwork, without selecting a different photograph or blocking departures. There is no automatic rotation. Reduced transparency and forced colors retain the existing solid fallback and skip the image request.

The existing decorative-only blur/dim remains; text, signs and controls stay crisp on their current panels. The entire background remains hidden from assistive technology and cannot receive pointer events. No foreground design, user-selected style, favorites, exact bus identity, trip/checklist progress, walking preference or transit data changes.

## Verification and release boundary

Browser regressions cover EN/ES, light/dark preferences,305/320/390px,100/130/200% text, actual photo dimensions/selection, contrast/accessibility, keyboard style changes, Train/Bus navigation, saved choices, exact-bus lock preservation, failed images, late prior-style loads and reduced-transparency/forced-colors no-request behavior. Actual phone renders must be inspected, followed by complete npm run verify, exact-head CI, independent full-diff review and separate operator publication/public acceptance. This document alone is not a deployment claim.

Rail authentication/API/health/feed retry remains held independently; the background feature changes no rail source, Worker, recorder, polling rate, schedule, secret, spending or provider.

# Seasonal stop illustration

Issue #106, existing owner approval: [asset handoff](https://github.com/jwchr/dale/issues/106#issuecomment-6711933400). This bounded slice adds **See stop sign** to each valid saved home trip, in English and Spanish. Opening it shows the actual boarding-stop name/code, eligible routes for that saved destination, and an optional seasonal illustration. It does not change the selected bus, favorite, route, lock or checklist.

## Honest sign details

- Use the dataset's public `Stop.code` as a string, preserving leading zeros. Missing codes show the existing number-unavailable label; internal IDs are never substituted.
- Routes come only from patterns that permit boarding at this exact origin and later alighting at the saved destination, respecting saved route filters. These are loaded-schedule routes, not a promise that each is running now. The caption tells riders to check departures and match the real sign's number/direction.
- All dynamic details are accessible HTML outside the decorative illustration. The foreground sign repeats those facts visually; the decorative image/sign group is hidden from screen readers to avoid duplicate announcements. Unknown routes remain unknown.

## Printed wording and app language

Physical sign lettering stays in its source language when the app switches English/Spanish: Bus Stop, verified public stop code (dash if absent), eligible route numbers and New York · Port Authority for the known terminal. Other destinations retain the dataset's proper stop name. The surrounding title, button, instructions and accessible selected-stop explanation still translate. This correction does not claim the current deterministic sign matches the owner's requested original-photo treatment; that photo-faithful replacement remains queued under #113/#106.

## Approved artwork and crop

The eight metadata-stripped WebPs and their original source manifest are preserved byte-for-byte under `src/assets/stop-scenes`. Unit tests verify every approved size and SHA256. The manifest's original preparation status is historical provenance; this document records integration.

The supplied artwork has baked-in routes164/707/144 and stop13583. Rather than fit fragile text patches to perspective lettering, this implementation follows the handoff's fallback: use the scene behind a separate deterministic sign. The original sign is never used as the rider's stop sign.

At250% image width, the clipped frame admits only the left40% of the source image (original source sign starts beyond x400 of941). The bottom10% is also clipped, excluding the embedded seasonal caption. This applies before image paint, during loading, on failure and at enlarged text. All sign lettering is separately rendered HTML. The approved source images are not edited, regenerated or asserted to show this boarding stop. The visible caption explicitly calls the scene illustrative, not a current camera/weather observation. Tests inspect crop geometry and screenshot all eight scenes.

## Loading and fallback

- Closed disclosure: no image element/request, season formatting or route scan. Native disclosure/keyboard behavior and44px controls are retained.
- Opening: request only the selected hashed WebP URL, with low fetch priority because it is optional artwork. Native width/height preserve image geometry; the foreground sign provides the layout. Browser cache and Dale's existing cache-first hashed-asset path reuse viewed scenes; the service worker does not precache all eight images.
- Automatic uses New Jersey's local calendar: December–February winter, March–May spring, June–August summer, September–November autumn, always clear artwork when weather is unknown. No weather service is connected. Manual weather choices select artwork only.
- Invalid time or failed image: retain a solid background, readable stop details/sign and translated failure message. Switching artwork allows recovery. Scene choice stays in this component's memory and resets for a different boarding/destination leg; no new storage key, GPS, upload or background work.
- Existing skins, forced colors and305px/130% text remain supported. Image failure must never hide the stop information.

Broader #106 bilingual learning overlays, personal uploads, opening slogans and #94 camera scanning are outside this slice. Review and merging follow `CLAUDE.md`, section "How we work".

# Official MyBus fallback (#96)

The optional **Check NJ Transit directly** disclosure appears in the locked-bus status card, and the schedule-load error offers a generic lookup. English and Spanish use the same behavior. Opening the disclosure makes no MyBus request and does not change the selected bus, favorites, live observations or history.

The web action opens only <https://www.njtransit.com/my-bus-to>, without query parameters or a referrer. No stop-specific deep-link is assumed. With a verified code, copy it and enter it in NJ Transit's form; otherwise choose the route, direction and stop there.

## Stop and direction

The code comes only from `Stop.code`, populated from the official GTFS `stop_code` by `scripts/gtfs-lib.mjs`. The schedule must be validated canonical `njt-bus-g2` data, neither demo nor transcribed. The exact trip, pattern, direction and boarding position must agree with the selected departure; final/drop-off-only positions cannot supply a code. Codes are five ASCII digits, preserving leading zeroes. Neither internal stop IDs, twins, route numbers nor intersections supply a substitute. The disclosure names the boarding stop and destination direction and asks the rider to match the physical sign. Missing codes disable the text action and retain the generic website.

## Explicit rider actions

- **Copy stop code** writes only the public stop code to the clipboard. Native Invoker Commands and the older-browser click fallback share one copying function, with only one active dispatch path. Success and refusal are visible and announced; refusal leaves the code selectable and the button available for retry.
- **Android:** `sms:69287?body=CODE` requests a draft containing only that code. The rider must inspect it and tap Send. This follows the [SMS URI standard](https://www.rfc-editor.org/rfc/rfc5724.html); it does not prove every installed messaging app handles the draft identically.
- **iPhone/iPad:** Apple's [documented SMS scheme](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/SMSLinks/SMSLinks.html) supports the recipient only, so Dale uses `sms:69287` with copy/paste instructions. This avoids relying on an undocumented body parameter. Desktop-style iPad identification uses the Mac platform plus touch capability; device hints are not proof that Messages is installed.
- **Other/desktop:** the official website, selectable code and manual texting instructions remain available. Dale does not offer a mobile-protocol link on an unrecognized device.

The note beside text actions states NJT's 12-message daily limit per phone number and possible carrier message/data charges. Dale never sends a message, requests SMS permissions, counts allowances, retries automatically, passes rider coordinates, or reads/imports a response. A MyBus response remains NJT's own live/scheduled result; this is not independent telemetry or a promise of recovery from an agency-wide outage.

## Official sources checked November 15, 2026

- [NJ Transit MyBus texting](https://www.njtransit.com/mybustexting): recipient 69287, stop-code-only lookup, daily limit and carrier charges.
- [Official MyBus web form](https://www.njtransit.com/my-bus-to): route/direction/stop lookup or five-digit stop number.
- Apple SMS scheme and RFC 5724 linked above: composition handoffs, not unattended sending.

## Verification and release limits

Unit tests use a synthetic GTFS fixture for code provenance, leading zeroes, exact boarding position/direction, unavailable codes, unsafe strings, pickup restrictions, source exclusions and protocol construction. Browser tests intercept schedule/live traffic and stub the clipboard; the web-click test intercepts the official form too. No real text is sent and no production lookup is used as fixture evidence. Tests cover both languages, 305 px with 200% body text, all five styles, keyboard focus, axe checks, copy refusal, the command-event fallback and preservation of the exact lock. Device hints exercise rendered URL/instruction choices; they do not prove an actual iPhone/Android messaging app opens or retains the draft.

An extra WebKit run found whole-page horizontal overflow at 305 px / 200% text in the existing route-strip stop name and alighting tag. In a bounded diagnostic the new disclosure stayed within the viewport (x=28.75, width=247.5 on a 305 px viewport), and closing it left the page width unchanged at 366 px. This is not evidence of physical Safari acceptance or a completed whole-page WebKit layout sweep. The separately owned travel-screen work remains separate.

Before release, complete the normal exact-head local/CI and CodeRabbit gates, plus independent Argon review for the optional potentially chargeable text handoff. A builder must still verify the deployed app normally; the owner must verify actual phone handoffs without sending a text unless desired. This implementation authorizes no deployment or live-service changes.

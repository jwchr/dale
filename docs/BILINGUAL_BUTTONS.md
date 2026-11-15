# Optional bilingual main buttons (#106)

Jeff chose **Main buttons first** on November 15, 2026, rather than both languages throughout the app. This is the complete bounded first phase; page text, full-app assistance and personal-photo work remain separate.

Settings → Bilingual button helper is off by default. When enabled, the selected English/Spanish mode stays primary and a smaller translation appears beneath selected text buttons. Switching the app language swaps the order. Turning the helper off immediately restores the ordinary single-language labels. The existing settings record remembers one boolean; inaccessible storage follows the existing best-effort preference behavior and must not prevent using Dale.

## Included controls

- Bus / Train, Find a stop, and schedule-load Retry / return to schedule.
- Saved-trip Leave by, other buses / Get me home, and See bus stop sign.
- Lock, Unlock, start waiting, no bus yet, bus arrived, boarded, passed without stopping, leave the stop, and end ride.
- Enter / exit the full-screen ride view.

Other buttons, field labels, status explanations, place/route identifiers and saved names retain their existing presentation. No automatic translation, DOM rewriting, overlapping gloss, network service or new dependency is used. Both labels come from the existing reviewed English/Spanish dictionaries. The second line has the correct `lang` attribute, remains part of the native button's accessible name, and does not add a focus target. Decorative icons remain hidden from the accessible name.

## Ownership and layout

`BilingualButtons` supplies presentation context from the existing settings in both the main and load-error shells. `ButtonLabel` opts individual controls in; when disabled it returns the original string without a label wrapper. It has no event handler, network, favorite, bus-session or persistence interface. Native controls retain their original handlers, pressed/disabled states and focus. Existing End ride semantics still remove the resumable lock; the helper does not own that operation.

The scoped CSS lets paired lines and their controls grow and wrap. Enabled saved-trip controls retain at least 44 px height. No fixed label height, ellipsis or hidden overflow is used. Existing backgrounds, source labeling, exact-bus logic and five skins remain the basis.

## Verification and limits

Browser checks cover both primary languages, opt-in/off and remembered preference, reversed language order and language tags, keyboard focus, unchanged fictional favorites/exact trip, one arrived/boarded report per native click, normal full-screen exit and terminal-lock clearing, load-error controls, blocked preference storage, all five skins at 305/320 px with both 200% root text and 32 px body text, whole-word wrapping without overlapping controls, enlarged waiting controls, and scoped axe checks. The rest of the existing suite verifies the default single-language modes. No real rider data or actual agency feed is needed.

No physical screen reader, actual phone or deployed acceptance is claimed. Optional translations do not replace the normal release and hands-on usability checks. This change authorizes no merge, deployment, new permission or private-data access.

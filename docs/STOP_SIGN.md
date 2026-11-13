# See bus stop sign

Issue #106 (asset handoff), owner decision D69 (2026-11-13). Each valid saved home trip has **See bus stop sign**, in English and Spanish. Opening it shows the boarding stop's name, public stop code, direction and the routes for that saved trip as accessible text, then a picture of the real NJ Transit stop sign with that stop's routes and number written on it. It does not change the selected bus, favorite, route, lock or checklist.

## Honest sign details

- The stop number is the dataset's public `Stop.code`, kept as a string with leading zeros. A missing code shows the number-unavailable label in the text and a dash on the sign; internal IDs are never substituted.
- Routes come only from patterns that permit boarding at this exact origin and later alighting at the saved destination, respecting saved route filters. They are loaded-schedule routes, not a promise that each is running now; the note tells riders to check departures and match the real sign's number and direction.
- The picture and its lettering are decorative (`aria-hidden`); the same facts are in the text above it. Unknown routes leave the sign's rows blank.

## The photographed sign (D69)

- Source: the eight owner-approved seasonal scenes in `src/assets/stop-scenes` (kept byte-for-byte; unit tests check size and SHA-256). They are AI seasonal visualizations of an owner-supplied photo of a real NJ Transit stop.
- `scripts/stop-sign-photos.py` (developer tool; Python 3, numpy, opencv-python-headless; not part of the build) makes `src/assets/stop-signs/<scene>.webp`. For each scene it erases the printed route lines and stop number 13583 by copying the sign's own blank ruled rows and plate, then crops around the sign with some street and trees (`SIGN_VIEW`, 530 x 1030 source pixels). Nothing else changes: the owner chose his sharp photo over a softened background, and power lines could not be removed cleanly without blurring, so they stay. The sign artwork, NJ Transit and mybus logos included, stays as photographed so riders recognize the real sign (owner decision; a narrow exception to the no-logos rule in `CLAUDE.md`).
- The app overlays an SVG with the same view box. Like the real sign, the rows list every route in Dale's loaded schedule that picks up at this stop, lettered "165 To New York" (route, then where that bus ends; Port Authority reads New York). The rider's own bus for this saved trip gets a yellow highlighter mark. Up to seven rows; with more, the rider's lines are always kept and the last row reads "+N more". Dale loads only its corridor routes, so the caption says the real sign may list more. Each row follows the photo's perspective (`signRowPlacement`, measured on all eight scenes within 1 px) and is squeezed only if it would run off its ruled line. The stop number goes after "This stop #" on the mybus plate.
- Physical sign lettering stays English in both app languages; the title, caption, controls and accessible text translate. The caption says the picture is a real NJ Transit sign pictured by season, that Dale writes in the stop number and its routes that board there and highlights the rider's bus, that the real sign may list more routes, and that the weather is not live.

## Loading and fallback

- Closed disclosure: no image request, season formatting or route scan. Opening requests only the selected WebP (about 90-125 KB) with low fetch priority; the service worker does not precache them.
- Automatic follows New Jersey's calendar (December-February winter, March-May spring, June-August summer, September-November autumn) with clear-weather artwork; no weather service is connected. Manual choices select artwork only and reset for a different trip leg; no new storage key, GPS, upload or background work.
- If the picture fails, or the device forces its own colors, a plain drawn sign shows the same stop number and routes, and a translated message says the picture is unavailable. Image failure never hides the stop information.
- Existing skins, forced colors and 305 px / 130% text remain supported.

Review and merging follow `CLAUDE.md`, section "How we work".

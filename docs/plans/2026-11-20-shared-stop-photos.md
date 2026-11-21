# Plan for Codex to check before building: riders share stop photos (#106, Nov 20, 2026)

Jeff, Nov 20, 2026, asked whether riders should be able to share their stop photos with other Dale riders: "Sure but the default should be my image." So Jeff's photographed stop sign (D69, `src/assets/stop-signs/`) stays what every rider sees by default; a rider's shared photo is an extra a rider can choose to look at. Codex cannot answer on issues here, so the plan is reviewed in this pull request.

## Today

"See bus stop sign" shows Jeff's photo in seasonal versions. The personal home backdrop (#168, `src/data/homePhoto.ts`) re-encodes a rider's photo on the phone so no GPS, EXIF or file name survives, and never uploads it.

## The change

1. **Default unchanged.** Jeff's photo always opens first. Shared photos appear only behind a "Photos from riders" button for that stop, and only after Jeff approves each one.
2. **Sharing is explicit.** In "See bus stop sign", "Share a photo of this stop" opens a short consent screen (English and Spanish): the photo becomes visible to other Dale riders after review, no name or account is attached, avoid faces and license plates, and how to remove it. Nothing uploads without that tap.
3. **Cleaned on the phone first.** The existing `prepareHomePhoto` re-encode (fresh pixels, no metadata, 2 MB cap). The upload carries only the image and the official stop ID the rider is viewing. Never the rider's location.
4. **Checked again on the server (Codex, #239).** The phone step can be bypassed, so the Worker does not trust it: it rejects any body over 2 MB before reading it, accepts only WebP with Dale's own encoder layout, and rejects any file that carries EXIF, XMP, ICC or other metadata chunks, or whose size does not match its header. Tests send raw requests that skip the phone (a JPEG with GPS, an oversized body, a WebP with an EXIF chunk) and confirm nothing is stored.
5. **Stored privately, inside a counted budget (Codex, #239).** A Worker endpoint writes to a private R2 prefix `stop-photos/pending/` on Dale's existing Free Cloudflare account. Every R2 write, list and read (upload, review listing, approval move, serving, retries) reserves its operation in the same durable daily and monthly ledger `docs/HISTORY_COLLECTION.md` uses, counted together with history collection against one shared allocation well under the Free limits. Approved photos are served with a long cache lifetime so repeat views do not reach R2. When the photo share of the budget is used, upload, review and serving all fail closed ("not available right now"); Jeff's default photo, which ships with the app, never depends on R2. Per-phone and per-day upload limits and a total storage cap also apply. No new vendor and no image service.
6. **Jeff approves each photo.** A private review page on the Worker, behind a secret Jeff sets in Cloudflare, shows pending photos with Approve and Delete. Approved photos move to `stop-photos/approved/` and are served with the stop ID only. Nothing is public before approval.
7. **The rider can remove it.** The phone keeps a random removal code for each upload; "Remove my photo" deletes it from pending or approved. Jeff's Delete also removes it for good.
8. **Tests:** metadata stripped on the phone and rejected on the server (synthetic images only), the operation budget failing closed, no upload without consent, limits and cap, pending never served, removal code works only for its own photo, Jeff's photo stays the default in English and Spanish.

## Needs Jeff before building

- OK to use a new private prefix in R2 within the Free plan (the existing `dale-history` approval covers history only).
- Jeff sets the review page secret in Cloudflare himself.

## How it ships

Worker change, so it follows Dale's Worker deploy rules and gets a Codex code review (privacy, uploads, deleting data). Not live until a Worker deploy Jeff approves.

Please flag: any path where a rider's location or identity could reach the server or other riders, any way a photo is visible before approval, and any way usage could reach a paid tier.

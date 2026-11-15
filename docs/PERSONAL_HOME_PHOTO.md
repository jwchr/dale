# Personal home backdrop (#106)

An optional user-selected bus-stop photo replaces Dale’s decorative background in all five styles. It never changes the photographed stop-sign feature, verified trip/stop identity, favorites, locks, reports or agency data. Seasonal/weather rendering is neutral: this personal picture is decorative and does not claim current weather or a verified boarding location. No new service, AI generation, account, permission, package or deployment.

## Data boundary

A native file chooser reads one explicitly selected JPG/PNG/WebP, up to 12 MiB and 40 million decoded pixels. MIME and raster signature must agree; SVG/HTML/HEIC and unknown types fail visibly. Browser decoding applies EXIF orientation, draws fresh pixels into a bounded canvas (longest side <=2048), flattens transparency to white and creates a new JPEG <=2 MiB. The selected source file is never modified, stored or uploaded. The only persisted copy is the newly encoded pixel image: no filename, source bytes, source EXIF/GPS/XMP/IPTC or path. A browser may generate new technical EXIF such as output dimensions/color information; that is not the original location metadata. Visible content in the image can still be personal; removing metadata does not anonymize the picture.

One dedicated IndexedDB database (`dale-home-photo-v1`), one `photo` store, one `home` key holds only `{version, blob}`. No image or path enters localStorage, Cache API, network requests, Worker, logs, analytics, repository, review packet or BroadcastChannel. Storage is local to the current browser profile/origin, not encrypted or isolated from other same-origin scripts/apps. Browser site-data removal, eviction or private browsing can lose the copy; the untouched original remains the rider’s source. No request for persistent storage or new permission is made.

Reads validate record shape/version/blob type and size. Mutations compare the displayed version and write/remove in the same readwrite transaction. They report success only after transaction completion, not request success. A stale tab cannot replace or remove a newer choice: conflict refreshes the authoritative photo and requires a fresh deliberate action. Errors/abort/quota refusal retain the previous committed record and show a clear message. No automatic replay/overwrite/cleanup or database deletion. Open failure/blocked access times out and does not block the app. Failed/invalid data is not silently erased.

## UI and lifetime

Settings → Your home photo supplies translated pick/replace/remove controls, a local preview and polite success/refusal status. The original remains on the device unchanged. Remove explicitly removes only this optional photo record; existing app data is untouched. Busy controls prevent duplicate submission and focus returns after the UI re-enables the chooser.

A provider above the loading/main shells owns one photo state. Blob URLs are revoked on replace/remove/unmount, and readiness is tied to the current URL, so late older loads cannot paint an earlier photo. Existing solid/illustrated fallback and forced-colors/reduced-transparency behavior remain. BroadcastChannel carries only a change hint; foreground refresh also reads the database. Transactions provide correctness without that optional notification API.

## Verification and limits

Use synthetic raster fixtures only. The 22 focused cases passed in installed persistent WebKit (22.6 s); the ordinary Chromium suite remains the required full-verification basis. Browser checks cover both languages, all five styles at 305 px with enlarged root/body text, axe/keyboard, select/replace/remove/reload, no outgoing writes or external requests, unchanged fictional favorites, synthetic EXIF/orientation, input size/type/decode refusal, resize, URL cleanup, unavailable storage, quota/remove failure, transaction abort after request success, and cross-tab writes/deletes with delayed encoding or missing notifications.

The installed WebKit temporary profile refused Blob writes even in a tiny standalone IndexedDB-only probe; the same native probe committed successfully in a persistent test profile. This is recorded as a test-environment/storage limitation, not an iPhone pass.

Physical iPhone/Android photo-library behavior, HEIC-to-JPEG picker conversion, actual assistive technology, hardware memory pressure, real photo metadata varieties, browser eviction/power-loss durability and deployed acceptance remain unverified. Independent Argon review is required because this feature handles personal images. Nothing here authorizes a merge or deployment.

References: [createImageBitmap orientation](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap), [transaction completion](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event).

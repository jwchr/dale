# Owner-only corridor history (#250)

Built locally, not deployed or enabled. Jeff's November 21 clarification is
[on #250](https://github.com/jwchr/dale/issues/250): private means not public,
not hidden from the owner. This read door serves recorded corridor bus
observations to the owner and his authorized local tools. It contains no
rider records, ride-alert subscriptions, browser storage or rider GPS.

## Access

`GET /v1/owner/history` is off (404) unless the owner sets the Cloudflare
**secret** binding `OWNER_HISTORY_SECRET`. There is no default secret, UI
setting, URL token, account or new credential service. The owner generates a
strong random value and enters it directly in Cloudflare's secret interface,
never in chat, source, a plain Worker variable or the repository. Removing the
secret turns this door off. Setting/removing it changes the deployed Worker;
use the existing owner-approved deployment and continuity checks.

Send `Authorization: Bearer <owner-set value>` in a header from a local tool.
Do not put the value in a URL, command argument, shell history, public file,
screenshot or logs. A tool should ask for it using a hidden local prompt and
keep it in memory. Never paste it into this document or a PR. No actual secret
was read or set during implementation.

Missing/wrong authorization returns 401. Authentication runs at both the
router and Durable Object before a history read. WebCrypto HMAC verification
avoids a prefix-sensitive secret comparison. Responses are `private,
no-store`, vary on authorization, and carry no CORS grant. Browser-origin
requests are rejected; this endpoint is separate from the rider UI. Only GET
is supported. Unknown/duplicate query fields, token query parameters and
arbitrary object paths are rejected.

## Reading saved evidence

- No query, or `?after=<attempt milliseconds>`: up to four retained hot
  batches in ascending attempt order. Use `nextAfter` until null. Hot storage
  normally covers six hours; this does not claim a complete historical export.
- `?day=YYYY-MM-DD`: list up to 20 objects under that UTC archive day's
  existing `v1/<day>/batches/` prefix. `keys` contains only batch keys.
  Continue using the returned `nextAfter` with `day` until `truncated` is false.
  A cursor can end in `.manifest.json`; pages can contain no batch keys and
  still require continuation. UTC is the archive partition convention; the
  rider UI continues to use Eastern time.
- `?key=<listed batch key>`: read one immutable batch. The gzip and expanded
  body have hard size bounds (256 KB / 128 KB). Its expanded SHA-256 must match
  the existing content-addressed key before any evidence is returned.

Responses whitelist official GPS observations for routes 163, 164, 165 and
165T, with original bus/trip identity, source clocks, route, direction and
service date. An observation's stop sample is retained where present. Quality
fields are allowlisted. Arbitrary extensions and non-corridor records are
removed, including nested rider fields. This door is an observation reader,
not a full raw-bundle export: census, trip-update arrays and schedule objects
remain in the original private archive. It makes no claim that an empty
batch means no bus operated or that a sample is the exact arrival instant.

## Limits and preservation

Reads never call NJ Transit, collect a new sample, change a projection or
collector checkpoint, put/delete an archive object or change an original hot
batch. Authenticated archive reads reserve only operation-budget bookkeeping:
one list (Class A) or one object get (Class B) per request, before I/O, in the
existing persistent `dale_archive_days` ledger. Reservations include failed
or timed-out calls. They stop at half the existing rolling Free caps, leaving
headroom for collection. SQLite bookkeeping comes from spare writes and
leaves 2,500 units for other optional work. Denied budgets return 503, with no
archive I/O; there are no retries or paid overflow. A request has a five-second
archive deadline. Hot reads need no writes or R2 calls.

The existing deployment binding allowlist does not yet accept this new
secret name or the `EARLIER_BUSES` setting. Activation needs a reviewed
allowlist update, independent risky-change reviews, owner approval for what
goes live, and fresh capacity/continuity checks. This branch changes no
secrets, Wrangler bindings, collection setting or production behavior.

## Validation

`tests/unit/ownerHistory.test.ts` covers off/missing/wrong/right auth at both
boundaries, no CORS, browser-origin and mutation denial, strict queries,
private response headers, hot paging, field filtering, archive checksum and
size rejection, shared budget reservation/refusal, and no upstream fetch or
change to original history. All fixtures and credentials are synthetic.

Implementation references: [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
and [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

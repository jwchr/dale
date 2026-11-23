## What this does for you

When choosing a bus or viewing Bus Lock, see the latest five confirmed earlier
buses on the same route and direction today. Tap any listed bus for its own
scheduled time at your stop and Port Authority, the available observed stop
sample or last NJ Transit prediction, and each time's source and age. Missing
information stays unknown. A GPS stopped-at sample is not an exact actual
arrival time. Looking at earlier buses never changes the bus you locked.
English and Spanish are included.

Also adds the owner's private, read-only history door. It is off unless the
owner sets its secret directly in Cloudflare. It can page recorded corridor
bus observations from retained hot history and existing private archives.
It excludes rider data and adds no NJ Transit requests. Nothing is deployed
or enabled by this PR.

## How to try it

On the test build with synthetic history, or after a separately approved
activation with real history:

1. Open a saved bus commute toward Port Authority. Find **Earlier buses today**
   below the next arrivals. If history is off or unavailable, the app says so.
2. Tap each earlier bus, or focus its row and press Enter. Compare **Your stop**
   and **Port Authority**. Check scheduled, observed/expected and unknown times,
   plus source and age. No missing report should say cancelled.
3. Open a future bus and lock it. Open an earlier bus's times. The locked bus
   must stay the same.
4. Switch to Spanish, use a 320 px screen and enlarge text to 200%. Headings,
   times and sources should wrap inside their cards. The regression also
   covers 305 px, Verdana and every skin.

Owner-history access is a local-tool check rather than an app setting. Its
single access, paging and limits contract is [OWNER_HISTORY.md](../OWNER_HISTORY.md).
The owner sets any real secret directly, never in chat, source or a URL. Tests
exercise unset/missing/wrong/right authorization with synthetic credentials.

## Implementation and validation

- Reuses the existing collector and journal, a bounded daily projection and
  read-only public history answers. Checkpoint and projection commit together;
  denied writes/crashes do not advance them. Existing immutable archives stay
  intact. Eastern dates, after-midnight service, DST and schedule-context
  mismatch are covered by domain tests.
- Fixes Spanish enlarged-text overflow at the earlier-bus heading by wrapping
  panel content at its source. The commute-notice layout tests are unchanged.
- Corrects the earlier-bus lock test to ignore only normal `officialFeed`
  metadata updates, while asserting saved identity, lock and rider actions.
- TypeScript and **1,261 unit tests in 89 files pass**, including the real local
  Worker runtime suites, with writable temporary Wrangler paths. The test-app
  production build and Worker dry-run bundle also pass.
- Full `npm run verify` reaches `worker:check` and is blocked by the sandbox's
  denial of its `../.wrangler/check/README.md` output. The equivalent dry-run
  passes with output inside this worktree. Playwright cannot launch Chromium
  here (macOS MachPortRendezvous permission denied); phone layout, keyboard and
  accessibility tests need the lead's Mac run before this PR is ready.

## Remaining integration and release gates

The #252 just-left/chase row is not in this checkout. `EarlierBusDetails` is
exported for that row to reuse with its exact history record. Its integration
with #252 is not tested or claimed in this PR; never join history by route
alone or change the lock on disclosure. This PR makes every existing
Earlier buses row tappable.

The current deployment binding allowlist rejects the new setting/secret.
A separately reviewed activation change, fresh free-capacity/continuity
qualification, independent security/history reviews and the owner's decision
about what goes live remain required. No real secret, archive or production
setting was changed. This work is uncommitted for the lead to finish the git
and review steps.

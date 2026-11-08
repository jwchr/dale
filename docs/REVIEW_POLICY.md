# Review and release policy

Owner decisions D58/D59, November 7, 2026. These supersede D38's provider restriction and historical, time-limited Codex substitutions. They do not change product scope, ownership, spending or release authorization.

## Current provider hold

Jeff explicitly said: "don't let anyone use Gemini until I say it's ok."

Do not call Gemini, retry a staged request, poll its availability or automatically resume at a quota reset. Only Jeff's explicit release ends this hold. Preserve existing packets and results without starting another generation. Gemini's next authorized use is reserved for the Snowboard and autonomous-foundation plan/architecture reviews; those final decisions still wait for Jeff's release and their required Gemini review.

During this hold, routine Dale changes use CodeRabbit and high-risk implementation uses the **existing independent non-author Codex reviewer**. There is no requirement for a second provider or a retrospective Gemini rerun of a properly qualified implementation review. No new worker, timer, paid API, review add-on or service is authorized.

## Classify before dispatch

The existing non-author reviewer/release operator verifies and records the risk class and reason against the actual current PR diff. The source author cannot downgrade it alone. Unknown or mixed risk uses the high-risk route, regardless of line count.

| Class | Examples | Qualifying independent reviewer |
| --- | --- | --- |
| Routine | Bounded presentation, copy, ordinary tests or local refactoring without the risks below | CodeRabbit's actual GitHub App review |
| High-risk | Review policy/gates, workflows, security, permissions, secrets, privacy, data writes, destructive behavior, migrations, release automation, native/background location safety, sample/live integrity or material architecture | Authenticated Gemini 4 Argon; existing non-author Codex while the explicit owner hold above applies |

PR #108 is proposed high-risk because it combines local location/timer behavior, sample-versus-live boundaries and this review-policy migration. The non-author operator must confirm that classification. A small policy or safety change is still high-risk.

## Existing dispatch mechanism

Dale uses the existing reviewer and separate release operator; it has no automatic review-to-merge gate or unattended merger. GitHub Actions still runs the complete repository checks and publishes main to Pages. Neither Actions success nor this policy grants the author merge authority.

`.coderabbit.yaml` disables automatic opening/push reviews and automatic approvals. After independently confirming routine risk and review readiness, the operator requests **one** `@coderabbitai full review` on the PR. Inspect whether an equivalent current review is already running or complete first. Do not dispatch CodeRabbit for a high-risk PR just to duplicate its selected review. For an already-open PR that began under automatic settings, the operator/builder can post `@coderabbitai pause` before another push; verify the bot's acknowledgment. This prevents duplicate generation, not required review.

Manual review remains available with automatic reviews paused or disabled. No path exclusions are configured here. If provider defaults skip files, explicitly qualify coverage before release. Bot-generated copy must not silently change the approved PR scope. No autofix, approval or bulk-resolution command is part of this process; findings go back to the sole builder.

Supported controls: [CodeRabbit automatic review controls](https://docs.coderabbit.ai/configuration/auto-review), [configuration reference](https://docs.coderabbit.ai/reference/configuration), and [manual review/pause commands](https://docs.coderabbit.ai/guides/commands). Configuration alone does not prove an actual review ran.

## Qualify evidence, then release

1. The sole builder claims the eligible issue, retains the existing branch/PR, runs complete `npm run verify` before every push, and uses expected-head protection. At most one implementation PR is in flight.
2. Record the immutable head, current base, complete diff/file list and hash, and current PR title/body or hash. Scope changes require a fresh binding; changed commits/base invalidate the old clearance until independently qualified against the new diff. Reuse actual prior coverage where valid, but never relabel an old verdict as a new-head review.
3. The selected reviewer receives the full diff and necessary source context. CodeRabbit qualification requires genuine GitHub App provenance, completed review on the current commit, applicable full source coverage and review findings, not just a walkthrough, `COMMENTED`, green check or copied `CLEAN` text. Skipped, aborted, summary-only, rate-limited or incomplete reviews do not qualify. If generated outputs are excluded, verify them deterministically against their reviewed sources and record that evidence; unreviewed hand-written source is not a generated-output exception.
4. Review all current discussion and findings, including later comments. Fix each material finding or answer it with evidence accepted by the independent reviewer/operator. A previous clean verdict cannot override an unresolved finding. Cosmetic advisories can be recorded as nonblocking with reasons; do not hide or mass-resolve findings to obtain a green state.
5. For non-author Codex/Gemini, record the actual reviewer identity/provider, current head/base, full coverage and attributable result. A source-author assessment, provider-name string or forged marker is not independent review. Preserve existing provider authentication, model and budget checks.
6. The separate release operator freshly verifies risk, author/reviewer separation, exact head/base and PR scope, complete local checks, successful CI, review coverage/findings and applicable holds. It then performs the already-authorized squash merge with the expected head SHA. No self-merge, automatic approval/merge or change to permissions/protection rules.
7. Verify Pages completion and the actual public app separately, including narrow-phone English/Spanish behavior. Worker deployment, live feed checks, real-device/ride acceptance, rail access and collection/privacy holds remain separate and applicable. PR #108 does not change the Worker and needs no Worker deployment.

If a provider trial ends, quota is exhausted, full review is unavailable or provenance/coverage is insufficient, hold the affected release and name that precise gate. Never buy access, enable usage-based billing, add a fallback service or invent approval. Continue unrelated authorized work within the one-writer/one-PR limit.

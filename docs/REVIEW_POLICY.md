# Review and release policy

Owner decisions D58/D59, November 7, 2026, as amended by D64, November 11, 2026. These supersede D38's provider restriction and historical, time-limited Codex substitutions. They do not change product scope, ownership, spending or release authorization.

## Current provider route (D64, D65)

On November 11, 2026, Jeff lifted the Gemini hold: "You may use Gemini anytime you want." Gemini Pro, Gemini 4 Argon and Gemini 4 Carbon are available through the session's existing connected Gemini key (verified 2026-11-11: `gemini-pro-latest`, `gemini-4-argon`, `gemini-4-carbon`).

CodeRabbit reviews every PR. Each PR also gets one independent Gemini review, tiered by risk (D65):

| Tier | Model | Changes |
| --- | --- | --- |
| Easy | Gemini Pro (`gemini-pro-latest`) | Wording, layout, styling, tests, docs and small local refactors with none of the risks below |
| Harder | Gemini 4 Argon (`gemini-4-argon`) | Data pipeline, CI workflows, bus-lock and gate logic, review-policy text, sample/live integrity, release-path logging, and any unclear or mixed risk |
| Most serious | Gemini 4 Carbon (`gemini-4-carbon`) | Secrets, credentials or permissions; production deploy or rollback; the private history recorder and its storage (writes, deletes, cleanup); rider privacy or location; anything hard to undo; material architecture |

- When unsure between two tiers, use the higher one. If a model is unavailable or out of quota, move up a tier, never down, and say so on the PR.
- Every finding is a claim to check against the code before acting on it. This matters most for Carbon, which one independent report found more prone to unsupported factual claims than Argon.
- Codex is currently unavailable; Jeff expects it back in about three days (his estimate, around November 14). Once it is back, the builder may use the existing non-author Codex reviewer in place of the Argon or Carbon tier.
- The builder may call Gemini directly at any time. Dispatching a review does not make the builder the reviewer: the author still never approves, accepts its own findings responses, or merges. Record the model, response id, head/base and a hash of the exact diff sent on the PR.
- No mandatory extra provider beyond the above, and no retrospective rerun of a properly qualified review. No paid upgrade, credits, new worker, timer, review add-on or service.

The earlier D59 hold ("don't let anyone use Gemini until I say it's ok") and its reservation of the next Gemini use for other projects no longer apply.

## Classify before dispatch

The existing non-author reviewer/release operator verifies and records the risk class and reason against the actual current PR diff. The source author cannot downgrade it alone. Unknown or mixed risk uses the high-risk route, regardless of line count.

| Class | Examples | Qualifying independent reviewer |
| --- | --- | --- |
| Routine | Bounded presentation, copy, ordinary tests or local refactoring without the risks below | CodeRabbit's actual GitHub App review, plus Gemini Pro |
| High-risk | Review policy/gates, workflows, security, permissions, secrets, privacy, data writes, destructive behavior, migrations, release automation, native/background location safety, sample/live integrity or material architecture | CodeRabbit plus Gemini 4 Argon, or Gemini 4 Carbon for the most serious changes (see tiers above); the existing non-author Codex reviewer may take either slot when available |

PR #108 is proposed high-risk because it combines local location/timer behavior, sample-versus-live boundaries and this review-policy migration. The non-author operator must confirm that classification. A small policy or safety change is still high-risk.

## Existing dispatch mechanism

Dale uses the existing reviewer and separate release operator; it has no automatic review-to-merge gate or unattended merger. GitHub Actions still runs the complete repository checks and publishes main to Pages. Neither Actions success nor this policy grants the author merge authority.

`.coderabbit.yaml` disables automatic opening/push reviews and automatic approvals. Once a PR is ready for review, the builder or operator requests **one** `@coderabbitai full review` on it, whatever its risk class (D65). Inspect whether an equivalent current review is already running or complete first. For an already-open PR that began under automatic settings, the operator/builder can post `@coderabbitai pause` before another push; verify the bot's acknowledgment. This prevents duplicate generation, not required review.

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

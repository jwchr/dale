# Review and release policy

Owner decision of November 11, 2026. This replaces the earlier policy (D58, D59, D64, D65), including the separate release operator, the rule that an author never merges, the Gemini hold, and the Pro/Argon/Carbon tiers.

The rules are in `CLAUDE.md`, section "How we work". That section is the authority. In short, for Dale:

| Change | Review needed before the builder merges |
| --- | --- |
| Routine (wording, layout, ordinary tests, docs, small refactors) | Passing `npm run verify` and green CI on the final commit, plus one CodeRabbit full review with serious findings fixed or answered |
| Risky (money, secrets, rider privacy, deleting or overwriting data, the data pipeline, workflows and deploys, the Worker, live feeds, history collection, these rules, anything hard to undo or unclear) | All of the above, plus one independent review from Gemini 4 Argon, or from Codex when it is available |

- Gemini reviews use Argon only. Carbon and Pro are not used. No paid upgrade or new service.
- Request one `@coderabbitai full review` when the pull request is ready. `.coderabbit.yaml` keeps automatic reviews off, so it does not start by itself. Never request a duplicate.
- Check every finding against the code before acting on it.
- The builder squash-merges its own pull request once the checks pass, then confirms the public Pages site shows the change.
- The owner is never asked to read reviews, comment or merge.

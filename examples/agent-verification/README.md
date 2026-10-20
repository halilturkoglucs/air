# Agent-written replacement check

This example compares an ordinary replacement against an immutable legacy baseline. Neither implementation imports AIR and no Application IR is required.

`air check` is currently an unreleased source preview. From the AIR repository, install and build once with `pnpm install && pnpm build`, then use `pnpm air` as shown below:

```bash
pnpm air check validate examples/agent-verification/check.yaml \
  --policy examples/agent-verification/policy.yaml --json
pnpm air check baseline examples/agent-verification/check.yaml \
  --target examples/agent-verification/legacy.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/example-1/baseline --json
pnpm air check run examples/agent-verification/check.yaml \
  --baseline .air/check/example-1/baseline \
  --target examples/agent-verification/candidate.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/example-1/run --json
pnpm air check explain .air/check/example-1/run/result.json --json
```

The final result should pass. Run baseline creation from a clean tracked tree. AIR refuses to overwrite either output directory. Delete neither an approved baseline nor its Git history to “update” behavior; create and review a new pack instead.

For a deliberately failing candidate, HTTP service configuration, normalization examples, CI exit codes, and a guide to adapting the harness, continue with [Getting started with agent verification](../../docs/getting-started-agent-verification.md).

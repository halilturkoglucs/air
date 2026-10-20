# Agent-written replacement check

This example compares an ordinary replacement against an immutable legacy baseline. Neither implementation imports AIR and no Application IR is required.

```bash
air check validate examples/agent-verification/check.yaml \
  --policy examples/agent-verification/policy.yaml --json
air check baseline examples/agent-verification/check.yaml \
  --target examples/agent-verification/legacy.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/baseline --json
air check run examples/agent-verification/check.yaml \
  --baseline .air/check/baseline \
  --target examples/agent-verification/candidate.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/run --json
air check explain .air/check/run/result.json --json
```

Run baseline creation from a clean tracked tree. AIR refuses to overwrite either output directory. Delete neither an approved baseline nor its Git history to “update” behavior; create and review a new pack instead.

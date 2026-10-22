# Driving `air check` by hand

`air protect` runs these steps for you. This page shows the underlying commands for CI pipelines and for people who want full control over each artifact. Moved here unchanged from the README.

## Steps

Install AIR v0.13 with Node.js 22 or newer, then clone the repository for the included example files:

```bash
npm install --global @halilturkoglucs/air@0.17.0
git clone https://github.com/halilturkoglucs/air.git
cd air
air --version
```

Then run the included legacy-versus-candidate example:

```bash
# 1. Validate the reviewed scenarios and policy.
air check validate examples/agent-verification/check.yaml \
  --policy examples/agent-verification/policy.yaml --json

# 2. Execute only the legacy implementation and freeze its behavior.
air check baseline examples/agent-verification/check.yaml \
  --target examples/agent-verification/legacy.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/tutorial-1/baseline --json

# 3. Execute the same scenarios against an ordinary replacement.
air check run examples/agent-verification/check.yaml \
  --baseline .air/check/tutorial-1/baseline \
  --target examples/agent-verification/candidate.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/tutorial-1/run --json

# 4. Turn the machine-readable result into an actionable explanation.
air check explain .air/check/tutorial-1/run/result.json --json
```

The result should contain `"passed": true`. AIR does not overwrite baselines or results; use a new output name such as `tutorial-2` when repeating the walkthrough.

Continue with the [from-scratch agent verification tutorial](getting-started-agent-verification.md). It includes a deliberately broken migration, command and HTTP target examples, normalization, environment variables, CI behavior, troubleshooting, and guidance for adapting the workflow to your own service.

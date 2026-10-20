# Agent verification

AIR’s v0.12 product direction is simple: **AI writes the migration. AIR proves what changed.**

AIR does not decide that a replacement is generally correct. It checks equivalence only inside a reviewed observation boundary. Anything outside that boundary remains unproven.

## Trust model

- A check declares scenarios, observable categories, and bounded normalization.
- A target declares reviewed argv commands or an HTTP endpoint. AIR never invokes an implicit shell and target files contain environment-variable references rather than credential values.
- `air check baseline` executes only the legacy target and writes a content-addressed, overwrite-protected pack. Clean tracked trees are required by default.
- `air check run` executes the same scenarios against the candidate without modifying the baseline.
- Baseline, check, policy, normalization, discovery, and repository hashes make stale or tampered evidence fail closed.
- Stored observations contain structure, types, sizes, and SHA-256 leaf digests. Raw rows, messages, payloads, headers, and credentials are absent by default.

The supported normalization language is deliberately small: reasoned ignored JSON pointers, typed UUID/timestamp tokens, named value bindings, and arrays declared unordered by a key. AIR does not run normalization scripts or regular expressions and does not accept percentage similarity or LLM equality judgments.

## Agent and CI protocol

Every command supports stable JSON output. Exit codes are:

- `0`: the command succeeded and a candidate check passed;
- `1`: behavioral or policy differences;
- `2`: invalid or stale input, including a tampered baseline;
- `3`: target, lifecycle, readiness, or capture infrastructure failure.

`air check explain` labels each difference as `candidate-difference`, `baseline-stale`, `missing-observation`, `policy-violation`, or `infrastructure-error`, and says whether an agent should fix candidate code or repair the harness.

See the [five-minute command-target example](../examples/agent-verification/README.md). Discovery is optional: `air check init` can prepare a review candidate from a discovered capability, while teams may author a check directly around an existing harness.

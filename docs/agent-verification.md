# Agent verification

AIR’s v0.12 product direction is simple: **AI writes the migration. AIR proves what changed.**

AIR does not decide that a replacement is generally correct. It checks equivalence only inside a reviewed observation boundary. Anything outside that boundary remains unproven.

If this is your first time using AIR, begin with the [from-scratch tutorial](getting-started-agent-verification.md). It builds the source preview, creates a baseline, checks an equivalent replacement, and demonstrates a detected defect before introducing HTTP targets and CI.

## Core objects

- A **check** defines a capability, its scenarios, the observation boundary, and bounded normalization.
- A **target** defines how AIR invokes either the legacy or candidate implementation. It contains explicit argv or an HTTP base URL reference, never an implicit shell command.
- A **policy** states what evidence is mandatory and which normalization forms reviewers permit.
- A **baseline** is an immutable, content-addressed digest of legacy observations.
- A **result** compares candidate observations to that baseline and categorizes every mismatch.

## Trust model

- A check declares scenarios, observable categories, and bounded normalization.
- A target declares reviewed argv commands or an HTTP endpoint, plus explicit per-scenario process or reset-command fixture isolation for observable effects. AIR never invokes an implicit shell and target files contain environment-variable references rather than credential values.
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

## What a passing result means

A pass means the candidate matched the approved baseline for every declared scenario and observation after the declared deterministic normalization. It does not prove that the legacy behavior is correct, that undiscovered scenarios behave the same, or that production infrastructure will have identical performance and availability.

This is why AIR keeps the scenario set, observation boundary, policy, normalization, and baseline hashes together. Expanding or weakening any of them requires a new reviewed baseline rather than silently reusing old evidence.

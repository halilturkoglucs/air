# Language-agnostic agent protocol

AIR does not need to understand the implementation language of a legacy or candidate backend. Its stable boundary is a reviewed check plus either an explicit command adapter or an HTTP adapter. A coding agent can use that boundary through the CLI's JSON output without importing an AIR runtime, generating AIR application YAML, or using a particular model provider.

## The portable contract

A command target may be a Java JAR, Python module, Go or Rust binary, Node program, .NET executable, test runner, or container wrapper. AIR:

1. starts the exact reviewed `argv` array with no implicit shell;
2. appends the scenario arguments;
3. writes the scenario input as one JSON value to standard input;
4. expects exactly one JSON observation object on standard output;
5. treats diagnostic output as standard error;
6. treats non-zero exit, timeout, invalid JSON, or oversized output as an infrastructure failure.

The adapter is deliberately thin. It drives the real capability, resets an isolated fixture, and reports only the categories selected by the check: `http`, `database`, `messages`, `outbound`, `ordering`, `failures`, and `retryability`. It does not reimplement business logic.

```yaml
apiVersion: air.dev/check-target/v0.1
kind: CheckTarget
metadata: { name: legacy-capability }
spec:
  type: command
  fixtureIsolation: process
  workingDirectory: verification
  environment:
    DATABASE_URL: { fromEnv: LEGACY_DATABASE_URL }
  command:
    argv: [java, -jar, legacy-harness.jar]
```

Replace the final `argv` with `[python, -m, harness]`, `[./target/release/harness]`, `[./harness-go]`, `[dotnet, Harness.dll]`, or any other explicit executable. The check, policy, baseline, result format, and agent loop stay unchanged.

For a running service, an HTTP target invokes reviewed requests directly. When the boundary includes state, messages, or outbound calls, the service exposes a test-only observation endpoint and declares explicit reset/readiness lifecycle commands. Production endpoints do not need to depend on AIR.

## The model-neutral agent loop

Give an LLM access to the repository, a disposable test environment, and the `air` executable. The agent should:

1. validate the human-reviewed check and policy;
2. create or select a thin adapter around the legacy capability;
3. create the baseline once, then treat it as read-only;
4. implement the candidate in the repository's chosen language and framework;
5. run the candidate against the baseline with `air check run --json`;
6. use `air check explain --json` to decide whether to fix candidate code or the harness;
7. repeat only the candidate run until it passes.

The minimum tool surface is ordinary process execution:

```text
air check validate CHECK --policy POLICY --json
air check baseline CHECK --target LEGACY --policy POLICY --output BASELINE --json
air check run CHECK --baseline BASELINE --target CANDIDATE --policy POLICY --output RUN --json
air check explain RUN/result.json --json
```

Agents must preserve the exit-code contract: `0` pass, `1` behavioral or policy difference, `2` invalid or stale evidence, and `3` harness or infrastructure failure. They must never repair a failing candidate by modifying the baseline, weakening policy, or adding normalization unless a human explicitly reviews the behavioral change.

## Why the protocol remains language-neutral

- The wire values are JSON and versioned YAML/JSON documents.
- Target execution is argv or HTTP, not a language SDK.
- Secrets remain environment-variable references.
- Observation comparison is structural and deterministic; no LLM judges equality.
- Generated UUIDs and timestamps can be type-checked and correlated without requiring equal values across implementations.
- PostgreSQL, broker, and outbound-call evidence is supplied by adapters, so the application runtime does not need AIR libraries.

The v0.12 release proof exercises the same protocol across a Spring/Java/PostgreSQL legacy capability and an agent-written TypeScript/PostgreSQL replacement. The pinned HMCTS proof wraps real Java service classes with a separate harness and compares them with another ordinary replacement. Those examples demonstrate cross-language verification; they do not make Java or TypeScript part of the product contract.

## Recommended prompt for a coding agent

```text
Use AIR as the independent verification oracle for this capability. Do not modify
the approved baseline, check, or policy. Implement or repair the candidate in the
repository's existing language. Run `air check run ... --json`; when it fails,
run `air check explain ... --json`. Fix candidate code for candidate differences,
and report infrastructure or missing-observation failures instead of weakening the
check. A pass proves equivalence only for the declared scenarios and observations.
```

Thin MCP servers or agent skills may wrap these commands later, but the CLI protocol remains the compatibility boundary so Codex, Claude, local models, CI systems, and future agents all receive the same evidence.

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

## Compact agent mode (`air.dev/agent/v1`)

The full JSON above is the audit format. For a repair loop, agents should use the compact mode instead: it needs no arguments after a one-time profile, stays inside a line budget, and reports progress between runs.

```text
air check profile --check CHECK --policy POLICY --baseline BASELINE --legacy LEGACY --candidate CANDIDATE --output RUNS
air check baseline                 # once, from the legacy target in the profile
air check run --agent --reveal     # repeat until exit 0
air check status                   # last run summary; executes nothing
```

`air check run --agent` prints one header line, one block per failing scenario, and a `NEXT` line:

```text
FAIL 0/1 scenarios · 4 differences · fixed 2, new 0 since last run
- creates-book
  /database/rows/0 (3): expected {"state":"created","version":1,...}, got {"state":"draft","version":2,...}
  /http/status: expected 201, got 200
NEXT edit candidate code only, then rerun `air check run --agent`.
```

- Output is deterministic: scenarios follow the check order and selectors are sorted. Three or more differences under one parent collapse into that parent with a count.
- `--max-lines N` (default 40) caps the report; overflow becomes `...(+N more)`. Infrastructure errors shrink to the first line and the causing error.
- `--reveal` re-runs the legacy target locally for the failing scenarios only and prints expected and actual values. Values go to stdout only; `result.json` and the baseline keep digests. The legacy re-run must still match the approved baseline digest, otherwise values are withheld with a `NOTE`. A policy can forbid reveal with `reveal: deny`; a legacy target that uses evidence capture requires `reveal: allow`.
- `fixed`/`new` compare against `.air/last-run.json` for the same baseline, so a repair round reports what it resolved.
- `--agent --json` returns the same report as JSON with short, stable keys (`v`, `ok`, `passed`, `total`, `differences`, `fixed`, `added`, `diffs[{s,p,k,n,e,a}]`, `omitted`, `notes`, `next`).

In AIR's LLM verification-lift benchmark, this feedback style (compact, value-revealing differences) took Claude Sonnet 5.5 from 0/9 to 9/9 behaviorally correct migrations.

### MCP without extra dependencies

`air mcp` serves four tools over MCP stdio from the same binary: `air_check_status`, `air_check_run` (`reveal`, `maxLines`), `air_check_explain`, and `air_check_baseline`. They wrap the compact mode above.

```bash
claude mcp add air -- air mcp
codex mcp add air -- air mcp
```

## Why the protocol remains language-neutral

- The wire values are JSON and versioned YAML/JSON documents.
- Target execution is argv or HTTP, not a language SDK.
- Secrets remain environment-variable references.
- Observation comparison is structural and deterministic; no LLM judges equality.
- Generated UUIDs and timestamps can be type-checked and correlated without requiring equal values across implementations.
- PostgreSQL, broker, and outbound-call evidence is supplied by adapters, so the application runtime does not need AIR libraries.

The v0.12 release proof exercises the same protocol across a Spring/Java/PostgreSQL legacy capability and an agent-written TypeScript/PostgreSQL replacement. The pinned HMCTS proof wraps real Java service classes with a separate harness and compares them with another ordinary replacement. Those examples demonstrate cross-language verification; they do not make Java or TypeScript part of the product contract.

## Recommended instructions for a coding agent

`air agent instructions` prints the canonical repair loop for the installed version. Paste it into `AGENTS.md`, `CLAUDE.md`, or a skill; nothing else needs to be installed. A pass proves equivalence only for the declared scenarios and observations.

The MCP tools and the instructions are thin wrappers: the CLI protocol remains the compatibility boundary, so Codex, Claude, local models, CI systems, and future agents all receive the same evidence.

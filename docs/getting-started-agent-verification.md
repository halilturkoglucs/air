# Getting started with agent verification

This tutorial starts with no AIR application model. You will freeze the observable behavior of a small legacy capability, compare an ordinary replacement, make the replacement intentionally wrong, and see AIR identify the difference.

The workflow is:

```text
reviewed scenarios + policy
          │
          ├── legacy target ──> immutable baseline
          │
          └── candidate target ──> result + categorized differences
```

AIR does not generate the candidate and neither implementation imports an AIR runtime.

## 1. Prerequisites

You need:

- Git;
- Node.js 22 or newer;
- AIR v0.13.

Install AIR, then clone the repository for the tutorial fixtures:

```bash
npm install --global @halilturkoglucs/air@0.14.0
git clone https://github.com/halilturkoglucs/air.git
cd air
air --version
```

## 2. Understand the four input files

The example lives in `examples/agent-verification`:

| File | Purpose |
| --- | --- |
| `check.yaml` | Names the capability, scenarios, observation categories, and deterministic normalization rules. |
| `policy.yaml` | Requires important scenarios and observations and limits which normalization rules reviewers may accept. |
| `legacy.target.yaml` | Tells AIR exactly how to execute the legacy implementation. |
| `candidate.target.yaml` | Tells AIR exactly how to execute the replacement. |

The implementations are ordinary Node.js programs. Each receives scenario input as JSON on standard input and prints one JSON observation object on standard output.

## 3. Validate the check before executing code

```bash
air check validate examples/agent-verification/check.yaml \
  --policy examples/agent-verification/policy.yaml \
  --json
```

Expected result:

```json
{"ok":true,"check":".../examples/agent-verification/check.yaml","violations":[]}
```

Validation checks the closed schemas and policy. Unknown keys, forbidden normalization, missing required scenarios, and missing observation categories fail before either target runs.

## 4. Freeze legacy behavior

Baseline creation runs only the legacy target:

```bash
air check baseline examples/agent-verification/check.yaml \
  --target examples/agent-verification/legacy.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/tutorial-1/baseline \
  --json
```

By default, the tracked Git tree must be clean. The resulting `baseline.json` is content-addressed and records hashes for the check, policy, normalization, target, repository, and discovery input when present. AIR refuses to overwrite it.

Inspect the pack:

```bash
less .air/check/tutorial-1/baseline/baseline.json
```

The pack contains structural observations, types, sizes, and SHA-256 leaf digests. It does not contain raw rows, messages, response values, credentials, or payloads by default.

## 5. Check an equivalent replacement

```bash
air check run examples/agent-verification/check.yaml \
  --baseline .air/check/tutorial-1/baseline \
  --target examples/agent-verification/candidate.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/tutorial-1/run \
  --json
```

The result should contain:

```json
{"passed":true,"mismatches":[]}
```

Ask AIR to explain it:

```bash
air check explain .air/check/tutorial-1/run/result.json --json
```

Generated UUIDs and timestamps differ on every execution. The check uses typed tokens with named bindings, so AIR verifies that each value is valid and remains correlated across the response, database row, message, and outbound call without requiring the legacy and candidate to generate identical values.

## 6. Deliberately break the candidate

The benchmark candidate has 15 selectable defects. Create a temporary target that chooses the `response-status` defect:

```bash
mkdir -p .air/check
cp benchmarks/capability-replacement/candidate.target.yaml \
  .air/check/mutant-response-status.target.yaml
perl -0pi.bak -e 's/equivalent/response-status/' \
  .air/check/mutant-response-status.target.yaml
```

Create a matching benchmark baseline:

```bash
air check baseline benchmarks/capability-replacement/check.yaml \
  --target benchmarks/capability-replacement/legacy.target.yaml \
  --policy benchmarks/capability-replacement/policy.yaml \
  --output .air/check/mutant-1/baseline \
  --json
```

Run the broken candidate:

```bash
air check run benchmarks/capability-replacement/check.yaml \
  --baseline .air/check/mutant-1/baseline \
  --target .air/check/mutant-response-status.target.yaml \
  --policy benchmarks/capability-replacement/policy.yaml \
  --output .air/check/mutant-1/run \
  --json
```

The command exits `1`, which is expected. Explain the failed result:

```bash
air check explain .air/check/mutant-1/run/result.json --json
```

The explanation identifies `/http/status` as a `candidate-difference` and recommends repairing candidate code. Other benchmark modes include `missing-write`, `rollback`, `outbound-order`, `message-duplication`, `failure-mapping`, `idempotency`, and `id-correlation`.

To exercise all 15 defects and 20 clean reruns:

```bash
pnpm exec vitest run tests/enterprise-discovery.test.ts \
  -t "detects all 15 capability-replacement mutants and passes 20 clean reruns"
```

## 7. Adapt a command target to your own capability

A command target is the easiest integration point for jobs, workers, service methods, and test fixtures. It can invoke any language:

```yaml
apiVersion: air.dev/check-target/v0.1
kind: CheckTarget
metadata:
  name: legacy-delete-expired-documents
spec:
  type: command
  fixtureIsolation: process
  workingDirectory: verification-harness
  command:
    argv: [java, -jar, legacy-harness.jar]
    environment:
      DATABASE_URL:
        fromEnv: LEGACY_DATABASE_URL
```

For every command scenario, AIR:

1. appends the scenario's `arguments` to the reviewed `argv` array;
2. sends the scenario's `input` as JSON on standard input;
3. expects one JSON observation object on standard output;
4. treats a non-zero exit, invalid JSON, timeout, or oversized output as an infrastructure failure.

A stateful command should start from a fresh process for each scenario or declare an explicit reset command. The implementation may be a small test harness around the real application; it does not need to change production code.

An observation can contain only the categories declared by the check:

```json
{
  "http": {"status": 201, "body": {"id": "..."}},
  "database": {"rows": [{"id": "...", "state": "created"}]},
  "messages": [{"type": "document.created", "id": "..."}],
  "outbound": [{"operation": "vendor.authorize", "status": 200}],
  "ordering": ["database", "outbound", "message"],
  "failures": [{"code": "vendor-unavailable", "status": 503}],
  "retryability": true
}
```

Use environment-variable references rather than putting credentials in target YAML. AIR passes only a small safe base environment plus explicitly mapped names to child commands.

## 8. Adapt an HTTP service

An HTTP check sends the same request to legacy and candidate base URLs. If the check observes only the HTTP response, a target can be as small as:

```yaml
apiVersion: air.dev/check-target/v0.1
kind: CheckTarget
metadata:
  name: legacy-orders
spec:
  type: http
  baseUrlEnv: LEGACY_ORDERS_URL
```

The corresponding scenario is explicit:

```yaml
spec:
  scenarios:
    - id: creates-order
      request:
        kind: http
        method: POST
        path: /orders
        headers:
          x-test-tenant: air
        body:
          sku: example
          quantity: 2
  observations: [http]
```

For database, message, outbound, ordering, failure, or retry observations, the target must also declare deterministic fixture isolation. A typical controlled-test target is:

```yaml
spec:
  type: http
  baseUrlEnv: LEGACY_ORDERS_URL
  fixtureIsolation: reset-command
  workingDirectory: verification-harness
  lifecycle:
    reset:
      argv: [node, reset-fixture.mjs]
      environment:
        DATABASE_URL:
          fromEnv: LEGACY_DATABASE_URL
    readiness:
      path: /health
      timeoutMs: 30000
  observationPath: /_air/observations/{scenario}
```

Before each scenario AIR runs the explicit reset command. It captures the response itself, then requests the observation endpoint for the non-HTTP categories. The observation endpoint is a test adapter and should expose only redacted, allowlisted evidence from disposable infrastructure.

Run the same check twice with different target files:

```bash
LEGACY_ORDERS_URL=http://127.0.0.1:8080 \
LEGACY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/legacy_fixture \
air check baseline check.yaml --target legacy.target.yaml \
  --policy policy.yaml --output .air/check/orders-1/baseline --json

CANDIDATE_ORDERS_URL=http://127.0.0.1:3000 \
CANDIDATE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/candidate_fixture \
air check run check.yaml --baseline .air/check/orders-1/baseline \
  --target candidate.target.yaml --policy policy.yaml \
  --output .air/check/orders-1/run --json
```

Legacy and candidate fixtures must be isolated. Shared databases or ambiguous observations should be treated as a broken harness, not equivalence evidence.

## 9. Choose normalization carefully

AIR supports only deterministic, reviewable normalization:

- `typed-token` verifies UUIDs or UTC timestamps and can bind the same generated value across several locations on each side;
- `unordered-array` sorts an array by a declared unique key;
- `ignore` removes one JSON pointer and requires a written reason.
- `rename` moves a value to a canonical pointer with a written reason, for example a table that moved to another service's database (`/database/billing_invoices` to `/database/invoices`); it is a no-op where the pointer is absent and fails if the destination already exists;
- `internal-boundary` drops array items that match a subset pattern, with a written reason, for calls or steps that became internal when a service was extracted or merged (for example `match: { service: billing }` on `/outbound`).

For topology changes, a target can also start supporting processes with `lifecycle.services` (each with an optional `readinessUrl`) so a candidate made of several services runs together. See `examples/extract-service` for a monolith-to-service split.

AIR does not run regular expressions, scripts, LLM judgments, percentage similarity, or arbitrary comparison code. Keep policies narrow; an ignored value is an unproven value.

## 10. Use it from an agent or CI

All check commands support `--json`. Standard output is reserved for stable machine-readable output. Exit codes are:

| Exit | Meaning | Usual action |
| --- | --- | --- |
| `0` | Valid input or equivalent candidate | Continue the pipeline. |
| `1` | Behavioral or policy difference | Fix candidate code or review the declared policy. |
| `2` | Invalid, stale, or tampered input | Repair the check, policy, or baseline. |
| `3` | Lifecycle, readiness, target, or capture failure | Repair the harness or infrastructure. |

A CI step can therefore invoke the same command used locally:

```bash
air check run checks/orders/check.yaml \
  --baseline checks/orders/baseline \
  --target checks/orders/candidate.target.yaml \
  --policy checks/orders/policy.yaml \
  --output .air/check/ci-run \
  --json
```

Commit reviewed check and policy files. Store approved baselines according to your evidence-retention policy, and generate a new baseline pack when accepted behavior changes. Do not mutate an old pack to make a candidate pass.

## 11. Start from discovery when useful

Discovery is optional. If AIR has already mapped a service, it can prepare a review candidate for one capability:

```bash
air discover spring ../legacy-orders \
  --output .air/discovery \
  --analyzer openrewrite
air workbench .air/discovery --reviewer alice@example.com
air check init .air/discovery \
  --capability endpoint:reviewed-id \
  --output .air/check/orders
```

`check init` does not authorize discovered behavior. Review and replace the generated `review-me` scenario, observation list, and any normalization before creating a baseline.

## Troubleshooting

### “Policy requires a clean tracked tree”

Commit or stash tracked changes before creating an approved baseline. `--allow-dirty` is useful for local experimentation, but marks the pack non-releasable and a strict policy rejects it.

### “Output already exists”

Baselines and results are overwrite-protected. Choose a new output directory such as `tutorial-2`; do not edit an approved baseline in place.

### `baseline-stale`

The check, policy, normalization, discovery input, or baseline content changed. Generate and review a new baseline rather than waiving the mismatch.

### `missing-observation`

The target failed to report a category required by the check. Usually the harness or observation adapter needs repair.

### `infrastructure-error`

Look at target startup, readiness, reset commands, credentials referenced through the environment, timeouts, and disposable dependencies. This category is not a candidate behavior difference.

## Next reading

- [Agent verification trust model](agent-verification.md)
- [Enterprise discovery and modernization](enterprise-modernization.md)
- [Product roadmap](roadmap.md)
- [Example source](../examples/agent-verification/README.md)
- [Mutation benchmark](../benchmarks/capability-replacement/README.md)

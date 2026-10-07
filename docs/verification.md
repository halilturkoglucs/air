# Verification IR

Compilation answers “can this target represent and emit the application?” Verification answers “do the declared behaviors produce the expected observations?” They are separate gates.

## Suite format

`air.dev/verification/v0.1` defines target-independent scenarios. Each scenario provides:

- command input
- optional typed principal
- initial entity state
- expected output or declared error
- optional expected post-state

```yaml
apiVersion: air.dev/verification/v0.1
kind: VerificationSuite
scenarios:
  - id: transferMovesFundsAtomically
    command: transferFunds
    given:
      principal: { ownerId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa }
      input:
        transferId: 33333333-3333-4333-8333-333333333333
        fromAccountId: 11111111-1111-4111-8111-111111111111
        toAccountId: 22222222-2222-4222-8222-222222222222
        amount: 30
        expectedFromVersion: 0
        expectedToVersion: 0
        idempotencyKey: 44444444-4444-4444-8444-444444444444
        ownerId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
      state: {}
    expect:
      output: {}
      state: {}
```

The complete ledger suite is in [`examples/ledger/verification.yaml`](../examples/ledger/verification.yaml).

## Canonical executor

`@air/verifier` implements the command semantics without depending on Next.js, Rust, SQL, or HTTP. It clones initial state, applies authentication/authorization, replay, guards, record selection, invariants, preconditions, named mutations, and the primary effect. Any declared domain error returns the original state, making rollback observable.

Generated UUIDs and timestamps are deterministic unless the caller supplies alternatives. Comparisons use exact JSON-compatible values and entity-array order from the suite.

## Evidence

```bash
air verify examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --output evidence.json
```

Evidence format `air.dev/verification-evidence/v0.1` records:

- SHA-256 of the AIR source and verification suite
- AIR/suite API versions and verifier version
- pass/fail totals
- every scenario diagnostic
- actual output/error and actual post-state

The writer refuses to overwrite existing evidence.

## Live target verification

`air verify-live` runs the same suite against a generated service and PostgreSQL. Before each scenario it resets the AIR-owned tables to `given.state`, signs the optional principal as an HS256 bearer token, calls the command's declared HTTP operation, reads persisted rows back, normalizes database representations such as PostgreSQL `BIGINT`, and compares the HTTP result and post-state. Valid target-generated UUID/timestamp fields are treated as generated observations rather than fixed canonical values.

Use a dedicated disposable database. The acknowledgement flag is mandatory because this command deletes rows from every AIR entity table:

```bash
AIR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/air_conformance \
AIR_AUTH_SECRET=test-secret-at-least-32-characters \
air verify-live examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --base-url http://127.0.0.1:3000 \
  --allow-database-reset \
  --output live-evidence.json
```

Live evidence uses `air.dev/live-verification-evidence/v0.1` and records the target URL, source hashes, HTTP statuses, diagnostics, actual responses, and actual database state. Database credentials and the auth secret are never written to evidence.

## Differential verification

`air verify-differential` runs every scenario concurrently across two or more live targets. Each target must first match the canonical AIR expectation; the verifier then compares target-to-target HTTP status, error/output, and normalized persisted state. Target-generated UUIDs and timestamps are validated and normalized, while scenario-provided identifiers and other values remain exact.

Every target needs a distinct disposable database:

```bash
AIR_AUTH_SECRET=test-secret-at-least-32-characters \
air verify-differential examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --target nextjs=http://127.0.0.1:3001 \
  --database-url nextjs=postgres://postgres:postgres@127.0.0.1:5432/air_nextjs \
  --target rust=http://127.0.0.1:3000 \
  --database-url rust=postgres://postgres:postgres@127.0.0.1:5432/air_rust \
  --allow-database-reset \
  --output differential-evidence.json
```

The command rejects duplicate names, missing database mappings, shared database URLs, and invocations without the reset acknowledgement. Evidence format `air.dev/differential-verification-evidence/v0.1` includes target names and URLs but excludes database URLs and secrets.

## Live replay benchmark

`air benchmark-live` only accepts a scenario whose `given.state` already contains the command's scoped idempotency record. This makes every measured request a semantically validated replay with no intended state mutation. The runner performs a canonical live check, resets the fixture, warms up, sends a fixed number of requests through bounded concurrent workers, validates every response, confirms final state is unchanged, and calculates min/mean/p50/p95/p99/max latency plus throughput.

Evidence format `air.dev/live-benchmark-evidence/v0.1` includes source hashes, workload parameters, raw latency samples, aggregates, target URL, and runner environment. It excludes database URLs and secrets. This first workload does not measure the full mutation transaction path; see [benchmarking methodology](benchmarking.md).

With `--workload mutation`, the runner derives independent fixtures from a canonical success scenario. UUID inputs and referenced records become deterministic per request, the canonical executor calculates every expected output and post-state, and the live target receives the combined fixture. Retryable HTTP 409 responses are retried up to `--client-retries`; evidence records both logical requests and total HTTP attempts. A run passes only when every logical request commits and the complete aggregate database state matches the canonical result.

## Evidence packs

`air evidence-pack` copies semantic, live, differential, and benchmark evidence into a new immutable directory. It rejects incompatible AIR or suite hashes and writes `manifest.json` with a SHA-256 checksum for every artifact. `air evidence-verify <directory>` reparses the evidence formats, checks source identities, rejects unsafe or duplicate paths, and fails if any artifact checksum changed.

The repository's [conformance workflow](../.github/workflows/conformance.yml) generates both targets from scratch, applies isolated PostgreSQL databases, runs native target gates, waits for database-backed readiness, executes differential conformance and a replay benchmark, verifies the evidence pack, and uploads the pack plus runtime logs.

## Runtime probes

Generated targets reserve `/air-runtime` for operational controls:

- `GET /air-runtime/health` reports process liveness without touching dependencies.
- `GET /air-runtime/ready` executes a PostgreSQL query and returns `503` with a retryable `DATABASE_UNAVAILABLE` error until the database is reachable.

Rust additionally supports `AIR_PORT`, JSON tracing, SIGINT graceful shutdown, and an in-binary container healthcheck. Node deployments include a standalone multi-stage Dockerfile and healthcheck. AIR applications cannot declare routes inside the reserved namespace.

## Conformance levels

1. **Semantic:** the suite passes in the canonical executor.
2. **Generated:** target source contains and tests the required lowering.
3. **Build:** the emitted target installs/typechecks/compiles.
4. **Integration:** the generated API and database pass equivalent scenarios.
5. **Differential:** two or more targets receive the same request stream and normalized observations match.

The ledger currently has semantic, build, live integration, and automated differential conformance for Next.js/PostgreSQL, Rust/PostgreSQL, and Python/PostgreSQL. Replay and isolated-mutation measurements are reproducible; controlled conflict mixes and resource sampling remain open.

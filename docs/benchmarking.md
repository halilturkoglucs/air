# Benchmarking AIR targets

Performance results are only meaningful after semantic and differential conformance pass. AIR's first benchmark workload therefore reuses a canonical verification scenario and accepts only an idempotent replay state. Every measured request must return the expected response, and persisted state must remain unchanged.

## Reproducible replay workload

```bash
AIR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/air_target \
AIR_AUTH_SECRET=test-secret-at-least-32-characters \
air benchmark-live examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --scenario transferReplaysIdempotentResult \
  --base-url http://127.0.0.1:3000 \
  --warmup 25 \
  --requests 500 \
  --concurrency 10 \
  --allow-database-reset \
  --output benchmark-evidence.json
```

The measured interval excludes fixture reset, baseline conformance, warmup, and final state inspection. It includes client-side loopback time, HTTP handling, JWT verification, transaction setup, the scoped idempotency query, serialization, and connection-pool behavior. Workers keep at most `concurrency` requests in flight.

## Initial local baseline

On 2026-10-06, the generated ledger targets were built in production/release mode and run sequentially against separate databases on the same local PostgreSQL 16 server. The benchmark client used Node.js 22.18.0 on Darwin arm64. Both targets had already passed the three-scenario differential suite.

| Target | Build | Requests | Concurrency | Throughput | Mean | p50 | p95 | p99 | Max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Next.js 16.3.8 | production | 500 | 10 | 1,362.40 req/s | 7.30 ms | 6.98 ms | 10.05 ms | 12.17 ms | 13.24 ms |
| Rust 1.99 / Axum | release | 500 | 10 | 4,383.62 req/s | 2.24 ms | 2.24 ms | 3.41 ms | 4.39 ms | 4.48 ms |

The corresponding emitted artifacts were approximately 41 MB for the Next.js standalone directory and 5.8 MB for the Rust executable. These are directional local measurements, not a general performance claim: the sample is short, uses loopback networking, exercises replay rather than mutation, has no CPU/RSS sampling or confidence interval, and was not repeated across machines or deployment environments.

## Mutation and conflict workloads

AIR now also supports an isolated-mutation workload. It creates deterministic per-request transfer IDs, idempotency keys, and account pairs; calculates each result through the canonical executor; retries declared retryable conflicts at the client boundary; and validates the complete aggregate state.

An initial 100-request, concurrency-10 production/release run produced:

| Target | Logical throughput | HTTP attempts | Retryable conflicts | Mean | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Next.js 16.3.8 | 139.23 commits/s | 334 | 234 | 70.36 ms | 182.59 ms | 221.56 ms |
| Rust 1.99 / Axum | 1,402.32 commits/s | 238 | 138 | 6.88 ms | 17.93 ms | 29.71 ms |

The conflict counts are part of the result: PostgreSQL serializable predicate locks around the idempotency absence check cause contention even when account pairs and keys are independent. Generated targets perform their declared three internal attempts; the benchmark's bounded client retry completes the logical operation and measures the full latency.

The `conflict` workload deliberately sends unique operations against the same versioned records. Exactly one mutation must commit; every other request must return the command's declared conflict status, and final PostgreSQL state must equal one canonical mutation. This makes contention behavior measurable without accepting silent duplicate writes.

Use `--duration-seconds` for fixed-duration replay runs, `--repetitions` for an aggregate mean and 95% confidence interval, `--target-pid` to sample process CPU/RSS through the host `ps` interface, and `--artifact-path` to record recursive emitted bytes. Resource fields are evidence about the named process and artifact, not whole-system measurements. Duration mode currently applies only to replay; mutation and conflict runs remain request-count bounded so final-state assertions are exact.

```bash
air benchmark-live examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --scenario transferMovesFundsAtomically \
  --workload conflict --base-url http://127.0.0.1:3000 \
  --requests 20 --concurrency 20 --repetitions 5 \
  --allow-database-reset --output conflict-evidence.json
```

Startup timing is deployment-orchestrator specific and is not inferred from an already-running PID. Record it in the surrounding evidence pipeline. Broader positioning claims still require repeated results across machines or deployment environments.

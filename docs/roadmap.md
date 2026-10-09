# Product roadmap

AIR should earn trust as a semantic application compiler before optimizing runtime code. “Implemented” therefore means a capability has deterministic validation and tests; target compatibility requires additional build and integration evidence.

## 0. Foundation — complete

- versioned AIR schema, YAML parser, semantic validator, migrations, CLI, and target contracts
- deterministic Next.js App Router target with PostgreSQL/Drizzle, CRUD, and a basic web UI
- managed/detached lifecycle, provenance, overwrite protection, and compiler lockfile
- generated Todo application installs, typechecks, tests, and builds

## 1. Semantic credibility — AIR v0.9 complete

AIR v0.2–v0.9 now covers:

- identity, uniqueness, defaults, generation, nullability, and owned foreign keys
- closed request contracts, output projections, errors, guards, and create effects
- selected-record updates, preconditions, isolation, and optimistic concurrency
- typed principals and input/record ownership rules
- composable typed invariant expressions
- named locked update effects and cross-record operands
- input-derived increment/decrement
- scoped idempotent replay and bounded retries
- role/scope membership rules, CRUD authorization, command delete effects, and bounded collections
- a ledger reference that models atomic transfer without target annotations
- a library reference that exercises authorization, deletion, conflict handling, pagination, filtering, and ordering
- versioned events, tasks, transactional message effects, consumers, schedules, derived caches, and realtime channels

Reviewable semantic diffs and deterministic schema-evolution plans now classify safe, review-required, and breaking changes, including backfill and data-loss warnings.

## 2. Verification IR — live harness complete

Completed:

- versioned verification-suite schema and parser
- target-independent command executor
- expected output/error/post-state comparison
- rollback and idempotent replay scenarios
- reproducible evidence artifact with source hashes and actual observations
- normalized live HTTP/PostgreSQL verification through `air verify-live`
- scenario-by-scenario fixture reset, JWT principal invocation, response comparison, and persisted-state comparison
- required destructive-reset acknowledgement and secret-free live evidence

Next gate:

- generate fixtures and property tests from field constraints/invariants
- completed: publish build, differential integration, benchmark, logs, and checksum-verified evidence packs automatically in CI

## 3. Multi-target differential execution — complete for the ledger slice

Completed:

- second target adapter and capability manifest
- Axum routes, Serde types, SQLx migrations/queries, PostgreSQL transactions, JWT boundary, binary/container output
- v0.7 ledger lowering with row locks, invariants, atomic debit/credit, replay, and retry
- deterministic generation, managed ownership, and lockfile tests
- generated Rust toolchain pin used by local builds and the container image
- native format, compile, strict Clippy, and test gates on Rust 1.99
- PostgreSQL migration plus live success, rollback, and idempotent-replay verification
- multi-target orchestration with isolated fixtures and parallel scenario execution
- exact HTTP-status/error/state comparison after target-generated value normalization
- a third Python/FastAPI/psycopg target with the same transaction and operational boundary
- successful Next.js-versus-Rust-versus-Python differential execution for all ledger scenarios

Follow-up:

- completed: publish differential evidence automatically in CI
- expand the shared suite as AIR adds authorization and collection semantics

## 4. Measurement and positioning — tooling complete, field evidence next

- completed: validated idempotent-replay workload with explicit warmup, request count, concurrency, reset rules, raw samples, percentiles, throughput, and environment evidence
- completed: production Next.js versus release Rust localhost baseline under identical replay parameters
- completed: deterministic isolated-mutation workload with unique identifiers, account partitions, bounded client retries, conflict counts, and aggregate transaction-state verification
- completed: explicitly controlled shared-record conflict mix with exact final-state validation
- completed: duration-based replay runs, multiple repetitions, 95% confidence intervals, process CPU/RSS sampling, and artifact-size evidence
- record startup time in deployment-specific pipelines
- measure latency percentiles, throughput, memory, startup, artifact size, and environment metadata
- compare Next.js and Rust only after differential conformance passes; the ledger now satisfies this prerequisite
- publish evidence before choosing a performance claim

Exit gate: a reproducible evidence pack identifies whether portability, generated quality, or runtime performance is AIR’s strongest wedge.

Operational foundation completed: all generated targets expose liveness and PostgreSQL-backed readiness, generated containers include health checks, failures are structured, native targets support configurable ports and graceful shutdown, and CI assembles then independently verifies evidence-pack checksums.

## 5. Adoption and import — core workflows complete

Completed:

- PostgreSQL `information_schema` importer
- portable type/default/generator/key mapping
- foreign-key/delete-behavior mapping
- generated CRUD surface
- explicit diagnostics for approximations and ambiguity
- successful import and validation of the PostgreSQL 16 ledger schema
- OpenAPI 3.x YAML/JSON import with synthetic-identity, security, nested-schema, and non-CRUD diagnostics
- reviewable semantic diffs and migration plans
- manifest-backed generated/user ownership reports
- stdio Language Server Protocol diagnostics for YAML and AIR semantics

Completed follow-up:

- conventional Next.js App Router and Drizzle reverse analysis with provenance and review diagnostics
- persisted partial-adoption boundaries plus reconcile/ownership reporting
- editor completion, hover, document symbols, and pull diagnostics

Next: quick fixes, workspace references, and schema-aware rename.

## 6. Capability solver and target ecosystem — first solver complete

- completed: aligned runtime and YAML capability manifests
- completed: versioned machine-readable predicates
- completed: strict and preferred target constraints with inferred semantic requirements
- completed: deterministic compatibility and incompatibility reports
- add topology alternatives and autonomous non-semantic preferences
- stabilize a third-party target SDK after an external adapter passes conformance

## 7. Complex services — AIR v0.10 complete and distributed

- closed Application v0.9, System v0.1, Deployment v0.1, and verification v0.2 schemas
- standard envelopes, at-least-once delivery, transactional outbox, inbox deduplication, retries, and dead letters
- persisted PostgreSQL saga/timer and realtime-journal structures
- deterministic broker/cache/clock/scheduler/saga/realtime verification and system evidence packs
- explicit plugin SDK with Kafka/Redpanda, RabbitMQ, PostgreSQL, and Redis reference providers
- mixed Next.js API, Rust worker, and Python service generation with API, worker, scheduler, orchestrator, and realtime roles
- process, Docker/Compose, Kubernetes/Helm, and Terraform Helm-release rendering
- conservative Spring messaging, scheduling, and Integration Flow discovery
- live provider checks and mixed-language complex-commerce gates in CI
- coordinated v0.10.0 distribution through npm, GitHub Releases, and the project Homebrew tap

External provider/deployer conformance and real-world complex-service pilots are deliberately deferred until the next roadmap review.

## 8. Release and pilots — v0.10 distribution complete; pilots deferred

- checksummed source artifacts gated by build, typecheck, and tests
- tag/manual GitHub Actions packaging, dependency update automation, security and versioning policy
- structured pilot protocol and issue template for greenfield, import, and partial-adoption trials
- coordinated CLI and plugin-SDK npm publishing, checksummed GitHub Release assets, and Homebrew distribution
- next, after a future roadmap review: execute three independent pilots and evaluate adoption evidence

## 9. AI-native authoring

- accept model-proposed AIR patches, never opaque source trees as the primary artifact
- validate proposals against schema, semantics, capabilities, and verification evidence
- preserve proposal and acceptance provenance
- require human review for security, destructive migration, and data-loss-sensitive changes

## 10. Advanced research

- profiler-guided transformations accepted only when verification passes and measurements improve
- UI IR and evidence-backed service decomposition recommendations
- formal equivalence for selected command subsets
- LLVM, SIMD, or assembly lowering only after multiple high-level targets pass identical suites

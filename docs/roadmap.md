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

## 5. Adoption and import — original reverse-import workflows complete

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

The original importers are now classified as discovery prototypes. They remain compatible, but enterprise modernization does not promote their output automatically.

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

## 11. Enterprise discovery — v0.11 release candidate complete

Supported in v0.11:

- `air.dev/discovery/v0.1` JSONL/YAML bundle with stable IDs, source hashes, confidence, multidimensional coverage, reviewer decisions, and rebuildable SQLite index
- incremental rescans that retain decisions only while evidence is unchanged
- npm-packaged, pinned OpenRewrite 8.90.4 Java analyzer plus a conservative, review-required source fallback; clean installations need Java 17+ but not Maven
- Java Spring inventory for modules, REST and GraphQL boundaries, annotated records/DTOs, JPA, repositories/queries/transactions, security, Kafka, RabbitMQ, Spring events, schedules, caches/Redis, outbound HTTP, configuration, profile-selected publisher adapters, and dynamic routing
- inventory-only Kotlin findings and explicit opaque diagnostics
- loopback-only local architecture workbench with module/system/entry-point/capability views, reachable slices, filters, edge provenance, hash-verified source excerpts, reviewer identity, required rejection/opaque reasons, diagnostics, unmatched evidence, and review progress
- deterministic, source-free `air.dev/discovery-report/v0.1` JSON and self-contained HTML reports
- compatibility warning on the original `import-spring` command
- explicit experimental labels on extraction, differential import verification, and capability adoption

Two independent calibrations now cover complementary shapes. The archived [Netflix Conductor calibration](calibration-netflix-conductor.md) found and removed annotation-named endpoint false positives, added complete route composition, and connected source-derived service/DAO topology at scale. The actively maintained [claims-microservices calibration](calibration-claims-microservices.md) hardened production/test separation, annotated records, GraphQL boundaries, and profile-switched Spring/Kafka publisher adapters. These are reproducible external regression corpora, not completed pilots.

The release-gating [Spring Petclinic REST rehearsal](../pilots/petclinic-rest/report.md) pinned commit `afc8fc1d3b8ec8de69414482b3bd70a1da78cb95` before scanning. It passed 237 Maven tests against disposable PostgreSQL 16, found all 37 documented operations exactly once, produced 100% provenance, excluded test topology, matched source/OpenRewrite identities, preserved node and edge IDs across repeated clean scans, and completed 154 workbench decisions without hand editing. One source-unattributed OpenAPI operation correctly remains opaque.

An external design-partner architecture-inventory pilot follows the release. It must measure human archaeology time, review effort, unexplained behavior, and willingness to repeat the workflow; the internal rehearsal is not independent enterprise validation.

## 12. Evidence and typed extraction — v0.12 next

Experimental foundation already present:

- redacted OTLP/JSONL/test evidence ingestion with explicit field allowlisting
- Application v0.10 outbound ports, operation failures, ordered invocation metadata, and bounded transformations
- System v0.2 foreign components
- capability slicing from endpoint/listener/schedule entry points
- extraction blockers for unreviewed inferred, opaque, or conflicting observable behavior
- generated Application/System/verification/capability artifacts bound to repository and evidence hashes

v0.12 release work:

- replace heuristic evidence matching with deterministic route/method, JVM symbol, database, messaging-destination, and trace-correlation identities
- add self-hosted PostgreSQL before/after, Kafka/Rabbit message, and outbound HTTP observation adapters
- generate real contracts, entities, ports, transformations, failures, and scenarios from reviewed evidence instead of placeholder imported contracts
- complete one vendor-REST capability pilot; unresolved writes or outbound effects must block extraction

## 13. Verified replacement — v0.13 next

Implemented foundation:

- `air verify-import` legacy/candidate HTTP comparison with normalized JSON, status, and selected headers
- verification result v0.3 evidence structure for HTTP, database, message, and outbound observations, persisted as privacy-safe hashes rather than raw values
- typed foreign-component retention and evidence-bound `air adopt <capability>`
- extraction ownership promotion only when blockers are empty and a matching evidence-bound differential result passes

v0.13 release work:

- complete a transactional Kafka capability pilot with database and message equivalence
- add controlled staging replay, shadow comparison, and generated adapters around retained foreign operations
- compare responses, errors, database changes, messages, and outbound invocations
- permit adoption only when every required scenario passes against the same evidence hash
- demonstrate one complete strangler-style replacement before making a supported modernization claim

Later breadth follows repeatable pilots: deep Kotlin, more Java frameworks, multi-repository federation, collaboration/RBAC/audit/CI policies, then optional AI-assisted naming and grouping behind deterministic review.

## 14. Advanced research

- profiler-guided transformations accepted only when verification passes and measurements improve
- UI IR and evidence-backed service decomposition recommendations
- formal equivalence for selected command subsets
- LLVM, SIMD, or assembly lowering only after multiple high-level targets pass identical suites

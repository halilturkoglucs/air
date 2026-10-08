# AIR

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Conformance](https://github.com/halilturkoglucs/air/actions/workflows/conformance.yml/badge.svg)](https://github.com/halilturkoglucs/air/actions/workflows/conformance.yml)

AIR is an experimental, language-neutral Application Intermediate Representation. Application semantics are the source of truth; Next.js, Rust, databases, and deployment platforms are replaceable compilation targets.

AIR CLI v0.10 accepts application documents from v0.1 through v0.9 and adds provider-neutral system and deployment documents:

- entities, relationships, CRUD HTTP operations, contracts, principals, and declared errors
- transactional create/update/delete commands, guards, preconditions, ownership, role/scope policies, and invariant expressions
- authorized CRUD plus bounded collection pagination, filtering, and ordering
- named multi-record updates, dynamic increment/decrement, idempotent replay, and bounded retries
- target-independent semantic verification plus live HTTP/PostgreSQL conformance and reproducible JSON evidence
- deterministic Next.js/Drizzle, Rust/Axum/SQLx, and Python/FastAPI/psycopg PostgreSQL targets
- managed generation with provenance and compiler lockfiles, plus detached output
- PostgreSQL catalog, OpenAPI 3.x, and conventional Next.js/Drizzle import with explicit uncertainty diagnostics
- semantic compatibility diffs, migration plans, partial-adoption boundaries, and an interactive LSP
- deterministic capability solving across the Next.js, Rust, and Python targets
- production runtime health/readiness, structured errors, graceful Rust shutdown, and container health checks
- checksum-verified evidence packs and a full GitHub Actions conformance workflow
- versioned domain/integration events, point-to-point tasks, consumers, schedules, derived caches, WebSocket/SSE channels, and a standard message envelope
- at-least-once delivery through transactional outboxes and durable inbox deduplication; AIR does not claim cross-system exactly-once delivery
- multi-application topology, durable saga definitions, and deterministic system verification with virtual brokers, caches, clocks, schedulers, and realtime sessions
- explicit, version-locked Kafka/Redpanda, RabbitMQ, PostgreSQL outbox, and Redis plugins through the public plugin SDK
- process, Docker Compose, Kubernetes/Helm, and Terraform-to-existing-Kubernetes deployment rendering

## Quick start

Install the CLI from npm:

```bash
npm install --global @halilturkoglucs/air
air --help
```

Or install it from the project Homebrew tap:

```bash
brew install halilturkoglucs/tap/air-ir
air --help
```

The formula is named `air-ir` because Homebrew core already uses `air` for an
unrelated package. Both formulae install an `air` executable and therefore
cannot be installed together.

Or work from source:

```bash
pnpm install
pnpm test

pnpm air validate examples/ledger/air.yaml
pnpm air inspect examples/ledger/air.yaml
pnpm air verify examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --output ledger-evidence.json

pnpm air compile examples/ledger/air.yaml \
  --target nextjs \
  --output dist/ledger-nextjs

pnpm air compile examples/ledger/air.yaml \
  --target rust \
  --deployment container \
  --output dist/ledger-rust

pnpm air compile examples/ledger/air.yaml \
  --target python \
  --deployment container \
  --output dist/ledger-python

# With the generated target running against an isolated test database:
AIR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/air_conformance \
AIR_AUTH_SECRET=replace-with-at-least-32-random-characters \
pnpm air verify-live examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --base-url http://127.0.0.1:3000 \
  --allow-database-reset

# With all generated targets running against distinct disposable databases:
AIR_AUTH_SECRET=replace-with-at-least-32-random-characters \
pnpm air verify-differential examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --target nextjs=http://127.0.0.1:3001 \
  --database-url nextjs=postgres://postgres:postgres@127.0.0.1:5432/air_nextjs \
  --target rust=http://127.0.0.1:3000 \
  --database-url rust=postgres://postgres:postgres@127.0.0.1:5432/air_rust \
  --target python=http://127.0.0.1:3003 \
  --database-url python=postgres://postgres:postgres@127.0.0.1:5432/air_python \
  --allow-database-reset

# Benchmark a validated, non-mutating idempotent replay path:
AIR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/air_rust \
AIR_AUTH_SECRET=replace-with-at-least-32-random-characters \
pnpm air benchmark-live examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --scenario transferReplaysIdempotentResult \
  --base-url http://127.0.0.1:3000 \
  --warmup 25 --requests 500 --concurrency 10 \
  --allow-database-reset \
  --output benchmark-evidence.json

# Benchmark independent successful mutations with bounded retry handling:
AIR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/air_rust \
AIR_AUTH_SECRET=replace-with-at-least-32-random-characters \
pnpm air benchmark-live examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --scenario transferMovesFundsAtomically \
  --workload mutation \
  --base-url http://127.0.0.1:3000 \
  --warmup 10 --requests 100 --concurrency 10 --client-retries 30 \
  --allow-database-reset \
  --output mutation-evidence.json

# Assemble compatible artifacts and verify the pack has not been changed:
pnpm air evidence-pack \
  --artifact semantic=ledger-evidence.json \
  --artifact mutation=mutation-evidence.json \
  --output ledger-evidence-pack
pnpm air evidence-verify ledger-evidence-pack

# Check target feasibility before generating anything:
pnpm air target-check examples/ledger/air.yaml \
  --require domain.commands --prefer ui.web --json

# Compose and verify the mixed Next.js/Rust/Python complex-service reference:
pnpm air compose examples/complex-commerce/system.air.yaml \
  --deployment examples/complex-commerce/deployment.compose.yaml \
  --output dist/complex-commerce
pnpm air verify-system examples/complex-commerce/system.air.yaml \
  --scenarios examples/complex-commerce/verification.yaml \
  --output complex-system-evidence.json
pnpm air provider-check examples/complex-commerce/deployment.compose.yaml --live
```

Import an existing PostgreSQL schema:

```bash
pnpm air import-postgres \
  --url postgres://postgres:postgres@127.0.0.1:5432/app \
  --schema public \
  --name imported-app \
  --output imported.air.yaml

pnpm air validate imported.air.yaml

pnpm air import-openapi \
  --input openapi.yaml \
  --name imported-api \
  --output imported-api.air.yaml

pnpm air import-nextjs \
  --input existing-next-app \
  --output imported-next.air.yaml \
  --report imported-next.report.json

pnpm air import-spring \
  --input existing-spring-service \
  --output imported-spring.air.yaml \
  --report imported-spring.report.json

pnpm air diff before.air.yaml after.air.yaml --output semantic-diff.json
pnpm air plan-migration before.air.yaml after.air.yaml --output migration-plan.json

# Start a standard Language Server Protocol process for an editor client:
pnpm air lsp
```

The PostgreSQL importer reads catalog metadata only. Reverse importers preserve provenance and confidence; unsupported types, defaults, nested schemas, and command-like routes produce diagnostics that must be reviewed rather than invented semantics.

## Workspace

- `packages/air-schema` — versioned JSON Schemas and TypeScript AIR contracts
- `packages/air-parser` — YAML parsing, migration, and semantic validation
- `packages/compiler-core` — target interfaces, diagnostics, artifacts, and provenance
- `packages/verifier` — canonical execution plus normalized live-target response/state comparison
- `packages/plugin-sdk` — public, versioned provider and deployer plugin interfaces
- `packages/providers` — first-party Kafka/Redpanda, RabbitMQ, PostgreSQL outbox, and Redis bindings
- `packages/composer` — System/Deployment planning and process, Compose, Kubernetes/Helm, and Terraform rendering
- `packages/target-nextjs` — Next.js App Router, Drizzle, PostgreSQL, JWT boundary, and web console
- `packages/target-rust` — experimental Axum, SQLx, PostgreSQL, JWT boundary, and container output
- `packages/target-python` — FastAPI, psycopg, PostgreSQL, JWT boundary, and container output
- `packages/import-postgres` — PostgreSQL catalog reverse compiler
- `packages/import-openapi` — OpenAPI 3.x reverse compiler with review diagnostics
- `packages/import-nextjs` — conventional Drizzle schema and App Router reverse compiler
- `packages/import-spring` — conservative messaging, scheduling, and Spring Integration discovery
- `packages/language-server` — stdio LSP server with shared validation, completion, hover, symbols, and pull diagnostics
- `packages/cli` — validation, migration, import, compilation, verification, benchmarking, evidence, evolution, ownership, and LSP workflows
- `examples/ecommerce` — ownership, state transition, and invariant reference application
- `examples/ledger` — atomic multi-record transfer, rollback, idempotency, and retry reference application
- `examples/complex-commerce` — mixed-language events, consumers, saga, cache, schedule, and realtime reference system

## Managed and detached output

Managed mode is the default. Every target writes:

- `.air/manifest.json` — file ownership, checksums, and AIR-node provenance
- `.air/lock.json` — source hash, schema version, compiler/target versions, resolved options, and dependency versions

Managed regeneration may replace owned files and refuses to overwrite unowned files. Add `--detach` to emit an ordinary project without AIR metadata.
`air ownership <generated-directory> [--json]` makes the boundary reviewable: manifest artifacts are compiler-owned, files outside that set are user-owned, and changed or missing generated artifacts fail the report. `air adopt <directory> --user-owned <path>` persists an explicit exception so regeneration no longer writes that artifact; `air reconcile` is the ownership/drift alias intended for daily use.

## Current verification status

- compiler workspace: TypeScript typecheck, build, and the full automated test suite pass
- generated Next.js ledger: generated tests, typecheck, production build, PostgreSQL migration, live HTTP/API transaction tests, and rendered browser state pass
- PostgreSQL importer: exercised against PostgreSQL 16 and the isolated ledger schema
- generated Rust ledger: `cargo fmt --check`, `cargo check`, strict Clippy, tests, PostgreSQL migration, and all three live HTTP/database verification scenarios pass
- generated Python ledger: Pydantic validation, pooled psycopg access, Ruff, Pyright, syntax compilation, PostgreSQL migration, restart-safe migration tracking, and all three live scenarios pass
- three-target differential gate: Next.js, Rust, and Python produce matching HTTP statuses, normalized outputs, and PostgreSQL post-state for all ledger scenarios
- generated runtime controls: `/air-runtime/health` and database-backed `/air-runtime/ready` are emitted by all three targets
- complex-service gate: the same deterministic saga/cache/realtime suite is checked alongside live Redpanda/Kafka, RabbitMQ, PostgreSQL-outbox, and Redis provider round trips
- CI automation: [the conformance workflow](.github/workflows/conformance.yml) builds all targets, runs three-way differential verification plus replay/conflict benchmarks, verifies mixed-language generation and live providers, then uploads checksum-verified evidence packs
- release operations: gated, checksummed release-candidate archives, dependency automation, version/security policy, and a structured three-path pilot protocol

See [the architecture](docs/architecture.md), [AIR schema guide](docs/air-schema.md), [verification model](docs/verification.md), [editor integration](docs/editor.md), [benchmarking methodology](docs/benchmarking.md), [pilot protocol](docs/pilots.md), [versioning policy](docs/versioning.md), and [product roadmap](docs/roadmap.md).

## License and commercial use

AIR is licensed under Apache-2.0. Commercial use is permitted. AIR does not require generated applications to use the AIR license; see [generated output and ownership](docs/generated-output-license.md). The AIR name and branding are governed separately by [the trademark policy](TRADEMARKS.md).

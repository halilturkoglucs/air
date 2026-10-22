# AIR

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Conformance](https://github.com/halilturkoglucs/air/actions/workflows/conformance.yml/badge.svg)](https://github.com/halilturkoglucs/air/actions/workflows/conformance.yml)

> **AI writes the migration. AIR proves what changed.**

AIR is an open, model-neutral verification layer for capability replacement. Freeze reviewed legacy behavior, let any coding agent write an ordinary replacement in any language, then compare HTTP results, database effects, messages, outbound calls, ordering, and failures independently. AIR proves equivalence only inside the observation boundary you declare—not general correctness.

Since v0.12, agent verification is AIR's primary product journey. AIR’s existing Application IR, compiler, providers, discovery, and import commands remain compatible, but coding agents no longer need AIR-generated code or an Application AIR document to verify a replacement.

<!-- AIR_LLM_BENCHMARK:START -->
## Does AIR improve an LLM migration?

![LLM alone pass@3](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-control-pass-at-3.svg) ![LLM + AIR pass@3](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-air-pass-at-3.svg) ![Escaped defects](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-escaped-defects.svg)

> **Same model. Same task. Same 3-round repair budget.** With AIR feedback, `claude-sonnet-5-5` passed **100%** of hidden behavioral scenarios, compared with **23%** on ordinary tests alone. Escaped defects: **218 → 0**. Fully correct migrations: **9/9** vs 0/9.

| Metric | LLM alone | LLM + AIR | Lift |
| --- | ---: | ---: | ---: |
| ✅ Behaviorally correct (pass@3) | 0/9 (0%) | **9/9 (100%)** | **+100 pts** |
| ⚡ Correct on first attempt (pass@1) | 0/9 (0%) | 0/9 (0%) | = |
| 🐛 Escaped defects (hidden suite) | 218 | **0** | **−100%** |
| 🟢 Tests green, behavior wrong | 9/9 | 0/9 | **−100%** |
| 🎯 Hidden scenarios passed | 23% | 100% | **+77 pts** |
| 🔁 Median repair rounds | 3 | 2 | **−33%** |
| 🪙 Median tokens per run | 63k | 65k | **+4%** |

| Capability slice | LLM alone | LLM + AIR |
| --- | ---: | ---: |
| Document creation | 0/3 | **3/3** |
| Ledger transfer | 0/3 | **3/3** |
| Library access | 0/3 | **3/3** |

<details>
<summary>Escaped defects by category</summary>

| Category | LLM alone | LLM + AIR |
| --- | ---: | ---: |
| authorization | 7 | 0 |
| database | 51 | 0 |
| failures | 24 | 0 |
| filtering | 3 | 0 |
| http | 51 | 0 |
| idempotency | 12 | 0 |
| messages | 24 | 0 |
| ordering | 14 | 0 |
| outbound | 12 | 0 |
| pagination | 2 | 0 |
| retryability | 12 | 0 |
| rollback | 6 | 0 |

</details>

Pinned result: `claude-sonnet-5-5`, medium reasoning, claude-code 2.1.308 · suite 1.4.0 · 18 isolated runs · 2026-10-22 · source `d68184d1768d`. pass@3 95% Wilson interval: alone 0%–30%, AIR 70%–100%. Both arms see the same task and ordinary tests. The AIR arm also receives `air check` differences on feedback scenarios. A held-out hidden suite scores both arms. [Methodology and evidence](https://github.com/halilturkoglucs/air/tree/main/benchmarks/llm-air-lift).

This result applies only to the named model and suite. Runtime throughput is measured separately.
<!-- AIR_LLM_BENCHMARK:END -->

For existing enterprise systems, AIR does **not** promise one-click repository-to-YAML conversion. It builds an evidence-backed architecture map, then helps teams review, verify, and replace one business capability at a time. Architecture inventory is the entry point; verified modernization is the outcome.

AIR CLI v0.13 accepts application documents from v0.1 through v0.10, System documents through v0.2, Deployment v0.1, and framework-neutral UI v0.1 documents. Discovery and agent verification are supported product boundaries; extraction, differential import verification, and adoption remain experimental:

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
- local/self-hosted discovery v0.1 bundles with stable IDs, source hashes, confidence, reviewer decisions, coverage, and a rebuildable SQLite workbench index
- pinned OpenRewrite Java/Spring analysis, redacted runtime evidence ingestion, capability slicing, legacy/candidate verification v0.3, and evidence-bound adoption
- typed outbound ports, operation failures, bounded transformations, and foreign components that may remain outside AIR ownership

## Start here

Install AIR v0.13 with Node.js 22 or newer, then clone the repository for the included example files:

```bash
npm install --global @halilturkoglucs/air@0.14.0
git clone https://github.com/halilturkoglucs/air.git
cd air
air --version
```

Then run the included legacy-versus-candidate example:

```bash
# 1. Validate the reviewed scenarios and policy.
air check validate examples/agent-verification/check.yaml \
  --policy examples/agent-verification/policy.yaml --json

# 2. Execute only the legacy implementation and freeze its behavior.
air check baseline examples/agent-verification/check.yaml \
  --target examples/agent-verification/legacy.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/tutorial-1/baseline --json

# 3. Execute the same scenarios against an ordinary replacement.
air check run examples/agent-verification/check.yaml \
  --baseline .air/check/tutorial-1/baseline \
  --target examples/agent-verification/candidate.target.yaml \
  --policy examples/agent-verification/policy.yaml \
  --output .air/check/tutorial-1/run --json

# 4. Turn the machine-readable result into an actionable explanation.
air check explain .air/check/tutorial-1/run/result.json --json
```

The result should contain `"passed": true`. AIR does not overwrite baselines or results; use a new output name such as `tutorial-2` when repeating the walkthrough.

Continue with the [from-scratch agent verification tutorial](docs/getting-started-agent-verification.md). It includes a deliberately broken migration, command and HTTP target examples, normalization, environment variables, CI behavior, troubleshooting, and guidance for adapting the workflow to your own service.

## What can I use it for?

| Use case | Observation boundary | Typical target setup |
| --- | --- | --- |
| Replace a Spring endpoint with TypeScript, Rust, or Python | HTTP response, PostgreSQL changes, emitted messages, vendor calls | Two HTTP targets with disposable fixtures |
| Refactor a transactional workflow | Database writes, rollback, ordering, failure mapping | Command harness or HTTP observation adapter |
| Move Kafka/Rabbit behavior to another broker or runtime | Messages, headers represented by the harness, duplication, ordering | Self-hosted evidence adapter |
| Replace a scheduled job or worker | State changes, outbound calls, messages, retryability | Explicit command target |
| Review an AI-generated migration in CI | Approved baseline versus candidate result | `air check run --json` with exit-code gating |
| Map an unfamiliar Spring service before choosing a capability | Source-linked endpoints, persistence, messaging, schedules, opaque boundaries | `air discover spring`, workbench, then `air check init` |

AIR is not a general correctness oracle, fuzzy similarity scorer, load tester, or one-click migration generator. A passing result means that the candidate matched the approved legacy baseline for the declared scenarios and observations.

## Choose a workflow

- **Prove an agent-written replacement:** follow [Getting started with agent verification](docs/getting-started-agent-verification.md).
- **Understand the security and evidence model:** read [Agent verification](docs/agent-verification.md).
- **Connect any backend or coding agent:** use the [language-agnostic agent protocol](docs/language-agnostic-agent-protocol.md).
- **Inventory an enterprise Spring service:** follow [Enterprise discovery and modernization](docs/enterprise-modernization.md).
- **Use the existing AIR IR and code generators:** see the [AIR schema guide](docs/air-schema.md), [verification model](docs/verification.md), and the `examples/ledger` and `examples/complex-commerce` projects.
- **Preserve UI intent across frameworks:** use the framework-neutral [AIR UI schema](docs/ui-schema.md) for static, server-rendered, client, or hybrid interfaces.
- **Build a provider or deployment integration:** see [Target and plugin adapters](docs/target-adapters.md).

## CLI, discovery, and generation

The v0.13 package also preserves the discovery, AIR IR, compiler, and conformance workflows:

```bash
npm install --global @halilturkoglucs/air@0.14.0
# or: brew install halilturkoglucs/tap/air-ir

# Create an evidence-backed map of a Spring service (Java 17+).
air discover spring ./legacy-service --output .air/discovery --analyzer openrewrite
air workbench .air/discovery --reviewer alice@example.com
air discovery report .air/discovery --output .air/report

# Validate, verify, or generate from an existing AIR application document.
air validate examples/ledger/air.yaml
air verify examples/ledger/air.yaml \
  --scenarios examples/ledger/verification.yaml \
  --output ledger-evidence.json
air compile examples/ledger/air.yaml --target rust --output dist/ledger-rust

# Compose and deterministically verify a multi-service system.
air compose examples/complex-commerce/system.air.yaml \
  --deployment examples/complex-commerce/deployment.compose.yaml \
  --output dist/complex-commerce
air verify-system examples/complex-commerce/system.air.yaml \
  --scenarios examples/complex-commerce/verification.yaml
```

The Homebrew formula is named `air-ir` because Homebrew core already uses `air` for an unrelated package. Both packages install an `air` executable and should not be installed together.

The engine and formats are Apache-2.0. A future paid control plane will add collaboration, organizational policy, approvals, RBAC/SSO, immutable audit, and estate reporting while execution stays local or on self-hosted runners.

External discovery calibration reports are available for the large archived [Netflix Conductor](docs/calibration-netflix-conductor.md) corpus and the actively maintained [claims-microservices](docs/calibration-claims-microservices.md) REST/JPA/GraphQL/Kafka service. The pinned [Buoy public-corpus benchmark](pilots/buoy/report.md) additionally runs clean source/OpenRewrite scans, workbench review, PostgreSQL runtime, and deterministic reporting. The [HMCTS document-deletion proof](pilots/hmcts-document-management-store/report.md) executes the real pinned Java capability and four ordered success/failure scenarios against PostgreSQL 16 and controlled foreign boundaries. These are product regression evidence, not customer adoption claims.

## Plugin SDK

Provider and deployment integrations use the public, versioned SDK:

```bash
npm install @halilturkoglucs/air-plugin-sdk@0.14.0
```

Implement `AirProviderPlugin` for brokers, caches, or databases, or `AirDeployerPlugin` for deployment profiles. Export the implementation through an `AirPluginModule`, set `apiVersion` to `AIR_PLUGIN_API_VERSION`, and declare an immutable plugin `id` and `version`. Deployment documents must name the plugin explicitly and lock that version; AIR does not discover or execute arbitrary installed packages.

Provider entry points include capability declaration, plan analysis, artifact rendering, optional local lifecycle and health checks, and an optional live-conformance adapter. Deployer entry points analyze and render a `DeploymentPlan` and may provide a local lifecycle. Use `assertPluginCompatibility` and `assertLockedPlugin` at the loading boundary. See [the target and plugin adapter guide](docs/target-adapters.md) and the [`@halilturkoglucs/air-plugin-sdk` package](packages/plugin-sdk/README.md).

Import an existing PostgreSQL schema:

```bash
air import-postgres \
  --url postgres://postgres:postgres@127.0.0.1:5432/app \
  --schema public \
  --name imported-app \
  --output imported.air.yaml \
  --discovery .air/discovery

air validate imported.air.yaml

air import-openapi \
  --input openapi.yaml \
  --name imported-api \
  --output imported-api.air.yaml \
  --discovery .air/discovery

air import-nextjs \
  --input existing-next-app \
  --output imported-next.air.yaml \
  --report imported-next.report.json \
  --discovery .air/discovery

air import-spring \
  --input existing-spring-service \
  --output imported-spring.air.yaml \
  --report imported-spring.report.json

air diff before.air.yaml after.air.yaml --output semantic-diff.json
air plan-migration before.air.yaml after.air.yaml --output migration-plan.json

# Start a standard Language Server Protocol process for an editor client:
air lsp
```

The PostgreSQL importer reads catalog metadata only. Legacy `import-*` commands remain compatible and produce review candidates. Enterprise imports should use the discovery workflow: findings remain separate from AIR, preserve provenance and confidence, and cannot be adopted while important side effects are unresolved. See [enterprise discovery and modernization](docs/enterprise-modernization.md).

## Workspace

- `packages/air-schema` — versioned JSON Schemas and TypeScript AIR contracts
- `packages/air-parser` — YAML parsing, migration, and semantic validation
- `packages/compiler-core` — target interfaces, diagnostics, artifacts, and provenance
- `packages/verifier` — canonical execution plus normalized live-target response/state comparison
- `packages/plugin-sdk` — public, versioned provider and deployer plugin interfaces
- `packages/providers` — first-party Kafka/Redpanda, RabbitMQ, PostgreSQL outbox, and Redis bindings
- `packages/discovery` — discovery v0.1 graph, Spring analysis, evidence ingestion, workbench, extraction, differential verification, and adoption
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

See [getting started with agent verification](docs/getting-started-agent-verification.md), [the architecture](docs/architecture.md), [enterprise discovery and modernization](docs/enterprise-modernization.md), [AIR schema guide](docs/air-schema.md), [verification model](docs/verification.md), [editor integration](docs/editor.md), [benchmarking methodology](docs/benchmarking.md), [pilot protocol](docs/pilots.md), [versioning policy](docs/versioning.md), and [product roadmap](docs/roadmap.md).

## License and commercial use

AIR is licensed under Apache-2.0. Commercial use is permitted. AIR does not require generated applications to use the AIR license; see [generated output and ownership](docs/generated-output-license.md). The AIR name and branding are governed separately by [the trademark policy](TRADEMARKS.md).

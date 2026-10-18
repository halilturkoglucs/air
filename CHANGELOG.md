# Changelog

All notable changes are recorded here. AIR follows the pre-1.0 policy in `docs/versioning.md`.

## 0.11.0 - 2026-10-18

- Added discovery v0.1 bundles with stable provenance, confidence, coverage, incremental review decisions, and a rebuildable local SQLite index.
- Added a pinned, npm-packaged OpenRewrite Java/Spring analyzer, conservative source fallback, runtime evidence ingestion with default redaction, and a reviewer-attributed local architecture workbench.
- Added module/system/entry-point/capability graph views, reachable dependency slices, filters, edge provenance, hash-verified source excerpts, required rejection/opaque reasons, diagnostics, unmatched evidence, and review progress.
- Added closed discovery-report v0.1 validation plus deterministic source-free JSON and self-contained HTML export through `air discovery report`.
- Added Application v0.10 outbound ports/failures/transformations and System v0.2 foreign components.
- Added `discover`, `evidence ingest`, and `workbench`; preserved `extract`, `verify-import`, and capability adoption as explicitly experimental workflows.
- Added privacy-safe verification v0.3 legacy/candidate observations, evidence-bound adoption gates, and extraction blockers for unexplained observable side effects.
- Added the pinned Spring Petclinic REST rehearsal with repeatable source/OpenRewrite identities, 100% operation recall and provenance, sanitized metrics, and clean macOS/Linux npm-install gates.

## 0.10.0 - 2026-10-09

- Added AIR application documents at `air.dev/v0.9` with versioned events, durable tasks, consumers, UTC schedules, derived caches, and authenticated WebSocket/SSE channels.
- Added provider-neutral message envelopes, transactional outbox production, durable inbox deduplication, at-least-once delivery semantics, dead letters, and reconnect journals.
- Added `System` and `Deployment` documents for multi-application topology, explicit provider bindings, polyglot components, and PostgreSQL-backed durable sagas.
- Added the public `@halilturkoglucs/air-plugin-sdk` plus first-party Kafka/Redpanda, RabbitMQ, PostgreSQL, and Redis bindings.
- Added API, worker, scheduler, orchestrator, and realtime generation for Next.js, Rust/Axum, and Python/FastAPI.
- Added native-process, Docker, Compose, Kubernetes/Helm, and Terraform deployment rendering.
- Added `compose`, `dev`, `verify-system`, `provider-check`, and `import-spring` CLI workflows.
- Added deterministic verification v0.2, mixed-language live conformance, failure injection, differential observations, and expanded evidence packs.
- Preserved AIR v0.1-v0.8 compatibility and added behavior-preserving v0.8-to-v0.9 migration.

## 0.9.2 - 2026-10-07

- Derived CLI help and `--version` output from the published package metadata.
- Added release guards that require the Git tag, workspace version, and npm package version to match.

## 0.9.1 - 2026-10-07

- Fixed generated Next.js startup in the live conformance workflow.
- Added target-compatibility reports to checksum-verified evidence packs.
- Normalized the published `air` binary path for npm 11.21.
- Enabled npm trusted publishing from the GitHub release workflow.

## 0.9.0 - 2026-10-07

- Added deterministic Next.js, Rust, and Python PostgreSQL targets with three-way differential verification.
- Hardened generated Python services with Pydantic input validation, psycopg pooling, Ruff, and Pyright gates.
- Added machine-readable target constraints and the `target-check` capability solver.
- Added PostgreSQL, OpenAPI, and conventional Next.js/Drizzle reverse importers.
- Added partial-adoption boundaries through `adopt`, `ownership`, and `reconcile`.
- Expanded the LSP with completion, hover, document symbols, and diagnostic pull.
- Added replay, isolated-mutation, and shared-record conflict benchmarks with repetitions, confidence intervals, resource sampling, and artifact sizing.
- Added checksummed evidence packs, release-candidate artifacts, dependency automation, and a structured pilot workflow.
- Published the standalone `@halilturkoglucs/air` CLI distribution under Apache-2.0 with generated-output, contribution, security, and trademark policies.

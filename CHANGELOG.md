# Changelog

All notable changes are recorded here. AIR follows the pre-1.0 policy in `docs/versioning.md`.

## Unreleased

## 0.13.0 - 2026-10-22

- Added the framework-neutral UI v0.1 schema and MongoDB target generation.
- Added a reproducible, resumable LLM verification-lift benchmark. On suite v1.3, `claude-sonnet-5-5` reached behavioral pass@3 9/9 with AIR feedback versus 0/9 on ordinary tests alone, with zero escaped defects; the scorecard is published in the README.
- The benchmark harness supports Codex CLI and Claude Code agents, keeps checkpoints and agent workspaces outside the repository, pauses on usage limits, and verifies committed evidence deterministically from a clean clone.
- Releases now also publish both packages to GitHub Packages.
- Updated tsup to 9, vitest to 5.0.5, and `actions/setup-java` to v6, and pinned vite to 7.3.7 or later to resolve Dependabot advisories.

## 0.12.0 - 2026-10-20

- Repositioned AIR around the model-neutral promise “AI writes the migration. AIR proves what changed,” while preserving every existing discovery, IR, compiler, provider, and import interface.
- Added closed check, check-target, check-policy, check-baseline, and check-result v0.1 formats plus `air check init|validate|baseline|run|explain` with stable JSON output and documented 0/1/2/3 exits.
- Added clean-tree, content-addressed, overwrite-protected legacy baselines; hash-bound policies and normalization; deterministic typed tokens, named bindings, and keyed unordered arrays; and fail-closed stale/tamper detection.
- Added privacy-safe structural comparison for HTTP, database, messages, outbound calls, ordering, failures, and retryability without persisting raw values.
- Added a five-minute agent-written TypeScript replacement example that requires no Application AIR YAML or generated code.
- Added closed evidence-capture v0.1 profiles and privacy-safe PostgreSQL before/after, loopback outbound-HTTP, Kafka, and RabbitMQ capture adapters through `air evidence capture`.
- Replaced heuristic evidence attachment with exact canonical HTTP, JVM, PostgreSQL, messaging, and explicit identities; ambiguous and unmatched evidence remains diagnostic.
- Added typed discovery metadata for DTOs, JPA entities, Feign operations, pure mappings, Flyway tables, externally selected `Runnable` tasks, programmatic Caffeine caches, and transactional Spring-event listeners.
- Hardened typed extraction to block missing or reordered outbound evidence and missing failure/retryability contracts instead of inventing defaults or placeholder types.
- Removed a no-op polynomial route regular expression from Rust target rendering and added adversarial route-string coverage.
- Updated the first-party AMQP and Redis clients and the dependency-review, Node setup, and artifact-upload GitHub Actions to their reviewed current major versions.
- Added the completed pinned Buoy public-corpus discovery benchmark and a pinned HMCTS document-deletion equivalence proof that executes the real Java capability against PostgreSQL 16 and controlled foreign boundaries.
- Added a live cross-language Spring/Java-to-TypeScript capability proof, with 20 clean equivalent reruns and detection of all 15 semantic mutants through the public JSON CLI protocol.
- Documented a language-agnostic command and HTTP adapter contract that any coding agent can drive without an AIR runtime or required Application AIR YAML.

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

# Changelog

All notable changes are recorded here. AIR follows the pre-1.0 policy in `docs/versioning.md`.

## Unreleased

- Narrower product surface: `air --help` leads with the everyday commands (`protect`, `agent install`, `check approve/status/run`, `harness`, `mcp`), then discovery, then `air check` in detail, with the Application IR, compiler, generators, providers, and importers grouped as the legacy toolchain. The README keeps the behavior-check story; the IR reference moved unchanged to `docs/legacy-toolchain.md` and the manual check steps to `docs/manual-check-workflow.md`. No command was removed.
- `air protect --add --tests` grows coverage from the project's own API tests: AIR finds the test command (npm scripts, pytest, go test, rspec, phpunit, Maven, Gradle, cargo), points base-URL environment variables the tests read at its recording proxy, and appends and baselines only the new requests. `--add -- <command>` and `--add --from-har` work the same way; the previous baseline is kept.
- `air protect` prints a COVERAGE line (HTTP routes found in the code versus routes exercised) and, when the code stores data, suggests the project's own reset command (npm scripts, Prisma, Rails, Laravel, Django).
- Recorded sign-ins are replayed: when a recorded request carries a token or cookie that an earlier recorded response issued, the scenario takes it from that response at replay time (`headersFrom` in the check), so signed-in routes are covered without storing a credential. A signed-in request is kept as its own scenario next to the signed-out one.
- `air protect` reruns every scenario once after baselining. Values that change between identical runs and look generated (UUIDs, timestamps, JWTs) are normalized as typed tokens for the scenarios where they appear; anything else that changes is named in a NOTE because it would fail every check. Normalization rules accept `scenarios` to limit them to some scenarios.
- `--reset-scope run` resets state once per run instead of before every scenario, for flows where later requests depend on earlier ones.
- The COVERAGE line counts only routes whose scenarios did not answer 404, and a NOTE says when most scenarios hit 404 (usually a missing route prefix or base path).
- `air harness verify` rejects harnesses with a declared category that is never observed and accepts repeated `--mutation` patches, each of which must be detected.
- `air discover code` now covers Java (Spring, JAX-RS, JPA, MyBatis), C# (ASP.NET controllers and minimal APIs, Entity Framework), PHP (Laravel routes and resources, Eloquent), Rust (axum, actix, rocket, SQL in raw strings), and Ruby (a Rails routes DSL interpreter, ActiveRecord). Measured on RealWorld implementations, route recall is 19/19 in all ten supported stacks.

Measured on public RealWorld implementations (the same 19-endpoint API in five stacks), route recall of `air discover code` went from Express 19, NestJS 16, FastAPI 11, Go/gin 13, Django REST 0 to 19/19 in all five:

- Route prefixes declared away from the route are resolved: Nest `@Controller`, FastAPI `APIRouter(prefix=)`, Flask `Blueprint(url_prefix=)` in the same file, and cross-file mounts (FastAPI `include_router(module.router, prefix=)`, Django `url(..., include("dotted.module"))`, Go `Register(group.Group("/p"))` functions, Express `app.use("/p", importedRouter)`).
- Django regex routes become path templates (`^profiles/(?P<username>\w+)/?$` to `/profiles/:username/`), old-style `url()` is supported, and Django REST Framework `router.register` expands to its conventional routes; FastAPI routes with an empty path are found.
- Data effects now include TypeORM entities, SQLAlchemy/SQLModel models, GORM models, and plain `.sql` files.
From a field trial of `air protect` on a production Next.js and MongoDB service:

- `air protect --reset "<command>"` restores a clean state before each scenario, and `--header <Name>=<ENV_VAR>` signs requests in with a value read from an environment variable (only the name is stored, in the target's new `headers` field). `--rebaseline` re-captures behavior with the new setup and keeps the previous baseline.
- After its first baseline, `air protect` explains what limits the check: scenarios that only reached a login wall, 5xx responses from missing configuration, and stored data that can make earlier requests change later answers.
- `air discover code` recognizes MongoDB (driver collections, Mongoose models, pymongo, Go driver) and only treats SQL as SQL when a string literal starts with a statement, which removes false positives from messages such as "Failed to update ...".
- Clearer agent output: proxy-free scenarios are reported as built from OpenAPI or code, and `NEXT` lines tell agents to rerun the same AIR command.
## 0.17.0 - 2026-10-22

- Added `air protect`, one command for people and agents: the first run (`--url`) builds read-only scenarios from an OpenAPI file or the routes in the code, or records a command through `$AIR_PROXY_URL`, and creates a baseline; later runs check the current code and show expected and actual values from a local, gitignored cache. No proxy or framework plugin is required.
- Added `air agent install`, which writes a managed AIR block to `AGENTS.md` and `CLAUDE.md` and can register the MCP server (`--mcp`), and the `air_protect` MCP tool.
- `air check run --reveal` now uses locally cached expected values when the legacy service is no longer running.
- Added agent-written harnesses for behavior HTTP cannot see (events, caches, data, jobs, files, emails): `air harness task` lists what to cover, `air harness new` scaffolds a harness in the command-target contract, and `air harness verify --mutation <patch>` accepts it only if it is stable across runs, input-sensitive, and detects a planted break in a throwaway copy of the code. `air protect` baselines verified harnesses and checks them on every run, and asks for re-verification when a harness changes.
- Observation categories are open: besides the built-in seven, any lowercase name (`cache`, `events`, `files`, ...) can be declared and compared.
- `air discover code` reports every database and messaging effect, including those outside detected entry points; agent-mode run state is kept per check.
- Added `air discover code` (step 4a of source discovery): proposes behavioral seams (HTTP routes, CLI entry points, jobs, consumers) and the database, outbound, and messaging effects behind them in JavaScript/TypeScript, Python, and Go code, scoped by path, symbol, or `--since <git-ref>`. Detection rules are data files; every seam stays `inferred` until AIR executes it.

## 0.16.0 - 2026-10-22

- Added `air discover traces`: OpenTelemetry (OTLP JSON) traces from any language become a deterministic map of endpoints and their database, outbound, and messaging effects.
- Added `air check init --from-openapi`: reviewable HTTP scenario skeletons for every OpenAPI operation, with example path, query, and body values.
- Added `air check coverage`: operations from OpenAPI or traces that no scenario exercises, with `--fail-under` for CI.
- `AIR_STATE_DIR` relocates agent-mode last-run state; `.air/last-run.json` is per-developer and should not be committed.
- Added `rename` and `internal-boundary` normalizations for topology changes: map data that moved to another service's database, and drop calls or steps that became internal when a service was extracted or merged. Both require a written reason and are policy-controlled.
- Added `lifecycle.services` to check targets, so a candidate made of several processes is started (with optional readiness URLs) and stopped together.
- Added `examples/extract-service`, a monolith-to-service split verified by AIR.

## 0.15.0 - 2026-10-22

- Added `air check baseline --at <ref>` (with `--at-setup`): legacy runs from a clean Git worktree, so refactors and upgrades in place need no second running copy. `run --reveal` uses the same ref.
- Added `air check record`: a built-in recording proxy or a HAR file becomes reviewable HTTP check scenarios for any language; credentials are dropped unless explicitly kept.
- Added `air check approve` and `air check diff-baseline` for auditable, per-scenario approval of intentional behavior changes; baselines can now carry an `approvals` record.

## 0.14.0 - 2026-10-22

- Added the compact agent protocol `air.dev/agent/v1`: `air check profile` stores a check's paths in `.air/check.json`, so `air check run --agent` needs no arguments and prints a deterministic, line-budgeted report with progress since the last run.
- Added `air check run --reveal`, which re-runs the legacy target locally for failing scenarios and prints expected and actual values without persisting them. Policies can deny it with the new `reveal` field.
- Added `air check status`, `air agent instructions`, and a dependency-free MCP server, `air mcp`, exposing `air_check_*` tools.
- Benchmark suite v1.4 feeds the AIR arm the exact `air check run --agent --reveal` output: `claude-sonnet-5-5` reached pass@3 9/9 with AIR versus 0/9 alone, with zero escaped defects.
- Benchmark evidence verification now treats the source commit as provenance, so evidence stays verifiable after squash merges.
- The plugin SDK publishes with npm's normalized repository URL.

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

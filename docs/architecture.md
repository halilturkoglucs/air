# Architecture

## Current semantic boundary

AIR v0.9 supports application metadata, entities, primitive fields, explicit identity and nullability, owned foreign-key relationships, validation, authorized CRUD and collection HTTP operations, contracts, principals, role/scope authorization, executable commands, events, tasks, consumers, schedules, derived caches, and realtime channels.

Application v0.10 adds typed outbound ports, operation failure contracts, ordered invocations, and a deliberately bounded transformation language: projection, rename, literals, scalar conversion, enum mapping, defaults, and conditionals. Provider endpoints, credentials, SDK configuration, reflection, and arbitrary code do not enter semantic AIR. System v0.2 can retain foreign services, libraries, databases, brokers, and vendors beside AIR-managed components.

A command can declare guards, output projection, domain errors, transaction isolation, state/version preconditions, composable invariants, one primary create/update/delete effect, named record update effects, input-derived increment/decrement, scoped idempotent replay, and bounded retries. The ledger reference uses these constructs to debit and credit two accounts atomically and create one transfer without embedding SQL, TypeScript, Rust, Python, or framework concepts in AIR.

## Package graph

```text
                         @air/schema
                   _________^_________
                  /         |         \
        @air/parser  @air/verifier  @air/compiler-core
             ^             ^          ^
             |             |          |
        @air/composer  @air/providers +---- targets
             ^             ^
             +------ public CLI ------+
                         ^
               @air/discovery + import-*
```

- `@air/schema` owns public, framework-neutral contracts.
- `@air/parser` owns YAML, JSON Schema, migrations, and semantic checks.
- `@air/verifier` executes canonical scenarios directly against AIR semantics.
- `@air/compiler-core` owns target contracts, diagnostics, artifacts, and provenance.
- `@halilturkoglucs/air-plugin-sdk` defines explicit provider/deployer contracts, lifecycle hooks, health, and conformance adapters.
- `@air/composer` resolves System and Deployment documents into generated components and deployment artifacts.
- `@air/discovery` owns non-authoritative source/runtime graphs, incremental evidence, review decisions, capability extraction, the local workbench, and import verification.
- targets analyze capability compatibility and generate deterministic projects.
- `@air/import-postgres` reverse-compiles catalog metadata and reports uncertainty.
- `@halilturkoglucs/air` is the public process boundary; private workspace packages are bundled into its distribution.

No schema package imports a target. Target options never enter AIR.

## Validation and execution boundaries

1. JSON Schema validates closed structure, names, required values, and scalar ranges.
2. Semantic validation resolves entity/field/error/principal/effect references and proves type, mutability, ownership, idempotency, transaction, and invariant compatibility.
3. Target analysis rejects semantics that a particular output cannot implement.
4. Compilation writes source only after validation and target analysis succeed.
5. Verification executes declared scenarios independently of a target.
6. Generated-project builds and integration tests remain separate evidence; successful compilation alone is not behavioral proof.

## Determinism and reproducibility

There are no LLM calls in parsing, validation, verification, import mapping, or target generation. Identical AIR, verification YAML, catalog metadata, and target options produce identical results.

Managed targets write:

- `.air/manifest.json` for ownership, artifact checksums, and AIR-node provenance
- `.air/lock.json` for the canonical AIR hash, schema version, compiler/target versions, resolved options, dependency versions, and artifact checksums

Verification can write application evidence v0.1 or system evidence v0.2, containing source/suite hashes, summaries, diagnostics, observed state, and asynchronous envelope/delivery/cache/saga/realtime traces.

## Target boundaries

The Next.js target emits App Router route handlers, Drizzle/PostgreSQL persistence, Zod contracts, HS256 JWT verification, transactional domain functions, structured errors, tests, a small read/write console, and API/worker/scheduler/orchestrator/realtime runtime roles.

The Rust target emits Axum routes, SQLx/PostgreSQL migrations and queries, typed Serde contracts, HS256 JWT verification, the same command transaction semantics, native API/worker/scheduler/orchestrator roles, OpenTelemetry hooks, and a Dockerfile.

The Python target emits FastAPI routing, psycopg/PostgreSQL migrations and queries, HS256 JWT verification, restart-safe migration tracking, transactional command interpretation, worker/scheduler/orchestrator roles, WebSocket/SSE endpoints, and a Dockerfile.

Authentication transport remains target-specific. AIR defines typed principals and authorization facts, not JWT, cookies, OAuth, or a provider.

## Import boundary

The PostgreSQL importer reads `information_schema` only. Portable scalar types, primary/unique keys, nullability, generated UUID/identity/timestamp values, literal defaults, foreign keys, and delete behavior are deterministic. Unportable types, expressions, missing primary keys, and naming collisions become diagnostics. Imported AIR is a review candidate, not automatically authoritative.

Enterprise import adds a boundary before AIR. `air.dev/discovery/v0.1` stores stable source-linked nodes and edges, source spans and hashes, build coordinates, redacted runtime evidence, confidence states, coverage dimensions, and reviewer decisions. JSONL/YAML files are authoritative; SQLite is a rebuildable workbench index. A rescan invalidates decisions when their evidence hash changes.

The Java/Spring analyzer is pinned to OpenRewrite 8.90.4. Its source fallback is conservative and explicitly review-required. Kotlin is inventory-only in v0.1. Dynamic routing, effectful mappers, scripts, reflection, and unknown Redis use remain opaque. Extraction is blocked while an important write, message, cache, or outbound call is unexplained.

Verification v0.3 compares legacy and candidate observations. Adoption is an explicit evidence-bound transition, not a consequence of successful parsing. See [enterprise discovery and modernization](enterprise-modernization.md).

## Deliberate omissions

Cache semantics do not include sessions, locks, rate limits, or arbitrary Redis data structures. First-party Terraform deploys a generated Helm release to an existing Kubernetes cluster and does not provision cloud accounts or managed services. Cloud provisioning belongs in explicit deployer plugins. A target must report unsupported semantics rather than silently weaken them.

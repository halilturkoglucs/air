# Architecture

## Current semantic boundary

AIR v0.9 supports application metadata, entities, primitive fields, explicit identity and nullability, owned foreign-key relationships, validation, authorized CRUD and collection HTTP operations, contracts, principals, role/scope authorization, executable commands, events, tasks, consumers, schedules, derived caches, and realtime channels.

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
                 import-* packages
```

- `@air/schema` owns public, framework-neutral contracts.
- `@air/parser` owns YAML, JSON Schema, migrations, and semantic checks.
- `@air/verifier` executes canonical scenarios directly against AIR semantics.
- `@air/compiler-core` owns target contracts, diagnostics, artifacts, and provenance.
- `@halilturkoglucs/air-plugin-sdk` defines explicit provider/deployer contracts, lifecycle hooks, health, and conformance adapters.
- `@air/composer` resolves System and Deployment documents into generated components and deployment artifacts.
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

## Deliberate omissions

Cache semantics do not include sessions, locks, rate limits, or arbitrary Redis data structures. First-party Terraform deploys a generated Helm release to an existing Kubernetes cluster and does not provision cloud accounts or managed services. Cloud provisioning belongs in explicit deployer plugins. A target must report unsupported semantics rather than silently weaken them.

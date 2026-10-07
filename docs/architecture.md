# Architecture

## Current semantic boundary

AIR v0.8 supports application metadata, entities, primitive fields, explicit identity and nullability, owned foreign-key relationships, validation, authorized CRUD and collection HTTP operations, contracts, principals, role/scope authorization, and executable commands.

A command can declare guards, output projection, domain errors, transaction isolation, state/version preconditions, composable invariants, one primary create/update/delete effect, named record update effects, input-derived increment/decrement, scoped idempotent replay, and bounded retries. The ledger reference uses these constructs to debit and credit two accounts atomically and create one transfer without embedding SQL, TypeScript, Rust, Python, or framework concepts in AIR.

## Package graph

```text
                         @air/schema
                   _________^_________
                  /         |         \
        @air/parser  @air/verifier  @air/compiler-core
             ^             ^          ^          ^
             |             |          |          |
             +---- @halilturkoglucs/air CLI      |
                         ^            |          |
                         |       @air/target-nextjs
                @air/import-postgres  @air/target-rust
```

- `@air/schema` owns public, framework-neutral contracts.
- `@air/parser` owns YAML, JSON Schema, migrations, and semantic checks.
- `@air/verifier` executes canonical scenarios directly against AIR semantics.
- `@air/compiler-core` owns target contracts, diagnostics, artifacts, and provenance.
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

Verification can write `air.dev/verification-evidence/v0.1`, containing source/suite hashes, runner version, summary, diagnostics, observed outputs, and observed post-state.

## Target boundaries

The Next.js target emits App Router route handlers, Drizzle/PostgreSQL persistence, Zod contracts, HS256 JWT verification, transactional domain functions, structured errors, tests, and a small read/write console.

The Rust target emits Axum routes, SQLx/PostgreSQL migrations and queries, typed Serde contracts, HS256 JWT verification, the same command transaction semantics, a native entry point, and a Dockerfile. Native format, compile, test, strict Clippy, live conformance, and differential gates pass.

The Python target emits FastAPI routing, psycopg/PostgreSQL migrations and queries, HS256 JWT verification, restart-safe migration tracking, transactional command interpretation, a Uvicorn entry point, and a Dockerfile. It passes the same live ledger suite and three-way differential gate.

Authentication transport remains target-specific. AIR defines typed principals and authorization facts, not JWT, cookies, OAuth, or a provider.

## Import boundary

The PostgreSQL importer reads `information_schema` only. Portable scalar types, primary/unique keys, nullability, generated UUID/identity/timestamp values, literal defaults, foreign keys, and delete behavior are deterministic. Unportable types, expressions, missing primary keys, and naming collisions become diagnostics. Imported AIR is a review candidate, not automatically authoritative.

## Deliberate omissions

Next.js source reverse analysis, WebSockets, events, jobs, queues, a UI IR, richer editor actions, profiler-guided optimization, and low-level lowering are not implemented yet. A target must report unsupported semantics rather than silently weaken them.

# Target adapters

A target adapter maps validated AIR semantics to a concrete technology stack. Adapters are outputs of the compiler architecture, never extensions to the AIR schema.

## Core contracts

`@air/compiler-core` defines:

- `TargetAdapter<TOptions>` — target identity, manifest, analysis, and compilation
- `CapabilityManifest` — versioned support declarations
- `CompilationContext<TOptions>` — validated AIR, output directory, lifecycle mode, and target options
- `CompilationResult` — success/failure, diagnostics, and produced artifacts
- `CompilationArtifact` — path, kind, checksum, and provenance

Target options are typed separately. For example, a Next.js adapter may accept framework version, package manager, and deployment choice without placing those fields in AIR.

## Capability language

Each capability is `supported`, `conditional`, or `unsupported`. Conditional support carries versioned machine-readable predicates such as required database, deployment, or explicit join-entity constraints. `air target-check <file>` infers semantic requirements, combines them with strict `--require` and advisory `--prefer` capabilities, and emits deterministic explanations in text or `air.dev/target-compatibility/v0.1` JSON.

Manifests state platform limits before generation begins. The current solver ranks compatible targets and rejects unsupported or unsatisfied conditional capabilities before generation. System topology is explicit rather than inferred: `air compose` resolves components, channels, and deployment bindings without silently decomposing an application.

## Adapter phases

1. `analyze` reports target compatibility diagnostics without writing files.
2. `compile` generates artifacts only after analysis and policy checks pass.
3. A separate verifier builds and tests those artifacts.

Compilation must not reinterpret or weaken application semantics. When a target cannot represent a requirement, it returns an error diagnostic.

## Next.js adapter

`@air/target-nextjs` publishes HTTP, domain-command, ownership-authorization, relational persistence, web UI, long-running worker, and Vercel deployment capabilities. It maps AIR CRUD and command operations to App Router route handlers, uses the asynchronous `params` contract required by modern Next.js, selects the default Node.js runtime, and emits a PostgreSQL/Drizzle repository layer with explicit primary keys, defaults, generated values, uniqueness, nullability, and foreign keys.

For AIR commands, the adapter generates closed request parsing, a transactional command function, existence queries for guards, declared `DomainError` failures, a typed output projection, and a stable structured HTTP error envelope. AIR v0.4 update effects additionally lower to state checks plus a compare-and-update query, the selected PostgreSQL isolation level, numeric version increments, and declared handling for SQLSTATE `40001` serialization conflicts.

For AIR v0.5 authorized commands, the generated route remains a thin transport boundary: it verifies an HS256 bearer JWT using `AIR_AUTH_SECRET`, extracts same-named claims, and parses them through the generated principal contract. Missing or invalid credentials become the declared 401 error. The typed principal is passed to the domain command, where input or persisted-record ownership is enforced in the transaction and violations become the declared 403 error. This JWT mapping is a target convention; AIR itself remains identity-provider neutral.

AIR v0.6 invariant trees lower to parenthesized TypeScript boolean expressions over typed input, selected-record, principal, and literal operands. Each invariant runs inside the command transaction before its effect and throws its declared `DomainError` when false. The target manifest explicitly limits this capability to portable scalar comparisons and logical composition.

AIR v0.7 named effects select and lock every declared record, evaluate cross-record invariants, check versions, apply dynamic arithmetic updates, and create the primary result in one PostgreSQL transaction. Scoped idempotency checks return the existing projection before mutation. Declared retry limits handle serialization failures, deadlocks, and unique-key races.

Before writing, it rejects unsupported path shapes, method/action mismatches, non-POST or parameterized command routes, route conflicts, missing or unsupported IDs, ambiguous table names, and many-to-many relationships without explicit join entities. Managed compilation never overwrites an unowned file.

The YAML manifest is readable by plugin discovery. The TypeScript export is the runtime form used by the compiler; tests keep the two representations aligned.

## Rust Axum adapter

`@air/target-rust` is the second target. It emits a native Rust project with Axum HTTP routing, Serde request/principal types, SQLx runtime queries and migrations, PostgreSQL transactions, structured error envelopes, HS256 JWT claim extraction, a pinned Rust toolchain shared with its container image, and binary/container deployment output.

The ledger command lowers to serializable SQLx transactions, `SELECT ... FOR UPDATE`, input-to-principal and record-to-principal ownership checks, cross-record invariants, version preconditions, dynamic debit/credit statements, idempotent replay, a primary transfer insert, and bounded retry classification for SQLSTATE `40001`, `40P01`, and `23505`.

The Rust target deliberately emits no UI. Many-to-many relations require explicit join entities, PostgreSQL is the only database, and named effects currently require a primary create effect. The generated ledger passes formatting, native compilation, strict Clippy, tests, migration, and the live canonical PostgreSQL scenarios.

## Python FastAPI adapter

`@air/target-python` is the third target. It emits FastAPI routes, Pydantic request models, a psycopg 3 connection pool, HS256 JWT verification, CRUD and bounded collection handlers, the shared transactional command semantics, restart-safe migration tracking, Uvicorn process output, and a health-checked container image. Generated development requirements include Ruff and Pyright gates. Its generic generated runtime keeps AIR semantics visible as data while still producing a standalone deployable service.

The target supports AIR v0.9 authorization and create/update/delete primary effects, named locked updates, invariants, preconditions, scoped replay, bounded retry, and asynchronous runtime roles. It deliberately emits no UI, requires explicit join entities for many-to-many relations, and supports PostgreSQL only. Next.js, Rust, and Python match on success, rollback, and idempotent replay in the differential ledger suite; the mixed-language complex-commerce system exercises their event, saga, cache, and realtime generation.

## Provider and deployer plugins

`@halilturkoglucs/air-plugin-sdk` separates infrastructure adapters from application semantics. Plugins declare capabilities, analyze a locked resource plan, render artifacts, optionally manage a local lifecycle, report health, and expose live-conformance adapters. Deployment documents name providers; the composition lock records the exact plugin id and version. AIR does not scan or execute arbitrary installed npm packages.

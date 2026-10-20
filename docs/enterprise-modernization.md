# Enterprise discovery and modernization

AIR does not convert an enterprise repository into one authoritative YAML file. A repository can contain thousands of classes, runtime-selected routes, vendor SDKs, broker conventions, reflection, scripts, and behavior that exists only in configuration or production data. Pretending that a static scan has recovered all of that behavior would make the result dangerous.

The product contract is narrower and more useful:

> AIR creates an evidence-backed architecture map of a legacy estate, then lets a team extract, verify, and replace one business capability at a time.

The adoption unit is a business capability with an observable entry point—an HTTP operation, message listener, or schedule—not a repository, service, class, or framework.

## Three boundaries

1. **Discovery** records what source, builds, configuration, bytecode, tests, or runtime traces say. Findings have provenance and confidence, but are not authoritative semantics.
2. **Reviewed AIR** contains durable behavior a person has accepted: boundary contracts, state effects, messages, outbound ports, transformations, failures, and explicit foreign operations.
3. **Adopted AIR** is promoted only after required legacy-versus-candidate scenarios match. An adoption record binds ownership to the reviewed evidence hash.

This separation is intentional. Discovery can be incomplete while still saving archaeology time. AIR must not silently fill gaps.

## Discovery bundle v0.1

`air.dev/discovery/v0.1` is a local directory:

```text
manifest.json       bundle identity, repository hash, analyzer version
nodes.jsonl         stable source-linked findings
edges.jsonl         source/runtime-linked relationships
evidence.jsonl      redacted runtime and test observations
decisions.yaml      approve/reject/rename/merge/mark-opaque decisions
coverage.json       coverage by construct and confidence state
index.sqlite        rebuildable workbench index; never authoritative
```

Node IDs derive from stable repository-relative identities rather than source line numbers. An incremental rescan keeps an existing decision only when its subject and evidence hash are unchanged. Changed or missing evidence marks the decision invalidated.

Every node and edge must cite a source span or runtime evidence. Confidence is one of `proven`, `observed`, `inferred`, `opaque`, or `conflicting`. Coverage is multidimensional; AIR does not report a single percentage that mixes known, guessed, and unexplained behavior.

## Spring analysis

The authoritative Java path is the pinned OpenRewrite 8.90.4 analyzer in `packages/discovery/spring-analyzer`. Build it with:

```bash
mvn -q -DskipTests package -f packages/discovery/spring-analyzer/pom.xml
```

The v0.11 npm CLI includes the shaded analyzer JAR and requires Java 17 or newer for deep Spring discovery; it does not require Maven or a source checkout. `AIR_OPENREWRITE_ANALYZER_JAR` can explicitly select a development build. `--analyzer openrewrite` fails if the analyzer or Java is unavailable. `--analyzer auto` can use the conservative source analyzer, but emits a review-required diagnostic. The source analyzer is a resilience and bootstrap path, not a claim of equivalent Java type attribution.

The first pass inventories Maven/Gradle modules, controllers, boundary DTOs, Jackson/validation signals, JPA entities/repositories/queries/transactions, Spring Security declarations, Kafka/Rabbit/Spring event interactions, Integration flows, schedules, Feign/WebClient/RestClient calls, caches/Redis, properties, and dynamic routing. Kotlin is deliberately inventory-only in discovery v0.1.

## Runtime evidence and privacy

Ingest OTLP JSON, JSONL test evidence, database-change observations, broker observations, schema contracts, or outbound-call records:

```bash
air evidence ingest trace.json --discovery .air/discovery
```

Or capture controlled evidence while running a test command:

```bash
air evidence capture evidence-profile.yaml \
  --output .air/evidence.jsonl -- ./gradlew integrationTest
air evidence ingest .air/evidence.jsonl --discovery .air/discovery
```

The closed `air.dev/evidence-capture/v0.1` profile names credential environment variables rather than values. Its self-hosted adapters snapshot selected PostgreSQL relations, serve loopback outbound-HTTP stubs, and observe configured Kafka topics or RabbitMQ queues. Persisted records contain canonical identities, counts, statuses, sizes, and hashes—not connection strings, headers, bodies, messages, rows, or payload values.

Evidence matching is exact and unique. HTTP uses module/method/normalized route, JVM observations use build coordinate/qualified symbol/descriptor, PostgreSQL uses system/namespace/relation/operation, and messaging uses provider/destination/direction/schema. Trace and span IDs correlate observations but never replace semantic identity. Ambiguous and unmatched observations remain diagnostics. Extraction also checks source-attributed outbound order and requires explicit linked failure behavior and retryability evidence; missing policy is a blocker, never a generated default.

Authorization, cookies, secrets, tokens, passwords, payloads, bodies, and common personal-data fields are redacted by default. Payload capture requires an explicit field allowlist such as `--allow-field order.status`. AIR is designed for controlled staging, replay, or test environments; production telemetry is not required.

## Review and extraction

```bash
air discover spring ./legacy-service --output .air/discovery
air workbench .air/discovery --reviewer alice@example.com
air discovery report .air/discovery --output .air/report

# Experimental in v0.11:
air extract .air/discovery --capability endpoint:... --output capabilities/place-order
```

The workbench binds to loopback only. It provides module, system, entry-point, and reachable-capability views; module/kind/confidence/unresolved filters; edge provenance; content-hash-verified source excerpts; diagnostics; unmatched evidence; and review progress. Rejection and `mark-opaque` decisions require reasons, and every decision records the requested reviewer identity.

`air discovery report` writes deterministic `report.json` and self-contained `report.html`. The JSON validates against the closed `air.dev/discovery-report/v0.1` schema. Reports contain topology, coverage, confidence, unresolved boundaries, review state, analyzer versions, and provenance metadata, but never source excerpts or payload values.

Extraction is experimental in v0.11. It follows outgoing evidence edges from one entry point—including externally selected `Runnable` tasks—and fails when an inferred, opaque, or conflicting observable effect has not been reviewed. Accepted pure mappers become bounded transformations; vendor dependencies become typed outbound ports only when their operations and failure policy are proven; reviewed opaque behavior becomes a foreign System v0.2 component. The generated capability directory contains Application v0.10, System v0.2, verification v0.3, and an evidence-bound capability manifest.

## Differential verification and adoption

```bash
air verify-import capabilities/place-order \
  --legacy http://127.0.0.1:8080 \
  --candidate http://127.0.0.1:3000

air adopt capabilities/place-order
```

Verification and adoption are experimental in v0.11. Verification v0.3 compares normalized legacy and candidate HTTP status, selected headers, and bodies. Suites can also request database, message, and outbound-call observations from a self-hosted observation adapter. Persisted results contain content hashes and sizes instead of raw bodies or side-effect values; sensitive response headers are redacted. A failed, missing, or stale comparison does not transfer ownership. `air adopt` writes an immutable evidence-hash-linked adoption record only when the latest result passed for the same extracted capability and discovery evidence.

## Representation policy

- Boundary DTOs become contracts; internal DTOs remain inventory unless they affect observable behavior.
- Pure mappers can become bounded transformations. Mappers with lookups or effects remain opaque until evidence explains them.
- Vendor calls become typed ports. Provider endpoints and credentials stay in deployment configuration.
- Broker interactions become events, tasks, consumers, and channels only after review.
- Dynamic routing, reflection, scripts, and unknown Redis structures remain visible opaque dependencies.
- Complex algorithms may remain typed foreign operations indefinitely. AIR can generate adapters and surrounding capabilities without rewriting them.

An LLM may propose names, groupings, mappings, or scenarios, but proposals are disabled by default, non-authoritative, and subject to the same deterministic review and verification gates.

# Claims microservices discovery calibration

This is AIR's second repeatable external-repository calibration. It uses a small, actively maintained Spring Boot service to test precision on a conventional REST/JPA application with profile-switched local and Kafka event delivery. It is not an AIR adoption pilot: no capability was reviewed, differentially verified, or promoted to AIR ownership.

## Corpus

- repository: [akinifecode/claims-microservices](https://github.com/akinifecode/claims-microservices)
- commit: `97d3c587634bd740fbfc0f99be6f3ac8833b40cd`
- snapshot date: 2026-06-11
- shape: 35 Java files in three Maven modules
- stack: Java 17, Spring Boot 3.2, Spring MVC, GraphQL, Bean Validation, JPA, transactions, Spring events, and Kafka

The application selects `LocalEventPublisher` under the `!kafka` profile and `KafkaEventPublisher` under `kafka`. This makes it a useful precision fixture: both adapters implement the same application port, while test code also publishes local events and must not be mistaken for deployed topology.

## Reproduction

```bash
git clone https://github.com/akinifecode/claims-microservices.git /tmp/claims-microservices
git -C /tmp/claims-microservices checkout 97d3c587634bd740fbfc0f99be6f3ac8833b40cd
mvn -q -f packages/discovery/spring-analyzer/pom.xml package
pnpm air discover spring /tmp/claims-microservices \
  --output /tmp/claims-microservices-discovery \
  --name claims-microservices \
  --analyzer openrewrite
```

The discovery output is temporary calibration evidence and is not committed to AIR.

## Result after calibration fixes

| Measure | Before | After |
| --- | ---: | ---: |
| Nodes | 51 | 46 |
| Edges | 59 | 59 |
| Public endpoints | 6 REST | 6 REST + 2 GraphQL |
| Publisher findings | 8 | 2 adapters + 1 contract |
| Production listeners | 6 | 6 |
| Transactions | 5 | 5 |
| Test-source semantic nodes | 3 publisher calls | 0 |
| Spurious dynamic-routing diagnostics | 1 | 0 |

The source and OpenRewrite analyzers produce the same 46 stable node IDs. The graph contains all six REST endpoints, both GraphQL query fields, six production listeners, five transactions, the JPA entity/repository pair, and the two publisher adapters. Both GraphQL entry points call `ClaimService`; `ClaimService` depends on the `EventPublisher` contract; and that contract connects to both profile-qualified implementations.

The `SubmitClaimRequest` record now has the exact component list `policyNumber`, `claimantName`, `type`, `description`, and `amount`. Nested Bean Validation arguments such as `@Size(max = 2000)` and `@DecimalMin(value = "0.0", inclusive = false)` no longer become invented field names.

## Defects found and hardened

- Excluded `src/test`, `src/integrationTest`, and `src/it` code from deployed semantic topology while retaining it in the repository hash for later test-evidence ingestion.
- Replaced naive record parsing with balanced delimiter and top-level component parsing.
- Added Spring GraphQL query, mutation, and subscription mappings to both the source and pinned OpenRewrite analyzers.
- Distinguished publisher contracts from provider adapters and recorded `@Profile` alternatives.
- Counted typed client invocations rather than imports, field declarations, constructor parameters, or arbitrary `.send(...)` calls as message publications.
- Connected publisher contracts to implementations and service dependencies to publisher boundaries.
- Restricted dynamic-routing diagnostics to actual runtime-dispatch mechanisms; prose containing the word `routing` no longer creates an opaque finding.

## Honest limitations

- A profile predicate is recorded as source evidence, not evaluated against a deployment. Deployment evidence must establish which adapter is active.
- Publisher discovery currently recognizes typed Spring Kafka, RabbitMQ, StreamBridge, and `ApplicationEventPublisher` clients. Custom wrappers remain service or foreign-operation boundaries until supported or reviewed.
- GraphQL mappings are boundary inventory. AIR does not infer the full GraphQL schema, field selection semantics, or resolver batching behavior from annotations alone.
- Test sources are deliberately absent from deployed topology. A future test-evidence adapter should link executed tests to existing nodes without turning test doubles into production components.
- No source scan proves message delivery, database effects, or behavioral equivalence. Extraction and adoption remain blocked until reviewers and runtime/differential evidence explain the capability.

Together with the large archived Conductor corpus, this calibration demonstrates both scale-oriented recall and conventional-service precision. It still does not satisfy the roadmap's real architecture-inventory or verified-replacement pilot gates.

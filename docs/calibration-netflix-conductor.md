# Netflix Conductor discovery calibration

This is a repeatable external-repository calibration, not an AIR adoption pilot. It measures whether discovery produces a useful, reviewable architecture graph on a large codebase that was not designed for AIR.

## Corpus

- repository: [Netflix Conductor](https://github.com/Netflix/conductor)
- commit: `548f386c2c6c1e4d467b8551edbb6182881004ae`
- snapshot date: 2023-12-13
- shape: 516 Java files and 24 Gradle build files
- status: archived/read-only; useful as a stable regression corpus, not as evidence of current Spring ecosystem coverage

The snapshot includes Spring MVC APIs, Spring services and configuration, Redis and Cassandra persistence, Elasticsearch indexing, SQS event queues, gRPC services, schedules, caches, and extensive custom orchestration logic.

## Reproduction

```bash
git clone --depth 1 https://github.com/Netflix/conductor.git /tmp/netflix-conductor
mvn -q -f packages/discovery/spring-analyzer/pom.xml package
pnpm air discover spring /tmp/netflix-conductor \
  --output /tmp/netflix-conductor-discovery \
  --name netflix-conductor \
  --analyzer openrewrite
```

Pin the checkout to the commit above when comparing results over time. The discovery bundle is temporary calibration output and is not committed to AIR.

## Result after calibration fixes

| Measure | Before | After |
| --- | ---: | ---: |
| Nodes | 301 | 471 |
| Edges | 282 | 635 |
| Endpoint findings | 115 | 71 |
| Annotation-named false endpoints | 44 | 0 |
| Endpoints connected to an invoked service boundary | 0 | 70 |

All 71 method-level Spring MVC mapping annotations are represented once. Route composition resolves the class-level mapping constants in this snapshot: 70 routes are under `/api/...`, and the remaining health route is outside that prefix. No route expression was silently replaced with `/`; an unresolved or ambiguous expression remains an inferred `pathExpression` requiring review.

The graph also includes 23 Gradle modules, Spring services/components, configuration classes and beans, service contracts, custom DAO boundaries, schedules, caches, mapper inventory, dynamic routing, and provider calls. Gradle child modules inherit the root `com.netflix.conductor` group instead of receiving invented `unknown` coordinates.

As a usefulness check, the `POST /api/workflow` `startWorkflow` capability now reaches a 23-node source-linked slice: its service contract, implementation, orchestration services, and eight custom DAO boundaries. The DAO nodes and source-derived dependency edges remain `inferred`; they are not promoted to proven command effects.

## Defects found and hardened

- Replaced the multiline-annotation fallback that mistook `DeleteMapping`, `RequestParam`, and similar annotation calls for Java method names.
- Composed method routes with class-level `RequestMapping` prefixes.
- Resolved simple and concatenated Java string constants while treating name collisions as unresolved instead of guessing.
- Added inventory for `Service`, `Component`, `Configuration`, `ConfigurationProperties`, and `Bean` declarations.
- Added inferred service-contract and custom-DAO boundaries for non-JPA enterprise architectures.
- Added source-linked controller-to-service calls, service dependencies, and contract-to-implementation edges.
- Inherited root Gradle group/version information for child-module build coordinates.
- Extended the pinned OpenRewrite annotation inventory to match the source fallback coverage.

## Honest limitations

- Dependency edges derived from fields and method calls are architecture evidence, not proof that every downstream dependency executes for a particular request. Runtime traces and tests must confirm them.
- Conductor uses custom SQS/event-queue abstractions rather than Kafka or Rabbit listener annotations. Those abstractions are inventoried but are not automatically rewritten into AIR event/task semantics.
- Custom Redis, Cassandra, and Elasticsearch behavior remains behind inferred DAO or opaque provider boundaries until queries, mutations, and runtime evidence explain it.
- Conductor's workflow engine semantics are not converted into AIR sagas. Complex algorithms may remain foreign operations or foreign components indefinitely.
- No capability is adoptable from this source scan alone. Reviewer decisions and legacy/candidate verification remain mandatory.

The result supports AIR's intended value proposition: a navigable, evidence-backed architecture map and a bounded capability slice. It does not support a claim of one-click repository conversion.

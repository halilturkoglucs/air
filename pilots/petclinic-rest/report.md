# Petclinic REST v0.11 discovery rehearsal

## Decision

The pinned Petclinic corpus passes the AIR v0.11 discovery gates. This is an internal release rehearsal, not independent enterprise validation and not a modernization-success claim.

The run found all 37 checked-in OpenAPI operations exactly once. Supported-construct recall was 100%, the adjudicated false-positive rate was 0%, every node and edge had provenance, no test source entered deployed topology, and source/OpenRewrite scans produced identical stable semantic identities. The exported report contained no source excerpts, payload values, credentials, or personal data.

## Corpus and baseline

- Repository: `spring-petclinic/spring-petclinic-rest`
- Immutable commit: `afc8fc1d3b8ec8de69414482b3bd70a1da78cb95`
- Baseline: 237 passing Maven tests
- Runtime: PostgreSQL 16.4 with `postgres,spring-data-jpa`; health `UP`
- Discovery: 196 nodes and 300 edges
- Review scope: 154 entry-point or observable findings; 153 approved, 1 marked opaque, 0 rejected

The additional non-OpenAPI entry point is the root Swagger redirect. The single opaque boundary is `GET /api/oops`: it exists in the checked-in OpenAPI contract but has no uniquely attributable checked-in controller implementation. AIR did not invent one.

## Independent ground-truth corrections

The ground truth was frozen before the first AIR scan and was not rewritten after seeing AIR output. Review found two issues in that manifest:

- `cacheOperations: 1` was based on a commented example. The repository contains no active cache annotation.
- The seven MapStruct mappers were complete, but two hand-written JDBC row mappers were omitted. AIR's two additional mapper findings were valid.

These are recorded as adjudications in `metrics.json`; they were not counted as AIR errors.

## Defects found and fixed

The rehearsal produced three parser/report defects worth fixing before release:

1. Nested annotation arguments containing brace arrays could truncate a class annotation block and hide an entity.
2. An OpenAPI operation could be matched to a same-named service method in a controller file instead of only to the controller class body.
3. JavaDoc text and the `Superclass` suffix could be mistaken for Java type declarations while recovering annotations.

The workbench also initially counted non-observable inventory as required review and kept an approved inferred repository contract in the unresolved set. Review scope and unresolved semantics now match the release policy.

Regression tests cover nested annotations, controller-local OpenAPI attribution, required reviewer reasons, source-hash verification, deterministic redacted reports, and CLI report export.

## Review friction

- Repository-alternative JDBC, JPA, and Spring Data adapters are all visible. The reviewer must understand that profiles select them; the report preserves those profile attributes.
- OpenAPI-generated interfaces are absent until the build runs. Joining the checked-in contract to controller implementations is therefore necessary for useful operation coverage.
- A scripted workbench pass is fast, but an external design partner is still needed to measure human naming, grouping, and architecture-understanding effort.

No undocumented intervention was required after the fixes, and no decision or JSONL file was hand-edited. The next product proof is an external discovery design-partner pilot. Typed extraction remains experimental until the v0.12 vendor-REST pilot; verified adoption remains experimental until the v0.13 transactional Kafka/strangler pilot.

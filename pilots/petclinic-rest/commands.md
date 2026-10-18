# Rehearsal command log

All durations are wall-clock measurements on the local rehearsal host. Commands that contain temporary paths are shown with stable placeholders.

## Corpus freeze

```bash
git clone https://github.com/spring-petclinic/spring-petclinic-rest.git <temporary>/spring-petclinic-rest
git -C <temporary>/spring-petclinic-rest rev-parse HEAD
# afc8fc1d3b8ec8de69414482b3bd70a1da78cb95
```

The OpenAPI and source ground truth in `ground-truth.yaml` was recorded before the first AIR discovery run.

## Baseline build and runtime

```bash
./mvnw -Dmaven.repo.local=<temporary>/m2 test
# 237 tests, 0 failures, 0 errors, 0 skipped; 37.661 seconds

initdb -D <temporary>/postgres/data --auth=trust
pg_ctl -D <temporary>/postgres/data -o "-p 55432" start
createdb -p 55432 petclinic
./mvnw -Dmaven.repo.local=<temporary>/m2 spring-boot:run \
  -Dspring-boot.run.profiles=postgres,spring-data-jpa \
  -Dspring-boot.run.arguments="--spring.datasource.url=jdbc:postgresql://127.0.0.1:55432/petclinic"
# PostgreSQL 16.4; application startup 2.515 seconds; health status UP
```

The HTTP smoke test confirmed that the application could read its disposable seed data. Response payloads and the database directory were not retained.

## Independent discovery passes

Each command wrote to a new empty temporary directory. The two source bundles, the two OpenRewrite bundles, and all four node/edge identity sets were compared.

```bash
air discover spring <repository> --output <temporary>/source-a --name petclinic-rest --analyzer source
# 196 nodes, 300 edges; 0.58-0.61 seconds
air discover spring <repository> --output <temporary>/source-b --name petclinic-rest --analyzer source

air discover spring <repository> --output <temporary>/openrewrite-a --name petclinic-rest --analyzer openrewrite
# 196 nodes, 300 edges; 1.73-1.74 seconds
air discover spring <repository> --output <temporary>/openrewrite-b --name petclinic-rest --analyzer openrewrite
```

## Workbench review and report

```bash
air workbench <temporary>/openrewrite-a --reviewer internal-rehearsal
# Every observable boundary was decided through the workbench API and every
# source excerpt was fetched through its hash-verifying source endpoint.
# 154 decisions and 190 verified excerpts; 1.913 seconds for the scripted pass.

air discovery report <temporary>/openrewrite-a --output <temporary>/report
# 38 entry points, 1 unresolved/opaque boundary, 0 unreviewed observable boundaries
```

The review approved 153 findings and marked the source-unattributed `failingRequest` operation opaque with a required reason. No bundle or decision file was edited by hand.

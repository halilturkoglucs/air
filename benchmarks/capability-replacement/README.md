# Capability replacement benchmark

This is the deterministic mutation layer for the v0.12 release proof. `legacy.mjs` is a privacy-safe command harness for the AIR-owned legacy capability; `candidate.mjs` is an ordinary TypeScript/JavaScript replacement authored by an external coding agent and imports no AIR runtime.

The automated gate creates a legacy baseline in memory, runs the equivalent candidate 20 times, and requires every entry in `mutants.json` to produce a behavioral or missing-observation result. The committed material contains no payload captures or credentials.

The live gate uses `live-legacy.target.yaml` to execute an AIR-owned Spring JDBC capability against disposable PostgreSQL. The legacy process makes real loopback vendor HTTP calls, commits a document plus transactional outbox event, and reports observations read back from PostgreSQL. `live-candidate.target.yaml` runs the ordinary external-agent replacement against its own per-process PostgreSQL schema and the same observable boundary.

Set `AIR_BENCHMARK_DATABASE_URL` to a disposable PostgreSQL database, build the legacy JAR once with Maven, then use the standard `air check baseline` and `air check run` commands. The deterministic mutation gate remains useful without infrastructure and requires all 15 mutants to fail plus 20 equivalent reruns to pass.

The coordinated live gate is `pnpm proof:v0.12-live`. It requires a clean tracked tree, `AIR_PROOF_POSTGRES_URL`, and `AIR_HMCTS_REPOSITORY` pointing at the pinned checkout. It uses only the public `air check ... --json` protocol, performs 20 live equivalent reruns, detects all 15 live mutants, and then runs the four HMCTS scenarios.

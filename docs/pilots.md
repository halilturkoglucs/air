# Pilot program

The first pilots should test trust and adoption cost, not raw feature count. Use a bounded service with PostgreSQL 16, fewer than ten entities, one transactional command, and no regulated or production customer data.

## Recommended pilot sequence

1. Baseline the existing service: tests, schema, routes, build time, artifact size, and one representative transaction.
2. Choose one entry path: new AIR document, PostgreSQL import, OpenAPI import, or Next.js/Drizzle import.
3. Run `air target-check` before compilation and preserve the JSON compatibility report.
4. Compile into an isolated directory, run `air ownership`, and mark intentionally maintained artifacts with `air adopt`.
5. Add verification scenarios for success, domain failure, authorization, rollback, and replay where applicable.
6. Run live conformance against a disposable database. Run differential verification only when evaluating multiple targets.
7. Record setup time, manual edits, diagnostics that required interpretation, regenerated-file drift, and whether the team would repeat the workflow.

## Exit criteria

A successful pilot has a reproducible command log, passing semantic and live evidence, no unexplained generated changes, and an explicit keep/stop decision. Performance evidence is optional unless performance is the pilot hypothesis. Never count generated lines of code as the primary outcome.

Use the repository’s AIR pilot issue template for a sanitized report. The initial decision set should compare at least three pilots: greenfield, imported, and partial-adoption. Promote a workflow only when two independent pilots complete it without undocumented intervention.

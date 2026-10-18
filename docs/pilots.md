# Pilot program

AIR v0.11 is pilot-first: unfamiliar-service discovery and review is the supported outcome. Capability extraction and replacement are separate later pilots and remain experimental.

The internal [Spring Petclinic REST rehearsal](../pilots/petclinic-rest/report.md) pins an unseen corpus, freezes ground truth before scanning, exercises PostgreSQL 16, compares source and OpenRewrite scans, completes all review through the workbench, and records sanitized metrics. It is release-gating regression evidence, not independent customer validation.

The first pilots should test trust and adoption cost, not raw feature count. Use a bounded service with PostgreSQL 16, fewer than ten entities, one transactional command, and no regulated or production customer data.

## Recommended pilot sequence

1. Pin the corpus commit and freeze independent ground truth before the first AIR scan.
2. Baseline tests, documented operations, persistence profiles, and a disposable runtime.
3. Run source and OpenRewrite discovery twice from clean directories; compare semantic identities and provenance.
4. Review every entry point and observable boundary through `air workbench --reviewer`; never edit bundle files manually.
5. Export `air discovery report`, then record setup, scan, review, false-positive, miss, archaeology, and intervention metrics.
6. For later experimental pilots, extract only one reviewed capability and require differential evidence before adoption.

## Exit criteria

A successful discovery pilot has a reproducible command log, complete provenance, stable identities, explicit unresolved behavior, no source/payload leakage, no hand-edited bundle files, and an explicit keep/stop decision. It measures archaeology and review time—not imported class count or YAML size.

Use the repository’s AIR pilot issue template for a sanitized report. An external design-partner discovery pilot follows v0.11. Promote typed extraction only after the v0.12 vendor-REST pilot, and promote verified replacement only after the v0.13 transactional Kafka/strangler pilot.

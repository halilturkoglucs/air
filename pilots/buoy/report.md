# Buoy public-corpus discovery benchmark

Status: complete at commit `138611efc00e27e33d03b37993a85c3db3dd3ca9`.

This is an independent public-corpus regression benchmark. It does not measure another team's review effort or willingness to adopt AIR and therefore is not a design-partner pilot.

The frozen ground truth exposed two real misses in the first run: programmatic Caffeine caches and `@TransactionalEventListener` handlers were absent. AIR added conservative, review-required Caffeine inventory and transactional Spring-event listeners, plus SQL migration-table inventory, then repeated all scans from fresh output directories.

The final source and OpenRewrite runs each produced 185 nodes and 346 edges. Repeated runs preserved every node and edge ID, and source/OpenRewrite semantic identities were identical. All 35 documented REST operations appeared exactly once; both Caffeine caches, four transactional event listeners, nine entities, nine migration tables, repositories, transactions, security boundaries, and Spring-event publications were present. No deployed finding referenced test source. Every node and edge had provenance.

The loopback workbench was the only decision-writing interface. Reviewer `public-corpus-reviewer` opened the verified source evidence and approved 116 entry-point or observable findings; no bundle file was edited manually. The final report has 39 entry points, zero unreviewed observable findings, zero unresolved boundaries, and zero unmatched evidence. No reviewed finding was rejected as a false positive.

Buoy's 129 Gradle tests passed on the repository's required Java 25 toolchain. A disposable PostgreSQL 16.15 runtime applied its migrations and reached `UP` in 3.239 seconds. The four AIR scans took 0.872 s, 0.904 s, 1.970 s, and 1.901 s respectively; the deterministic workbench API rehearsal took 1.574 s. These machine timings do not represent human enterprise review time.

Report checksums:

- `report.json`: `3b6846eeec4a312d781838a8e38c73cd33c38d8fe9e9ea6d074beb2bf2ac10e2`
- `report.html`: `e6bd594eed54f8240b3cbc49bba591fd72bf65222ef8f3641830346044d86e81`

The sanitized report proves product behavior against a public corpus. It does not support customer archaeology-time, adoption, or ROI claims.

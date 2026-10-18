# Spring Petclinic REST internal rehearsal

This directory contains sanitized, reproducible evidence for AIR's v0.11 discovery release gate. It never contains the cloned repository, generated application files, database contents, raw HTTP bodies, credentials, or personal data.

The ground truth was frozen from the repository's checked-in OpenAPI contract and Java source before AIR discovery was run. The pinned corpus is `spring-petclinic/spring-petclinic-rest` at commit `afc8fc1d3b8ec8de69414482b3bd70a1da78cb95`.

Expected committed artifacts:

- `ground-truth.yaml`: independent supported-construct inventory and release thresholds;
- `commands.md`: reproducible, secret-free command log and timings;
- `metrics.json`: machine-readable sanitized results;
- `report.md`: findings, review friction, fixes, and the release decision.

Temporary clones, AIR discovery bundles, SQLite indexes, generated HTML, Maven output, and PostgreSQL data stay outside the repository.

# Versioning and releases

AIR is pre-1.0 and uses semantic versioning with an intentionally strict interpretation:

- patch: defect fixes that do not change accepted AIR documents or generated public behavior;
- minor: new schema versions, target capabilities, import behavior, or generated-runtime changes;
- major: reserved for a stable compatibility commitment.

The AIR document declares its own `apiVersion`; the CLI migrates older supported documents in memory. Target manifests and evidence formats are separately versioned. A CLI release may support several AIR schema versions.

Run `pnpm release:check`, then `pnpm release:artifacts <directory>`. The latter creates a source archive and `manifest.json` containing its byte size and SHA-256 digest, and refuses to overwrite an existing archive. Manual GitHub Actions runs build private release candidates. A signed `v*` tag runs the same gate, publishes `@halilturkoglucs/air` through npm trusted publishing, and creates a checksummed GitHub release.

Before tagging, update `CHANGELOG.md`, ensure target compiler versions and lockfile dependencies are intentional, run the conformance workflow, and retain its evidence pack with the release candidate.

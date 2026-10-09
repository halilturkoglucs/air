# Versioning and releases

AIR is pre-1.0 and uses semantic versioning with an intentionally strict interpretation:

- patch: defect fixes that do not change accepted AIR documents or generated public behavior;
- minor: new schema versions, target capabilities, import behavior, or generated-runtime changes;
- major: reserved for a stable compatibility commitment.

The AIR document declares its own `apiVersion`; the CLI migrates older supported documents in memory. Target manifests and evidence formats are separately versioned. A CLI release may support several AIR schema versions.

Run `pnpm release:check`, then `pnpm release:artifacts <directory>`. The latter creates a source archive and `manifest.json` containing its byte size and SHA-256 digest, and refuses to overwrite an existing archive. Manual GitHub Actions runs build private release candidates. A signed `v*` tag runs the same gate, publishes both `@halilturkoglucs/air-plugin-sdk` and `@halilturkoglucs/air` through npm trusted publishing, and creates a checksummed GitHub release. The workflow checks npm before each publish, so an interrupted coordinated release can be rerun without attempting to replace an immutable version.

Before tagging, update `CHANGELOG.md`, ensure target compiler versions and lockfile dependencies are intentional, run the conformance workflow, and retain its evidence pack with the release candidate.

## npm trusted publishing

Each npm package has its own trusted-publisher connection. Configure both packages with:

- provider: GitHub Actions;
- organization or user: `halilturkoglucs`;
- repository: `air`;
- workflow: `release.yml`;
- direct `npm publish`: allowed;
- dist-tag management: not granted.

The release workflow needs `id-token: write`, uses a current npm CLI, and publishes with `--provenance`. Keep the package name, repository, workflow filename, and GitHub owner exact: npm matches the OIDC claim against this configuration. AIR never stores a long-lived npm token in GitHub Actions.

### One-time bootstrap for a new npm package

npm cannot attach a trusted publisher until a package exists. For a new coordinated package:

1. Build and inspect the tarball with `npm pack --dry-run`.
2. Create the package once using npm's authenticated bootstrap flow. Prefer staged publishing and approve the staged version in npm when available; otherwise perform the smallest one-time direct publish from an authenticated maintainer session.
3. Add the trusted-publisher connection shown above immediately after the package exists.
4. Confirm `latest` points at the intended real version. A bootstrap placeholder may remain in version history; do not move `latest` back to it.
5. Validate the connection with the next GitHub Actions publication and confirm the published version contains a provenance attestation whose source is this repository and workflow.

A manually bootstrapped version does not acquire provenance retroactively. Record that exception rather than claiming an attestation that npm does not expose.

## Coordinated release order

Release the distribution in this order:

1. Publish or confirm the plugin SDK on npm.
2. Publish the CLI on npm with provenance.
3. Create the GitHub Release from the immutable tag and attach the source archive plus `manifest.json`.
4. Calculate the SHA-256 of the public CLI npm tarball, update `halilturkoglucs/homebrew-tap`, and test the formula.

Do not update Homebrew before the CLI tarball is publicly readable. Verify the two npm versions and dist-tags, the CLI provenance attestation, the GitHub tag/commit identity, every release-asset checksum, and the formula checksum before declaring the release complete.

## Recovering an interrupted release

Treat published npm versions and Git tags as immutable. Fix credentials or publisher configuration, then rerun the failed tag workflow. Its registry checks skip versions that already exist and continue with the missing package or GitHub Release. Never delete and republish a real version to make a coordinated run look atomic.

If npm reports that a successful publication is still being processed, wait for the public registry document and tarball to converge before updating Homebrew. If the SDK exists but the CLI does not, leave the GitHub tag unchanged, rerun the workflow after fixing the failure, and verify all channels again. Document any bootstrap publication that lacks provenance; use a later patch release if a fully attested SDK artifact is required.

# Contributing to AIR

Thank you for helping improve AIR. Start with an issue for substantial semantic, schema, target, or compatibility changes so the behavior and migration path can be agreed before implementation.

## Development

Use Node.js 22 and pnpm 11.19 or newer:

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

Changes to AIR semantics require parser validation, canonical-verifier coverage, target compatibility analysis, and migration notes when existing documents are affected. Generated target changes should preserve managed ownership and include build or live evidence proportional to their risk.

## Certificate of origin

By contributing, you certify the Developer Certificate of Origin in [DCO.md](DCO.md). Add a `Signed-off-by` line to commits using `git commit -s`. Contributions are licensed under Apache-2.0, the repository license. Do not submit employer-owned or third-party code without authorization.

## Security and conduct

Do not open public issues for vulnerabilities, credentials, proprietary source, or customer data; follow [SECURITY.md](SECURITY.md). Be respectful, technically specific, and assume good faith in review.

# AIR CLI

**AI writes the migration. AIR proves what changed.** The AIR CLI freezes reviewed legacy behavior and independently checks an agent-written replacement. It also preserves the earlier discovery, Application IR, compiler, provider, and conformance workflows.

<!-- AIR_LLM_BENCHMARK:START -->
## Does AIR improve an LLM migration?

The reproducible paired benchmark is ready. Results publish only after all 18 pinned GPT-6 Astra runs and deterministic rescoring complete.
<!-- AIR_LLM_BENCHMARK:END -->

```bash
npm install --global @halilturkoglucs/air
air --version
air --help
```

The current public release is `0.12.0`. For a reproducible installation, use
`npm install --global @halilturkoglucs/air@0.12.0`.

The `air check` workflow uses stable JSON output and needs no hand-authored Application AIR YAML:

```bash
air check validate check.yaml --policy policy.yaml --json
air check baseline check.yaml --target legacy.target.yaml --policy policy.yaml --output .air/check/baseline --json
air check run check.yaml --baseline .air/check/baseline --target candidate.target.yaml --policy policy.yaml --output .air/check/run --json
air check explain .air/check/run/result.json --json
```

Candidate differences exit `1`, invalid or stale input exits `2`, and infrastructure failures exit `3`. Baselines are content-addressed and overwrite-protected; raw observed values and credentials are absent by default.

See the [from-scratch tutorial](https://github.com/halilturkoglucs/air/blob/main/docs/getting-started-agent-verification.md) for installation, a passing example, a deliberately broken migration, command and HTTP targets, policies, normalization, and CI usage.

Spring discovery requires Java 17 or newer. The npm package includes AIR's pinned OpenRewrite analyzer, so Maven and an AIR source checkout are not required:

```bash
air discover spring ./legacy-service --output .air/discovery --analyzer openrewrite
air workbench .air/discovery --reviewer alice@example.com
air discovery report .air/discovery --output .air/report
```

In v0.11, discovery and report generation are supported. `air extract`, `air verify-import`, and capability adoption are preserved as experimental workflows.

Homebrew users can install the same CLI from the project tap:

```bash
brew install halilturkoglucs/tap/air-ir
air --version
air --help
```

Documentation and source: https://github.com/halilturkoglucs/air

# AIR CLI

**AI writes the migration. AIR proves what changed.** The AIR CLI freezes reviewed legacy behavior and independently checks an agent-written replacement. It also preserves the earlier discovery, Application IR, compiler, provider, and conformance workflows.

<!-- AIR_LLM_BENCHMARK:START -->
## Does AIR improve an LLM migration?

![LLM alone pass@3](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-control-pass-at-3.svg) ![LLM + AIR pass@3](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-air-pass-at-3.svg) ![Escaped defects](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-escaped-defects.svg)

> **Same model. Same task. Same 3-round repair budget.** With AIR feedback, `claude-sonnet-5-5` shipped **1/9** behaviorally correct migrations, compared with **0/9** on ordinary tests alone. Escaped defects: **125 → 58**.

| Metric | LLM alone | LLM + AIR | Lift |
| --- | ---: | ---: | ---: |
| ✅ Behaviorally correct (pass@3) | 0/9 (0%) | **1/9 (11%)** | **+11 pts** |
| ⚡ Correct on first attempt (pass@1) | 0/9 (0%) | 0/9 (0%) | = |
| 🐛 Escaped defects (hidden suite) | 125 | **58** | **−54%** |
| 🟢 Tests green, behavior wrong | 9/9 | 8/9 | **−11%** |
| 🎯 Hidden scenarios passed | 12% | 58% | **+45 pts** |
| 🔁 Median repair rounds | 3 | 3 | = |
| 🪙 Median tokens per run | 127k | 148k | **+17%** |

| Capability slice | LLM alone | LLM + AIR |
| --- | ---: | ---: |
| Document creation | 0/3 | **0/3** |
| Ledger transfer | 0/3 | **0/3** |
| Library access | 0/3 | **1/3** |

<details>
<summary>Escaped defects by category</summary>

| Category | LLM alone | LLM + AIR |
| --- | ---: | ---: |
| authorization | 5 | 0 |
| database | 29 | 14 |
| failures | 12 | 3 |
| filtering | 5 | 2 |
| http | 29 | 14 |
| idempotency | 6 | 6 |
| messages | 12 | 9 |
| ordering | 9 | 5 |
| outbound | 6 | 0 |
| pagination | 3 | 2 |
| retryability | 6 | 3 |
| rollback | 3 | 0 |

</details>

Pinned result: `claude-sonnet-5-5`, medium reasoning, claude-code 2.1.308 · suite 1.2.0 · 18 isolated runs · 2026-10-22 · source `b04b5f7d0869`. pass@3 95% Wilson interval: alone 0%–30%, AIR 2%–44%. Both arms see the same task and ordinary tests. The AIR arm also receives `air check` differences on feedback scenarios. A held-out hidden suite scores both arms. [Methodology and evidence](https://github.com/halilturkoglucs/air/tree/main/benchmarks/llm-air-lift).

This result applies only to the named model and suite. Runtime throughput is measured separately.
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

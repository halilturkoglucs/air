# AIR CLI

**AI writes the migration. AIR proves what changed.** The AIR CLI freezes reviewed legacy behavior and independently checks an agent-written replacement. It also preserves the earlier discovery, Application IR, compiler, provider, and conformance workflows.

<!-- AIR_LLM_BENCHMARK:START -->
## Does AIR improve an LLM migration?

![LLM alone pass@3](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-control-pass-at-3.svg) ![LLM + AIR pass@3](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-air-pass-at-3.svg) ![Escaped defects](https://raw.githubusercontent.com/halilturkoglucs/air/main/benchmarks/llm-air-lift/badges/claude-sonnet-5-5-escaped-defects.svg)

> **Same model. Same task. Same 3-round repair budget.** With AIR feedback, `claude-sonnet-5-5` passed **100%** of hidden behavioral scenarios, compared with **23%** on ordinary tests alone. Escaped defects: **218 → 0**. Fully correct migrations: **9/9** vs 0/9.

| Metric | LLM alone | LLM + AIR | Lift |
| --- | ---: | ---: | ---: |
| ✅ Behaviorally correct (pass@3) | 0/9 (0%) | **9/9 (100%)** | **+100 pts** |
| ⚡ Correct on first attempt (pass@1) | 0/9 (0%) | 0/9 (0%) | = |
| 🐛 Escaped defects (hidden suite) | 218 | **0** | **−100%** |
| 🟢 Tests green, behavior wrong | 9/9 | 0/9 | **−100%** |
| 🎯 Hidden scenarios passed | 23% | 100% | **+77 pts** |
| 🔁 Median repair rounds | 3 | 2 | **−33%** |
| 🪙 Median tokens per run | 63k | 65k | **+4%** |

| Capability slice | LLM alone | LLM + AIR |
| --- | ---: | ---: |
| Document creation | 0/3 | **3/3** |
| Ledger transfer | 0/3 | **3/3** |
| Library access | 0/3 | **3/3** |

<details>
<summary>Escaped defects by category</summary>

| Category | LLM alone | LLM + AIR |
| --- | ---: | ---: |
| authorization | 7 | 0 |
| database | 51 | 0 |
| failures | 24 | 0 |
| filtering | 3 | 0 |
| http | 51 | 0 |
| idempotency | 12 | 0 |
| messages | 24 | 0 |
| ordering | 14 | 0 |
| outbound | 12 | 0 |
| pagination | 2 | 0 |
| retryability | 12 | 0 |
| rollback | 6 | 0 |

</details>

Pinned result: `claude-sonnet-5-5`, medium reasoning, claude-code 2.1.308 · suite 1.4.0 · 18 isolated runs · 2026-10-22 · source `d68184d1768d`. pass@3 95% Wilson interval: alone 0%–30%, AIR 70%–100%. Both arms see the same task and ordinary tests. The AIR arm also receives `air check` differences on feedback scenarios. A held-out hidden suite scores both arms. [Methodology and evidence](https://github.com/halilturkoglucs/air/tree/main/benchmarks/llm-air-lift).

This result applies only to the named model and suite. Runtime throughput is measured separately.
<!-- AIR_LLM_BENCHMARK:END -->

```bash
npm install --global @halilturkoglucs/air
air --version
air --help
```

The current public release is `0.15.0`. For a reproducible installation, use
`npm install --global @halilturkoglucs/air@0.15.0`.

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

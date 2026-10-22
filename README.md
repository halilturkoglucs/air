# AIR

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Conformance](https://github.com/halilturkoglucs/air/actions/workflows/conformance.yml/badge.svg)](https://github.com/halilturkoglucs/air/actions/workflows/conformance.yml)

> **AI writes the change. AIR proves what changed.**

AIR is an open, model-neutral behavior lock for code changes. Freeze the reviewed behavior of a service, or of one part of it, then let you or any coding agent change the code: rewrite it in another language, refactor or upgrade it in place, split it into services or merge it back, or build the next feature. AIR compares HTTP results, database effects, messages, outbound calls, ordering, and failures independently, reports exactly what changed, and lets you approve intended changes per scenario. It proves equivalence only inside the observation boundary you declare, not general correctness.

Since v0.12, agent verification is AIR's primary product journey. AIR’s existing Application IR, compiler, providers, discovery, and import commands remain compatible, but coding agents no longer need AIR-generated code or an Application AIR document to verify a replacement.

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

## What can I use it for?

| Use case | What AIR locks | How you start |
| --- | --- | --- |
| Rewrite a service or endpoint in another language | HTTP responses, database effects, messages, outbound calls, ordering, failures | Legacy and candidate targets (command or HTTP) |
| Refactor or upgrade a service in place (framework, dependencies, internals) | Everything observable stays the same | `air check baseline --at main`: legacy runs from a Git ref, no second deployment |
| Extract a microservice or merge services into a monolith | External behavior; the new internal boundary is declared, not ignored | `rename` and `internal-boundary` normalizations, `lifecycle.services` |
| Day-to-day feature work with a coding agent | Behavior you did not mean to change; intended changes are approved per scenario | `air check run --agent --reveal`, then `air check approve <scenario> --reason "..."` |
| Gate AI-written changes in CI | Approved baseline versus the pull request | `air check run --json` exit codes, `air check coverage --fail-under` |
| Understand an unfamiliar service before changing it | Endpoints, gRPC methods, consumers, and their data, cache, outbound, and messaging effects | `air discover code`, `air discover traces`, recorded traffic |

### Quick start

```bash
npm install --global @halilturkoglucs/air
air agent install                              # once: tells Claude Code, Codex, and other agents how to use AIR
air protect --url http://localhost:3000        # once, with your service running: builds safe scenarios and a baseline
# change the code (or ask your agent to), restart the service
air protect                                    # after every change: PASS, or exactly what changed
```

No proxy or framework plugin is needed: the first `air protect` builds read-only scenarios from an OpenAPI file in the repository or from the routes it finds in the code, then calls the service directly. Every run prints how many of the code's HTTP routes are exercised. Grow that with `air protect --add --tests`, which runs your existing API tests through AIR's recording proxy (it detects the test command and points base-URL variables such as `API_URL` at the proxy), or `air protect --add -- <command>` for any script that calls `$AIR_PROXY_URL`. Only new requests are added and baselined. When a recorded sign-in issues a token or cookie, later requests take it from that response at replay time, so signed-in routes are covered without storing a credential. Differences show expected and actual values; values stay on your machine (`.air/expected.json`, gitignored). Accept an intended change with `air check approve <scenario> --reason "..."`.

Two flags cover what most real services need. `--header Cookie=AIR_SESSION` signs requests in with a value read from that environment variable (only the name is stored). `--reset "npm run db:reset"` restores a clean state before each scenario, so data written by one request (even a GET) cannot hide a code change; add `--reset-scope run` when later requests depend on earlier ones (add to cart, then check out). `air protect` suggests both when its first run shows a login wall or the code stores data, and `--rebaseline` re-captures behavior with the new setup while keeping the old baseline.

Every new baseline is run twice. Generated IDs, timestamps, and JWTs that differ between the runs are checked by type instead of value. Content that is random by design (ads, recommendations) is named with a ready `shape` rule, which keeps keys and types but not values; you add it with the reason.

Events, caches, data, jobs, files, and emails are covered without AIR parsing every technology: `air protect` prints a `TASK`, your coding agent writes a small harness in any language (`air harness new`), and AIR accepts it only after `air harness verify --mutation <patch>` proves it is stable across runs, reacts to its input, and catches a deliberately broken copy of the code. Verified harnesses are baselined and checked by every `air protect` run. For a service in containers, `--setup` builds and deploys the broken copy and `--teardown` restores the original.

On the [OpenTelemetry demo](docs/design/discover-code.md#field-trial-opentelemetry-demo) (nine languages, gRPC, Kafka, Valkey), a planted checkout bug that sent only the first order item to Kafka passed all 14 HTTP scenarios; the harness caught it in both the Kafka event and the accounting database.

### Ways to start

Scenarios can come from wherever a team already is. None of them needs AIR-generated code or a framework plugin in your service:

- **Recorded traffic, any language:** `air check record --to http://localhost:3000 --output checks/api` puts a recording proxy in front of a running service (or use `--from-har` with a browser or Playwright HAR file). Credentials are dropped unless you keep a header explicitly.
- **An OpenAPI spec:** `air check init --from-openapi openapi.yaml --output checks/api` writes one reviewable scenario per operation.
- **OpenTelemetry traces:** `air discover traces traces.json` maps each endpoint to the tables, outbound calls, and messages it touches.
- **Spring source code:** `air discover spring ./service` builds an evidence-backed map, then `air check init` turns a reviewed capability into a check.
- **By hand, for any language:** a target is just a command that reads JSON and prints an observation, or an HTTP base URL. Writing one is usually a short script.

`air discover code` reads HTTP routes, gRPC methods (`.proto`), message producers and consumers (Kafka, RabbitMQ, ActiveMQ/JMS, BullMQ, MassTransit, Service Bus), caches, and data stores from source in JavaScript/TypeScript, Python, Go, Java/Kotlin, C#, PHP, Rust, and Ruby (19/19 RealWorld endpoints in each measured stack). It only proposes; nothing counts until AIR has executed it; see [`docs/roadmap.md`](docs/roadmap.md) §12a.

### The everyday loop

```bash
air check profile --check check.yaml --policy policy.yaml --baseline .air/baseline \
  --legacy legacy.target.yaml --candidate candidate.target.yaml --output .air/runs --at main
air check baseline                 # once; legacy runs from the Git ref
air check run --agent --reveal     # repeat while you or an agent edit the code
air check approve <scenario> --reason "intended change"
air check coverage --openapi openapi.yaml --fail-under 80
```

`air check run --agent` prints a short, deterministic report (expected versus actual values for each failing scenario, what was fixed since the last run, and the next step). `air mcp` serves the same commands as MCP tools for Claude Code, Codex, and other agents, and `air agent instructions` prints the loop to paste into `AGENTS.md` or `CLAUDE.md`. Nothing else needs to be installed.

AIR is not a general correctness oracle, fuzzy similarity scorer, load tester, or one-click migration generator. A passing result means that the candidate matched the approved baseline for the declared scenarios and observations.

## Choose a workflow

- **Prove an agent-written replacement:** follow [Getting started with agent verification](docs/getting-started-agent-verification.md).
- **Refactor, record traffic, or approve intended changes:** see [refactors, recorded traffic, and intentional changes](docs/language-agnostic-agent-protocol.md#refactors-recorded-traffic-and-intentional-changes).
- **Extract or merge services:** start from [`examples/extract-service`](examples/extract-service) and the topology normalizations in the [getting-started guide](docs/getting-started-agent-verification.md#9-choose-normalization-carefully).
- **Understand the security and evidence model:** read [Agent verification](docs/agent-verification.md).
- **Connect any backend or coding agent:** use the [language-agnostic agent protocol](docs/language-agnostic-agent-protocol.md).
- **Inventory an enterprise Spring service:** follow [Enterprise discovery and modernization](docs/enterprise-modernization.md).
- **Use the existing AIR IR and code generators:** see the [AIR schema guide](docs/air-schema.md), [verification model](docs/verification.md), and the `examples/ledger` and `examples/complex-commerce` projects.
- **Preserve UI intent across frameworks:** use the framework-neutral [AIR UI schema](docs/ui-schema.md) for static, server-rendered, client, or hybrid interfaces.
- **Build a provider or deployment integration:** see [Target and plugin adapters](docs/target-adapters.md).

## More

- [Driving `air check` by hand](docs/manual-check-workflow.md): the individual commands behind `air protect`, for CI and full control.
- [AIR IR toolchain](docs/legacy-toolchain.md): the Application IR, compiler, Next.js/Rust/Python generators, providers, importers, plugin SDK, and verification status. Supported and compatible, but not the main path.

## License and commercial use

AIR is licensed under Apache-2.0. Commercial use is permitted. AIR does not require generated applications to use the AIR license; see [generated output and ownership](docs/generated-output-license.md). The AIR name and branding are governed separately by [the trademark policy](TRADEMARKS.md).

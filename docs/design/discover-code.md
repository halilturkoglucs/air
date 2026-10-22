# Design: `air discover code`

Status: proposed (roadmap §12a, milestone 4). Owner review required before implementation.

## Problem

Today a team without Spring, OpenAPI, telemetry, or recorded traffic has to hand-write a check before AIR can protect a change. That blocks the most common case: a developer or coding agent about to change some part of an ordinary codebase, in any language.

## What it is, and what it is not

`air discover code` turns a scope of source code into an **executed, approved baseline** for the behavior at its seams. A finding that has not been run is a proposal, never a result.

It is not a code knowledge graph. It does not model the internal call graph, symbols, or architecture. Structural tools (for example graphify) answer "how is this code organized?"; this answers "what does this code observably do, and will my change alter it?"

| | Code map / knowledge graph | `air discover code` |
| --- | --- | --- |
| Unit | Files, symbols, references | Behavioral seams: entry points and their effects |
| Output | A graph to read | Runnable targets, scenarios, and a baseline |
| Truth source | Static analysis | Execution; static analysis only proposes |
| Done when | The graph is built | The seam ran deterministically and was baselined |
| Question answered | How is it structured? | What could this change break? |

## Pipeline

```text
scope ──► seam scan ──► proposals ──► execution gate ──► baseline
(path, symbol,   (static,        (targets +       (run N times,       (at a Git ref,
 --since ref)     inferred)       scenarios)       stable digests)     approved)
```

1. **Scope.** The whole repository, or `--path <dir|file>`, `--symbol <name>`, or `--since <git-ref>` (only seams whose files the diff touches). Development is the default use: discover what you are about to change.
2. **Seam scan (static, deterministic, no new dependencies).** Find entry points (HTTP routes and handlers, CLI entry points, scheduled jobs, message consumers) and the effects near them (SQL and ORM calls, HTTP clients, message publishes). Detection rules are data (`packages/discovery/rules/*.json`): per-ecosystem patterns over comment-stripped source, not per-framework code. First ecosystems: JavaScript/TypeScript (Express, Fastify, Koa, Hono, Nest, Next.js route handlers), Python (Flask, FastAPI, Django), Go (net/http, gin, echo, chi); Java keeps the existing Spring analyzer. Every finding has a kind, a source location, and evidence `inferred`.
3. **Proposals (`air check init --from-code`).** For each seam, a target and scenario skeletons:
   - HTTP seams get an HTTP target whose `lifecycle.start` comes from the project's own start command (`package.json` scripts, `Procfile`, `manage.py runserver`, `go run`), plus a readiness path. Scenarios come from the route, its path parameters, and request-field reads in the handler, and are marked `TODO review`.
   - CLI seams get a command target with the detected argv.
   - Function-level seams (`--symbol`) use the existing command-target contract (JSON on stdin, observation JSON on stdout). AIR ships tiny adapter templates for JavaScript/TypeScript and Python, written into the user's repository and owned by them. For other languages, `air agent instructions --adapter` prints the contract for a coding agent to implement.
4. **Execution gate (`air discover code --verify`).** Start each proposed target, check readiness, and run its scenarios three times.
   - Identical normalized digests across runs: the seam becomes `observed`.
   - Values that differ across runs and match a UUID or UTC-timestamp format: AIR proposes `typed-token` normalizations automatically.
   - Any other unstable value: reported for review; only a human may add an `ignore` with a reason.
   - A target that fails to start or crashes: reported with the first causing error line (agent-mode style); never silently dropped.
5. **Baseline.** Accepted seams are baselined with the existing `air check baseline`, by default `--at <ref>` so the protected behavior is the code before the change.

## Outputs

- `.air/discovery/code.json` (`air.dev/code-seams/v0.1`): seams with kind, location, scope, evidence (`inferred` → `runnable` → `observed` → `baselined`), proposed target and check paths, and any review notes. Deterministic ordering; no raw observed values.
- A compact text summary in the same style as `--agent` output, for people and agents.
- Ordinary check, target, and policy files the user reviews and commits. Nothing AIR-specific is added to the service itself.

## Agent-first operation

Developers should not have to learn or type this pipeline. A coding agent runs it, and the developer only answers the questions only a human can answer.

- **One entry point:** `air protect [<path>] [--since <ref>]` runs scope, seam scan, proposals, and the execution gate in one step and is idempotent. It stops only at review decisions and ends with a single `NEXT` line, in the same compact format as `air check run --agent`.
- **One-time setup, then automatic:** `air agent install` appends a marked, idempotent block to `AGENTS.md` and `CLAUDE.md` (created if missing, never rewritten outside the markers) that tells any agent to run `air protect --since HEAD` on the area it is about to change, then `air check run --agent --reveal` after each edit, and to ask the developer before approving or ignoring anything. It prints the one-line MCP registration for Claude Code and Codex and only performs it with `--mcp`.
- **MCP tools:** `air_protect` and `air_discover_code` join the existing `air_check_*` tools, so agents that use MCP never shell out.
- **Human decisions are phrased as questions.** When AIR needs a human (a `TODO review` scenario input, an unstable field that would need `ignore`, an intended behavior change), the report states the exact question and the command the agent runs once the developer answers, for example `QUESTION orders.total changes on every run; is it derived from time? If yes: air protect --ignore /http/body/total --reason "<answer>"`.
- **Safe defaults for unattended runs.** `air protect` never baselines unreviewed scenarios, never approves changes, and never adds an `ignore` on its own. Everything it writes is ordinary, reviewable files under `.air/` plus the check files the developer commits.

### Delivered first: `air protect` on existing sources

At the owner's request, the agent-first entry point shipped before steps 4b–4d, built on sources that already work for any HTTP service: an OpenAPI file, routes found by `air discover code` (read-only, parameter-free GET routes only), or an optional recorded command. As 4b–4d land, `air protect` gains richer scenarios and non-HTTP seams without changing how people use it.

### Behavior beyond HTTP: agent-written, AIR-verified harnesses

Parsing every technology (brokers, caches, schedulers, file and mail systems) does not scale. Instead, the coding agent that already works in the repository writes a small harness in the existing command-target contract, and AIR decides whether to trust it with deterministic checks only: identical results across runs (generated UUIDs and timestamps become proposed `typed-token` rules), different observations for different inputs, and a detected difference when the same harness runs against a throwaway copy of the code with an agent-supplied breaking patch applied. Observation categories are open, so a harness reports whatever matters (`events`, `cache`, `files`, ...). This replaces most of the planned per-language work in steps 4b–4d: the code scanner now points the agent at what to cover instead of trying to model it.

### Measured recall

Static seam detection is checked against public RealWorld ("Conduit") implementations, which expose the same 19 endpoints in every stack. They are scanned only; third-party code is never installed or run.

| Stack | Routes found | Data effects reported |
| --- | ---: | --- |
| Express | 19/19 | Prisma models |
| NestJS | 19/19 | TypeORM entities |
| FastAPI | 19/19 | tables from `.sql` query files |
| Django REST Framework | 19/19 | Django models |
| Go / gin | 19/19 | GORM models |
| Spring Boot | 19/19 | MyBatis mapper tables |
| ASP.NET Core | 19/19 | Entity Framework `DbSet`s |
| Rails | 19/19 | ActiveRecord models |
| Laravel | 19/19 | Eloquent models |
| Rust / axum | 19/19 | tables from `sqlx` queries |

Prefixes held in runtime variables (for example `settings.API_V1_STR`) are not resolved; scenarios stay correct relative to the router and are completed by recording or OpenAPI.

## Everyday flow

What the developer does: run `air agent install` once, then ask their agent for a change as usual.

What the agent does, guided by the installed instructions:

```bash
air protect src/billing --since main      # discover, propose, verify; asks questions if needed
air check baseline                        # after the developer confirms the proposed scenarios
# edit code
air check run --agent --reveal            # repeat until exit 0
air check approve <scenario> --reason "..."   # only after the developer confirms the change is intended
```

The individual commands (`air discover code`, `air check init --from-code`, `--verify`) remain available for CI and for people who want to drive each step.

## Increments

| Step | Delivers | Verified by |
| --- | --- | --- |
| 4a | Seam scanner with rules for JS/TS, Python, Go; `--path`, `--symbol`, `--since`; report | Fixture repositories per framework, exact report snapshots |
| 4b | Start-command detection, target and scenario proposals (`check init --from-code`) | Fixtures produce valid check and target files |
| 4c | Execution gate: three runs, stability classification, typed-token proposals | Fixture services, including deliberately nondeterministic ones |
| 4d | Function-level adapters: JS/TS and Python templates, `agent instructions --adapter` | A symbol in each language is baselined end to end |
| 4e | `air protect`, `air agent install`, `air_protect`/`air_discover_code` MCP tools, question-style review output | An agent-driven end-to-end test that only answers questions, never types pipeline commands |

Each step ships on its own PR with deterministic tests and no model calls.

## Non-goals

- No call graphs, architecture diagrams, or symbol indexes.
- No per-framework code generators or runtime plugins inside the user's service.
- No claim of completeness: a seam AIR did not find is simply not protected, and `air check coverage` is the tool for gaps.
- No LLM in the discovery path. Agents may draft adapters, but AIR accepts them only through the execution gate.

## Open questions for review

1. Rule format: regular-expression rules over comment-stripped source (no dependency, good enough to propose, since execution is the truth) versus an optional tree-sitter backend later for precision. Proposal: regex first, keep the rule interface backend-neutral.
2. Default run count for the gate: three runs, configurable with `--runs`.
3. Whether `--verify` should baseline automatically when every scenario is stable, or always stop for review. Proposal: always stop; baselining stays an explicit step.

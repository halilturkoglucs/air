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

## Everyday flow

```bash
air discover code src/billing --since main --verify   # seams in the area you are changing, executed
air check profile ... --at main && air check baseline  # lock behavior as of main
# edit code, or let an agent edit it
air check run --agent --reveal
air check approve <scenario> --reason "intended change"
```

## Increments

| Step | Delivers | Verified by |
| --- | --- | --- |
| 4a | Seam scanner with rules for JS/TS, Python, Go; `--path`, `--symbol`, `--since`; report | Fixture repositories per framework, exact report snapshots |
| 4b | Start-command detection, target and scenario proposals (`check init --from-code`) | Fixtures produce valid check and target files |
| 4c | Execution gate: three runs, stability classification, typed-token proposals | Fixture services, including deliberately nondeterministic ones |
| 4d | Function-level adapters: JS/TS and Python templates, `agent instructions --adapter` | A symbol in each language is baselined end to end |

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

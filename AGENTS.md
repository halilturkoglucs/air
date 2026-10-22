# AGENTS.md

Shared instructions for every coding agent in this repository (Codex reads this file; `CLAUDE.md` imports it). Keep one source of truth here. Do not fork instructions into agent-specific files.

## Project

AIR is a model-neutral verification layer for agent-written migrations: freeze reviewed legacy behavior, let any agent write a replacement, then compare HTTP, database, messages, outbound calls, ordering, and failures with `air check`. It is a pnpm monorepo (Node.js 22+, pnpm 11.19+). Published npm packages: `@halilturkoglucs/air` (`packages/cli`) and `@halilturkoglucs/air-plugin-sdk` (`packages/plugin-sdk`). Everything else under `packages/` is internal.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build            # required before tests and benchmarks
pnpm test             # build + vitest
pnpm release:check    # typecheck + test
```

## Orientation

`graphify-out/` (gitignored) holds a knowledge graph of the repo. Prefer it over broad file sweeps:

```bash
graphify query "<question>"   # answer from the graph
graphify update .             # refresh after code changes, no LLM cost
```

`graphify-out/GRAPH_REPORT.md` records the commit it was built from. Check it against `git rev-parse HEAD` before relying on it.

## Conventions

- Commits follow Conventional Commits and need a DCO `Signed-off-by` line (`git commit -s`).
- Match surrounding code: dense single-line helpers in `scripts/`, few comments, no new dependencies without need.
- Generated README blocks between `<!-- AIR_LLM_BENCHMARK:START -->` and `<!-- AIR_LLM_BENCHMARK:END -->` are owned by `pnpm benchmark:render`. Never hand-edit them.

## LLM verification-lift benchmark

Methodology: `benchmarks/llm-air-lift/README.md`. Code: `scripts/*-llm-benchmark.mjs` and `scripts/lib/llm-benchmark.mjs`.

`pnpm benchmark:llm` is the only step that spends model credits. Everything else is offline and deterministic. Before any paid step:

1. Run `pnpm benchmark:status`. It is offline and lists completed, resumable, and pending runs, tokens spent, and the exact resume commands.
2. Resume with the printed command. The runner skips completed runs and continues from per-round checkpoints in `~/.cache/air-llm-benchmark/<model>/<batch>/`. Never delete checkpoints or batch evidence to "start fresh"; that discards paid work.
3. Exit code 75 means the agent hit a usage limit. Wait for the reset and rerun the same command.
4. When 18/18 runs are complete: `pnpm benchmark:merge && pnpm benchmark:verify && pnpm benchmark:render`, then commit `results/` and `badges/`.

Every file under `benchmarks/llm-air-lift/` except `results*/`, `badges/`, `archive/`, and `.checkpoints/` feeds the suite hash. Editing one, including that README, invalidates all evidence and checkpoints. Change the suite only when you mean to rerun everything. If you do, bump `suite.json` `version` and move old batches to `archive/<old-version>/`. Evidence also records `HEAD`, so commit harness changes before starting paid runs.

## Handoff

Any agent can stop at any time. State lives in Git, in `pnpm benchmark:status`, and in the "Current work" section below. Update that section before ending a session that leaves work unfinished.

### Current work

- Suite v1.3.0 (`claude-sonnet-5-5` via Claude Code, medium reasoning) is complete and published: AIR pass@3 9/9 vs 0/9 alone, escaped defects 222 -> 0, about 49k tokens per AIR run. Older suites (v1.0-v1.2) are archived locally under `benchmarks/llm-air-lift/archive/` and not published.
- README badges point at `main`; they render once this branch is merged.

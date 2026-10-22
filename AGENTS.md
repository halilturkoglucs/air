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
- Never add `Co-Authored-By` trailers, "Generated with" lines, or any other AI attribution to commits, PR descriptions, tags, or release notes.
- Match surrounding code: dense single-line helpers in `scripts/`, few comments, no new dependencies without need.
- Generated README blocks between `<!-- AIR_LLM_BENCHMARK:START -->` and `<!-- AIR_LLM_BENCHMARK:END -->` are owned by `pnpm benchmark:render`. Never hand-edit them.

## Before pushing

`main` requires the `conformance` CI job and an up-to-date branch. These local checks catch what usually fails it, cost no model tokens, and only their tail needs reading:

```bash
pnpm install --frozen-lockfile        # fails on a broken or stale pnpm-lock.yaml
pnpm release:check 2>&1 | tail -15    # typecheck + build + full test suite
pnpm audit 2>&1 | tail -3             # include dev dependencies; --prod misses Dependabot's dev alerts
```

Skip the live PostgreSQL, Maven, and runtime-target steps of `conformance`; CI runs them.

Dependency hygiene, so pushes do not open Dependabot alerts:

- Change dependencies only through `pnpm add` / `pnpm update`, then commit `package.json` and `pnpm-lock.yaml` together. Never hand-merge `pnpm-lock.yaml`: on a conflict, take either side and rerun `pnpm install` to regenerate it.
- When `pnpm audit` reports a vulnerable transitive package, raise the direct dependency if a fixed release exists; otherwise add a bounded override to `pnpm-workspace.yaml` (for example `vite@<7.3.7: ^7.3.7`) and remove it once the parent catches up.
- Keep GitHub Actions on the same major version across workflows, and Java dependencies in `pom.xml` files on their latest patched release.
- To land Dependabot PRs that fell behind `main`, comment `@dependabot rebase` rather than merging `main` into them; merge commits have corrupted `pnpm-lock.yaml` before.

## Releases

Bump `version` identically in `package.json`, `packages/cli/package.json`, and `packages/plugin-sdk/package.json`, move `CHANGELOG.md` "Unreleased" notes under the new version, merge to `main`, then push tag `v<version>` on that commit. The `release.yml` workflow verifies the versions, publishes both packages to npmjs with provenance, mirrors them to GitHub Packages, and creates the GitHub release.

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
- v0.13.0 is released (npmjs, GitHub Packages, GitHub release, Homebrew `air-ir`).
- Agent protocol `air.dev/agent/v1` (`air check run --agent --reveal`, `air mcp`) is in review. Next: switch the benchmark's AIR arm to call this CLI mode (suite v1.4) so published results measure the shipped product; a full rerun costs about 1M Claude tokens and needs the owner's go-ahead.

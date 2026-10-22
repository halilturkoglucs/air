# AIR LLM verification-lift benchmark

This paired benchmark asks the same pinned coding model to replace three capabilities. The control arm receives ordinary tests. The AIR arm receives the same inputs plus `air check` differences after each repair round. A hidden AIR suite scores both arms.

Suite v1.3 pins Claude Sonnet 5.5 via Claude Code at medium reasoning. The runner is agent-neutral (a Codex CLI adapter is included), and each pinned profile runs three slices, three trials per arm, and three repair rounds: 18 isolated runs per model. Results apply only to the named model, suite, commit, and environment. They are not a universal claim about every LLM or migration. A model's scorecard is published only when its AIR arm beats its control arm on pass@3, or ties on pass@3 with fewer escaped defects.

## Feedback boundary

AIR check results store digests, not payloads. For the AIR arm, the harness re-runs the legacy oracle and the candidate on the **feedback** scenarios only. Each difference is shown with the reviewed expected value and the actual value, as a developer with local legacy access would see them. Sibling differences collapse into their parent and each scenario is capped at eight lines to keep tokens down.

Feedback covers every behavior once. Evaluation re-runs those scenarios plus one **held-out variant** per behavior with new identifiers, amounts, principals, and data. Neither arm ever sees the variants, so they measure whether a fix generalizes rather than whether it memorized one example.

Earlier suites are archived locally and not published. v1.0 sent digests only, so neither arm could recover unnamed contract strings (0 of 12 runs passed). v1.2 held out whole behaviors whose exact strings no input revealed, and its ledger ordinary test asserted status 200 while the legacy system returns 201; v1.3 fixes both.

## Reproduce

```bash
pnpm build
pnpm benchmark:status          # offline progress, tokens spent, resume commands
pnpm benchmark:llm -- --model claude-sonnet-5-5
pnpm benchmark:merge
pnpm benchmark:verify
pnpm benchmark:render -- --check
```

Every run is checkpointed after each agent turn and each verification. Re-run the same command to resume. It skips completed runs, restores the pre-turn candidate after an interrupted turn, and exits with code 75 when the agent reports a usage limit. Checkpoints live outside the repository under `~/.cache/air-llm-benchmark/<model>/<batch>/` (override with `AIR_BENCHMARK_CHECKPOINTS`).

For concurrent local execution, run one `--slice` per process with a distinct `--batch`, then use `pnpm benchmark:merge`. Batch evidence must share the same source, model, and budget metadata.

`benchmark:llm` is the only paid/networked step. Normal CI runs only deterministic evidence verification and rendering checks. Each run starts in an isolated Git repository outside this checkout, containing only the public task, starter candidate, and ordinary tests, so neither agent can discover `AGENTS.md`, `CLAUDE.md`, oracle files, or hidden scenarios. Claude Code runs headless with project-only settings, no MCP servers, no slash commands or skills, edits auto-accepted inside the workspace, and Bash limited to `npm test` and `node`.

## Measurements

- behavioral pass@1 and pass@3
- tests green but behavior wrong: ordinary tests passed in the final round while the hidden suite failed
- fully correct migrations and escaped defects
- scenario results grouped by HTTP, database, messages, outbound calls, ordering, rollback, idempotency, authorization, filtering, and pagination
- repair rounds, hidden scenarios passed after each round, duration, build failures, and token counts when the agent exposes them
- bounded infrastructure retries, which do not consume repair rounds and restore the pre-attempt candidate before retrying

Runtime throughput remains documented separately in [`docs/benchmarking.md`](../../docs/benchmarking.md). This benchmark measures verification lift, not generated-runtime speed.

Committed evidence uses `air.dev/llm-benchmark/v0.1`. Patches, scrubbed JSONL transcripts, final AIR results, input hashes, model identity, agent CLI version, and source commit are retained for auditability.

# AIR LLM verification-lift benchmark

This paired benchmark asks the same pinned coding model to replace three capabilities. The control arm receives ordinary tests. The AIR arm receives the same inputs plus `air check` differences after each repair round. A hidden AIR suite scores both arms.

Suite v1.1 uses GPT-6 Astra with medium reasoning, three slices, three trials per arm, and three repair rounds: 18 isolated runs. Results apply only to the named model, suite, commit, and environment. They are not a universal claim about every LLM or migration.

## Feedback boundary

AIR check results store digests, not payloads. For the AIR arm, the harness re-runs the legacy oracle and the candidate on the **feedback** scenarios only. Each mismatch is shown with the reviewed expected value and the actual value, as a developer with local legacy access would see them. Evaluation adds held-out scenarios, such as idempotent replay, that neither arm ever sees.

Suite v1.0 sent digests only. The task text does not name contract strings such as outbound operation names, so neither arm could recover them: 0 of 12 completed runs passed. Those runs are archived locally under `archive/v1.0.0/` and are not published.

## Reproduce

```bash
pnpm build
pnpm benchmark:status          # offline progress, tokens spent, resume commands
pnpm benchmark:llm
pnpm benchmark:verify
pnpm benchmark:render -- --check
```

Every run is checkpointed after each agent turn and each verification. Re-run the same command to resume. It skips completed runs, restores the pre-turn candidate after an interrupted turn, and exits with code 75 when the agent reports a usage limit.

For concurrent local execution, run one `--slice` per process with a distinct `--batch`, then use `pnpm benchmark:merge`. Batch evidence must share the same source, model, and budget metadata.

`benchmark:llm` is the only paid/networked step. Normal CI runs only deterministic evidence verification and rendering checks. Each run starts in a temporary isolated Git repository containing the public task, starter candidate, and ordinary tests. Oracle files and hidden scenarios remain outside that workspace.

## Measurements

- behavioral pass@1 and pass@3
- tests green but behavior wrong: ordinary tests passed in the final round while the hidden suite failed
- fully correct migrations and escaped defects
- scenario results grouped by HTTP, database, messages, outbound calls, ordering, rollback, idempotency, authorization, filtering, and pagination
- repair rounds, duration, build failures, and token counts when the agent exposes them
- bounded infrastructure retries, which do not consume repair rounds and restore the pre-attempt candidate before retrying

Runtime throughput remains documented separately in [`docs/benchmarking.md`](../../docs/benchmarking.md). This benchmark measures verification lift, not generated-runtime speed.

Committed evidence uses `air.dev/llm-benchmark/v0.1`. Patches, scrubbed JSONL transcripts, final AIR results, input hashes, model identity, Codex CLI version, and source commit are retained for auditability.

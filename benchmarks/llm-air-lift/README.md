# AIR LLM verification-lift benchmark

This paired benchmark asks the same pinned coding model to replace three capabilities. The control arm receives ordinary tests. The AIR arm receives the same inputs plus privacy-safe `air check` differences after each repair round. A hidden AIR suite scores both arms.

The v1 design uses GPT-6 Astra with high reasoning, three slices, three trials per arm, and three repair rounds: 18 isolated runs. Results apply only to the named model, suite, commit, and environment. They are not a universal claim about every LLM or migration.

## Reproduce

```bash
pnpm build
pnpm benchmark:llm
pnpm benchmark:verify
pnpm benchmark:render -- --check
```

`benchmark:llm` is the only paid/networked step. Normal CI runs only deterministic evidence verification and rendering checks. Each run starts in a temporary isolated Git repository containing the public task, starter candidate, and ordinary tests. Oracle files and hidden scenarios remain outside that workspace.

## Measurements

- behavioral pass@1 and pass@3
- fully correct migrations and escaped defects
- scenario results grouped by HTTP, database, messages, outbound calls, ordering, rollback, idempotency, authorization, filtering, and pagination
- repair rounds, duration, build failures, and token counts when the agent exposes them

Runtime throughput remains documented separately in [`docs/benchmarking.md`](../../docs/benchmarking.md). This benchmark measures verification lift, not generated-runtime speed.

Committed evidence uses `air.dev/llm-benchmark/v0.1`. Patches, scrubbed JSONL transcripts, final AIR results, input hashes, model identity, Codex CLI version, and source commit are retained for auditability.

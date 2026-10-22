import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentCommands,
  aggregateEvidence,
  airWins,
  benchmarkRoot,
  evaluateCandidate,
  explainResult,
  feedbackValues,
  isUsageLimitFailure,
  loadSuite,
  modelProfile,
  renderScorecard,
  root,
  sha256File,
  suiteSha256,
  tokenUsage,
  validateEvidence,
  wilsonInterval,
} from "../scripts/lib/llm-benchmark.mjs";

async function evidenceFixture() {
  const suite = await loadSuite();
  const artifactPath = "slices/document-create/task.md";
  const artifactHash = await sha256File(resolve(benchmarkRoot, artifactPath));
  const artifact = { path: artifactPath, sha256: artifactHash };
  return {
    format: "air.dev/llm-benchmark/v0.1",
    suiteVersion: suite.version,
    generatedAt: "2026-10-21T12:00:00.000Z",
    source: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      suiteSha256: await suiteSha256(),
    },
    model: { ...suite.models[0], agentVersion: "0.160.0" },
    budget: suite.budget,
    runs: [{
      id: "document-create-control-1",
      arm: "control",
      slice: "document-create",
      trial: 1,
      inputs: { taskSha256: artifactHash, promptSha256: artifactHash, starterSha256: artifactHash },
      measurements: {
        passAt1: false, passAt3: false, ordinaryTestsPassed: true, roundsUsed: 3, passedScenarios: 2, totalScenarios: 3,
        escapedDefects: 2, buildFailures: 0, infrastructureRetries: 0, mismatchesByCategory: { idempotency: 1, messages: 1 }, durationMs: 1000,
      },
      artifacts: { patch: artifact, transcript: artifact, result: artifact },
    }],
  };
}

describe("LLM verification-lift benchmark", () => {
  it("loads the pinned three-slice, two-arm, 18-run design", async () => {
    const suite = await loadSuite();
    expect(suite.models).toEqual([
      { id: "claude-sonnet-5-5", reasoning: "medium", agent: "claude-code" },
    ]);
    expect(() => modelProfile(suite, "unknown-model")).toThrow("Unknown benchmark model");
    expect(suite.slices.map((slice: { id: string }) => slice.id)).toEqual(["document-create", "ledger-transfer", "library-access"]);
    expect(suite.slices.length * suite.arms.length * suite.trialsPerArm).toBe(18);
  });

  it("computes Wilson confidence intervals and aggregate metrics", () => {
    const [lower, upper] = wilsonInterval(8, 9);
    expect(lower).toBeCloseTo(0.565, 2);
    expect(upper).toBeCloseTo(0.98, 2);
    const run = (arm: "control" | "air", pass: boolean, rounds: number) => ({ arm, slice: "document-create", measurements: { passAt1: pass, passAt3: pass, ordinaryTestsPassed: true, escapedDefects: pass ? 0 : 2, mismatchesByCategory: pass ? {} : { messages: 2 }, roundsUsed: rounds, passedScenarios: pass ? 3 : 2, totalScenarios: 3 } });
    const summary = aggregateEvidence({ runs: [run("control", false, 3), run("air", true, 2)] });
    expect(summary.arms.control).toMatchObject({ total: 1, passAt3: 0, escapedDefects: 2, greenButWrong: 1, medianRounds: 3, mismatchesByCategory: { messages: 2 } });
    expect(summary.arms.air).toMatchObject({ total: 1, passAt3: 1, escapedDefects: 0, medianRounds: 2 });
  });

  it("sums usage from independent repair turns", () => {
    const transcript = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 10 } }),
    ].join("\n");
    expect(tokenUsage(transcript)).toEqual({ inputTokens: 180, outputTokens: 30 });
    const claude = JSON.stringify({ type: "result", usage: { input_tokens: 4, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, output_tokens: 300 } });
    expect(tokenUsage(claude)).toEqual({ inputTokens: 20_504, outputTokens: 300 });
  });

  it("builds an isolated Claude Code turn without user settings, MCP servers, or network tools", async () => {
    const turn = agentCommands["claude-code"].turn({ id: "claude-sonnet-5-5", reasoning: "medium" }, "/tmp/workspace", "task");
    expect(turn.program).toBe("claude");
    expect(turn.input).toBe("task");
    expect(turn.args).toEqual(expect.arrayContaining(["-p", "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "WebFetch", "Task"]));
    expect(Object.keys(turn.env).some((key) => key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDECODE"))).toBe(false);
  });

  it("publishes only models where AIR beats the control arm", () => {
    expect(airWins({ passAt3: 1, escapedDefects: 9 }, { passAt3: 2, escapedDefects: 9 })).toBe(true);
    expect(airWins({ passAt3: 0, escapedDefects: 9 }, { passAt3: 0, escapedDefects: 4 })).toBe(true);
    expect(airWins({ passAt3: 0, escapedDefects: 4 }, { passAt3: 0, escapedDefects: 4 })).toBe(false);
    expect(airWins({ passAt3: 3, escapedDefects: 0 }, { passAt3: 2, escapedDefects: 0 })).toBe(false);
  });

  it("recognizes account usage limits without treating ordinary failures as limits", () => {
    expect(isUsageLimitFailure("You've hit your usage limit. Purchase more credits or try again later.")).toBe(true);
    expect(isUsageLimitFailure("Claude AI usage limit reached|1761140000")).toBe(true);
    expect(isUsageLimitFailure("You've hit your session limit · resets 3pm")).toBe(true);
    expect(isUsageLimitFailure("request failed with HTTP 500")).toBe(false);
  });

  it("renders a deterministic evidence-backed scorecard", () => {
    const evidence = {
      generatedAt: "2026-10-21T12:00:00.000Z", suiteVersion: "1.1.0",
      source: { commit: "a".repeat(40) }, model: { id: "gpt-6-astra", reasoning: "medium", agent: "codex-cli", agentVersion: "0.160.0" },
      runs: [
        ...[1, 2, 3].map((trial) => ({ arm: "control", slice: "document-create", trial, measurements: { passAt1: false, passAt3: trial === 3, ordinaryTestsPassed: true, escapedDefects: trial === 3 ? 0 : 2, mismatchesByCategory: trial === 3 ? {} : { idempotency: 2 }, roundsUsed: 3, passedScenarios: trial === 3 ? 3 : 2, totalScenarios: 3, inputTokens: 300_000, outputTokens: 10_000 } })),
        ...[1, 2, 3].map((trial) => ({ arm: "air", slice: "document-create", trial, measurements: { passAt1: false, passAt3: true, ordinaryTestsPassed: true, escapedDefects: 0, mismatchesByCategory: {}, roundsUsed: 2, passedScenarios: 3, totalScenarios: 3, inputTokens: 200_000, outputTokens: 5_000 } })),
      ],
    };
    const first = renderScorecard(evidence, { "document-create": "Document creation" });
    expect(renderScorecard(evidence, { "document-create": "Document creation" })).toBe(first);
    expect(first).toContain("| ✅ Behaviorally correct (pass@3) | 1/3 (33%) | **3/3 (100%)** | **+67 pts** |");
    expect(first).toContain("| 🐛 Escaped defects (hidden suite) | 4 | **0** | **−100%** |");
    expect(first).toContain("| 🟢 Tests green, behavior wrong | 2/3 | 0/3 | **−100%** |");
    expect(first).toContain("| 🪙 Median tokens per run | 310k | 205k | **−34%** |");
    expect(first).toContain("| Document creation | 1/3 | **3/3** |");
    expect(first).toContain("| idempotency | 4 | 0 |");
  });

  it("rejects tampering, duplicates, mixed models, stale suites, and missing trials, and accepts squash-merged source commits", async () => {
    const valid = await evidenceFixture();
    await expect(validateEvidence(valid, { requireComplete: false })).resolves.toBe(valid);
    await expect(validateEvidence({ ...valid, runs: [...valid.runs, valid.runs[0]] }, { requireComplete: false })).rejects.toThrow("Duplicate benchmark run ID");
    await expect(validateEvidence({ ...valid, model: { ...valid.model, id: "another-model" } }, { requireComplete: false })).rejects.toThrow("a pinned suite model");
    await expect(validateEvidence({ ...valid, source: { ...valid.source, suiteSha256: "0".repeat(64) } }, { requireComplete: false })).rejects.toThrow("suite hash is stale");
    await expect(validateEvidence({ ...valid, source: { ...valid.source, commit: "0".repeat(40) } }, { requireComplete: false })).resolves.toBeDefined();
    const tampered = structuredClone(valid); tampered.runs[0].artifacts.patch.sha256 = "0".repeat(64);
    await expect(validateEvidence(tampered, { requireComplete: false })).rejects.toThrow("Artifact checksum mismatch");
    await expect(validateEvidence(valid)).rejects.toThrow("must contain all 18 runs");
  });

  it("shows compact reviewed values only for feedback scenarios", async () => {
    const suite = await loadSuite();
    const slice = suite.slices.find((item: { id: string }) => item.id === "document-create");
    const starter = resolve(benchmarkRoot, "slices/document-create/workspace/candidate.mjs");
    const result = await evaluateCandidate(slice, starter, "feedback");
    const values = await feedbackValues(slice, starter);
    expect(Object.keys(values).sort()).toEqual(["creates-document", "maps-vendor-failure", "replays-idempotently"]);
    const text = await explainResult(result, values);
    expect(text).toContain('/outbound/0: expected {"operation":"vendor.authorize"');
    expect(text).not.toContain("holdout");
    expect(text.split("\n").length).toBeLessThanOrEqual(40);
  }, 30_000);

  it("passes known-good candidates and rejects starter mutants for every hidden evaluator", async () => {
    const suite = await loadSuite();
    for (const slice of suite.slices) {
      const oracle = resolve(benchmarkRoot, "slices", slice.id, "oracle/legacy.mjs");
      const starter = resolve(benchmarkRoot, "slices", slice.id, "workspace/candidate.mjs");
      await expect(evaluateCandidate(slice, oracle, "evaluation")).resolves.toMatchObject({ passed: true });
      await expect(evaluateCandidate(slice, starter, "evaluation")).resolves.toMatchObject({ passed: false });
    }
  }, 30_000);
});

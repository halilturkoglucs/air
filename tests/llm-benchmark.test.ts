import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateEvidence,
  benchmarkRoot,
  evaluateCandidate,
  loadSuite,
  renderScorecard,
  root,
  sha256File,
  suiteSha256,
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
    model: { ...suite.model, agentVersion: "0.160.0" },
    budget: suite.budget,
    runs: [{
      id: "document-create-control-1",
      arm: "control",
      slice: "document-create",
      trial: 1,
      inputs: { taskSha256: artifactHash, promptSha256: artifactHash, starterSha256: artifactHash },
      measurements: {
        passAt1: false, passAt3: false, roundsUsed: 3, passedScenarios: 2, totalScenarios: 3,
        escapedDefects: 2, buildFailures: 0, mismatchesByCategory: { idempotency: 1, messages: 1 }, durationMs: 1000,
      },
      artifacts: { patch: artifact, transcript: artifact, result: artifact },
    }],
  };
}

describe("LLM verification-lift benchmark", () => {
  it("loads the pinned three-slice, two-arm, 18-run design", async () => {
    const suite = await loadSuite();
    expect(suite.model).toEqual({ id: "gpt-6-astra", reasoning: "high", agent: "codex-cli" });
    expect(suite.slices.map((slice: { id: string }) => slice.id)).toEqual(["document-create", "ledger-transfer", "library-access"]);
    expect(suite.slices.length * suite.arms.length * suite.trialsPerArm).toBe(18);
  });

  it("computes Wilson confidence intervals and aggregate metrics", () => {
    const [lower, upper] = wilsonInterval(8, 9);
    expect(lower).toBeCloseTo(0.565, 2);
    expect(upper).toBeCloseTo(0.98, 2);
    const run = (arm: "control" | "air", pass: boolean, rounds: number) => ({ arm, slice: "document-create", measurements: { passAt1: pass, passAt3: pass, escapedDefects: pass ? 0 : 2, roundsUsed: rounds, passedScenarios: pass ? 3 : 2, totalScenarios: 3 } });
    const summary = aggregateEvidence({ runs: [run("control", false, 3), run("air", true, 2)] });
    expect(summary.arms.control).toMatchObject({ total: 1, passAt3: 0, escapedDefects: 2, medianRounds: 3 });
    expect(summary.arms.air).toMatchObject({ total: 1, passAt3: 1, escapedDefects: 0, medianRounds: 2 });
  });

  it("renders a deterministic evidence-backed scorecard", () => {
    const evidence = {
      generatedAt: "2026-10-21T12:00:00.000Z", suiteVersion: "1.0.0",
      source: { commit: "a".repeat(40) }, model: { id: "gpt-6-astra", reasoning: "high" },
      runs: [
        ...[1, 2, 3].map((trial) => ({ arm: "control", slice: "document-create", trial, measurements: { passAt1: false, passAt3: trial === 3, escapedDefects: trial === 3 ? 0 : 2, roundsUsed: 3, passedScenarios: trial === 3 ? 3 : 2, totalScenarios: 3 } })),
        ...[1, 2, 3].map((trial) => ({ arm: "air", slice: "document-create", trial, measurements: { passAt1: false, passAt3: true, escapedDefects: 0, roundsUsed: 2, passedScenarios: 3, totalScenarios: 3 } })),
      ],
    };
    const first = renderScorecard(evidence);
    expect(renderScorecard(evidence)).toBe(first);
    expect(first).toContain("| gpt-6-astra alone | 0/3 | 1/3 | 4 | 3 |");
    expect(first).toContain("| gpt-6-astra + AIR | 0/3 | 3/3 | 0 | 2 |");
  });

  it("rejects tampering, duplicates, mixed models, stale suites, stale commits, and missing trials", async () => {
    const valid = await evidenceFixture();
    await expect(validateEvidence(valid, { requireComplete: false })).resolves.toBe(valid);
    await expect(validateEvidence({ ...valid, runs: [...valid.runs, valid.runs[0]] }, { requireComplete: false })).rejects.toThrow("Duplicate benchmark run ID");
    await expect(validateEvidence({ ...valid, model: { ...valid.model, id: "another-model" } }, { requireComplete: false })).rejects.toThrow("pinned suite model");
    await expect(validateEvidence({ ...valid, source: { ...valid.source, suiteSha256: "0".repeat(64) } }, { requireComplete: false })).rejects.toThrow("suite hash is stale");
    await expect(validateEvidence({ ...valid, source: { ...valid.source, commit: "0".repeat(40) } }, { requireComplete: false })).rejects.toThrow("is not an ancestor");
    const tampered = structuredClone(valid); tampered.runs[0].artifacts.patch.sha256 = "0".repeat(64);
    await expect(validateEvidence(tampered, { requireComplete: false })).rejects.toThrow("Artifact checksum mismatch");
    await expect(validateEvidence(valid)).rejects.toThrow("must contain all 18 runs");
  });

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

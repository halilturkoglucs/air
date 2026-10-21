import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { benchmarkRoot, evaluateCandidate, loadSuite, validateEvidence } from "./lib/llm-benchmark.mjs";

const evidence = JSON.parse(await readFile(resolve(benchmarkRoot, "results/evidence.json"), "utf8"));
const suite = await loadSuite();
await validateEvidence(evidence);

for (const run of evidence.runs) {
  const slice = suite.slices.find((item) => item.id === run.slice);
  const candidate = resolve(benchmarkRoot, run.artifacts.patch.path, "../candidate.mjs");
  const rescored = await evaluateCandidate(slice, candidate, "evaluation");
  const committed = JSON.parse(await readFile(resolve(benchmarkRoot, run.artifacts.result.path), "utf8"));
  const comparable = (result) => ({
    passed: result.passed,
    scenarios: result.scenarios,
    mismatches: result.mismatches.map(({ generatedAt, ...mismatch }) => mismatch),
  });
  if (JSON.stringify(comparable(rescored)) !== JSON.stringify(comparable(committed))) throw new Error(`Deterministic rescore differs for ${run.id}.`);
}

console.log(`Verified ${evidence.runs.length} benchmark runs, artifacts, hashes, and deterministic AIR results.`);

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { benchmarkRoot, evaluateCandidate, loadSuite, resultRoot, validateEvidence } from "./lib/llm-benchmark.mjs";

const suite = await loadSuite();
let verified = 0;
for (const { id } of suite.models) {
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(resultRoot(id), "evidence.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") continue; throw error; }
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
    if (JSON.stringify(comparable(rescored)) !== JSON.stringify(comparable(committed))) throw new Error(`Deterministic rescore differs for ${id} ${run.id}.`);
  }
  console.log(`Verified ${evidence.runs.length} ${id} benchmark runs, artifacts, hashes, and deterministic AIR results.`);
  verified += 1;
}
if (verified === 0) throw new Error("No merged benchmark evidence found. Run pnpm benchmark:merge first.");

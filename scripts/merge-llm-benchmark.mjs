import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { benchmarkRoot, ensureDirectory, validateEvidence } from "./lib/llm-benchmark.mjs";

const batchesRoot = resolve(benchmarkRoot, "results-batches");
const batches = (await readdir(batchesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (batches.length === 0) throw new Error("No benchmark batches found.");
const evidenceFiles = [];
for (const batch of batches) {
  const evidence = JSON.parse(await readFile(resolve(batchesRoot, batch, "evidence.json"), "utf8"));
  await validateEvidence(evidence, { requireComplete: false });
  evidenceFiles.push(evidence);
}
const first = evidenceFiles[0];
for (const evidence of evidenceFiles.slice(1)) {
  if (JSON.stringify(evidence.source) !== JSON.stringify(first.source) || JSON.stringify(evidence.model) !== JSON.stringify(first.model) || JSON.stringify(evidence.budget) !== JSON.stringify(first.budget)) throw new Error("Benchmark batches have different source, model, or budget metadata.");
}
const runs = evidenceFiles.flatMap((evidence) => evidence.runs).sort((left, right) => left.id.localeCompare(right.id));
const merged = { ...first, generatedAt: new Date().toISOString(), runs };
await validateEvidence(merged);
await ensureDirectory(resolve(benchmarkRoot, "results"));
await writeFile(resolve(benchmarkRoot, "results/evidence.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(`Merged ${batches.length} batches into complete ${runs.length}-run evidence.`);

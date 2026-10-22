import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { benchmarkRoot, ensureDirectory, loadSuite, resultRoot, scrubTranscript, sha256File, validateEvidence } from "./lib/llm-benchmark.mjs";

const directories = async (path) => { try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } };
const suite = await loadSuite();
const requested = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined;
let merged = 0;
for (const { id } of suite.models) {
  if (requested && id !== requested) continue;
  const batchesRoot = resolve(benchmarkRoot, "results-batches", id);
  const batches = await directories(batchesRoot);
  if (batches.length === 0) continue;
  const evidenceFiles = [];
  for (const batch of batches) {
    const evidence = JSON.parse(await readFile(resolve(batchesRoot, batch, "evidence.json"), "utf8"));
    await validateEvidence(evidence, { requireComplete: false });
    evidenceFiles.push(evidence);
  }
  const first = evidenceFiles[0];
  for (const evidence of evidenceFiles.slice(1)) {
    if (JSON.stringify(evidence.source) !== JSON.stringify(first.source) || JSON.stringify(evidence.model) !== JSON.stringify(first.model) || JSON.stringify(evidence.budget) !== JSON.stringify(first.budget)) throw new Error(`Benchmark batches for ${id} have different source, model, or budget metadata.`);
  }
  // Batches are gitignored scratch space; copy each run's artifacts next to the merged evidence so a clean clone can verify it.
  const runs = [];
  for (const run of evidenceFiles.flatMap((evidence) => evidence.runs).sort((left, right) => left.id.localeCompare(right.id))) {
    const artifacts = {};
    for (const [key, artifact] of Object.entries(run.artifacts)) {
      const destination = resolve(resultRoot(id), run.id, basename(artifact.path));
      await ensureDirectory(dirname(destination));
      if (key === "transcript") await writeFile(destination, scrubTranscript(await readFile(resolve(benchmarkRoot, artifact.path), "utf8")), "utf8");
      else await cp(resolve(benchmarkRoot, artifact.path), destination);
      artifacts[key] = { path: relative(benchmarkRoot, destination), sha256: await sha256File(destination) };
    }
    await cp(resolve(benchmarkRoot, run.artifacts.patch.path, "../candidate.mjs"), resolve(resultRoot(id), run.id, "candidate.mjs"));
    runs.push({ ...run, artifacts });
  }
  const evidence = { ...first, generatedAt: new Date().toISOString(), runs };
  await validateEvidence(evidence);
  await ensureDirectory(resultRoot(id));
  await writeFile(resolve(resultRoot(id), "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Merged ${batches.length} ${id} batches into complete ${runs.length}-run evidence.`);
  merged += 1;
}
if (merged === 0) throw new Error("No benchmark batches found.");

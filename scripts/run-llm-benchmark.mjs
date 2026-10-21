import { execFileSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  benchmarkRoot,
  createRunWorkspace,
  ensureDirectory,
  evaluateCandidate,
  explainResult,
  loadSuite,
  measurementFromResult,
  root,
  runProcess,
  scrubTranscript,
  sha256,
  sha256File,
  suiteSha256,
  tokenUsage,
  validateEvidence,
} from "./lib/llm-benchmark.mjs";

const arguments_ = process.argv.slice(2);
const option = (name) => { const index = arguments_.indexOf(name); return index >= 0 ? arguments_[index + 1] : undefined; };
const suite = await loadSuite();
const selectedArm = option("--arm");
const selectedSlice = option("--slice");
const selectedTrial = option("--trial") ? Number(option("--trial")) : undefined;
const batch = option("--batch");
const model = option("--model") ?? suite.model.id;
const reasoning = option("--reasoning") ?? suite.model.reasoning;
if (model !== suite.model.id || reasoning !== suite.model.reasoning) throw new Error(`Published suite is pinned to ${suite.model.id} with ${suite.model.reasoning} reasoning.`);
if (selectedArm && !suite.arms.includes(selectedArm)) throw new Error(`Unknown arm ${selectedArm}.`);
if (selectedSlice && !suite.slices.some((slice) => slice.id === selectedSlice)) throw new Error(`Unknown slice ${selectedSlice}.`);
if (selectedTrial !== undefined && (!Number.isInteger(selectedTrial) || selectedTrial < 1 || selectedTrial > suite.trialsPerArm)) throw new Error(`Trial must be 1-${suite.trialsPerArm}.`);

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const agentVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli\s+/u, "");
if (batch && !/^[a-z0-9-]+$/u.test(batch)) throw new Error("Batch name must contain lowercase letters, numbers, and hyphens only.");
const resultRoot = resolve(benchmarkRoot, batch ? `results-batches/${batch}` : "results");
const evidencePath = resolve(resultRoot, "evidence.json");
let existingRuns = [];
try {
  const existing = JSON.parse(await readFile(evidencePath, "utf8"));
  await validateEvidence(existing, { requireComplete: false });
  existingRuns = [...existing.runs];
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const targets = [];
for (const slice of suite.slices) {
  if (selectedSlice && slice.id !== selectedSlice) continue;
  for (const arm of suite.arms) {
    if (selectedArm && arm !== selectedArm) continue;
    for (let trial = 1; trial <= suite.trialsPerArm; trial += 1) {
      if (selectedTrial && trial !== selectedTrial) continue;
      targets.push({ slice, arm, trial, id: `${slice.id}-${arm}-${trial}` });
    }
  }
}

for (const target of targets) {
  console.log(`\n[${target.id}] starting ${suite.budget.repairRounds}-round isolated run`);
  const workspace = await createRunWorkspace(target.slice.id);
  const sliceRoot = resolve(benchmarkRoot, "slices", target.slice.id);
  const task = await readFile(resolve(sliceRoot, "task.md"), "utf8");
  const starterHash = await sha256File(resolve(sliceRoot, "workspace/candidate.mjs"));
  const basePrompt = `${task}\n\nBenchmark rules:\n- Work only inside this directory.\n- Modify candidate.mjs.\n- Run npm test.\n- Do not inspect Git history, parent directories, environment variables, or network resources.\n- Finish with a concise change summary.\n`;
  const transcriptParts = [];
  let previousFeedback = "";
  let hiddenResult;
  let passAt1 = false;
  let buildFailures = 0;
  let roundsUsed = 0;
  const startedAt = Date.now();

  for (let round = 1; round <= suite.budget.repairRounds; round += 1) {
    roundsUsed = round;
    const prompt = round === 1 ? basePrompt : `${basePrompt}\nThis is repair round ${round} of ${suite.budget.repairRounds}. The current files contain your previous attempt.\n\nPrevious verification feedback:\n${previousFeedback}\n`;
    const run = await runProcess("codex", [
      "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--approve-for-me",
      "--model", model,
      "--config", `model_reasoning_effort=\"${reasoning}\"`, "--cd", workspace,
      "--json", prompt,
    ], {
      cwd: workspace,
      onStdout: (chunk) => process.stdout.write(chunk.includes("turn.completed") ? "." : ""),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    transcriptParts.push(JSON.stringify({ kind: "round", round, exitCode: run.code }), run.stdout, run.stderr);
    if (run.code !== 0) throw new Error(`Codex failed for ${target.id} round ${round} with exit ${run.code}: ${run.stderr.trim() || run.stdout.trim()}`);
    const ordinary = await runProcess("npm", ["test"], { cwd: workspace });
    if (ordinary.code !== 0) buildFailures += 1;
    hiddenResult = await evaluateCandidate(target.slice, resolve(workspace, "candidate.mjs"), "evaluation");
    if (round === 1) passAt1 = hiddenResult.passed;
    let airFeedback = "";
    if (target.arm === "air") {
      const feedbackResult = await evaluateCandidate(target.slice, resolve(workspace, "candidate.mjs"), "feedback");
      airFeedback = `\n\n${explainResult(feedbackResult)}`;
    }
    previousFeedback = `Ordinary test exit ${ordinary.code}.\n${ordinary.stdout}${ordinary.stderr}${airFeedback}`.trim();
    transcriptParts.push(JSON.stringify({ kind: "ordinary-tests", round, exitCode: ordinary.code, stdout: ordinary.stdout, stderr: ordinary.stderr }));
    if (target.arm === "air") transcriptParts.push(JSON.stringify({ kind: "air-feedback", round, text: airFeedback.trim() }));
    if (hiddenResult.passed) break;
  }

  const transcript = scrubTranscript(`${transcriptParts.join("\n")}\n`);
  const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const resultDirectory = await ensureDirectory(resolve(resultRoot, target.id));
  const patchPath = resolve(resultDirectory, "candidate.patch");
  const transcriptPath = resolve(resultDirectory, "transcript.jsonl");
  const resultPath = resolve(resultDirectory, "result.json");
  await Promise.all([
    writeFile(patchPath, patch, "utf8"),
    writeFile(transcriptPath, transcript, "utf8"),
    writeFile(resultPath, `${JSON.stringify(hiddenResult, null, 2)}\n`, "utf8"),
    cp(resolve(workspace, "candidate.mjs"), resolve(resultDirectory, "candidate.mjs")),
  ]);
  const usage = tokenUsage(transcript);
  const runEvidence = {
    id: target.id,
    arm: target.arm,
    slice: target.slice.id,
    trial: target.trial,
    inputs: {
      taskSha256: await sha256File(resolve(sliceRoot, "task.md")),
      promptSha256: sha256(basePrompt),
      starterSha256: starterHash,
    },
    measurements: measurementFromResult(target.slice, hiddenResult, roundsUsed, passAt1, buildFailures, Date.now() - startedAt, usage),
    artifacts: {
      patch: { path: relative(benchmarkRoot, patchPath), sha256: await sha256File(patchPath) },
      transcript: { path: relative(benchmarkRoot, transcriptPath), sha256: await sha256File(transcriptPath) },
      result: { path: relative(benchmarkRoot, resultPath), sha256: await sha256File(resultPath) },
    },
  };
  existingRuns = [...existingRuns.filter((run) => run.id !== target.id), runEvidence].sort((left, right) => left.id.localeCompare(right.id));
  const evidence = {
    format: "air.dev/llm-benchmark/v0.1",
    suiteVersion: suite.version,
    generatedAt: new Date().toISOString(),
    source: { commit: sourceCommit, suiteSha256: await suiteSha256() },
    model: { ...suite.model, agentVersion },
    budget: suite.budget,
    runs: existingRuns,
  };
  await ensureDirectory(resultRoot);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`\n[${target.id}] ${hiddenResult.passed ? "PASS" : "FAIL"} after ${roundsUsed} round(s)`);
}

const finalEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
await validateEvidence(finalEvidence, { requireComplete: !batch && selectedArm === undefined && selectedSlice === undefined && selectedTrial === undefined });
console.log(`Evidence: ${relative(root, evidencePath)} (${finalEvidence.runs.length}/18 runs)`);

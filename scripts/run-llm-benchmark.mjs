import { execFileSync } from "node:child_process";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  benchmarkRoot,
  createRunWorkspace,
  ensureDirectory,
  evaluateCandidate,
  explainResult,
  isUsageLimitFailure,
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
const force = arguments_.includes("--force");
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
if (batch && !/^[a-z0-9-]+$/u.test(batch)) throw new Error("Batch name must contain lowercase letters, numbers, and hyphens only.");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const agentVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli\s+/u, "");
const currentSuiteHash = await suiteSha256();
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

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function assertCheckpoint(state, target) {
  if (state.format !== "air.dev/llm-benchmark-checkpoint/v0.1" || state.id !== target.id) throw new Error(`Invalid checkpoint for ${target.id}.`);
  if (state.suiteSha256 !== currentSuiteHash || state.model !== model || state.reasoning !== reasoning) throw new Error(`Checkpoint for ${target.id} does not match the current suite or model.`);
  try { execFileSync("git", ["merge-base", "--is-ancestor", state.sourceCommit, "HEAD"], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(`Checkpoint source ${state.sourceCommit} is not an ancestor of HEAD.`); }
}

let paused = false;
for (const target of targets) {
  if (!force && existingRuns.some((run) => run.id === target.id)) {
    console.log(`[${target.id}] already complete; skipping`);
    continue;
  }

  const checkpointDirectory = resolve(resultRoot, ".checkpoints", target.id);
  const checkpointPath = resolve(checkpointDirectory, "checkpoint.json");
  const workspace = resolve(checkpointDirectory, "workspace");
  const beforeRoundPath = resolve(checkpointDirectory, "candidate.before-round.mjs");
  const sliceRoot = resolve(benchmarkRoot, "slices", target.slice.id);
  const task = await readFile(resolve(sliceRoot, "task.md"), "utf8");
  const starterHash = await sha256File(resolve(sliceRoot, "workspace/candidate.mjs"));
  const basePrompt = `${task}\n\nBenchmark rules:\n- Work only inside this directory.\n- Modify candidate.mjs.\n- Run npm test.\n- Do not inspect Git history, parent directories, environment variables, or network resources.\n- Finish with a concise change summary.\n`;
  let state;
  try {
    state = JSON.parse(await readFile(checkpointPath, "utf8"));
    assertCheckpoint(state, target);
    console.log(`\n[${target.id}] resuming at round ${state.nextRound}, phase ${state.phase}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await rm(checkpointDirectory, { recursive: true, force: true });
    await ensureDirectory(checkpointDirectory);
    await createRunWorkspace(target.slice.id, workspace);
    state = {
      format: "air.dev/llm-benchmark-checkpoint/v0.1",
      id: target.id,
      arm: target.arm,
      slice: target.slice.id,
      trial: target.trial,
      sourceCommit,
      suiteSha256: currentSuiteHash,
      model,
      reasoning,
      nextRound: 1,
      phase: "idle",
      previousFeedback: "",
      transcriptParts: [],
      hiddenResult: null,
      passAt1: false,
      buildFailures: 0,
      infrastructureRetries: 0,
      roundsUsed: 0,
      durationMs: 0,
    };
    await writeJsonAtomically(checkpointPath, state);
    console.log(`\n[${target.id}] starting resumable ${suite.budget.repairRounds}-round isolated run`);
  }

  if (state.phase === "agent") {
    await cp(beforeRoundPath, resolve(workspace, "candidate.mjs"));
    state.phase = "idle";
    await writeJsonAtomically(checkpointPath, state);
    console.log(`[${target.id}] restored pre-round candidate after interrupted agent turn`);
  }

  for (let round = state.nextRound; round <= suite.budget.repairRounds; round += 1) {
    const prompt = round === 1 ? basePrompt : `${basePrompt}\nThis is repair round ${round} of ${suite.budget.repairRounds}. The current files contain your previous attempt.\n\nPrevious verification feedback:\n${state.previousFeedback}\n`;

    if (state.phase !== "verify") {
      await cp(resolve(workspace, "candidate.mjs"), beforeRoundPath);
      state.phase = "agent";
      await writeJsonAtomically(checkpointPath, state);
      let agentCompleted = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const attemptStartedAt = Date.now();
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
        state.durationMs += Date.now() - attemptStartedAt;
        state.transcriptParts.push(JSON.stringify({ kind: "round", round, infrastructureAttempt: attempt, exitCode: run.code }), run.stdout, run.stderr);
        if (run.code === 0) {
          state.phase = "verify";
          await writeJsonAtomically(checkpointPath, state);
          agentCompleted = true;
          break;
        }

        await cp(beforeRoundPath, resolve(workspace, "candidate.mjs"));
        if (isUsageLimitFailure(`${run.stderr}\n${run.stdout}`)) {
          state.phase = "idle";
          await writeJsonAtomically(checkpointPath, state);
          console.error(`\n[${target.id}] PAUSED_USAGE_LIMIT at round ${round}. Re-run the same command after reset; checkpoint preserved.`);
          paused = true;
          break;
        }
        if (attempt === 2) {
          state.phase = "idle";
          await writeJsonAtomically(checkpointPath, state);
          throw new Error(`Codex failed for ${target.id} round ${round} after one infrastructure retry: ${run.stderr.trim() || run.stdout.trim()}`);
        }
        state.infrastructureRetries += 1;
        await writeJsonAtomically(checkpointPath, state);
        console.log(`\n[${target.id}] retrying round ${round} after Codex exit ${run.code}`);
      }
      if (paused || !agentCompleted) break;
    }

    const verifyStartedAt = Date.now();
    const ordinary = await runProcess("npm", ["test"], { cwd: workspace });
    if (ordinary.code !== 0) state.buildFailures += 1;
    state.hiddenResult = await evaluateCandidate(target.slice, resolve(workspace, "candidate.mjs"), "evaluation");
    if (round === 1) state.passAt1 = state.hiddenResult.passed;
    let airFeedback = "";
    if (target.arm === "air") {
      const feedbackResult = await evaluateCandidate(target.slice, resolve(workspace, "candidate.mjs"), "feedback");
      airFeedback = `\n\n${explainResult(feedbackResult)}`;
    }
    state.previousFeedback = `Ordinary test exit ${ordinary.code}.\n${ordinary.stdout}${ordinary.stderr}${airFeedback}`.trim();
    state.transcriptParts.push(JSON.stringify({ kind: "ordinary-tests", round, exitCode: ordinary.code, stdout: ordinary.stdout, stderr: ordinary.stderr }));
    if (target.arm === "air") state.transcriptParts.push(JSON.stringify({ kind: "air-feedback", round, text: airFeedback.trim() }));
    state.durationMs += Date.now() - verifyStartedAt;
    state.roundsUsed = round;
    state.nextRound = round + 1;
    state.phase = "idle";
    await writeJsonAtomically(checkpointPath, state);
    if (state.hiddenResult.passed) break;
  }

  if (paused) break;
  if (!state.hiddenResult || state.roundsUsed < 1) throw new Error(`Run ${target.id} ended without an evaluation result.`);

  const transcript = scrubTranscript(`${state.transcriptParts.join("\n")}\n`);
  const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const resultDirectory = await ensureDirectory(resolve(resultRoot, target.id));
  const patchPath = resolve(resultDirectory, "candidate.patch");
  const transcriptPath = resolve(resultDirectory, "transcript.jsonl");
  const resultPath = resolve(resultDirectory, "result.json");
  await Promise.all([
    writeFile(patchPath, patch, "utf8"),
    writeFile(transcriptPath, transcript, "utf8"),
    writeFile(resultPath, `${JSON.stringify(state.hiddenResult, null, 2)}\n`, "utf8"),
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
    measurements: measurementFromResult(target.slice, state.hiddenResult, state.roundsUsed, state.passAt1, state.buildFailures, state.infrastructureRetries, state.durationMs, usage),
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
    source: { commit: sourceCommit, suiteSha256: currentSuiteHash },
    model: { ...suite.model, agentVersion },
    budget: suite.budget,
    runs: existingRuns,
  };
  await ensureDirectory(resultRoot);
  await writeJsonAtomically(evidencePath, evidence);
  await rm(checkpointDirectory, { recursive: true, force: true });
  console.log(`\n[${target.id}] ${state.hiddenResult.passed ? "PASS" : "FAIL"} after ${state.roundsUsed} round(s)`);
}

if (paused) {
  process.exitCode = 75;
} else {
  try {
    const finalEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
    await validateEvidence(finalEvidence, { requireComplete: !batch && selectedArm === undefined && selectedSlice === undefined && selectedTrial === undefined });
    console.log(`Evidence: ${relative(root, evidencePath)} (${finalEvidence.runs.length}/18 runs)`);
  } catch (error) {
    if (error?.code === "ENOENT") console.log(`Evidence: no completed runs yet; checkpoints are under ${relative(root, resolve(resultRoot, ".checkpoints"))}`);
    else throw error;
  }
}

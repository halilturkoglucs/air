import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const benchmarkRoot = resolve(root, "benchmarks/llm-air-lift");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export async function suiteSha256() {
  const files = (await filesBelow(benchmarkRoot))
    .filter((path) => !path.includes(`${sep}results${sep}`) && !path.includes(`${sep}badges${sep}`))
    .sort();
  const material = [];
  for (const path of files) material.push(`${relative(benchmarkRoot, path)}\0${await sha256File(path)}`);
  return sha256(material.join("\n"));
}

export async function loadSuite() {
  const suite = JSON.parse(await readFile(resolve(benchmarkRoot, "suite.json"), "utf8"));
  if (suite.format !== "air.dev/llm-benchmark-suite/v0.1") throw new Error("Unsupported LLM benchmark suite format.");
  if (!Array.isArray(suite.slices) || suite.slices.length !== 3) throw new Error("LLM benchmark v1 requires exactly three slices.");
  if (!Array.isArray(suite.arms) || suite.arms.join(",") !== "control,air") throw new Error("LLM benchmark arms must be control and air.");
  return suite;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid benchmark evidence: ${label} must be a SHA-256 digest.`);
}

function validateEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Invalid benchmark evidence: root must be an object.");
  if (evidence.format !== "air.dev/llm-benchmark/v0.1") throw new Error("Invalid benchmark evidence: unsupported format.");
  if (typeof evidence.suiteVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(evidence.suiteVersion)) throw new Error("Invalid benchmark evidence: suiteVersion must be semantic.");
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) throw new Error("Invalid benchmark evidence: generatedAt must be an ISO timestamp.");
  if (!evidence.source || !/^[0-9a-f]{40}$/u.test(evidence.source.commit)) throw new Error("Invalid benchmark evidence: source commit must be a full Git SHA.");
  assertSha256(evidence.source.suiteSha256, "source.suiteSha256");
  if (!evidence.model || !["id", "reasoning", "agent", "agentVersion"].every((key) => typeof evidence.model[key] === "string" && evidence.model[key])) throw new Error("Invalid benchmark evidence: model identity is incomplete.");
  if (!Number.isInteger(evidence.budget?.repairRounds) || evidence.budget.repairRounds < 1) throw new Error("Invalid benchmark evidence: repairRounds must be positive.");
  if (!Array.isArray(evidence.runs) || evidence.runs.length === 0) throw new Error("Invalid benchmark evidence: runs must be a non-empty array.");
  for (const run of evidence.runs) {
    if (!run || typeof run !== "object" || !/^[a-z0-9-]+$/u.test(run.id) || !["control", "air"].includes(run.arm) || !Number.isInteger(run.trial)) throw new Error("Invalid benchmark evidence: malformed run identity.");
    for (const key of ["taskSha256", "promptSha256", "starterSha256"]) assertSha256(run.inputs?.[key], `${run.id}.inputs.${key}`);
    const measurements = run.measurements;
    if (!measurements || typeof measurements.passAt1 !== "boolean" || typeof measurements.passAt3 !== "boolean") throw new Error(`Invalid benchmark evidence: ${run.id} pass measurements are required.`);
    for (const key of ["roundsUsed", "passedScenarios", "totalScenarios", "escapedDefects", "buildFailures", "infrastructureRetries", "durationMs"]) if (!Number.isInteger(measurements[key]) || measurements[key] < 0) throw new Error(`Invalid benchmark evidence: ${run.id}.measurements.${key} must be a non-negative integer.`);
    if (measurements.roundsUsed < 1 || measurements.totalScenarios < 1 || !measurements.mismatchesByCategory || typeof measurements.mismatchesByCategory !== "object") throw new Error(`Invalid benchmark evidence: ${run.id} measurements are incomplete.`);
    for (const key of ["patch", "transcript", "result"]) {
      if (typeof run.artifacts?.[key]?.path !== "string" || !run.artifacts[key].path) throw new Error(`Invalid benchmark evidence: ${run.id}.artifacts.${key}.path is required.`);
      assertSha256(run.artifacts[key].sha256, `${run.id}.artifacts.${key}.sha256`);
    }
  }
}

function safeArtifactPath(path) {
  const absolute = resolve(benchmarkRoot, path);
  if (absolute !== benchmarkRoot && !absolute.startsWith(`${benchmarkRoot}${sep}`)) throw new Error(`Artifact path escapes benchmark root: ${path}`);
  return absolute;
}

export async function validateEvidence(evidence, options = {}) {
  const suite = await loadSuite();
  JSON.parse(await readFile(resolve(benchmarkRoot, "evidence.schema.json"), "utf8"));
  validateEvidenceShape(evidence);
  if (evidence.suiteVersion !== suite.version) throw new Error(`Evidence suite version ${evidence.suiteVersion} does not match ${suite.version}.`);
  if (evidence.model.id !== suite.model.id || evidence.model.reasoning !== suite.model.reasoning || evidence.model.agent !== suite.model.agent) throw new Error("Evidence model identity does not match the pinned suite model.");
  if (evidence.budget.repairRounds !== suite.budget.repairRounds) throw new Error("Evidence repair budget does not match the suite.");
  const expectedSuiteHash = await suiteSha256();
  if (evidence.source.suiteSha256 !== expectedSuiteHash) throw new Error("Evidence suite hash is stale.");
  try { execFileSync("git", ["merge-base", "--is-ancestor", evidence.source.commit, "HEAD"], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(`Evidence source commit ${evidence.source.commit} is not an ancestor of HEAD.`); }

  const ids = new Set();
  for (const run of evidence.runs) {
    if (ids.has(run.id)) throw new Error(`Duplicate benchmark run ID ${run.id}.`);
    ids.add(run.id);
    const slice = suite.slices.find((item) => item.id === run.slice);
    if (!slice) throw new Error(`Unknown benchmark slice ${run.slice}.`);
    for (const artifact of Object.values(run.artifacts)) {
      const path = safeArtifactPath(artifact.path);
      if ((await sha256File(path)) !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${artifact.path}`);
    }
  }

  if (options.requireComplete !== false) {
    const expected = [];
    for (const slice of suite.slices) for (const arm of suite.arms) for (let trial = 1; trial <= suite.trialsPerArm; trial += 1) expected.push(`${slice.id}-${arm}-${trial}`);
    const missing = expected.filter((id) => !ids.has(id));
    const unexpected = [...ids].filter((id) => !expected.includes(id));
    if (missing.length > 0 || unexpected.length > 0) throw new Error(`Benchmark evidence must contain all 18 runs. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
  }
  return evidence;
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return [0, 0];
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function aggregateEvidence(evidence) {
  const arms = {};
  for (const arm of ["control", "air"]) {
    const runs = evidence.runs.filter((run) => run.arm === arm);
    const passAt1 = runs.filter((run) => run.measurements.passAt1).length;
    const passAt3 = runs.filter((run) => run.measurements.passAt3).length;
    arms[arm] = {
      total: runs.length,
      passAt1,
      passAt3,
      passAt3Interval: wilsonInterval(passAt3, runs.length),
      escapedDefects: runs.reduce((sum, run) => sum + run.measurements.escapedDefects, 0),
      medianRounds: median(runs.map((run) => run.measurements.roundsUsed)),
      scenarioPassRate: runs.reduce((sum, run) => sum + run.measurements.passedScenarios, 0) / runs.reduce((sum, run) => sum + run.measurements.totalScenarios, 0),
    };
  }
  const slices = [...new Set(evidence.runs.map((run) => run.slice))].map((slice) => ({
    slice,
    control: evidence.runs.filter((run) => run.slice === slice && run.arm === "control" && run.measurements.passAt3).length,
    air: evidence.runs.filter((run) => run.slice === slice && run.arm === "air" && run.measurements.passAt3).length,
  }));
  return { arms, slices };
}

export function renderScorecard(evidence) {
  const summary = aggregateEvidence(evidence);
  const date = evidence.generatedAt.slice(0, 10);
  const row = (label, item) => `| ${label} | ${item.passAt1}/${item.total} | ${item.passAt3}/${item.total} | ${item.escapedDefects} | ${item.medianRounds} |`;
  const slices = summary.slices.map((item) => `| ${item.slice} | ${item.control}/3 | ${item.air}/3 |`).join("\n");
  return `<!-- AIR_LLM_BENCHMARK:START -->
## Does AIR improve an LLM migration?

Same model. Same capability. Same three-round budget. The AIR arm receives behavioral differences; the control arm receives ordinary tests only.

| Workflow | Pass@1 | Behavioral pass@3 | Escaped defects | Median rounds |
| --- | ---: | ---: | ---: | ---: |
${row(`${evidence.model.id} alone`, summary.arms.control)}
${row(`${evidence.model.id} + AIR`, summary.arms.air)}

| Capability slice | LLM alone | LLM + AIR |
| --- | ---: | ---: |
${slices}

Pinned result: ${evidence.model.id}, ${evidence.model.reasoning} reasoning · suite ${evidence.suiteVersion} · 3 trials per arm · ${date} · source \`${evidence.source.commit.slice(0, 12)}\`. [Methodology and evidence](https://github.com/halilturkoglucs/air/tree/main/benchmarks/llm-air-lift).

This result applies only to the named model and suite. Runtime throughput is measured separately.
<!-- AIR_LLM_BENCHMARK:END -->`;
}

export async function replaceGeneratedBlock(path, block) {
  const source = await readFile(path, "utf8");
  const pattern = /<!-- AIR_LLM_BENCHMARK:START -->[\s\S]*?<!-- AIR_LLM_BENCHMARK:END -->/u;
  if (!pattern.test(source)) throw new Error(`Missing AIR benchmark markers in ${relative(root, path)}.`);
  return source.replace(pattern, block);
}

export async function writeOrCheck(path, content, check) {
  const current = await readFile(path, "utf8");
  if (check) {
    if (current !== content) throw new Error(`${relative(root, path)} has stale generated benchmark content.`);
  } else if (current !== content) await writeFile(path, content, "utf8");
}

export function badgeSvg(label, value, color) {
  const escape = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const left = Math.max(88, label.length * 7 + 14); const right = Math.max(48, String(value).length * 7 + 14); const width = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escape(label)}: ${escape(value)}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-color="#000" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></linearGradient><clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${left}" height="20" fill="#263238"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${width}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11"><text x="${left / 2}" y="15" fill="#010101" fill-opacity=".3">${escape(label)}</text><text x="${left / 2}" y="14">${escape(label)}</text><text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${escape(value)}</text><text x="${left + right / 2}" y="14">${escape(value)}</text></g></svg>\n`;
}

export async function runProcess(program, args, options = {}) {
  return await new Promise((complete, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; options.onStdout?.(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; options.onStderr?.(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => complete({ code: code ?? 1, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

export async function createRunWorkspace(sliceId) {
  const directory = await mkdtemp(resolve(tmpdir(), `air-llm-${sliceId}-`));
  const slice = resolve(benchmarkRoot, "slices", sliceId);
  await cp(resolve(slice, "workspace"), directory, { recursive: true });
  await cp(resolve(slice, "task.md"), resolve(directory, "task.md"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["-c", "user.name=AIR Benchmark", "-c", "user.email=benchmark@air.dev", "commit", "-qm", "benchmark starter"], { cwd: directory });
  return directory;
}

export async function evaluateCandidate(slice, candidatePath, checkKind) {
  const discoveryPath = resolve(root, "packages/discovery/dist/index.js");
  try { await stat(discoveryPath); } catch { throw new Error("Build AIR before benchmarking: pnpm build"); }
  const discovery = await import(`${pathToFileURL(discoveryPath).href}?benchmark=${Date.now()}`);
  const evaluationRoot = await mkdtemp(resolve(tmpdir(), `air-evaluate-${slice.id}-`));
  const oracle = resolve(benchmarkRoot, "slices", slice.id, "oracle");
  await cp(resolve(oracle, "legacy.mjs"), resolve(evaluationRoot, "legacy.mjs"));
  await cp(candidatePath, resolve(evaluationRoot, "candidate.mjs"));
  const checkPath = resolve(benchmarkRoot, checkKind === "feedback" ? slice.feedbackCheck : slice.evaluationCheck);
  const [checkSource, policySource] = await Promise.all([readFile(checkPath, "utf8"), readFile(resolve(oracle, "policy.yaml"), "utf8")]);
  const check = discovery.parseCheckDocument(checkSource);
  const policy = discovery.parseCheckPolicy(policySource);
  const target = (name, file) => discovery.parseCheckTarget(`apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: ${name} }\nspec:\n  type: command\n  fixtureIsolation: process\n  command: { argv: [node, ${file}] }\n`);
  const repositoryHash = sha256(`${slice.id}:${checkKind}:${await sha256File(resolve(oracle, "legacy.mjs"))}`);
  const baseline = await discovery.createCheckBaseline({ check, policy, target: target("legacy", "legacy.mjs"), repositoryRoot: evaluationRoot, repositoryHash, clean: true });
  return await discovery.runMigrationCheck({ check, policy, baseline, target: target("candidate", "candidate.mjs"), repositoryRoot: evaluationRoot, repositoryHash });
}

export function explainResult(result) {
  if (result.passed) return "AIR check: PASS. Candidate matches the reviewed feedback boundary.";
  return `AIR check: FAIL. Repair candidate code only.\n${result.mismatches.map((item) => `- ${item.classification} in ${item.scenario} at ${item.selector}; category ${item.category}; ${item.repair === "candidate-code" ? "fix candidate code" : "repair observation harness"}.`).join("\n")}`;
}

export function scrubTranscript(source) {
  return source
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[A-Za-z0-9._~-]+/giu, "$1[REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?)[^\s"']+/gu, "$1[REDACTED]");
}

export function tokenUsage(jsonl) {
  let inputTokens = 0; let outputTokens = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === "turn.completed" && value.usage) {
        if (Number.isFinite(value.usage.input_tokens)) inputTokens += Number(value.usage.input_tokens);
        if (Number.isFinite(value.usage.output_tokens)) outputTokens += Number(value.usage.output_tokens);
      }
    } catch { /* preserve non-JSON diagnostics, but they have no usage data */ }
  }
  return { inputTokens, outputTokens };
}

export function measurementFromResult(slice, result, rounds, passAt1, buildFailures, infrastructureRetries, durationMs, usage) {
  const failed = new Set(result.scenarios.filter((scenario) => !scenario.passed).map((scenario) => scenario.id));
  const mismatchesByCategory = {};
  for (const scenario of failed) for (const category of slice.scenarioCategories[scenario] ?? ["unclassified"]) mismatchesByCategory[category] = (mismatchesByCategory[category] ?? 0) + 1;
  return {
    passAt1,
    passAt3: result.passed,
    roundsUsed: rounds,
    passedScenarios: result.scenarios.filter((scenario) => scenario.passed).length,
    totalScenarios: result.scenarios.length,
    escapedDefects: Object.values(mismatchesByCategory).reduce((sum, count) => sum + count, 0),
    buildFailures,
    infrastructureRetries,
    mismatchesByCategory,
    durationMs,
    ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
  };
}

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
  return path;
}

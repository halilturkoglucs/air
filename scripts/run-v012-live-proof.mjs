import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const cli = resolve(root, "packages/cli/dist/bin.js");
const databaseUrl = process.env.AIR_PROOF_POSTGRES_URL;
const hmctsRepository = process.env.AIR_HMCTS_REPOSITORY;

if (!databaseUrl || !hmctsRepository) {
  console.error("AIR_PROOF_POSTGRES_URL and AIR_HMCTS_REPOSITORY are required.");
  process.exit(2);
}

const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (gitStatus.status !== 0 || gitStatus.stdout.trim()) {
  console.error("The v0.12 live proof requires a clean tracked Git tree.");
  process.exit(2);
}

const output = await mkdtemp(resolve(tmpdir(), "air-v012-live-proof-"));
const commonEnvironment = { ...process.env, AIR_BENCHMARK_DATABASE_URL: databaseUrl, AIR_PILOT_POSTGRES_URL: databaseUrl, AIR_HMCTS_REPOSITORY: hmctsRepository };

function execute(arguments_, expectedCodes = [0]) {
  const execution = spawnSync(process.execPath, [cli, ...arguments_], { cwd: root, env: commonEnvironment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (!expectedCodes.includes(execution.status ?? 3)) {
    console.error(execution.stderr || execution.stdout);
    process.exit(execution.status ?? 3);
  }
  try { return JSON.parse(execution.stdout); }
  catch {
    console.error(`AIR did not return machine JSON for: air ${arguments_.join(" ")}`);
    console.error(execution.stdout);
    process.exit(3);
  }
}

execute(["check", "validate", "benchmarks/capability-replacement/check.yaml", "--policy", "benchmarks/capability-replacement/policy.yaml", "--json"]);
const springBaseline = execute([
  "check", "baseline", "benchmarks/capability-replacement/check.yaml",
  "--target", "benchmarks/capability-replacement/live-legacy.target.yaml",
  "--policy", "benchmarks/capability-replacement/policy.yaml",
  "--output", resolve(output, "spring-baseline"), "--json"
]);

for (let index = 0; index < 20; index += 1) {
  const result = execute([
    "check", "run", "benchmarks/capability-replacement/check.yaml",
    "--baseline", resolve(output, "spring-baseline"),
    "--target", "benchmarks/capability-replacement/live-candidate.target.yaml",
    "--policy", "benchmarks/capability-replacement/policy.yaml",
    "--output", resolve(output, `spring-equivalent-${index + 1}`), "--json"
  ]);
  if (!result.passed) throw new Error(`Equivalent live candidate failed on run ${index + 1}.`);
}

const mutants = JSON.parse(await readFile(resolve(root, "benchmarks/capability-replacement/mutants.json"), "utf8"));
for (const mutant of mutants) {
  const target = resolve(output, `mutant-${mutant}.target.yaml`);
  await writeFile(target, `apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: live-mutant-${mutant} }\nspec:\n  type: command\n  fixtureIsolation: process\n  workingDirectory: benchmarks/capability-replacement\n  environment:\n    AIR_BENCHMARK_DATABASE_URL: { fromEnv: AIR_BENCHMARK_DATABASE_URL }\n  command: { argv: [node, candidate.mjs, ${mutant}] }\n`, "utf8");
  const result = execute([
    "check", "run", "benchmarks/capability-replacement/check.yaml",
    "--baseline", resolve(output, "spring-baseline"), "--target", target,
    "--policy", "benchmarks/capability-replacement/policy.yaml",
    "--output", resolve(output, `spring-mutant-${mutant}`), "--json"
  ], [1]);
  if (result.passed || result.mismatches.length === 0) throw new Error(`Live mutant ${mutant} was not detected.`);
}

execute(["check", "validate", "pilots/hmcts-document-management-store/check.yaml", "--policy", "pilots/hmcts-document-management-store/check-policy.yaml", "--json"]);
const hmctsBaseline = execute([
  "check", "baseline", "pilots/hmcts-document-management-store/check.yaml",
  "--target", "pilots/hmcts-document-management-store/legacy.target.yaml",
  "--policy", "pilots/hmcts-document-management-store/check-policy.yaml",
  "--output", resolve(output, "hmcts-baseline"), "--json"
]);
const hmctsResult = execute([
  "check", "run", "pilots/hmcts-document-management-store/check.yaml",
  "--baseline", resolve(output, "hmcts-baseline"),
  "--target", "pilots/hmcts-document-management-store/candidate.target.yaml",
  "--policy", "pilots/hmcts-document-management-store/check-policy.yaml",
  "--output", resolve(output, "hmcts-run"), "--json"
]);
if (!hmctsResult.passed) throw new Error("The HMCTS live candidate did not match the pinned legacy capability.");

console.log(JSON.stringify({
  ok: true,
  output,
  spring: { baselineId: springBaseline.baselineId, releasable: springBaseline.releasable, equivalentRuns: 20, detectedMutants: mutants.length },
  hmcts: { baselineId: hmctsBaseline.baselineId, releasable: hmctsBaseline.releasable, passedScenarios: hmctsResult.scenarios.map((scenario) => scenario.id) },
  rawValuesPersistedByAir: false
}));

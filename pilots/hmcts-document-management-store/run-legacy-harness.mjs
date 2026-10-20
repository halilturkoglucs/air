import { spawn } from "node:child_process";
import { resolve } from "node:path";

const scenario = process.argv[2] ?? "success";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = source ? JSON.parse(source) : { documentId: "00000000-0000-4000-8000-000000000012" };
const upstream = process.env.HMCTS_REPOSITORY;
if (!upstream) throw new Error("HMCTS_REPOSITORY is required");
const harness = resolve("harness");
const environment = {
  ...process.env,
  AIR_HMCTS_SCENARIO: scenario,
  AIR_HMCTS_DOCUMENT_ID: input.documentId,
  AIR_HMCTS_HARNESS_SOURCE: harness
};
const child = spawn(resolve(upstream, "gradlew"), ["-q", "-p", upstream, "-I", resolve(harness, "hmcts-harness.init.gradle"), "airHmctsHarness"], {
  cwd: upstream, env: environment, stdio: ["ignore", "pipe", "pipe"]
});
let stdout = ""; let stderr = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
const code = await new Promise((complete, reject) => { child.once("error", reject); child.once("exit", complete); });
if (code !== 0) {
  process.stderr.write(stderr || stdout);
  process.exit(code ?? 1);
}
const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("AIR_OBSERVATION:"));
if (!marker) {
  process.stderr.write(`HMCTS harness did not emit an observation.\n${stdout}\n${stderr}`);
  process.exit(1);
}
process.stdout.write(`${marker.slice("AIR_OBSERVATION:".length)}\n`);

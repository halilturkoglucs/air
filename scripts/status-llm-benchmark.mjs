import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { benchmarkRoot, checkpointRoot, loadSuite, root, suiteSha256 } from "./lib/llm-benchmark.mjs";

// Read-only, offline progress report. It spends no model tokens and is safe for any agent to run before resuming.
const suite = await loadSuite();
const currentSuiteHash = await suiteSha256();
const requested = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined;
const readJson = async (path) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } };
const directories = async (path) => { try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } };

for (const profile of suite.models) {
  if (requested && profile.id !== requested) continue;
  const batches = await directories(resolve(benchmarkRoot, "results-batches", profile.id));
  const roots = [resolve(benchmarkRoot, "results", profile.id), ...batches.map((name) => resolve(benchmarkRoot, "results-batches", profile.id, name))];
  const complete = new Map(); const checkpoints = new Map(); const stale = [];
  for (const resultRoot of roots) {
    const evidence = await readJson(resolve(resultRoot, "evidence.json"));
    if (evidence && evidence.source?.suiteSha256 !== currentSuiteHash) stale.push(relative(root, resultRoot));
    else for (const run of evidence?.runs ?? []) complete.set(run.id, run);
  }
  for (const batch of await directories(resolve(checkpointRoot, profile.id))) {
    for (const id of await directories(resolve(checkpointRoot, profile.id, batch))) {
      const state = await readJson(resolve(checkpointRoot, profile.id, batch, id, "checkpoint.json"));
      if (state && !complete.has(id)) checkpoints.set(id, { state, batch, stale: state.suiteSha256 !== currentSuiteHash });
    }
  }

  const expected = suite.slices.flatMap((slice) => suite.arms.flatMap((arm) => Array.from({ length: suite.trialsPerArm }, (_, index) => ({ id: `${slice.id}-${arm}-${index + 1}`, slice: slice.id }))));
  const tokens = [...complete.values()].map((run) => (run.measurements.inputTokens ?? 0) + (run.measurements.outputTokens ?? 0)).filter((value) => value > 0);
  const perRun = tokens.length ? tokens.reduce((sum, value) => sum + value, 0) / tokens.length : undefined;
  const pending = expected.filter((run) => !complete.has(run.id));

  console.log(`\n${profile.id} (${profile.agent}, ${profile.reasoning}) · suite ${suite.version} · ${complete.size}/${expected.length} complete`);
  for (const run of expected) {
    const done = complete.get(run.id); const checkpoint = checkpoints.get(run.id);
    const status = done ? `${done.measurements.passAt3 ? "PASS" : "FAIL"} rounds=${done.measurements.roundsUsed} defects=${done.measurements.escapedDefects}` : checkpoint ? `${checkpoint.stale ? "STALE checkpoint (suite changed)" : "RESUMABLE"} round ${checkpoint.state.nextRound} (batch ${checkpoint.batch})` : "pending";
    console.log(`  ${run.id.padEnd(28)} ${status}`);
  }
  if (stale.length) console.log(`  Ignored evidence from an older suite hash: ${stale.join(", ")}`);
  if (perRun) console.log(`  Tokens so far: ${tokens.reduce((sum, value) => sum + value, 0).toLocaleString("en-US")} · estimated remaining: ~${Math.round(perRun * pending.length).toLocaleString("en-US")} (${pending.length} runs × ${Math.round(perRun).toLocaleString("en-US")})`);
  if (pending.length) {
    console.log("  Resume (re-running a command skips completed runs and continues checkpoints):");
    for (const slice of [...new Set(pending.map((run) => run.slice))]) console.log(`    pnpm benchmark:llm -- --model ${profile.id} --slice ${slice} --batch ${slice.split("-")[0]}`);
  } else console.log(`  All runs complete. Next: pnpm benchmark:merge -- --model ${profile.id} && pnpm benchmark:verify && pnpm benchmark:render`);
}

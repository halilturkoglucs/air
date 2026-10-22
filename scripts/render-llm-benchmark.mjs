import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateEvidence, badgeSvg, benchmarkRoot, ensureDirectory, loadSuite, renderScorecard, replaceGeneratedBlock, root, validateEvidence, writeOrCheck } from "./lib/llm-benchmark.mjs";

const check = process.argv.includes("--check");
const evidence = JSON.parse(await readFile(resolve(benchmarkRoot, "results/evidence.json"), "utf8"));
await validateEvidence(evidence);
const suite = await loadSuite();
const scorecard = renderScorecard(evidence, Object.fromEntries(suite.slices.map((slice) => [slice.id, slice.label])));
for (const path of [resolve(root, "README.md"), resolve(root, "packages/cli/README.md")]) {
  const rendered = await replaceGeneratedBlock(path, scorecard);
  await writeOrCheck(path, rendered, check);
}

const summary = aggregateEvidence(evidence);
const badgeDirectory = resolve(benchmarkRoot, "badges");
await ensureDirectory(badgeDirectory);
const { control, air } = summary.arms;
for (const [name, label, value, color] of [
  ["control-pass-at-3", "LLM alone pass@3", `${control.passAt3}/${control.total}`, "#6b7280"],
  ["air-pass-at-3", "LLM + AIR pass@3", `${air.passAt3}/${air.total}`, "#16a34a"],
  ["escaped-defects", "escaped defects", `${control.escapedDefects} → ${air.escapedDefects}`, air.escapedDefects < control.escapedDefects ? "#16a34a" : "#6b7280"],
]) {
  const path = resolve(badgeDirectory, `${name}.svg`);
  const content = badgeSvg(label, value, color);
  if (check) await writeOrCheck(path, content, true); else await writeFile(path, content, "utf8");
}
console.log(`${check ? "Verified" : "Rendered"} benchmark scorecards and badges.`);

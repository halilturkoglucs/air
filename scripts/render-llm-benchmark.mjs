import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateEvidence, badgeSvg, benchmarkRoot, ensureDirectory, renderScorecard, replaceGeneratedBlock, root, validateEvidence, writeOrCheck } from "./lib/llm-benchmark.mjs";

const check = process.argv.includes("--check");
const evidence = JSON.parse(await readFile(resolve(benchmarkRoot, "results/evidence.json"), "utf8"));
await validateEvidence(evidence);
const scorecard = renderScorecard(evidence);
for (const path of [resolve(root, "README.md"), resolve(root, "packages/cli/README.md")]) {
  const rendered = await replaceGeneratedBlock(path, scorecard);
  await writeOrCheck(path, rendered, check);
}

const summary = aggregateEvidence(evidence);
const badgeDirectory = resolve(benchmarkRoot, "badges");
await ensureDirectory(badgeDirectory);
for (const [name, item, color] of [["control", summary.arms.control, "#6b7280"], ["air", summary.arms.air, "#16a34a"]]) {
  const path = resolve(badgeDirectory, `${name}-pass-at-3.svg`);
  const content = badgeSvg(`${name} pass@3`, `${item.passAt3}/${item.total}`, color);
  if (check) await writeOrCheck(path, content, true); else await writeFile(path, content, "utf8");
}
console.log(`${check ? "Verified" : "Rendered"} benchmark scorecards and badges.`);

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateEvidence, airWins, badgeSvg, benchmarkRoot, ensureDirectory, loadSuite, renderScorecards, replaceGeneratedBlock, resultRoot, root, validateEvidence, writeOrCheck } from "./lib/llm-benchmark.mjs";

const check = process.argv.includes("--check");
const suite = await loadSuite();
const published = [];
for (const { id } of suite.models) {
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(resultRoot(id), "evidence.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") continue; throw error; }
  await validateEvidence(evidence);
  const { control, air } = aggregateEvidence(evidence).arms;
  // Only publish a model's scorecard when AIR measurably helps it; otherwise report and leave the READMEs alone.
  if (!airWins(control, air)) {
    console.log(`${id}: AIR did not beat the control arm (pass@3 ${air.passAt3}/${air.total} vs ${control.passAt3}/${control.total}, escaped defects ${air.escapedDefects} vs ${control.escapedDefects}); not published.`);
    continue;
  }
  published.push(evidence);
}
if (published.length === 0) {
  console.log("No model qualifies for publication; READMEs unchanged.");
  process.exit(0);
}

const scorecard = renderScorecards(published, Object.fromEntries(suite.slices.map((slice) => [slice.id, slice.label])));
for (const path of [resolve(root, "README.md"), resolve(root, "packages/cli/README.md")]) {
  const rendered = await replaceGeneratedBlock(path, scorecard);
  await writeOrCheck(path, rendered, check);
}

const badgeDirectory = resolve(benchmarkRoot, "badges");
await ensureDirectory(badgeDirectory);
for (const evidence of published) {
  const { control, air } = aggregateEvidence(evidence).arms;
  for (const [name, label, value, color] of [
    ["control-pass-at-3", "LLM alone pass@3", `${control.passAt3}/${control.total}`, "#6b7280"],
    ["air-pass-at-3", "LLM + AIR pass@3", `${air.passAt3}/${air.total}`, "#16a34a"],
    ["escaped-defects", "escaped defects", `${control.escapedDefects} → ${air.escapedDefects}`, air.escapedDefects < control.escapedDefects ? "#16a34a" : "#6b7280"],
  ]) {
    const path = resolve(badgeDirectory, `${evidence.model.id}-${name}.svg`);
    const content = badgeSvg(label, value, color);
    if (check) await writeOrCheck(path, content, true); else await writeFile(path, content, "utf8");
  }
}
console.log(`${check ? "Verified" : "Rendered"} benchmark scorecards and badges for ${published.map((evidence) => evidence.model.id).join(", ")}.`);

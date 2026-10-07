import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nextjsCapabilityManifest } from "../packages/target-nextjs/dist/index.js";
import { rustCapabilityManifest } from "../packages/target-rust/dist/index.js";
import { pythonCapabilityManifest } from "../packages/target-python/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const targets = [
  ["packages/target-nextjs/manifest.yaml", nextjsCapabilityManifest],
  ["packages/target-rust/manifest.yaml", rustCapabilityManifest],
  ["packages/target-python/manifest.yaml", pythonCapabilityManifest],
];
const check = process.argv.includes("--check");
let stale = false;

for (const [relativePath, manifest] of targets) {
  // JSON is a strict subset of YAML and keeps this derivation dependency-free.
  const expected = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = resolve(root, relativePath);
  if (check) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) {
      console.error(`${relativePath} is stale; run pnpm targets:sync.`);
      stale = true;
    }
  } else {
    await writeFile(path, expected, "utf8");
    console.log(`Updated ${relativePath}`);
  }
}

if (stale) process.exitCode = 1;

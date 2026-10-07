import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.argv[2] ?? "release-artifacts");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const archiveName = `air-${packageJson.version}-source.tgz`;
const archivePath = resolve(output, archiveName);

try {
  await stat(archivePath);
  throw new Error(`Refusing to overwrite existing release artifact: ${archivePath}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await mkdir(output, { recursive: true });
const include = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".gitignore",
  "README.md",
  "LICENSE",
  "NOTICE",
  "TRADEMARKS.md",
  "CONTRIBUTING.md",
  "DCO.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "packages",
  "examples",
  "docs",
  "scripts",
  ".github",
];
const tar = spawnSync("tar", [
  "-czf",
  archivePath,
  "--exclude=node_modules",
  "--exclude=.DS_Store",
  "--exclude=release-artifacts",
  ...include,
], { cwd: root, encoding: "utf8" });
if (tar.status !== 0) throw new Error(tar.stderr || `tar exited with ${tar.status}`);

const archive = await readFile(archivePath);
const manifest = {
  format: "air.dev/release-artifacts/v0.1",
  version: packageJson.version,
  artifacts: [{
    path: basename(archivePath),
    bytes: archive.byteLength,
    sha256: createHash("sha256").update(archive).digest("hex"),
  }],
};
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Created ${archivePath}`);
console.log(`SHA-256 ${manifest.artifacts[0].sha256}`);

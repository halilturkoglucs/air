import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "packages/cli");
const analyzers = resolve(cli, "analyzers");
await mkdir(analyzers, { recursive: true });
await Promise.all([
  copyFile(resolve(root, "LICENSE"), resolve(cli, "LICENSE")),
  copyFile(resolve(root, "NOTICE"), resolve(cli, "NOTICE")),
  copyFile(resolve(root, "packages/discovery/spring-analyzer/target/air-spring-analyzer.jar"), resolve(analyzers, "air-spring-analyzer.jar")),
]);

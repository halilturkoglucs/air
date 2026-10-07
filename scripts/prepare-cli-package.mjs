import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "packages/cli");
await Promise.all([
  copyFile(resolve(root, "LICENSE"), resolve(cli, "LICENSE")),
  copyFile(resolve(root, "NOTICE"), resolve(cli, "NOTICE")),
]);

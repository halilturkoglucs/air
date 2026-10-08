import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "packages/plugin-sdk");
await Promise.all([
  copyFile(resolve(root, "LICENSE"), resolve(destination, "LICENSE")),
  copyFile(resolve(root, "NOTICE"), resolve(destination, "NOTICE")),
]);

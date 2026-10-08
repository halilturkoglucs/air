import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  // The public CLI bundles private AIR workspace packages. Mature third-party
  // runtimes remain normal npm dependencies so their native module formats are
  // preserved instead of being rewritten into the ESM bundle.
  noExternal: [/^@air\//, /^@halilturkoglucs\/air-plugin-sdk$/],
  external: ["ajv", "yaml", "postgres", "amqplib", "kafkajs", "redis"],
});

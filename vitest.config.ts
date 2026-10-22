import { configDefaults, defineConfig } from "vitest/config";

// Benchmark slice workspaces ship node:test suites for the agent under test; they are not AIR's own tests.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "benchmarks/**"] },
});

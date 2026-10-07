import { describe, expect, it } from "vitest";
import { inferRequiredCapabilities, solveTargetCompatibility } from "@air/compiler-core";
import { loadAirFile } from "@air/parser";
import { PythonTargetAdapter } from "@air/target-python";
import { nextjsCapabilityManifest } from "@air/target-nextjs";
import { rustCapabilityManifest } from "@air/target-rust";
import { pythonCapabilityManifest } from "@air/target-python";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("target capability solver", () => {
  it("infers v0.8 collection, role, command, and delete requirements", async () => {
    const air = await loadAirFile(resolve("examples/library/air.yaml"));
    expect(inferRequiredCapabilities(air)).toEqual(expect.arrayContaining([
      "authorization.roles-scopes", "domain.commands", "domain.delete", "http.collections", "persistence.relational",
    ]));
  });

  it("returns deterministic incompatibility explanations", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const adapter = new PythonTargetAdapter();
    const report = await solveTargetCompatibility({
      air,
      required: ["ui.web"],
      candidates: [{ adapter, options: { database: "postgres" } }],
    });
    expect(report.results[0]?.compatible).toBe(false);
    expect(report.results[0]?.diagnostics[0]).toMatchObject({ code: "TARGET_CAPABILITY_UNSUPPORTED" });
  });

  it("keeps checked-in discovery manifests derived from runtime manifests", async () => {
    const cases = [
      ["packages/target-nextjs/manifest.yaml", nextjsCapabilityManifest],
      ["packages/target-rust/manifest.yaml", rustCapabilityManifest],
      ["packages/target-python/manifest.yaml", pythonCapabilityManifest],
    ] as const;
    for (const [path, manifest] of cases) {
      expect(JSON.parse(await readFile(resolve(path), "utf8"))).toEqual(manifest);
    }
  });
});

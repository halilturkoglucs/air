import { describe, expect, it } from "vitest";
import { inferRequiredCapabilities, solveTargetCompatibility } from "@air/compiler-core";
import { loadAirFile, parseAir } from "@air/parser";
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

  it("never silently drops v0.10 outbound-port semantics", async () => {
    const air = parseAir(`
apiVersion: air.dev/v0.10
kind: Application
metadata: { name: target-safety }
spec:
  entities: {}
  contracts:
    VendorInput:
      fields: { value: { type: string, required: true } }
    VendorOutput:
      fields: { accepted: { type: boolean, required: true } }
  ports:
    vendor:
      operations:
        call:
          input: VendorInput
          output: VendorOutput
          failures:
            unavailable: { retryable: true }
  transformations:
    normalize:
      input: VendorInput
      output: VendorInput
      steps:
        - { kind: project, fields: [value] }
`);
    expect(inferRequiredCapabilities(air)).toEqual(expect.arrayContaining([
      "domain.transformations", "integration.outbound_ports",
    ]));

    const report = await solveTargetCompatibility({
      air,
      candidates: [{ adapter: new PythonTargetAdapter(), options: { database: "postgres" } }],
    });
    expect(report.results[0]?.compatible).toBe(false);
    expect(report.results[0]?.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "TARGET_CAPABILITY_UNSUPPORTED", "PYTHON_OUTBOUND_PORTS_UNSUPPORTED", "PYTHON_TRANSFORMATIONS_UNSUPPORTED",
    ]));
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

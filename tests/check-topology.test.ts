import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../packages/cli/src/index.js";

const example = resolve("examples/extract-service");

function capture() {
  let stdout = ""; let stderr = "";
  return { io: { stdout: (message: string) => { stdout += message; }, stderr: (message: string) => { stderr += message; } }, stdout: () => stdout, stderr: () => stderr };
}

async function workspace(normalization?: string) {
  const directory = await mkdtemp(resolve(tmpdir(), "air-topology-"));
  const policy = resolve(directory, "policy.yaml");
  // Tests run from a possibly dirty checkout, so this policy accepts a non-releasable baseline.
  await writeFile(policy, (await readFile(resolve(example, "policy.yaml"), "utf8")).replace("spec:\n", "spec:\n  requireCleanBaseline: false\n"));
  let check = resolve(example, "check.yaml");
  if (normalization !== undefined) {
    check = resolve(directory, "check.yaml");
    await writeFile(check, (await readFile(resolve(example, "check.yaml"), "utf8")).replace(/  normalization:\n[\s\S]*$/u, normalization));
  }
  const baseline = capture();
  expect(await runCli(["check", "baseline", check, "--policy", policy, "--target", resolve(example, "legacy.target.yaml"), "--output", resolve(directory, "baseline"), "--allow-dirty"], baseline.io), baseline.stderr()).toBe(0);
  const run = async (target: string, ...extra: string[]) => {
    const output = capture();
    const code = await runCli(["check", "run", check, "--policy", policy, "--baseline", resolve(directory, "baseline"), "--target", target, "--output", resolve(directory, `run-${Math.random().toString(36).slice(2)}`), "--agent", ...extra], output.io);
    return { code, out: output.stdout(), err: output.stderr() };
  };
  return { directory, run };
}

describe("air check for topology changes", () => {
  it("passes an extracted service when only the declared boundary differs, and catches a real regression", async () => {
    const { directory, run } = await workspace();
    const extracted = await run(resolve(example, "candidate.target.yaml"));
    expect(extracted.code, extracted.out + extracted.err).toBe(0);
    expect(extracted.out).toContain("PASS 2/2 scenarios");

    const broken = resolve(directory, "broken.target.yaml");
    await writeFile(broken, (await readFile(resolve(example, "candidate.target.yaml"), "utf8")).replace("argv: [node, orders.mjs]", "argv: [node, orders.mjs, bad]"));
    const regression = await run(broken, "--reveal", "--legacy", resolve(example, "legacy.target.yaml"));
    expect(regression.code).toBe(1);
    expect(regression.out).toContain("/http/body/total: expected 20, got 40");
    expect(regression.out).toContain("/database/invoices/0/total: expected 20, got 40");
  }, 60_000);

  it("reports the split as differences when the boundary is not declared", async () => {
    const { run } = await workspace("");
    const undeclared = await run(resolve(example, "candidate.target.yaml"));
    expect(undeclared.code).toBe(1);
    expect(undeclared.out).toMatch(/\/database\/(billing_)?invoices/u);
    expect(undeclared.out).toContain("/outbound/0");
  }, 60_000);

  it("rejects a rename onto an existing location", async () => {
    const { run } = await workspace("  normalization:\n    - { kind: rename, pointer: /database/billing_invoices, to: /database/orders, reason: wrong target }\n");
    const conflict = await run(resolve(example, "candidate.target.yaml"));
    expect(conflict.code).toBe(1);
    expect(conflict.out).toContain("normalization failed in small-order");
  }, 60_000);
});

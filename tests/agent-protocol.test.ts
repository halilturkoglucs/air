import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentReport, formatAgentReport, type CheckResult } from "@air/discovery";

const bin = resolve("packages/cli/dist/bin.js");

const legacy = `let s = ""; for await (const c of process.stdin) s += c; const i = JSON.parse(s);
console.log(JSON.stringify({ http: { status: 201, body: { title: i.title, outcome: "created" } }, database: { rows: [{ title: i.title, state: "created", version: 1, owner: "alice" }] } }));`;
const candidate = `let s = ""; for await (const c of process.stdin) s += c; const i = JSON.parse(s); const bad = process.argv[2] === "bad";
console.log(JSON.stringify({ http: { status: bad ? 200 : 201, body: { title: i.title, outcome: "created" } }, database: { rows: [bad ? { title: i.title, state: "draft", version: 2, owner: "bob" } : { title: i.title, state: "created", version: 1, owner: "alice" }] } }));`;
const target = (name: string, argv: string) => `apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: ${name} }\nspec: { type: command, fixtureIsolation: process, command: { argv: [${argv}] } }\n`;

async function project(policySpec = "{}"): Promise<{ root: string; air: (...args: string[]) => { code: number; out: string; err: string } }> {
  const root = await mkdtemp(resolve(tmpdir(), "air-agent-"));
  await writeFile(resolve(root, "legacy.mjs"), legacy); await writeFile(resolve(root, "candidate.mjs"), candidate);
  await writeFile(resolve(root, "legacy.target.yaml"), target("legacy", "node, legacy.mjs"));
  await writeFile(resolve(root, "bad.target.yaml"), target("candidate", "node, candidate.mjs, bad"));
  await writeFile(resolve(root, "good.target.yaml"), target("candidate", "node, candidate.mjs, good"));
  await writeFile(resolve(root, "policy.yaml"), `apiVersion: air.dev/check-policy/v0.1\nkind: CheckPolicy\nmetadata: { name: test }\nspec: ${policySpec}\n`);
  await writeFile(resolve(root, "check.yaml"), "apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: create }\nspec:\n  capability: { id: books.create }\n  observations: [http, database]\n  scenarios:\n    - { id: creates-book, request: { kind: command, input: { title: Dune } } }\n");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };
  expect(air("check", "profile", "--check", "check.yaml", "--policy", "policy.yaml", "--baseline", "out/baseline", "--legacy", "legacy.target.yaml", "--candidate", "bad.target.yaml", "--output", "out/runs").code).toBe(0);
  expect(air("check", "baseline").code).toBe(0);
  return { root, air };
}

describe("AIR agent protocol", () => {
  it("runs from the profile with compact, deterministic, revealed output and never persists values", async () => {
    const { root, air } = await project();
    const first = air("check", "run", "--agent", "--reveal");
    expect(first.code).toBe(1);
    expect(first.out).toBe([
      "FAIL 0/1 scenarios · 4 differences",
      "- creates-book",
      "  /database/rows/0 (3): expected {\"title\":\"Dune\",\"state\":\"created\",\"version\":1,\"owner\":\"alice\"}, got {\"title\":\"Dune\",\"state\":\"draft\",\"version\":2,\"owner\":\"bob\"}",
      "  /http/status: expected 201, got 200",
      "NEXT fix the code (never the checks) unless the change is intended, then rerun the same AIR command.",
      "",
    ].join("\n"));
    expect(air("check", "run", "--agent", "--reveal").out.split("\n")[0]).toBe("FAIL 0/1 scenarios · 4 differences · fixed 0, new 0 since last run");
    for (const run of await readdir(resolve(root, "out/runs"))) expect(await readFile(resolve(root, "out/runs", run, "result.json"), "utf8")).not.toMatch(/alice|bob|draft/u);
    expect(air("check", "status").out).toContain("LAST FAIL 0/1 scenarios · 4 differences");
    const fixed = air("check", "run", "--agent", "--target", "good.target.yaml");
    expect(fixed.code).toBe(0);
    expect(fixed.out).toBe("PASS 1/1 scenarios · 0 differences · fixed 4, new 0 since last run\nDONE candidate matches the baseline; stop.\n");
  }, 30_000);

  it("refuses --reveal when the policy denies it", async () => {
    const { air } = await project("{ reveal: deny }");
    const denied = air("check", "run", "--agent", "--reveal");
    expect(denied.code).toBe(2);
    expect(denied.err).toContain("INPUT The check policy denies --reveal");
    expect(air("check", "run", "--agent").code).toBe(1);
  }, 30_000);

  it("serves the check tools over MCP stdio", async () => {
    const { root } = await project();
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "air_check_run", arguments: { reveal: true } } },
      { jsonrpc: "2.0", id: 4, method: "nope" },
    ];
    const run = spawnSync(process.execPath, [bin, "mcp"], { cwd: root, encoding: "utf8", input: requests.map((request) => JSON.stringify(request)).join("\n") });
    const responses = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown>; error?: { code: number } });
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3, 4]);
    expect(responses[0]!.result).toMatchObject({ serverInfo: { name: "air" }, capabilities: { tools: {} } });
    expect((responses[1]!.result!.tools as { name: string }[]).map((tool) => tool.name)).toEqual(["air_protect", "air_check_status", "air_check_run", "air_check_explain", "air_check_baseline"]);
    expect(responses[2]!.result).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("/http/status: expected 201, got 200") }] });
    expect(responses[3]!.error!.code).toBe(-32601);
  }, 30_000);

  it("keeps reports inside the line budget, lists normalization first, and renders tokens compactly", () => {
    const mismatch = (selector: string) => ({ classification: "candidate-difference" as const, scenario: "s1", category: selector.split("/")[1]!, selector, provenance: "p", repair: "candidate-code" as const });
    const result: CheckResult = {
      apiVersion: "air.dev/check-result/v0.1", kind: "CheckResult", generatedAt: "2026-10-22T00:00:00.000Z", baselineId: "b", candidate: { name: "c", targetHash: "h" }, passed: false,
      policy: { passed: true, violations: [] }, scenarios: [{ id: "s1", passed: false }],
      mismatches: [...Array.from({ length: 12 }, (_, index) => mismatch(`/messages/${index}/type`)), { ...mismatch("/normalization"), classification: "missing-observation", repair: "harness" }, mismatch("/http/body/id")],
    };
    const values = new Map([["s1", { expected: { http: { body: { id: { $airToken: "uuid", binding: "doc" } } } }, actual: { http: { body: { id: "123" } } } }]]);
    const text = formatAgentReport(buildAgentReport({ result, values, maxLines: 8 }));
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(8);
    expect(text).toContain("- s1\n  /normalization: missing\n  /http/body/id: expected \"<uuid:doc>\", got \"123\"");
    expect(text).toContain("NOTE normalization failed in s1");
    expect(formatAgentReport(buildAgentReport({ result, values, maxLines: 8 }))).toBe(text);
  });
});

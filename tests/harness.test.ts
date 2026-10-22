import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
// Behavior HTTP checks cannot see: an event on an in-memory bus and a cache entry.
const orders = (factor = 1) => `export const bus = []; export const cache = new Map();
export function createOrder(id, amount) {
  bus.send({ topic: "order-created", id, amount: amount * ${factor} });
  cache.set(id, { amount: amount * ${factor} });
}
bus.send = (message) => bus.push(message);
`;
const harness = `import { bus, cache, createOrder } from "../../../orders.mjs";
let source = ""; for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source);
createOrder(input.id, input.amount);
console.log(JSON.stringify({ events: bus.map(({ topic, id, amount }) => ({ topic, id, amount })), cache: Object.fromEntries(cache) }));
`;

async function project() {
  const root = await mkdtemp(resolve(tmpdir(), "air-harness-"));
  await writeFile(resolve(root, "orders.mjs"), orders());
  await writeFile(resolve(root, "app.mjs"), "let s = ''; for await (const c of process.stdin) s += c; console.log(JSON.stringify({ http: { status: 200, body: JSON.parse(s) } }));\n");
  await mkdir(resolve(root, "air-checks"));
  await writeFile(resolve(root, "air-checks/app.target.yaml"), "apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: app }\nspec: { type: command, fixtureIsolation: process, command: { argv: [node, app.mjs] } }\n");
  await writeFile(resolve(root, "air-checks/check.yaml"), "apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: app }\nspec:\n  capability: { id: app }\n  observations: [http]\n  scenarios:\n    - { id: echo, request: { kind: command, input: { a: 1 } } }\n");
  await writeFile(resolve(root, "air-checks/policy.yaml"), "apiVersion: air.dev/check-policy/v0.1\nkind: CheckPolicy\nmetadata: { name: test }\nspec: { requireCleanBaseline: false, allowedNormalizations: [ignore, typed-token, unordered-array] }\n");
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "service");
  const env = { ...process.env }; delete env.AIR_STATE_DIR;
  const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", env }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };
  expect(air("check", "profile", "--check", "air-checks/check.yaml", "--policy", "air-checks/policy.yaml", "--baseline", "air-checks/baseline", "--legacy", "air-checks/app.target.yaml", "--candidate", "air-checks/app.target.yaml", "--output", ".air/runs").code).toBe(0);
  return { root, git, air };
}

describe("agent-written harnesses", () => {
  it("are requested, verified by execution, baselined by air protect, and catch behavior changes", async () => {
    const { root, git, air } = await project();
    const first = air("protect");
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain("TASK the code also has behavior HTTP checks cannot see (event order-created)");
    expect(air("harness", "task").out).toContain("event order-created (orders.mjs:3)");

    expect(air("harness", "new", "orders", "--observe", "events,cache").code).toBe(0);
    const directory = resolve(root, "air-checks/harnesses/orders");
    const placeholder = air("harness", "verify", "orders");
    expect(placeholder.code).toBe(1);
    expect(placeholder.out).toContain("every scenario produced the same observation");
    expect(placeholder.out).toContain("no --mutation patch");
    expect(placeholder.out).toContain("category events was never observed");

    await writeFile(resolve(directory, "harness.mjs"), harness);
    await writeFile(resolve(directory, "check.yaml"), "apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: harness-orders }\nspec:\n  capability: { id: orders }\n  observations: [events, cache]\n  scenarios:\n    - { id: small, request: { kind: command, input: { id: o-1, amount: 20 } } }\n    - { id: large, request: { kind: command, input: { id: o-2, amount: 900 } } }\n");
    await writeFile(resolve(root, "orders.mjs"), orders(2));
    const patch = resolve(root, "..", `break-${Date.now()}.patch`);
    await writeFile(patch, git("diff", "--", "orders.mjs").stdout);
    git("checkout", "--", "orders.mjs");
    // --teardown runs in the project after the planted change, to restore anything a --setup deployed.
    const teardown = resolve(root, "..", `teardown-${Date.now()}.mjs`); const restored = `${teardown}.done`;
    await writeFile(teardown, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(restored)}, process.cwd());\n`);
    const accepted = air("harness", "verify", "orders", "--mutation", patch, "--teardown", `node ${teardown}`);
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    expect(accepted.out).toContain("HARNESS ACCEPTED orders");
    await stat(resolve(directory, "verified.json"));
    expect(await realpath(await readFile(restored, "utf8"))).toBe(await realpath(root));
    expect(spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n")).toHaveLength(1);

    const baseline = air("protect");
    expect(baseline.code, baseline.out + baseline.err).toBe(0);
    expect(baseline.out).toContain("PROTECTED harness orders: 2 scenario(s)");
    const pass = air("protect");
    expect(pass.code).toBe(0);
    expect(pass.out.match(/PASS/gu)).toHaveLength(2);

    await writeFile(resolve(root, "orders.mjs"), orders(2));
    const broken = air("protect");
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("== harness orders");
    expect(broken.out).toContain("/events/0/amount: expected 20, got 40");
    git("checkout", "--", "orders.mjs");

    await writeFile(resolve(directory, "harness.mjs"), harness.replace("({ topic, id, amount })", "({ topic, id })"));
    const changed = air("protect");
    expect(changed.code).toBe(2);
    expect(changed.out).toContain("TASK harness orders is new or changed and not verified");
    expect(await readFile(resolve(root, ".gitignore"), "utf8").catch(() => "")).toBe("");
  }, 90_000);
});

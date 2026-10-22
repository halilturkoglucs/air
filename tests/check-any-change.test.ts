import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
const app = (status: number, state: string) => `let s = ""; for await (const c of process.stdin) s += c; const i = JSON.parse(s);
const total = [i.a, i.b].reduce((sum, value) => sum + value, 0); // refactors keep this observable behavior
console.log(JSON.stringify({ http: { status: ${status}, body: { total, state: "${state}" } } }));`;

async function repository(): Promise<{ root: string; git: (...args: string[]) => void; air: (...args: string[]) => { code: number; out: string; err: string } }> {
  const root = await mkdtemp(resolve(tmpdir(), "air-any-change-"));
  const git = (...args: string[]) => { const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }); if (run.status !== 0) throw new Error(run.stderr); };
  const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };
  return { root, git, air };
}

describe("air check for refactors and recorded traffic", () => {
  it("baselines legacy from a Git ref, then approves an intentional change with a recorded reason", async () => {
    const { root, git, air } = await repository();
    await writeFile(resolve(root, "app.mjs"), app(201, "open"));
    await writeFile(resolve(root, "app.target.yaml"), "apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: app }\nspec: { type: command, fixtureIsolation: process, command: { argv: [node, app.mjs] } }\n");
    await writeFile(resolve(root, "check.yaml"), "apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: sum }\nspec:\n  capability: { id: sum }\n  observations: [http]\n  scenarios:\n    - { id: adds, request: { kind: command, input: { a: 2, b: 3 } } }\n    - { id: zero, request: { kind: command, input: { a: 0, b: 0 } } }\n");
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "v1");
    // Refactor in place: same behavior, different code, committed on top of v1.
    await writeFile(resolve(root, "app.mjs"), app(201, "open").replace("[i.a, i.b].reduce((sum, value) => sum + value, 0)", "i.a + i.b"));
    git("commit", "-qam", "refactor");
    expect(air("check", "profile", "--check", "check.yaml", "--baseline", "out/baseline", "--legacy", "app.target.yaml", "--candidate", "app.target.yaml", "--output", "out/runs", "--at", "HEAD~1").code).toBe(0);
    const baseline = air("check", "baseline");
    expect(baseline.code, baseline.err).toBe(0);
    expect(spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n")).toHaveLength(1);
    expect(air("check", "run", "--agent").out).toContain("PASS 2/2 scenarios");

    // An intentional behavior change fails until it is approved for the scenarios it should affect.
    await writeFile(resolve(root, "app.mjs"), app(201, "closed"));
    const changed = air("check", "run", "--agent", "--reveal");
    expect(changed.code).toBe(1);
    expect(changed.out).toContain('/http/body/state: expected "open", got "closed"');
    expect(air("check", "approve", "adds", "--reason", "x").err).toContain("Commit the intended change before approving it");
    git("commit", "-qam", "close orders on creation");
    const approved = air("check", "approve", "adds", "zero", "--reason", "orders now close on creation", "--json");
    expect(approved.code, approved.err).toBe(0);
    const { path, previousBaselineId, changedSelectors } = JSON.parse(approved.out) as { path: string; previousBaselineId: string; changedSelectors: number };
    expect(changedSelectors).toBe(2);
    expect(air("check", "run", "--agent").code).toBe(0);
    const stored = JSON.parse(await readFile(path, "utf8")) as { approvals: { scenario: string; reason: string; previousBaselineId: string }[] };
    expect(stored.approvals.map((item) => item.scenario)).toEqual(["adds", "zero"]);
    expect(stored.approvals[0]).toMatchObject({ reason: "orders now close on creation", previousBaselineId });
    const diff = air("check", "diff-baseline", resolve(root, "out/baseline"), resolve(path, ".."));
    expect(diff.code).toBe(1);
    expect(diff.out).toContain("CHANGED adds /http/body/state");
    expect(diff.out).toContain("APPROVED adds by target app: orders now close on creation");
  }, 60_000);

  it("records HAR traffic into a reviewable HTTP check, skipping static, foreign, and non-JSON exchanges", async () => {
    const { root, air } = await repository();
    const entry = (method: string, url: string, mimeType: string, text?: string) => ({ request: { method, url, headers: [{ name: "Authorization", value: "Bearer secret" }, { name: "X-Tenant", value: "t1" }], ...(text === undefined ? {} : { postData: { text } }) }, response: { status: 200, content: { mimeType } } });
    await writeFile(resolve(root, "session.har"), JSON.stringify({ log: { entries: [
      entry("GET", "http://localhost:3000/", "text/html"),
      entry("POST", "http://localhost:3000/api/books?draft=1", "application/json", JSON.stringify({ title: "Dune" })),
      entry("POST", "http://localhost:3000/api/books?draft=1", "application/json", JSON.stringify({ title: "Dune" })),
      entry("POST", "http://localhost:3000/upload", "application/json", "not json"),
      entry("GET", "http://other.example/api/books", "application/json"),
      entry("GET", "http://localhost:3000/api/books", "application/json"),
    ] } }));
    const recorded = air("check", "record", "--from-har", "session.har", "--to", "http://localhost:3000", "--output", "recorded", "--keep-header", "x-tenant");
    expect(recorded.code, recorded.err).toBe(0);
    expect(recorded.out).toContain("Recorded 2 scenario(s); skipped 2");
    const check = await readFile(resolve(root, "recorded/check.yaml"), "utf8");
    expect(check).toContain("id: post-api-books\n");
    expect(check).toContain("path: /api/books?draft=1");
    expect(check).toContain("x-tenant: t1");
    expect(check).not.toMatch(/Bearer|secret/u);
    expect(await readFile(resolve(root, "recorded/legacy.target.yaml"), "utf8")).toContain("baseUrl: http://localhost:3000/");
    expect(air("check", "record", "--from-har", "session.har", "--to", "http://localhost:3000", "--output", "recorded").code).toBe(2);
  }, 30_000);

  it("records live traffic through the proxy and replays it into a baseline", async () => {
    const { root, git, air } = await repository();
    // The upstream runs in its own process: the CLI is invoked synchronously below and would block an in-process server.
    const server = spawn(process.execPath, ["-e", "require('node:http').createServer((q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: q.url, method: q.method }))).listen(0, '127.0.0.1', function () { console.log(this.address().port); })"]);
    const upstream = `http://127.0.0.1:${await new Promise<string>((ready) => server.stdout.once("data", (chunk: Buffer) => ready(chunk.toString().trim())))}`;
    try {
      const proxyPort = 20_000 + Math.floor(Math.random() * 20_000);
      const recorder = spawn(process.execPath, [bin, "check", "record", "--to", upstream, "--output", "live", "--listen", String(proxyPort), "--max", "2"], { cwd: root });
      let stderr = ""; recorder.stderr.on("data", (chunk) => { stderr += chunk; });
      await new Promise<void>((ready) => { const wait = (): void => { if (stderr.includes("Recording:")) ready(); else setTimeout(wait, 50); }; wait(); });
      expect(await (await fetch(`http://127.0.0.1:${proxyPort}/api/items`)).json()).toEqual({ path: "/api/items", method: "GET" });
      await fetch(`http://127.0.0.1:${proxyPort}/api/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
      expect(await new Promise<number | null>((done) => recorder.once("close", done))).toBe(0);
      git("init", "-q"); git("add", "-A"); git("commit", "-qm", "recorded");
      const baseline = air("check", "baseline", "live/check.yaml", "--target", "live/legacy.target.yaml", "--output", "live/baseline");
      expect(baseline.code, baseline.err).toBe(0);
      const run = air("check", "run", "live/check.yaml", "--baseline", "live/baseline", "--target", "live/legacy.target.yaml", "--output", "live/run", "--agent");
      expect(run.out).toContain("PASS 2/2 scenarios");
    } finally { server.kill(); }
  }, 30_000);
});

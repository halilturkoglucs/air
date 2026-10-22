import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
// A tiny service with an express-style router, so `air discover code` can find its routes.
const server = `import { createServer } from "node:http";
const routes = {};
const app = { get: (path, handler) => { routes["GET " + path] = handler; }, post: (path, handler) => { routes["POST " + path] = handler; } };
app.get("/books", () => ({ status: 200, body: { books: [{ title: process.env.TITLE ?? "Dune" }] } }));
app.get("/health", () => ({ status: 200, body: { ok: true } }));
app.get("/books/:id", () => ({ status: 200, body: { id: "x" } }));
app.post("/books", () => ({ status: 201, body: {} }));
createServer((request, response) => {
  const handler = routes[request.method + " " + request.url];
  const result = handler ? handler() : { status: 404, body: { error: "not found" } };
  response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const running: ChildProcess[] = [];
afterEach(() => { for (const child of running.splice(0)) child.kill(); });

async function startService(root: string, port: number, title?: string): Promise<void> {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: root, env: { ...process.env, PORT: String(port), ...(title ? { TITLE: title } : {}) }, stdio: "ignore" });
  running.push(child);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((ready) => setTimeout(ready, 50));
  }
  throw new Error("service did not start");
}

async function project() {
  const root = await mkdtemp(resolve(tmpdir(), "air-protect-"));
  await writeFile(resolve(root, "server.mjs"), server);
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "service");
  const env = { ...process.env }; delete env.AIR_STATE_DIR;
  const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", env }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };
  return { root, git, air, port: 20_000 + Math.floor(Math.random() * 20_000) };
}

describe("air protect", () => {
  it("protects a running service without a proxy, shows changes with expected values, and accepts approved ones", async () => {
    const { root, git, air, port } = await project();
    const unset = air("protect");
    expect(unset.code).toBe(2);
    expect(unset.out).toContain("QUESTION AIR is not set up here yet");

    await startService(root, port);
    const first = air("protect", "--url", `http://127.0.0.1:${port}`);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain("PROTECTED 2 scenario(s)");
    expect(first.err).toContain("NOTE 2 route(s) that need inputs or change data were not called");
    expect(await readFile(resolve(root, "air-checks/check.yaml"), "utf8")).toContain("path: /books");
    expect(await readFile(resolve(root, ".gitignore"), "utf8")).toContain(".air/expected.json");
    expect(air("protect").out).toContain("PASS 2/2 scenarios");

    // The developer changes behavior and restarts the service; the old code no longer runs, values come from the local cache.
    running.splice(0).forEach((child) => child.kill());
    await startService(root, port, "Emma");
    const changed = air("protect");
    expect(changed.code).toBe(1);
    expect(changed.out).toContain('/http/body/books/0/title: expected "Dune", got "Emma"');

    git("add", "-A"); git("commit", "-qm", "protect and rename");
    const approved = air("check", "approve", "get-books", "--reason", "default title is now Emma");
    expect(approved.code, approved.err).toBe(0);
    expect(air("protect").out).toContain("PASS 2/2 scenarios");
  }, 60_000);

  it("records richer traffic through the proxy when given a command", async () => {
    const { root, air, port } = await project();
    await startService(root, port);
    const recorded = air("protect", "--url", `http://127.0.0.1:${port}`, "--", process.execPath, "-e", "await fetch(process.env.AIR_PROXY_URL + '/books'); await fetch(process.env.AIR_PROXY_URL + '/books/7');");
    expect(recorded.code, recorded.err).toBe(0);
    expect(recorded.err).toContain("Recorded 2 scenario(s)");
    expect(recorded.out).toContain("PROTECTED 2 scenario(s)");
    expect(await readFile(resolve(root, "air-checks/check.yaml"), "utf8")).toContain("path: /books/7");
  }, 60_000);

  it("installs the agent loop into AGENTS.md and CLAUDE.md idempotently", async () => {
    const { root, air } = await project();
    const first = air("agent", "install");
    expect(first.code).toBe(0);
    expect(first.out).toContain("AGENTS.md: created");
    expect(first.out).toContain("CLAUDE.md: created");
    const agents = await readFile(resolve(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- AIR:START");
    expect(agents).toContain("air protect --url http://localhost:<port>");
    expect(air("agent", "install").out).toContain("AGENTS.md: already up to date");
    await writeFile(resolve(root, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(resolve(root, "AGENTS.md"), `# Project rules\n\nKeep this line.\n\n${agents}`);
    const again = air("agent", "install");
    expect(again.out).toContain("CLAUDE.md: imports AGENTS.md");
    const merged = await readFile(resolve(root, "AGENTS.md"), "utf8");
    expect(merged).toContain("Keep this line.");
    expect(merged.match(/AIR:START/gu)).toHaveLength(1);
  }, 30_000);
});

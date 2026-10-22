import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
const server = `import { createServer } from "node:http";
const routes = {};
const app = { get: (path, handler) => { routes["GET " + path] = handler; }, post: (path, handler) => { routes["POST " + path] = handler; } };
app.get("/books", () => ({ status: 200, body: [{ id: "1", title: "Dune" }] }));
app.get("/books/:id", () => ({ status: 200, body: { id: "7", title: "Emma" } }));
app.post("/books", (body) => ({ status: 201, body: { created: body.title } }));
const insert = "INSERT INTO books (title) VALUES ($1)";
createServer(async (request, response) => {
  let source = ""; for await (const chunk of request) source += chunk;
  const path = request.url.replace(/^\\/books\\/[^/]+$/, "/books/:id");
  const handler = routes[request.method + " " + path];
  const result = handler ? handler(source ? JSON.parse(source) : {}) : { status: 404, body: {} };
  response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
// The project's own end-to-end tests read the server URL from API_URL, as many API test suites do.
const e2e = `const base = process.env.API_URL;
await fetch(base + "/books/7");
await fetch(base + "/books", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Kindred" }) });
`;

const running: ChildProcess[] = [];
afterEach(() => { for (const child of running.splice(0)) child.kill(); });

describe("air protect coverage", () => {
  it("reports coverage, suggests the project's reset script, and grows coverage from the existing test suite", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-coverage-"));
    await writeFile(resolve(root, "server.mjs"), server);
    await writeFile(resolve(root, "tests-e2e.mjs"), e2e);
    await writeFile(resolve(root, "package.json"), JSON.stringify({ type: "module", scripts: { "test:e2e": "node tests-e2e.mjs", "db:reset": "node -e 0" } }));
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "service");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    running.push(spawn(process.execPath, ["server.mjs"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" }));
    for (let attempt = 0; attempt < 100; attempt += 1) { try { await fetch(`http://127.0.0.1:${port}/books`); break; } catch { await new Promise((ready) => setTimeout(ready, 50)); } }
    const env = { ...process.env }; delete env.AIR_STATE_DIR;
    const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", env }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };

    const first = air("protect", "--url", `http://127.0.0.1:${port}`);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain("COVERAGE 1 of 3 HTTP routes found in the code are exercised; add more with: air protect --add --tests");
    expect(first.out).toContain('air protect --reset "npm run db:reset" --rebaseline (found in this project: npm run db:reset;');

    const added = air("protect", "--add", "--tests");
    expect(added.code, added.out + added.err).toBe(0);
    expect(added.out).toContain("ADDED 2 scenario(s); 3 in total");
    expect(added.out).toContain("COVERAGE 3 of 3 HTTP routes found in the code are exercised.");
    expect(await readFile(resolve(root, "air-checks/check.yaml"), "utf8")).toContain("title: Kindred");
    expect(air("protect", "--add", "--tests").out).toContain("No new requests: all 2 recorded request(s) are already covered.");
    const pass = air("protect");
    expect(pass.code, pass.out + pass.err).toBe(0);
    expect(pass.out).toContain("PASS 3/3 scenarios");
  }, 60_000);
});

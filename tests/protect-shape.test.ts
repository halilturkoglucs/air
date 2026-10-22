import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
// Ads picked at random: values and length differ on every call, only the structure is stable.
const server = (field = "text") => `import { createServer } from "node:http";
const routes = {};
const app = { get: (path, handler) => { routes["GET " + path] = handler; } };
app.get("/ads", () => ({ status: 200, body: Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => ({ ${field}: "ad " + Math.random(), clicks: Math.floor(Math.random() * 100) })) }));
createServer((request, response) => {
  const handler = routes[request.method + " " + request.url];
  const result = handler ? handler(request) : { status: 404, body: {} };
  response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const running: ChildProcess[] = [];
afterEach(() => { for (const child of running.splice(0)) child.kill(); });

async function start(root: string, port: number) {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  running.push(child);
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await fetch(`http://127.0.0.1:${port}/ads`); return child; } catch { await new Promise((ready) => setTimeout(ready, 50)); } }
  return child;
}

describe("air protect random content", () => {
  it("suggests a shape rule for values that are random by design, then still catches a structural change", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-protect-shape-"));
    await writeFile(resolve(root, "server.mjs"), server());
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "service");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const first = await start(root, port);
    const env = { ...process.env }; delete env.AIR_STATE_DIR;
    const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", env }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };

    const setup = air("protect", "--url", `http://127.0.0.1:${port}`);
    expect(setup.code, setup.err).toBe(0);
    const suggestion = "  - { kind: shape, pointer: /http/body, scenarios: [get-ads], reason: \"<why it varies>\" }";
    expect(setup.out, setup.out).toContain(suggestion);

    const checkPath = resolve(root, "air-checks/check.yaml");
    await writeFile(checkPath, (await readFile(checkPath, "utf8")).replace("spec:\n", `spec:\n  normalization:\n${suggestion.replace("<why it varies>", "ads are picked at random")}\n`));
    expect(air("protect", "--rebaseline").code).toBe(0);
    for (const run of [air("protect"), air("protect")]) expect(run.out, run.out + run.err).toContain("PASS 1/1 scenarios");

    first.kill();
    await writeFile(resolve(root, "server.mjs"), server("title"));
    await start(root, port);
    const broken = air("protect");
    expect(broken.code, broken.out).toBe(1);
    expect(broken.out).toContain("/http/body/0/text");
  }, 60_000);
});

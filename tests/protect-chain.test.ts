import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
// A sign-in that issues a fresh token and timestamp on every call, then a route that needs the token.
const server = (greeting = "hello") => `import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
const routes = {};
const app = { get: (path, handler) => { routes["GET " + path] = handler; }, post: (path, handler) => { routes["POST " + path] = handler; } };
const tokens = new Set();
const part = () => randomBytes(12).toString("base64url");
app.post("/login", () => { const token = part() + "." + part() + "." + part(); tokens.add(token); return { status: 200, body: { user: { name: "ada", token, createdAt: new Date().toISOString() } } }; });
app.get("/me", (request) => tokens.has((request.headers.authorization ?? "").replace("Token ", "")) ? { status: 200, body: { message: "${greeting} ada" } } : { status: 401, body: { error: "sign in" } });
createServer((request, response) => {
  request.resume(); request.on("end", () => {
    const handler = routes[request.method + " " + request.url];
    const result = handler ? handler(request) : { status: 404, body: {} };
    response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
  });
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
const flow = `const base = process.env.AIR_PROXY_URL;
const login = await (await fetch(base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
await fetch(base + "/me", { headers: { authorization: "Token " + login.user.token } });
`;

const running: ChildProcess[] = [];
afterEach(() => { for (const child of running.splice(0)) child.kill(); });

async function start(root: string, port: number) {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  running.push(child);
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await fetch(`http://127.0.0.1:${port}/me`); return child; } catch { await new Promise((ready) => setTimeout(ready, 50)); } }
  return child;
}

describe("air protect credential chaining", () => {
  it("replays a recorded sign-in, normalizes generated tokens, and never stores the credential", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-protect-chain-"));
    await writeFile(resolve(root, "server.mjs"), server());
    await writeFile(resolve(root, "flow.mjs"), flow);
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "service");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const first = await start(root, port);
    const env = { ...process.env }; delete env.AIR_STATE_DIR;
    const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", env }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };

    expect(air("protect", "--url", `http://127.0.0.1:${port}`).code).toBe(0);
    const added = air("protect", "--add", "--", "node", "flow.mjs");
    expect(added.code, added.out + added.err).toBe(0);
    expect(added.err).toContain("NOTE 1 credential header(s) are taken from earlier responses");
    expect(added.out).toContain("/http/body/user/token as jwt");
    expect(added.out).toContain("/http/body/user/createdAt as timestamp");

    for (const run of [air("protect"), air("protect")]) expect(run.out, run.out + run.err).toMatch(/PASS (\d+)\/\1 scenarios/u);
    const check = await readFile(resolve(root, "air-checks/check.yaml"), "utf8");
    expect(check).toContain("headersFrom");
    expect(check).not.toMatch(/Token [A-Za-z0-9_-]{8,}\./u);

    // The signed-in response is really checked: a changed greeting behind the login fails.
    first.kill();
    await writeFile(resolve(root, "server.mjs"), server("hi"));
    await start(root, port);
    const broken = air("protect");
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('/http/body/message: expected "hello ada", got "hi ada"');
  }, 60_000);
});

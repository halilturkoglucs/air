import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanCodeSeams } from "@air/discovery";

const bin = resolve("packages/cli/dist/bin.js");
// Lessons from a field trial: GETs that write state, routes behind a login, and SQL keywords inside ordinary strings.
const server = `import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const routes = {};
const app = { get: (path, handler) => { routes["GET " + path] = handler; } };
app.get("/visits", () => { const count = Number(readFileSync("state.txt", "utf8")) + 1; writeFileSync("state.txt", String(count)); return { status: 200, body: { count } }; });
app.get("/me", (request) => request.headers.cookie === "session=ok" ? { status: 200, body: { user: "ada" } } : { status: 401, body: { error: "sign in" } });
app.get("/orders", (request) => request.headers.cookie === "session=ok" ? { status: 200, body: { orders: [] } } : { status: 401, body: { error: "sign in" } });
const audit = "INSERT INTO visits (count) VALUES ($1)";
const message = "Failed to update failed attempts from MongoDB.";
createServer((request, response) => {
  const handler = routes[request.method + " " + request.url];
  const result = handler ? handler(request) : { status: 404, body: {} };
  response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const running: ChildProcess[] = [];
afterEach(() => { for (const child of running.splice(0)) child.kill(); });

async function project() {
  const root = await mkdtemp(resolve(tmpdir(), "air-protect-setup-"));
  await writeFile(resolve(root, "server.mjs"), server);
  await writeFile(resolve(root, "state.txt"), "0");
  await writeFile(resolve(root, "reset.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('state.txt', '0');\n");
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "service");
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, ["server.mjs"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  running.push(child);
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await fetch(`http://127.0.0.1:${port}/me`); break; } catch { await new Promise((ready) => setTimeout(ready, 50)); } }
  const env = { ...process.env }; delete env.AIR_STATE_DIR;
  const air = (extra: Record<string, string>, ...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", env: { ...env, ...extra } }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };
  return { root, port, air };
}

describe("air protect setup guidance", () => {
  it("ignores SQL keywords in ordinary strings and finds MongoDB collections", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-effects-"));
    await writeFile(resolve(root, "data.ts"), `const a = "Update profile failed"; const b = "Failed to update failed attempts";\nawait db.collection("users").insertOne(user);\nconst Order = mongoose.model("Order", schema);\nawait sql\`UPDATE accounts SET balance = 1\`;\n`);
    expect((await scanCodeSeams({ root })).effects.map((effect) => effect.name)).toEqual(["users", "Order", "accounts"]);
  });

  it("flags state that changes between runs, then resets it, and checks signed-in behavior without storing the secret", async () => {
    const { root, port, air } = await project();
    const first = air({}, "protect", "--url", `http://127.0.0.1:${port}`);
    expect(first.code, first.err).toBe(0);
    expect(first.err).toContain("Built 3 read-only scenario(s) from routes found in the code");
    expect(first.out).toContain("NOTE 2 of 3 scenarios only reached a login wall");
    expect(first.out).toContain("NOTE this code stores data");

    // Without a reset, the stored counter makes the next run differ even though the code did not change.
    const drift = air({}, "protect");
    expect(drift.code).toBe(1);
    expect(drift.out).toContain("/http/body/count: expected 1, got 2");
    expect(drift.out).toContain("NEXT fix the code (never the checks) unless the change is intended, then rerun the same AIR command.");

    const reset = air({ AIR_TEST_COOKIE: "session=ok" }, "protect", "--reset", "node reset.mjs", "--header", "Cookie=AIR_TEST_COOKIE", "--rebaseline");
    expect(reset.code, reset.out + reset.err).toBe(0);
    expect(reset.err).toContain("NOTE previous baseline kept at air-checks/baseline-replaced-");
    expect(reset.out).not.toContain("login wall");
    expect(air({ AIR_TEST_COOKIE: "session=ok" }, "protect").out).toContain("PASS 3/3 scenarios");
    expect(air({ AIR_TEST_COOKIE: "session=ok" }, "protect").out).toContain("PASS 3/3 scenarios");

    const target = await readFile(resolve(root, "air-checks/legacy.target.yaml"), "utf8");
    expect(target).toContain("fromEnv: AIR_TEST_COOKIE");
    expect(target).toContain("fixtureIsolation: reset-command");
    expect(target).not.toContain("session=ok");
    const missing = air({}, "protect");
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("Header Cookie needs environment variable AIR_TEST_COOKIE");
  }, 60_000);
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAirFile } from "@air/parser";
import { planPython, PythonTargetAdapter, pythonCapabilityManifest } from "@air/target-python";

describe("Python target boundary", () => {
  it("declares an explicit FastAPI capability boundary", () => {
    expect(pythonCapabilityManifest.capabilities["http.crud"].support).toBe("supported");
    expect(pythonCapabilityManifest.capabilities["ui.web"].support).toBe("unsupported");
  });

  it("plans deterministic FastAPI, psycopg, and PostgreSQL output", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const first = planPython(air);
    expect(first).toEqual(planPython(air));
    expect(first.map((file) => file.path)).toEqual([...first.map((file) => file.path)].sort((left, right) => left.localeCompare(right)));
    expect(first.find((file) => file.path === "requirements.txt")?.content).toContain("fastapi==");
    expect(first.find((file) => file.path === "requirements.txt")?.content).toContain("psycopg-pool==");
    expect(first.find((file) => file.path === "migrations/0001_air.sql")?.content).toContain("CREATE TABLE todos");
    const application = first.find((file) => file.path === "app.py")?.content ?? "";
    expect(application).toContain('@app.get("/air-runtime/ready")');
    expect(application).toContain("app.add_api_route");
    expect(application).toContain("create_model");
    expect(application).toContain("ConnectionPool");
  });

  it("lowers commands to locks, atomic arithmetic, replay, and bounded retry", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const plan = planPython(air);
    const generated = plan.find((file) => file.path === "app.py")?.content ?? "";
    const runtime = plan.find((file) => file.path === "air_runtime.py")?.content ?? "";
    expect(generated).toContain("FOR UPDATE");
    expect(generated).toContain("SET TRANSACTION ISOLATION LEVEL");
    expect(generated).toContain("SerializationFailure");
    expect(generated).toContain("command.get(\"idempotency\")");
    expect(generated).not.toMatch(/(?:if|try|except) [^\n]+: (?:return|await|pass)/);
    expect(runtime).not.toMatch(/(?:if|elif|else) [^\n]*: (?:await|raise)/);
  });

  it("writes managed provenance and a reproducibility lock", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const directory = await mkdtemp(resolve(tmpdir(), "air-python-test-"));
    const result = await new PythonTargetAdapter().compile({ air, outputDirectory: directory, mode: "managed", options: {} });
    expect(result.status).toBe("success");
    const lock = JSON.parse(await readFile(resolve(directory, ".air/lock.json"), "utf8"));
    expect(lock.target.id).toBe("python-fastapi");
    expect(lock.dependencies).toMatchObject({ fastapi: "0.115", psycopg: "3.2", psycopgPool: "3.2", python: "3.12" });
  });
});

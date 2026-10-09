import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import cliPackage from "../packages/cli/package.json" with { type: "json" };
import { runCli, VERSION, type CliIo } from "@halilturkoglucs/air";

function captureIo() {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

describe("AIR CLI", () => {
  it("reports the published package version in help and version output", async () => {
    expect(VERSION).toBe(cliPackage.version);

    const help = captureIo();
    expect(await runCli(["--help"], help.io)).toBe(0);
    expect(help.stdout()).toContain(`AIR compiler toolkit ${cliPackage.version}`);

    const version = captureIo();
    expect(await runCli(["--version"], version.io)).toBe(0);
    expect(version.stdout()).toBe(`${cliPackage.version}\n`);
  });

  it("validates a file", async () => {
    const output = captureIo();
    const exitCode = await runCli(["validate", resolve("examples/todo/air.yaml")], output.io);

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Valid AIR document:");
    expect(output.stdout()).toContain("1 entity/entities, 5 HTTP operation(s)");
    expect(output.stderr()).toBe("");
  });

  it("prints a stable semantic inspection", async () => {
    const output = captureIo();
    const exitCode = await runCli(["inspect", resolve("examples/todo/air.yaml")], output.io);

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Application: AIR Todo");
    expect(output.stdout()).toContain("Todo: 4 field(s), 0 relationship(s)");
    expect(output.stdout()).toContain("GET    /todos -> Todo.list (listTodos)");
  });

  it("uses a non-zero exit for bad invocation", async () => {
    const output = captureIo();
    const exitCode = await runCli(["validate"], output.io);

    expect(exitCode).toBe(2);
    expect(output.stderr()).toBe("Usage: air validate <file>\n");
  });

  it("compiles AIR to a Next.js project", async () => {
    const output = captureIo();
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-nextjs-"));
    const exitCode = await runCli(
      [
        "compile",
        resolve("examples/todo/air.yaml"),
        "--target",
        "nextjs",
        "--output",
        directory,
      ],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Compiled");
    expect(await readFile(resolve(directory, "next.config.ts"), "utf8")).toContain("NextConfig");
  });

  it("compiles AIR to a Rust Axum project", async () => {
    const output = captureIo();
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-rust-"));
    const exitCode = await runCli(
      ["compile", resolve("examples/todo/air.yaml"), "--target", "rust", "--output", directory],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("to Rust Axum");
    expect(await readFile(resolve(directory, "Cargo.toml"), "utf8")).toContain('axum = { version = "0.8", features = ["ws"] }');
  });

  it("compiles AIR to a Python FastAPI project", async () => {
    const output = captureIo();
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-python-"));
    const exitCode = await runCli(
      ["compile", resolve("examples/todo/air.yaml"), "--target", "python", "--output", directory],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("to Python FastAPI");
    expect(await readFile(resolve(directory, "app.py"), "utf8")).toContain("FastAPI");
  });

  it("reports generated and user-owned output boundaries", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-ownership-"));
    const compileOutput = captureIo();
    expect(await runCli(["compile", resolve("examples/todo/air.yaml"), "--target", "python", "--output", directory], compileOutput.io)).toBe(0);
    await writeFile(resolve(directory, "user-extension.py"), "# user owned\n", "utf8");

    const output = captureIo();
    expect(await runCli(["ownership", directory, "--json"], output.io)).toBe(0);
    const report = JSON.parse(output.stdout());
    expect(report.targetId).toBe("python-fastapi");
    expect(report.generated).toContain("app.py");
    expect(report.user).toContain("user-extension.py");
    expect(report.modified).toEqual([]);
  });

  it("preserves explicitly adopted artifacts during managed regeneration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-adopt-"));
    expect(await runCli(["compile", resolve("examples/todo/air.yaml"), "--target", "python", "--output", directory], captureIo().io)).toBe(0);
    expect(await runCli(["adopt", directory, "--user-owned", "README.md"], captureIo().io)).toBe(0);
    await writeFile(resolve(directory, "README.md"), "# My owned documentation\n", "utf8");
    expect(await runCli(["compile", resolve("examples/todo/air.yaml"), "--target", "python", "--output", directory], captureIo().io)).toBe(0);
    expect(await readFile(resolve(directory, "README.md"), "utf8")).toBe("# My owned documentation\n");
    const output = captureIo();
    expect(await runCli(["reconcile", directory, "--json"], output.io)).toBe(0);
    expect(JSON.parse(output.stdout()).user).toContain("README.md");
  });

  it("solves required and preferred target capabilities", async () => {
    const output = captureIo();
    const exitCode = await runCli([
      "target-check", resolve("examples/library/air.yaml"),
      "--prefer", "ui.web", "--json",
    ], output.io);
    expect(exitCode).toBe(0);
    const report = JSON.parse(output.stdout());
    expect(report.format).toBe("air.dev/target-compatibility/v0.1");
    expect(report.results).toHaveLength(3);
    expect(report.results[0]).toMatchObject({ targetId: "nextjs", compatible: true, preferenceScore: 2 });
    expect(report.results.every((result: { compatible: boolean }) => result.compatible)).toBe(true);
  });

  it("executes a canonical verification suite", async () => {
    const output = captureIo();
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-evidence-"));
    const evidencePath = resolve(directory, "evidence.json");
    const exitCode = await runCli(
      [
        "verify",
        resolve("examples/ecommerce/air.yaml"),
        "--scenarios",
        resolve("examples/ecommerce/verification.yaml"),
        "--output",
        evidencePath,
      ],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("PASS placeOrderCreatesPendingOrder");
    expect(output.stdout()).toContain("Verified 5/5 scenario(s).");
    expect(output.stdout()).toContain(`Evidence: ${evidencePath}`);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(evidence.format).toBe("air.dev/verification-evidence/v0.1");
    expect(evidence.summary).toEqual({ passed: 5, failed: 0, total: 5 });
    expect(evidence.air.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.stderr()).toBe("");
  });

  it("requires explicit acknowledgement before live verification can reset a database", async () => {
    const output = captureIo();
    const exitCode = await runCli(
      [
        "verify-live",
        resolve("examples/ledger/air.yaml"),
        "--scenarios",
        resolve("examples/ledger/verification.yaml"),
        "--base-url",
        "http://127.0.0.1:3000",
        "--database-url",
        "postgres://unused",
        "--auth-secret",
        "unused-secret",
      ],
      output.io,
    );

    expect(exitCode).toBe(2);
    expect(output.stderr()).toContain("--allow-database-reset");
  });

  it("requires explicit acknowledgement before differential verification can reset databases", async () => {
    const output = captureIo();
    const exitCode = await runCli(
      [
        "verify-differential",
        resolve("examples/ledger/air.yaml"),
        "--scenarios",
        resolve("examples/ledger/verification.yaml"),
        "--target",
        "nextjs=http://127.0.0.1:3001",
        "--target",
        "rust=http://127.0.0.1:3000",
        "--database-url",
        "nextjs=postgres://unused-nextjs",
        "--database-url",
        "rust=postgres://unused-rust",
        "--auth-secret",
        "unused-secret",
      ],
      output.io,
    );

    expect(exitCode).toBe(2);
    expect(output.stderr()).toContain("--allow-database-reset");
  });

  it("assembles evidence artifacts with integrity metadata", async () => {
    const output = captureIo();
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-pack-"));
    const semantic = resolve(directory, "semantic.json");
    const live = resolve(directory, "live.json");
    const compatibility = resolve(directory, "target-compatibility.json");
    const destination = resolve(directory, "pack");
    const identity = { air: { sha256: "a".repeat(64) }, suite: { sha256: "b".repeat(64) } };
    await writeFile(semantic, JSON.stringify({ format: "air.dev/verification-evidence/v0.1", ...identity, summary: { passed: 1 } }));
    await writeFile(live, JSON.stringify({ format: "air.dev/live-verification-evidence/v0.1", ...identity, summary: { passed: 1 } }));
    await writeFile(compatibility, JSON.stringify({
      format: "air.dev/target-compatibility/v0.1",
      airVersion: "air.dev/v0.8",
      results: [],
    }));

    const exitCode = await runCli([
      "evidence-pack",
      "--artifact", `semantic=${semantic}`,
      "--artifact", `live=${live}`,
      "--artifact", `target-compatibility=${compatibility}`,
      "--output", destination,
    ], output.io);

    expect(exitCode, output.stderr()).toBe(0);
    const manifest = JSON.parse(await readFile(resolve(destination, "manifest.json"), "utf8"));
    expect(manifest.format).toBe("air.dev/evidence-pack/v0.1");
    expect(manifest.artifacts).toHaveLength(3);
    expect(manifest.artifacts.map((artifact: { format: string }) => artifact.format)).toContain("air.dev/target-compatibility/v0.1");
    expect(manifest.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const verifyOutput = captureIo();
    expect(await runCli(["evidence-verify", destination], verifyOutput.io)).toBe(0);
    expect(verifyOutput.stdout()).toContain("all checksums valid");

    await writeFile(resolve(destination, manifest.artifacts[0].file), "{}\n", "utf8");
    const tamperedOutput = captureIo();
    expect(await runCli(["evidence-verify", destination], tamperedOutput.io)).toBe(1);
    expect(tamperedOutput.stderr()).toContain("Checksum mismatch");
  });

  it("migrates an AIR v0.1 file without overwriting", async () => {
    const output = captureIo();
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-migrate-"));
    const source = resolve(directory, "air.yaml");
    const destination = resolve(directory, "air.v0.2.yaml");
    await writeFile(
      source,
      `apiVersion: air.dev/v0.1\nkind: Application\nmetadata: { name: legacy }\nspec:\n  entities:\n    Item:\n      fields:\n        id: { type: uuid, required: true }\n`,
      "utf8",
    );

    const exitCode = await runCli(
      ["migrate", source, "--to", "air.dev/v0.2", "--output", destination],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(await readFile(destination, "utf8")).toContain("apiVersion: air.dev/v0.2");
    const latestDestination = resolve(directory, "air.v0.9.yaml");
    expect(await runCli(["migrate", source, "--output", latestDestination], output.io)).toBe(0);
    expect(await readFile(latestDestination, "utf8")).toContain("apiVersion: air.dev/v0.9");
    expect(await runCli(["migrate", source, "--output", latestDestination], output.io)).toBe(1);
  });

  it("writes reviewable semantic diffs and schema-evolution plans", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-cli-diff-"));
    const before = resolve(directory, "before.yaml");
    const after = resolve(directory, "after.yaml");
    const diffPath = resolve(directory, "diff.json");
    const planPath = resolve(directory, "plan.json");
    const base = `apiVersion: air.dev/v0.8\nkind: Application\nmetadata: { name: diff-app }\nspec:\n  entities:\n    Item:\n      fields:\n        id: { type: uuid, primaryKey: true }\n`;
    await writeFile(before, base, "utf8");
    await writeFile(after, `${base}        note: { type: string, nullable: true }\n`, "utf8");

    expect(await runCli(["diff", before, after, "--output", diffPath], captureIo().io)).toBe(0);
    expect(await runCli(["plan-migration", before, after, "--output", planPath], captureIo().io)).toBe(0);
    expect(JSON.parse(await readFile(diffPath, "utf8"))).toMatchObject({
      format: "air.dev/semantic-diff/v0.1",
      summary: { safe: 1, breaking: 0 },
    });
    expect(JSON.parse(await readFile(planPath, "utf8"))).toMatchObject({
      format: "air.dev/schema-evolution-plan/v0.1",
      executable: true,
    });
  });
});

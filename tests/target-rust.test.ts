import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAirFile } from "@air/parser";
import { planRust, RustTargetAdapter, rustCapabilityManifest } from "@air/target-rust";

describe("Rust target boundary", () => {
  it("declares an explicit native capability boundary", () => {
    expect(rustCapabilityManifest.capabilities["http.crud"].support).toBe("supported");
    expect(rustCapabilityManifest.capabilities["ui.web"].support).toBe("unsupported");
  });

  it("plans deterministic Axum, SQLx, and PostgreSQL output", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const first = planRust(air);
    const second = planRust(air);

    expect(first).toEqual(second);
    expect(first.map((file) => file.path)).toEqual(
      [...first.map((file) => file.path)].sort((left, right) => left.localeCompare(right)),
    );
    expect(first.find((file) => file.path === "Cargo.toml")?.content).toContain('axum = { version = "0.8", features = ["ws"] }');
    expect(first.find((file) => file.path === "Cargo.toml")?.content).toContain('rust-version = "1.99.0"');
    expect(first.find((file) => file.path === "rust-toolchain.toml")?.content).toContain('channel = "1.99.0"');
    expect(first.find((file) => file.path === "src/generated.rs")?.content).toContain("pub async fn create_todo");
    expect(first.find((file) => file.path === "migrations/0001_air.sql")?.content).toContain("CREATE TABLE todos");
    expect(first.find((file) => file.path === "src/generated.rs")?.content).toContain('"/air-runtime/ready"');
    expect(first.find((file) => file.path === "src/main.rs")?.content).toContain("with_graceful_shutdown");
    expect(first.find((file) => file.path === "src/main.rs")?.content).toContain('std::env::var("AIR_PORT")');
    expect(first.find((file) => file.path === "Dockerfile")?.content).toContain('CMD ["air-app", "--healthcheck"]');
  });

  it("lowers the ledger command to locks, atomic arithmetic, replay, and retry", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const generated = planRust(air).find((file) => file.path === "src/generated.rs")?.content ?? "";

    expect(generated).toContain("FOR UPDATE");
    expect(generated).toContain("balance = balance - $1");
    expect(generated).toContain("balance = balance + $1");
    expect(generated).toContain("if let Some(replayed)");
    expect(generated).toContain("for attempt in 1..=3");
    expect(generated).toContain('Some("40001" | "40P01" | "23505")');
  });

  it("lowers v0.8 collections, CRUD authorization, and delete commands", async () => {
    const air = await loadAirFile(resolve("examples/library/air.yaml"));
    const generated = planRust(air).find((file) => file.path === "src/generated.rs")?.content ?? "";

    expect(generated).toContain("struct ListDocumentsQuery");
    expect(generated).toContain("ORDER BY title ASC LIMIT $2 OFFSET $3");
    expect(generated).toContain('AppError::domain(401, "UNAUTHENTICATED"');
    expect(generated).toContain("DELETE FROM documents WHERE id = $1 RETURNING");
    expect(generated).toContain('["admin"].contains(&principal.role.as_str())');
  });

  it("writes managed provenance and a reproducibility lock", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const directory = await mkdtemp(resolve(tmpdir(), "air-rust-test-"));
    const result = await new RustTargetAdapter().compile({ air, outputDirectory: directory, mode: "managed", options: {} });

    expect(result.status).toBe("success");
    const lock = JSON.parse(await readFile(resolve(directory, ".air/lock.json"), "utf8"));
    expect(lock.target.id).toBe("rust-axum");
    expect(lock.dependencies).toMatchObject({ axum: "0.8", sqlx: "0.8", rustVersion: "1.99.0" });
  });
});

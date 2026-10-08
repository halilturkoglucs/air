import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAirFile } from "@air/parser";
import { loadComposition, planComposition } from "@air/composer";
import { importSpring } from "@air/import-spring";
import { planNextjs } from "@air/target-nextjs";
import { planRust } from "@air/target-rust";
import { planPython } from "@air/target-python";
import { parseSystemVerificationSuite, verifySystemSuite } from "@air/verifier";
import { runCli, type CliIo } from "@halilturkoglucs/air";

const example = resolve("examples/complex-commerce");

function capture(): { io: CliIo; stdout: () => string; stderr: () => string } {
  let stdout = ""; let stderr = "";
  return { io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } }, stdout: () => stdout, stderr: () => stderr };
}

describe("AIR v0.10 complex services", () => {
  it("plans every reference provider and deployment topology", async () => {
    const bundle = await loadComposition(resolve(example, "system.air.yaml"), resolve(example, "deployment.compose.yaml"));
    const plan = planComposition(bundle);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.providerPlans.map((item) => item.provider)).toEqual(["redis", "postgres", "kafka"]);
    expect(plan.artifacts.map((item) => item.path)).toContain("compose.yaml");
    expect(plan.artifacts.map((item) => item.path)).toContain("otel-collector.yaml");

    const expectedByProfile = {
      process: ["processes.json"],
      docker: ["compose.yaml"],
      compose: ["compose.yaml"],
      kubernetes: ["kubernetes/components.yaml", "helm/Chart.yaml"],
      "terraform-kubernetes": ["kubernetes/components.yaml", "helm/Chart.yaml", "terraform/main.tf"],
    } as const;
    for (const [profile, expected] of Object.entries(expectedByProfile)) {
      const profiled = planComposition({
        ...bundle,
        deployment: { ...bundle.deployment, spec: { ...bundle.deployment.spec, profile: profile as typeof bundle.deployment.spec.profile } },
      });
      expect(profiled.diagnostics).toEqual([]);
      expect(profiled.artifacts.map((item) => item.path)).toEqual(expect.arrayContaining(expected));
      if (profile === "kubernetes" || profile === "terraform-kubernetes") {
        const manifests = profiled.artifacts.find((item) => item.path === "kubernetes/components.yaml")?.content ?? "";
        expect(manifests).toContain("name: orders-api");
        expect(manifests).toContain("image: redpandadata/redpanda:v24.1.21");
        expect(manifests).toContain("name: otel-collector");
      }
    }
  });

  it("generates durable async runtime artifacts in all three languages", async () => {
    const [orders, inventory, billing] = await Promise.all([
      loadAirFile(resolve(example, "orders.air.yaml")),
      loadAirFile(resolve(example, "inventory.air.yaml")),
      loadAirFile(resolve(example, "billing.air.yaml")),
    ]);
    const next = planNextjs(orders, { deployment: "node" });
    const rust = planRust(inventory, { rustVersion: "1.99.0" });
    const python = planPython(billing);
    expect(next.find((item) => item.path === "drizzle/0000_air_async_runtime.sql")?.content).toContain("air_realtime_journal");
    expect(next.find((item) => item.path === "src/air/runtime.ts")?.content).toContain("air.outbox.publish");
    expect(rust.find((item) => item.path === "migrations/0001_air.sql")?.content).toContain("air_saga_instances");
    expect(rust.find((item) => item.path === "src/main.rs")?.content).toContain("run_worker");
    expect(python.find((item) => item.path === "air_runtime.py")?.content).toContain("air.consumer.deliveries");
    expect(python.find((item) => item.path === "app.py")?.content).toContain("/air-runtime/realtime/{channel_name}");
  });

  it("runs deterministic broker, saga, cache, and realtime scenarios", async () => {
    const bundle = await loadComposition(resolve(example, "system.air.yaml"), resolve(example, "deployment.compose.yaml"));
    const suite = parseSystemVerificationSuite(await readFile(resolve(example, "verification.yaml"), "utf8"));
    const results = verifySystemSuite(bundle.system, bundle.applications, suite);
    expect(results.every((item) => item.passed)).toBe(true);
    expect(results[0]?.evidence.deliveries).toHaveLength(2);
    expect(results[0]?.evidence.correlationIds).toEqual(["00000000-0000-4000-8000-000000000100"]);
    expect(results[1]?.evidence.cache["orders.orderById"]).toBe("fallback");
  });

  it("discovers Spring messaging conservatively and emits review diagnostics", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-spring-"));
    await mkdir(resolve(directory, "src"));
    await writeFile(resolve(directory, "src", "Orders.java"), `
class Orders {
  @KafkaListener(topics = "orders.placed") void consume(String value) {}
  @RabbitListener(queues = "billing.capture") void task(String value) {}
  @Scheduled(cron = "0 * * * * *") void reconcile() {}
  void publish() { publisher.publishEvent(new OrderPlaced()); }
  IntegrationFlow flow = IntegrationFlow.from("input").handle(x -> x).get();
}
`, "utf8");
    const result = await importSpring(directory, { applicationName: "spring-orders" });
    expect(result.discoveries.map((item) => item.kind)).toEqual(expect.arrayContaining(["kafka-listener", "rabbit-listener", "scheduled-handler", "event-publisher", "integration-flow"]));
    expect(result.diagnostics.map((item) => item.code)).toContain("SPRING_INTEGRATION_FLOW_REVIEW");
    expect(result.document.apiVersion).toBe("air.dev/v0.9");
  });

  it("composes the mixed-language system through the public CLI", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-compose-"));
    const output = capture();
    expect(await runCli(["compose", resolve(example, "system.air.yaml"), "--deployment", resolve(example, "deployment.compose.yaml"), "--output", directory], output.io)).toBe(0);
    expect(output.stderr()).toBe("");
    expect(await readFile(resolve(directory, "compose.yaml"), "utf8")).toContain("inventoryWorker:");
    expect(await readFile(resolve(directory, "components/ordersApi/src/air/runtime.ts"), "utf8")).toContain("enqueueMessages");
    expect(await readFile(resolve(directory, "components/inventoryWorker/src/main.rs"), "utf8")).toContain("run_worker");
    expect(await readFile(resolve(directory, "components/billingService/air_runtime.py"), "utf8")).toContain("async def worker");
  });

  it("packs and verifies system-level evidence", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-system-evidence-"));
    const evidence = resolve(directory, "system.json");
    const pack = resolve(directory, "pack");
    const output = capture();
    expect(await runCli(["verify-system", resolve(example, "system.air.yaml"), "--scenarios", resolve(example, "verification.yaml"), "--output", evidence], output.io)).toBe(0);
    const parsed = JSON.parse(await readFile(evidence, "utf8")) as { format: string; system: { sha256: string }; suite: { sha256: string } };
    expect(parsed.format).toBe("air.dev/system-evidence/v0.2");
    expect(parsed.system.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.suite.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await runCli(["evidence-pack", "--artifact", `system=${evidence}`, "--output", pack], output.io)).toBe(0);
    expect(await runCli(["evidence-verify", pack], output.io)).toBe(0);
  });
});

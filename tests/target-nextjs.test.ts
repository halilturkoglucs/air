import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAirFile } from "@air/parser";
import {
  NextjsTargetAdapter,
  nextjsCapabilityManifest,
  planNextjs,
} from "@air/target-nextjs";

describe("Next.js target boundary", () => {
  it("declares platform capabilities without adding them to AIR", () => {
    expect(nextjsCapabilityManifest.capabilities["http.crud"].support).toBe("supported");
    expect(nextjsCapabilityManifest.capabilities["background.long-running"].support).toBe("supported");
    expect(nextjsCapabilityManifest.capabilities["messaging.consume"].support).toBe("supported");
    expect(nextjsCapabilityManifest.capabilities["deployment.vercel"].support).toBe("supported");
    expect(nextjsCapabilityManifest.capabilities["authorization.ownership"].support).toBe(
      "conditional",
    );
    expect(nextjsCapabilityManifest.capabilities["domain.invariants"].support).toBe(
      "conditional",
    );
    expect(nextjsCapabilityManifest.capabilities["domain.multi_effect"].support).toBe(
      "conditional",
    );
  });

  it("plans deterministic App Router output", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const first = planNextjs(air, { deployment: "vercel" });
    const second = planNextjs(air, { deployment: "vercel" });

    expect(first).toEqual(second);
    expect(first.map((file) => file.path)).toEqual(
      [...first.map((file) => file.path)].sort((left, right) => left.localeCompare(right)),
    );
    expect(first).toContainEqual(
      expect.objectContaining({ path: "src/app/todos/[id]/route.ts", kind: "source" }),
    );
    const dynamicRoute = first.find((file) => file.path === "src/app/todos/[id]/route.ts");
    expect(JSON.parse(first.find((file) => file.path === "package.json")?.content ?? "{}").type).toBe("module");
    expect(dynamicRoute?.content).toContain("params: Promise<{ readonly id: string }>");
    expect(dynamicRoute?.content).toContain("const { id } = await params");
    expect(first.find((file) => file.path === "src/app/air-runtime/health/route.ts")?.content).toContain(
      'status: "ok"',
    );
    expect(first.find((file) => file.path === "src/app/air-runtime/ready/route.ts")?.content).toContain(
      "checkDatabaseReady",
    );
    expect(first.find((file) => file.path === "src/air/runtime.ts")?.content).toContain(
      "AIR_ASYNC.realtime as Record<string",
    );
    expect(first.find((file) => file.path === "src/air/runtime.ts")?.content).toContain(
      "import.meta.url === pathToFileURL(process.argv[1]).href",
    );
    expect(first.find((file) => file.path === "src/air/migrate.ts")?.content).toContain(
      "0000_air_async_runtime.sql",
    );
  });

  it("hardens node deployments with a standalone container health check", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const files = planNextjs(air, { deployment: "node", packageManager: "pnpm" });
    const dockerfile = files.find((file) => file.path === "Dockerfile")?.content ?? "";
    const responses = files.find((file) => file.path === "src/http/responses.ts")?.content ?? "";

    expect(dockerfile).toContain("/air-runtime/health");
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
    expect(responses).toContain('event: "air.http.unhandled_error"');
  });

  it("generates a managed Next.js project with provenance", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const target = new NextjsTargetAdapter();
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "air-nextjs-test-"));
    const result = await target.compile({
      air,
      outputDirectory,
      mode: "managed",
      options: { deployment: "vercel", packageManager: "pnpm", database: "postgres" },
    });

    expect(result.status).toBe("success");
    expect(result.artifacts.length).toBeGreaterThan(15);
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        path: ".air/manifest.json",
        provenance: expect.objectContaining({ targetId: "nextjs", targetVersion: "0.10.0" }),
      }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({ path: ".air/lock.json", kind: "metadata" }),
    );
    const lock = JSON.parse(await readFile(resolve(outputDirectory, ".air/lock.json"), "utf8"));
    expect(lock.format).toBe("air.dev/compiler-lock/v0.1");
    expect(lock.source.apiVersion).toBe("air.dev/v0.2");
    expect(lock.target.options.deployment).toBe("vercel");
    expect(lock.dependencies.next).toBe("16.0.0");
    expect(await readFile(resolve(outputDirectory, "src/db/schema.ts"), "utf8")).toContain(
      'pgTable("todos"',
    );
    expect(await readFile(resolve(outputDirectory, "src/app/todos/route.ts"), "utf8")).toContain(
      "export async function POST",
    );
  });

  it("lowers v0.2 relationships into PostgreSQL foreign keys", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const schema = planNextjs(air).find((file) => file.path === "src/db/schema.ts");

    expect(schema?.content).toContain(
      '.references(() => customers.id, { onDelete: "restrict" })',
    );
    expect(schema?.content).toContain('id: uuid("id").defaultRandom().primaryKey()');
    expect(schema?.content).toContain('status: text("status").default("pending").notNull()');
  });

  it("lowers commands into transactional handlers with structured errors", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const files = planNextjs(air);
    const command = files.find((file) => file.path === "src/commands/place-order.ts");
    const route = files.find((file) => file.path === "src/app/orders/place/route.ts");
    const responses = files.find((file) => file.path === "src/http/responses.ts");

    expect(command?.content).toContain("getDb().transaction(async (tx)");
    expect(command?.content).toContain('throw new DomainError("CUSTOMER_NOT_FOUND"');
    expect(command?.content).toContain("customerId: input.customerId");
    expect(route?.content).toContain("parsePlaceOrderInput");
    expect(route?.content).toContain("await placeOrder(input, principal)");
    expect(responses?.content).toContain('code: "INVALID_INPUT"');
    expect(responses?.content).toContain("error instanceof DomainError");
  });

  it("lowers v0.4 state transitions and optimistic concurrency", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const files = planNextjs(air);
    const command = files.find((file) => file.path === "src/commands/mark-order-paid.ts");
    const route = files.find((file) => file.path === "src/app/orders/mark-paid/route.ts");

    expect(command?.content).toContain('isolationLevel: "serializable"');
    expect(command?.content).toContain('current.status !== "pending"');
    expect(command?.content).toContain("current.version !== input.expectedVersion");
    expect(command?.content).toContain("sql`${orders.version} + 1`");
    expect(command?.content).toContain('hasDatabaseErrorCode(error, "40001")');
    expect(command?.content).toContain('new DomainError("VERSION_CONFLICT"');
    expect(route?.content).toContain("parseMarkOrderPaidInput");
    expect(route?.content).toContain("await markOrderPaid(input, principal)");
  });

  it("lowers principals and ownership rules into authenticated command boundaries", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const files = planNextjs(air);
    const authentication = files.find((file) => file.path === "src/auth/principals.ts");
    const placeCommand = files.find((file) => file.path === "src/commands/place-order.ts");
    const placeRoute = files.find((file) => file.path === "src/app/orders/place/route.ts");
    const paidCommand = files.find((file) => file.path === "src/commands/mark-order-paid.ts");

    expect(authentication?.content).toContain("jwtVerify");
    expect(authentication?.content).toContain("AIR_AUTH_SECRET");
    expect(authentication?.content).toContain('typeof payload.exp !== "number"');
    expect(authentication?.content).toContain("parseCustomerPrincipal");
    expect(placeRoute?.content).toContain("authenticateCustomerPrincipal(request)");
    expect(placeRoute?.content).toContain('new DomainError("UNAUTHENTICATED"');
    expect(placeCommand?.content).toContain("input.customerId !== principal.customerId");
    expect(placeCommand?.content).toContain('new DomainError("FORBIDDEN"');
    expect(paidCommand?.content).toContain("current.customerId !== principal.customerId");
  });

  it("lowers v0.6 invariant trees into transactional domain checks", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const command = planNextjs(air).find((file) => file.path === "src/commands/place-order.ts");
    const content = command?.content ?? "";

    expect(content).toContain("input.total > 0");
    expect(content).toContain("input.total > principal.maximumOrderTotal");
    expect(content).toContain('new DomainError("ORDER_LIMIT_EXCEEDED"');
    expect(content.indexOf("ORDER_LIMIT_EXCEEDED")).toBeLessThan(content.indexOf(".insert("));
  });

  it("lowers v0.7 ledger transfers into locked atomic updates and idempotent replay", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const files = planNextjs(air);
    const command = files.find((file) => file.path === "src/commands/transfer-funds.ts");
    const errors = files.find((file) => file.path === "src/domain/errors.ts");
    const content = command?.content ?? "";

    expect(content).toContain('.for("update")');
    expect(content).toContain("recordDebitSource.balance");
    expect(content).toContain("${accounts.balance} - ${input.amount}");
    expect(content).toContain("${accounts.balance} + ${input.amount}");
    expect(content).toContain("const [replayed]");
    expect(content).toContain('hasDatabaseErrorCode(error, "23505")');
    expect(content).toContain("const maxAttempts = 3");
    expect(errors?.content).toContain('current = "cause" in current ? current.cause : undefined');
  });

  it("lowers v0.8 collections, CRUD authorization, and delete commands", async () => {
    const air = await loadAirFile(resolve("examples/library/air.yaml"));
    const files = planNextjs(air);
    const repository = files.find((file) => file.path === "src/repositories/document.ts")?.content ?? "";
    const listRoute = files.find((file) => file.path === "src/app/documents/route.ts")?.content ?? "";
    const command = files.find((file) => file.path === "src/commands/delete-document.ts")?.content ?? "";

    expect(repository).toContain(".limit(query.limit).offset(query.offset)");
    expect(repository).toContain("asc(documents.title)");
    expect(listRoute).toContain("authenticateOperatorPrincipal");
    expect(listRoute).toContain("parseDocumentStatusFilter");
    expect(command).toContain(".delete(documents)");
    expect(command).toContain('["admin"].includes(principal.role)');
  });

  it("refuses to overwrite a file it does not own", async () => {
    const air = await loadAirFile(resolve("examples/todo/air.yaml"));
    const target = new NextjsTargetAdapter();
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "air-nextjs-conflict-"));
    await writeFile(resolve(outputDirectory, "package.json"), '{"private":false}\n', "utf8");

    const result = await target.compile({
      air,
      outputDirectory,
      mode: "managed",
      options: {},
    });

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AIR_OUTPUT_CONFLICT" }),
    );
    expect(await readFile(resolve(outputDirectory, "package.json"), "utf8")).toBe(
      '{"private":false}\n',
    );
  });
});

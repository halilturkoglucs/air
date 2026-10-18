import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptExtractedCapability, discoverSpring, evidenceHash, extractCapability, ingestEvidence, readDiscoveryBundle, saveDecision, startWorkbench, verifyImportedCapability, writeDiscoveryBundle } from "@air/discovery";
import { parseAir, parseSystem } from "@air/parser";

async function springFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "air-enterprise-spring-"));
  await mkdir(resolve(root, "orders", "src", "main", "java", "example"), { recursive: true });
  await writeFile(resolve(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>estate</artifactId><version>1</version><modules><module>orders</module></modules></project>\n", "utf8");
  await writeFile(resolve(root, "orders", "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><artifactId>orders</artifactId></project>\n", "utf8");
  await writeFile(resolve(root, "orders", "src", "main", "java", "example", "Orders.java"), `package example;
interface Routes { String API = "/api"; }
@RestController
@RequestMapping(Routes.API)
class OrdersController {
  private final WebClient vendor;
  private final PricingService pricingService;
  @PostMapping(
    value = "/orders",
    produces = "application/json"
  )
  @Transactional
  @PreAuthorize("hasRole('BUYER')")
  OrderResponse place(OrderRequest request) { pricingService.quote(request); publisher.publishEvent(request); return null; }
  @KafkaListener(topics = "orders.placed") void consume(String message) {}
  @RabbitListener(queues = "billing.capture") void capture(String message) {}
  @Scheduled(cron = "0 * * * * *") void reconcile() {}
  @Cacheable(cacheNames = "orders") OrderResponse read(String id) { return null; }
}
record OrderRequest(String sku) {}
record OrderResponse(String id) {}
@Entity class OrderEntity { String id; }
@Repository interface OrdersRepository extends JpaRepository<OrderEntity, String> {
  @Query("select o from OrderEntity o") Object custom();
}
@Mapper interface OrderMapper {}
@FeignClient(name = "payments", url = "\${PAYMENTS_URL}") interface PaymentsClient {}
@Service class PricingService { Object quote(Object request) { return null; } }
@Configuration class OrdersConfiguration {
  @Bean Object systemClock() { return new Object(); }
}
class DynamicRouter { Object route(String type) { return context.getBean(type); } }
`, "utf8");
  await writeFile(resolve(root, "orders", "src", "main", "resources", "application.yml"), "spring:\n  application:\n    name: orders\n", { encoding: "utf8", flag: "w" }).catch(async () => {
    await mkdir(resolve(root, "orders", "src", "main", "resources"), { recursive: true });
    await writeFile(resolve(root, "orders", "src", "main", "resources", "application.yml"), "spring:\n  application:\n    name: orders\n", "utf8");
  });
  return root;
}

describe("enterprise discovery and modernization", () => {
  it("validates v0.10 ports, failures, transformations, and ordered invocations", () => {
    const document = parseAir(`
apiVersion: air.dev/v0.10
kind: Application
metadata: { name: port-example }
spec:
  entities:
    InvocationAudit:
      fields:
        id: { type: uuid, primaryKey: true, generated: uuid }
        payload: { type: json }
  contracts:
    VendorInput:
      fields: { payload: { type: json, required: true } }
    VendorOutput:
      fields: { payload: { type: json, required: true } }
  ports:
    paymentGateway:
      operations:
        charge:
          input: VendorInput
          output: VendorOutput
          failures:
            unavailable: { retryable: true }
          timeoutMs: 2000
          idempotency: caller-key
  transformations:
    toCharge:
      input: VendorInput
      output: VendorInput
      steps:
        - { kind: project, fields: [payload] }
    auditToCharge:
      input: InvocationAudit
      output: VendorInput
      steps:
        - { kind: project, fields: [payload] }
  commands:
    recordAndCharge:
      input: VendorInput
      output: { entity: InvocationAudit, fields: [id, payload] }
      errors:
        vendorUnavailable: { status: 503, message: Vendor unavailable, retryable: true }
      invocations:
        - id: chargeVendor
          port: paymentGateway
          operation: charge
          order: 1
          input: { from: input, transformation: toCharge }
          retry: { maxAttempts: 3, backoff: exponential }
          errorMapping: { unavailable: vendorUnavailable }
      effect:
        kind: create
        entity: InvocationAudit
        values: { payload: { input: payload } }
`);
    expect(document.spec.ports?.paymentGateway?.operations.charge?.failures.unavailable?.retryable).toBe(true);
  });

  it("builds a provenance-complete graph with broad Spring recall", async () => {
    const root = await springFixture();
    const result = await discoverSpring(root, { analyzer: "source" });
    const kinds = new Set(result.bundle.nodes.map((node) => node.kind));
    const expected = ["module", "service", "endpoint", "contract", "entity", "repository", "query", "transaction", "security", "listener", "publisher", "schedule", "cache", "vendor-call", "mapper", "dynamic-routing", "configuration"];
    expect(expected.filter((kind) => kinds.has(kind as never)).length / expected.length).toBeGreaterThanOrEqual(0.95);
    const annotationFalsePositives = result.bundle.nodes.filter((node) => ["PostMapping", "PreAuthorize", "Transactional", "KafkaListener", "RabbitListener", "Scheduled", "Cacheable"].includes(node.name));
    expect(annotationFalsePositives.length / result.bundle.nodes.length).toBeLessThan(0.05);
    const endpoint = result.bundle.nodes.find((node) => node.kind === "endpoint" && node.name === "place");
    expect(endpoint?.attributes).toMatchObject({ method: "POST", path: "/api/orders" });
    expect(result.bundle.nodes.some((node) => node.kind === "service" && node.name === "PricingService" && node.attributes.role === "service")).toBe(true);
    const pricing = result.bundle.nodes.find((node) => node.kind === "service" && node.name === "PricingService");
    expect(result.bundle.edges.some((edge) => edge.kind === "calls" && edge.from === endpoint?.id && edge.to === pricing?.id)).toBe(true);
    expect(result.bundle.nodes.some((node) => node.kind === "configuration" && node.name === "OrdersConfiguration" && node.attributes.role === "configuration-class")).toBe(true);
    expect(result.bundle.nodes.some((node) => node.kind === "configuration" && node.name === "systemClock" && node.attributes.role === "bean")).toBe(true);
    expect(result.bundle.nodes.every((node) => node.sources.length > 0 && node.sources.every((source) => source.contentHash.length === 64))).toBe(true);
    expect(result.bundle.nodes.filter((node) => node.kind === "dynamic-routing").every((node) => node.confidence === "opaque")).toBe(true);
  });

  it("keeps ambiguous route constants review-required instead of inventing a path", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-ambiguous-route-"));
    await mkdir(resolve(root, "src", "main", "java", "example"), { recursive: true });
    await writeFile(resolve(root, "src", "main", "java", "example", "AmbiguousController.java"), `package example;
class FirstRoutes { static final String API = "/one"; }
class SecondRoutes { static final String API = "/two"; }
@RestController
@RequestMapping(API)
class AmbiguousController {
  @GetMapping("/items") Object list() { return null; }
}
`, "utf8");
    const result = await discoverSpring(root, { analyzer: "source" });
    const endpoint = result.bundle.nodes.find((node) => node.kind === "endpoint" && node.name === "list");
    expect(endpoint?.confidence).toBe("inferred");
    expect(endpoint?.attributes.path).toBeUndefined();
    expect(endpoint?.attributes.pathExpression).toBe('API + "/items"');
  });

  it("rejects unknown fields in discovery documents", async () => {
    const root = await springFixture();
    const result = await discoverSpring(root, { analyzer: "source" });
    const node = result.bundle.nodes[0]!;
    const invalid = { ...result.bundle, nodes: [{ ...node, inventedSemantic: true }] } as unknown as typeof result.bundle;
    await expect(writeDiscoveryBundle(await mkdtemp(resolve(tmpdir(), "air-closed-discovery-")), invalid)).rejects.toThrow("additional properties");
    const danglingEvidence = { ...result.bundle, evidence: [{ id: "evidence:dangling", kind: "trace" as const, observedAt: new Date().toISOString(), source: "trace.json", nodeIds: ["node:missing"], attributes: {}, redacted: true }] };
    await expect(writeDiscoveryBundle(await mkdtemp(resolve(tmpdir(), "air-dangling-discovery-")), danglingEvidence)).rejects.toThrow("references unknown node");
  });

  it("retains stable IDs, invalidates stale decisions, and rebuilds SQLite", async () => {
    const root = await springFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "air-discovery-bundle-"));
    const first = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, first.bundle);
    const endpoint = first.bundle.nodes.find((node) => node.kind === "endpoint")!;
    await saveDecision(directory, { subjectId: endpoint.id, action: "approve", evidenceHash: evidenceHash(endpoint.sources), decidedAt: new Date().toISOString() });
    const second = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, second.bundle);
    expect((await readDiscoveryBundle(directory)).decisions[0]?.invalidated).not.toBe(true);
    const sourcePath = resolve(root, endpoint.sources[0]!.path);
    await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n// changed evidence\n`, "utf8");
    const third = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, third.bundle);
    const loaded = await readDiscoveryBundle(directory);
    expect(loaded.nodes.find((node) => node.kind === "endpoint")?.id).toBe(endpoint.id);
    expect(loaded.decisions[0]?.invalidated).toBe(true);
    expect((await readFile(resolve(directory, "index.sqlite"))).length).toBeGreaterThan(100);
  });

  it("redacts evidence and blocks extraction until observable boundaries are reviewed", async () => {
    const root = await springFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "air-discovery-evidence-"));
    const output = await mkdtemp(resolve(tmpdir(), "air-capability-parent-"));
    const result = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, result.bundle);
    const endpoint = result.bundle.nodes.find((node) => node.kind === "endpoint")!;
    const evidencePath = resolve(directory, "trace.json");
    await writeFile(evidencePath, JSON.stringify({ name: endpoint.name, traceId: "trace-1", spanId: "span-1", attributes: { "code.function.name": endpoint.name, "http.route": "/orders", "http.request.header.authorization": "Bearer secret", "request.payload": "personal", "db.statement": "select * from users where email='private@example.com'", "user.first_name": "Private" } }), "utf8");
    await ingestEvidence(evidencePath, directory);
    const loaded = await readDiscoveryBundle(directory);
    expect(JSON.stringify(loaded.evidence)).not.toContain("Bearer secret");
    expect(JSON.stringify(loaded.evidence)).not.toContain("personal");
    expect(JSON.stringify(loaded.evidence)).not.toContain("private@example.com");
    expect(JSON.stringify(loaded.evidence)).not.toContain('"Private"');
    expect((await extractCapability(directory, endpoint.id, resolve(output, "blocked"))).blockers.length).toBeGreaterThan(0);
    const selectedIds = new Set([endpoint.id, ...loaded.edges.filter((edge) => edge.from === endpoint.id).map((edge) => edge.to)]);
    for (const node of loaded.nodes.filter((candidate) => selectedIds.has(candidate.id))) {
      await saveDecision(directory, { subjectId: node.id, action: node.confidence === "opaque" ? "mark-opaque" : "approve", evidenceHash: evidenceHash(node.sources), decidedAt: new Date().toISOString() });
    }
    const extracted = await extractCapability(directory, endpoint.id, resolve(output, "accepted"));
    expect(extracted.blockers).toEqual([]);
    const extractedSource = await readFile(resolve(extracted.output, "air.yaml"), "utf8");
    expect(parseAir(extractedSource).apiVersion).toBe("air.dev/v0.10");
    expect(parseSystem(await readFile(resolve(extracted.output, "system.yaml"), "utf8")).apiVersion).toBe("air.dev/system/v0.2");
  });

  it("serves the local workbench and records reviewed decisions", async () => {
    const root = await springFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "air-workbench-"));
    const result = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, result.bundle);
    const workbench = await startWorkbench(directory, { port: 0 });
    try {
      expect(await fetch(workbench.url).then((response) => response.text())).toContain("AIR Discovery Workbench");
      const endpoint = result.bundle.nodes.find((node) => node.kind === "endpoint")!;
      expect((await fetch(`${workbench.url}/api/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subjectId: endpoint.id, action: "approve" }) })).status).toBe(204);
      expect((await readDiscoveryBundle(directory)).decisions[0]?.action).toBe("approve");
    } finally { await new Promise<void>((done) => workbench.server.close(() => done())); }
  });

  it("records legacy/candidate HTTP equivalence in verification v0.3", async () => {
    const capability = await mkdtemp(resolve(tmpdir(), "air-verify-import-"));
    await writeFile(resolve(capability, "capability.json"), `${JSON.stringify({ apiVersion: "air.dev/capability/v0.1", kind: "ExtractedCapability", capabilityId: "endpoint:orders", discoveryRepositoryHash: "b".repeat(64), evidenceHash: "a".repeat(64), nodes: ["endpoint:orders"], blockers: [], adopted: false }, null, 2)}\n`, "utf8");
    await writeFile(resolve(capability, "verification.yaml"), "apiVersion: air.dev/verification/v0.3\nkind: ImportVerificationSuite\nmetadata: { name: smoke }\nspec:\n  capability: orders\n  scenarios:\n    - id: baseline\n      request: { method: POST, path: /orders, body: { sku: one } }\n      compare: { status: true, body: json, headers: [] }\n      observations: { database: [orders], messages: [orders.placed], outbound: [payments.charge] }\n", "utf8");
    const server = createServer((request, response) => {
      response.writeHead(request.url?.startsWith("/_air/observations/") ? 200 : 201, { "content-type": "application/json" });
      response.end(request.url?.startsWith("/_air/observations/") ? '{"database":{"orders":[{"id":"1"}]},"messages":{"orders.placed":[{"id":"m1"}]},"outbound":{"payments.charge":[{"status":200}]}}' : '{"id":"1"}');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address(); const url = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
    try {
      await expect(adoptExtractedCapability(capability)).rejects.toThrow("run air verify-import");
      const result = await verifyImportedCapability(capability, url, url);
      expect(result.passed).toBe(true);
      expect(result.report.apiVersion).toBe("air.dev/verification-result/v0.3");
      expect(result.report).toMatchObject({ capabilityId: "endpoint:orders", evidenceHash: "a".repeat(64) });
      expect(JSON.stringify(result.report)).not.toContain('"m1"');
      expect(JSON.stringify(result.report)).toContain("sha256");
      expect(await adoptExtractedCapability(capability)).toBe(resolve(capability, "adoption.json"));
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});

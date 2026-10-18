import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptExtractedCapability, createDiscoveryReport, discoverSpring, evidenceHash, extractCapability, ingestEvidence, readDiscoveryBundle, saveDecision, startWorkbench, verifyImportedCapability, writeDiscoveryBundle, writeDiscoveryReport } from "@air/discovery";
import { runCli, type CliIo } from "@halilturkoglucs/air";
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
  private final ApplicationEventPublisher publisher;
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

  it("joins checked-in OpenAPI contracts to generated-interface implementations", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-openapi-spring-"));
    const source = resolve(root, "src", "main");
    await mkdir(resolve(source, "java", "example"), { recursive: true });
    await mkdir(resolve(source, "resources"), { recursive: true });
    await writeFile(resolve(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>api-first</artifactId><version>1</version></project>\n", "utf8");
    await writeFile(resolve(source, "resources", "application.properties"), "server.servlet.context-path=/petclinic\n", "utf8");
    await writeFile(resolve(source, "resources", "openapi.yml"), `openapi: 3.1.0
servers:
  - url: http://localhost:9966/petclinic/api
paths:
  /owners/{ownerId}:
    get:
      operationId: getOwner
      responses: { "200": { description: ok } }
  /missing:
    get:
      operationId: missingOperation
      responses: { "200": { description: ok } }
`, "utf8");
    await writeFile(resolve(source, "java", "example", "OwnerController.java"), `package example;
@RestController
class OwnerController implements OwnersApi {
  public OwnerResponse getOwner(Integer ownerId) { return null; }
}
@Service class OwnerService { public Object getOwner(Integer ownerId) { return null; } }
`, "utf8");
    await writeFile(resolve(source, "java", "example", "NestedAnnotations.java"), `package example;
@Entity
@Table(uniqueConstraints = @UniqueConstraint(columnNames = {"username", "role"}))
class Role {}
/** Base class for persisted records. */
@MappedSuperclass
public class BaseRecord {}
@Configuration
@EnableMethodSecurity // a comment between annotations must not hide @Configuration
@ConditionalOnProperty(name = "security.enabled", havingValue = "true")
class SecurityConfiguration {}
`, "utf8");

    const result = await discoverSpring(root, { analyzer: "source" });
    const owner = result.bundle.nodes.find((node) => node.kind === "endpoint" && node.name === "getOwner");
    expect(owner).toMatchObject({ confidence: "proven", attributes: { method: "GET", path: "/api/owners/{ownerId}", operationId: "getOwner" } });
    expect(owner?.sources.map((item) => item.path).sort()).toEqual([
      "src/main/java/example/OwnerController.java",
      "src/main/resources/openapi.yml",
    ]);
    const missing = result.bundle.nodes.find((node) => node.kind === "endpoint" && node.name === "missingOperation");
    expect(missing).toMatchObject({ confidence: "inferred", attributes: { method: "GET", path: "/api/missing", implementationMatches: 0 } });
    expect(missing?.diagnostics).toContain("OpenAPI operation has no uniquely attributed source implementation.");
    expect(result.bundle.nodes.find((node) => node.kind === "entity" && node.name === "Role")?.attributes.role).toBe("entity");
    expect(result.bundle.nodes.find((node) => node.kind === "entity" && node.name === "BaseRecord")?.attributes.role).toBe("mapped-superclass");
    expect(result.bundle.nodes.find((node) => node.kind === "configuration" && node.name === "SecurityConfiguration")?.attributes).toMatchObject({ role: "configuration-class", condition: { property: "security.enabled", havingValue: "true" } });
  });

  it("separates test code and models annotated records, GraphQL, and profile publisher adapters", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-spring-precision-"));
    const main = resolve(root, "src", "main", "java", "example");
    const test = resolve(root, "src", "test", "java", "example");
    const testResources = resolve(root, "src", "test", "resources");
    await mkdir(main, { recursive: true });
    await mkdir(test, { recursive: true });
    await mkdir(testResources, { recursive: true });
    await writeFile(resolve(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>precision</artifactId><version>1</version></project>\n", "utf8");
    await writeFile(resolve(main, "SubmitClaimRequest.java"), `package example;
record SubmitClaimRequest(
  @NotBlank String policyNumber,
  @Size(max = 2000) String description,
  @DecimalMin(value = "0.0", inclusive = false) BigDecimal amount) {}
`, "utf8");
    await writeFile(resolve(main, "ClaimGraphqlController.java"), `package example;
@Controller class ClaimGraphqlController {
  private final ClaimService service;
  @QueryMapping ClaimResponse claim(Long id) { return service.getById(id); }
  @QueryMapping("claims") Object allClaims() { return service.list(); }
}
@Service class ClaimService { Object getById(Long id) { return null; } Object list() { return null; } }
record ClaimResponse(Long id) {}
`, "utf8");
    await writeFile(resolve(main, "EventPublisher.java"), "package example; public interface EventPublisher { void publish(Object event); }\n", "utf8");
    await writeFile(resolve(main, "KafkaEventPublisher.java"), `package example;
@Component @Profile("kafka") class KafkaEventPublisher implements EventPublisher {
  private final KafkaTemplate<String, Object> kafkaTemplate;
  public void publish(Object event) { kafkaTemplate.send("claims", event); }
}
`, "utf8");
    await writeFile(resolve(main, "LocalEventPublisher.java"), `package example;
@Component @Profile("!kafka") class LocalEventPublisher implements EventPublisher {
  private final ApplicationEventPublisher delegate;
  public void publish(Object event) { delegate.publishEvent(event); }
}
`, "utf8");
    await writeFile(resolve(main, "KafkaTopics.java"), "package example; /** Deterministic event-to-topic routing. */ class KafkaTopics {}\n", "utf8");
    await writeFile(resolve(test, "LocalEventListenerTest.java"), `package example;
class LocalEventListenerTest {
  private final ApplicationEventPublisher publisher;
  void emitsOnlyTestEvidence() { publisher.publishEvent("test"); }
}
`, "utf8");
    await writeFile(resolve(testResources, "application-test.yml"), "spring:\n  kafka:\n    bootstrap-servers: test-only\n", "utf8");

    const result = await discoverSpring(root, { analyzer: "source" });
    const request = result.bundle.nodes.find((node) => node.kind === "contract" && node.name === "SubmitClaimRequest");
    expect(request?.attributes.fields).toEqual(["policyNumber", "description", "amount"]);
    expect(request?.attributes.validation).toEqual(["NotBlank", "Size", "DecimalMin"]);
    const graphql = result.bundle.nodes.filter((node) => node.kind === "endpoint" && node.attributes.protocol === "graphql");
    expect(graphql).toHaveLength(2);
    expect(graphql.map((node) => node.attributes.field).sort()).toEqual(["claim", "claims"]);
    expect(graphql.every((node) => node.attributes.path === "/graphql" && node.observable)).toBe(true);
    const publisherAdapters = result.bundle.nodes.filter((node) => node.kind === "publisher" && node.attributes.role === "publisher-adapter");
    expect(publisherAdapters).toHaveLength(2);
    expect(publisherAdapters.map((node) => node.attributes.transport).sort()).toEqual(["kafka", "spring-event"]);
    expect(publisherAdapters.map((node) => node.attributes.profiles).sort()).toEqual([["!kafka"], ["kafka"]]);
    expect(result.bundle.nodes.filter((node) => node.kind === "publisher" && node.attributes.role === "publish-operation")).toHaveLength(0);
    expect(result.bundle.nodes.some((node) => node.sources.some((source) => source.path.includes("src/test/")))).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SPRING_DYNAMIC_ROUTING")).toBe(false);
    const contract = result.bundle.nodes.find((node) => node.kind === "publisher" && node.attributes.role === "publisher-contract");
    expect(publisherAdapters.every((adapter) => result.bundle.edges.some((edge) => edge.kind === "calls" && edge.from === contract?.id && edge.to === adapter.id))).toBe(true);
  });

  it.skipIf(!existsSync(resolve("packages/discovery/spring-analyzer/target/air-spring-analyzer.jar")))("runs the pinned OpenRewrite fixture through discovery", async () => {
    const root = resolve("packages/discovery/spring-analyzer/src/test/resources/fixture");
    const result = await discoverSpring(root, { analyzer: "openrewrite" });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.bundle.manifest.metadata).toMatchObject({ analyzer: "spring-openrewrite", analyzerVersion: "8.90.4" });
    expect(result.bundle.nodes.find((node) => node.kind === "endpoint" && node.name === "place")?.attributes).toMatchObject({ analyzer: "openrewrite", analyzerVersion: "8.90.4" });
    expect(result.bundle.nodes.find((node) => node.kind === "listener" && node.name === "consume")?.attributes).toMatchObject({ analyzer: "openrewrite", analyzerVersion: "8.90.4" });
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
    await expect(saveDecision(directory, { subjectId: endpoint.id, action: "mark-opaque", evidenceHash: evidenceHash(endpoint.sources), decidedAt: new Date().toISOString(), reviewer: "test-reviewer" })).rejects.toThrow("reason");
    await saveDecision(directory, { subjectId: endpoint.id, action: "approve", evidenceHash: evidenceHash(endpoint.sources), decidedAt: new Date().toISOString(), reviewer: "test-reviewer" });
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
      await saveDecision(directory, { subjectId: node.id, action: node.confidence === "opaque" ? "mark-opaque" : "approve", ...(node.confidence === "opaque" ? { reason: "Retain as a typed foreign boundary in this fixture." } : {}), evidenceHash: evidenceHash(node.sources), decidedAt: new Date().toISOString(), reviewer: "test-reviewer" });
    }
    const extracted = await extractCapability(directory, endpoint.id, resolve(output, "accepted"));
    expect(extracted.blockers).toEqual([]);
    const extractedSource = await readFile(resolve(extracted.output, "air.yaml"), "utf8");
    expect(parseAir(extractedSource).apiVersion).toBe("air.dev/v0.10");
    expect(parseSystem(await readFile(resolve(extracted.output, "system.yaml"), "utf8")).apiVersion).toBe("air.dev/system/v0.2");
  });

  it("serves safe source excerpts and records attributable review decisions", async () => {
    const root = await springFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "air-workbench-"));
    const result = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, result.bundle);
    const workbench = await startWorkbench(directory, { port: 0, reviewer: "pilot-reviewer" });
    try {
      expect(await fetch(workbench.url).then((response) => response.text())).toContain("AIR Discovery Workbench");
      const endpoint = result.bundle.nodes.find((node) => node.kind === "endpoint")!;
      const rejected = await fetch(`${workbench.url}/api/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subjectId: endpoint.id, action: "reject" }) });
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("requires a reason");
      const excerpt = await fetch(`${workbench.url}/api/source?nodeId=${encodeURIComponent(endpoint.id)}&sourceIndex=0`);
      expect(excerpt.status).toBe(200);
      expect(await excerpt.json()).toMatchObject({ path: endpoint.sources[0]!.path, contentHash: endpoint.sources[0]!.contentHash });
      expect((await fetch(`${workbench.url}/api/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subjectId: endpoint.id, action: "approve" }) })).status).toBe(204);
      expect((await readDiscoveryBundle(directory)).decisions[0]).toMatchObject({ action: "approve", reviewer: "pilot-reviewer" });
      await writeFile(resolve(root, endpoint.sources[0]!.path), "changed after discovery\n", "utf8");
      expect((await fetch(`${workbench.url}/api/source?nodeId=${encodeURIComponent(endpoint.id)}&sourceIndex=0`)).status).toBe(400);
    } finally { await new Promise<void>((done) => workbench.server.close(() => done())); }
  });

  it("exports deterministic, schema-validated reports without source or payload contents", async () => {
    const root = await springFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "air-discovery-report-bundle-"));
    const output = await mkdtemp(resolve(tmpdir(), "air-discovery-report-output-"));
    const result = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, result.bundle);
    const report = createDiscoveryReport(result.bundle);
    expect(report.apiVersion).toBe("air.dev/discovery-report/v0.1");
    expect(report.summary.entryPoints).toBeGreaterThan(0);
    expect(report.topology.every((edge) => edge.provenance.length > 0)).toBe(true);
    const first = await writeDiscoveryReport(directory, output);
    const firstJson = await readFile(first.json, "utf8");
    const firstHtml = await readFile(first.html, "utf8");
    const second = await writeDiscoveryReport(directory, output);
    expect(await readFile(second.json, "utf8")).toBe(firstJson);
    expect(await readFile(second.html, "utf8")).toBe(firstHtml);
    expect(firstJson).not.toContain("class OrdersController");
    expect(firstHtml).not.toContain("class OrdersController");
    expect(firstHtml).toContain("Source contents and runtime payloads are not embedded");
    const cliOutput = await mkdtemp(resolve(tmpdir(), "air-discovery-report-cli-"));
    let stdout = ""; let stderr = "";
    const io: CliIo = { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } };
    expect(await runCli(["discovery", "report", directory, "--output", cliOutput], io)).toBe(0);
    expect(stdout).toContain("Discovery report:");
    expect(stderr).toBe("");
    expect(JSON.parse(await readFile(resolve(cliOutput, "report.json"), "utf8"))).toMatchObject({ apiVersion: "air.dev/discovery-report/v0.1" });
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

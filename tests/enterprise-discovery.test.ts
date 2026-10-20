import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptExtractedCapability, canonicalEvidenceIdentities, createCheckBaseline, createDiscoveryReport, discoverSpring, evidenceHash, extractCapability, ingestEvidence, normalizeHttpRoute, parseCheckBaseline, parseCheckDocument, parseCheckPolicy, parseCheckTarget, parseEvidenceCaptureProfile, readDiscoveryBundle, runMigrationCheck, saveDecision, startWorkbench, validateMigrationCheck, verifyImportedCapability, writeDiscoveryBundle, writeDiscoveryReport } from "@air/discovery";
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
  private final PaymentsClient paymentsClient;
  private final InventoryClient inventoryClient;
  private final ApplicationEventPublisher publisher;
  @PostMapping(
    value = "/orders",
    produces = "application/json"
  )
  @Transactional
  @PreAuthorize("hasRole('BUYER')")
  OrderResponse place(OrderRequest request) { pricingService.quote(request); VendorInput vendorInput = new VendorInput(request.sku()); paymentsClient.charge(vendorInput); inventoryClient.reserve(request.sku()); publisher.publishEvent(request); return null; }
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
@FeignClient(name = "payments", url = "\${PAYMENTS_URL}") interface PaymentsClient {
  @PostMapping("/charge") VendorOutput charge(VendorInput input);
}
record VendorInput(String sku) {}
record VendorOutput(String approvalId) {}
@FeignClient(name = "inventory", url = "\${INVENTORY_URL}") interface InventoryClient {
  @PostMapping("/reserve/{sku}") void reserve(@PathVariable String sku);
}
@Service class PricingService { Object quote(Object request) { return null; } }
@Service class SnapshotCache {
  private final Cache<String, Object> cache = Caffeine.newBuilder().build();
  @TransactionalEventListener void invalidate(OrderChangedEvent event) { cache.invalidate(event.id()); }
}
record OrderChangedEvent(String id) {}
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
  it("normalizes adversarial route strings in linear time", () => {
    expect(normalizeHttpRoute(`${"/".repeat(20_000)}orders${"/".repeat(20_000)}?secret=value`)).toBe("/orders");
  });

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
    expect(result.bundle.nodes.find((node) => node.kind === "cache" && node.name === "SnapshotCache")?.attributes).toMatchObject({ provider: "caffeine", role: "programmatic-cache", invalidation: true });
    expect(result.bundle.nodes.find((node) => node.kind === "listener" && node.name === "invalidate")?.attributes).toMatchObject({ transport: "spring-event", destination: "OrderChangedEvent", transactional: true, phase: "AFTER_COMMIT" });
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

  it("discovers externally selected Runnable tasks and excludes custom test source sets", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-runnable-task-"));
    const main = resolve(root, "src", "main", "java", "example");
    const functional = resolve(root, "src", "functionalTest", "java", "example");
    await mkdir(main, { recursive: true }); await mkdir(functional, { recursive: true });
    await writeFile(resolve(root, "build.gradle"), "group = 'example'\nversion = '1'\n", "utf8");
    await writeFile(resolve(main, "DeletionTask.java"), `package example;
@Service class DeletionTask implements Runnable {
  private final StoredDocumentService storedDocumentService;
  public void run() { storedDocumentService.deleteAll(); }
}
@Service class StoredDocumentService { void deleteAll() {} }
`, "utf8");
    await writeFile(resolve(functional, "TestOnlyController.java"), "package example; @RestController class TestOnlyController { @GetMapping(\"/test-only\") Object testOnly(){ return null; } }\n", "utf8");
    const result = await discoverSpring(root, { analyzer: "source" });
    const task = result.bundle.nodes.find((node) => node.kind === "operation" && node.name === "DeletionTask");
    const service = result.bundle.nodes.find((node) => node.kind === "service" && node.name === "DeletionTask");
    expect(task?.attributes).toMatchObject({ role: "runnable-task", entryPoint: true, selector: "deletionTask" });
    expect(result.bundle.edges.some((edge) => edge.kind === "calls" && edge.from === task?.id && edge.to === service?.id)).toBe(true);
    expect(result.bundle.nodes.some((node) => node.sources.some((source) => source.path.includes("functionalTest")))).toBe(false);
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
    await writeFile(evidencePath, JSON.stringify([
      { name: endpoint.name, traceId: "trace-1", spanId: "span-1", attributes: { "code.function.name": endpoint.name, "http.route": "/orders", "http.request.header.authorization": "Bearer secret", "request.payload": "personal", "db.statement": "select * from users where email='private@example.com'", "user.first_name": "Private" } },
      { name: "payments charge", kind: "outbound-call", attributes: { "air.identity": "outbound:payments:POST:/charge", "air.invocation.order": 1, "air.failure.name": "requestFailed", "air.failure.retryable": false, "air.failure.description": "Observed client exception on a rejected payment response." } },
      { name: "inventory reserve", kind: "outbound-call", attributes: { "air.identity": "outbound:inventory:POST:/reserve/{sku}", "air.invocation.order": 2, "air.failure.name": "requestFailed", "air.failure.retryable": false, "air.failure.description": "Observed client exception on a rejected inventory response." } },
    ]), "utf8");
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
    const extractedAir = parseAir(extractedSource);
    expect(extractedAir.apiVersion).toBe("air.dev/v0.10");
    expect(extractedSource).not.toContain("ImportedInput");
    expect(extractedSource).not.toContain("ImportedOutput");
    expect(extractedSource).not.toContain("timeoutMs: 5000");
    expect(extractedSource).not.toContain("maxAttempts: 3");
    expect(extractedSource).not.toContain("The reviewed HTTP client operation failed");
    expect(extractedAir.spec.ports?.payments?.operations.charge?.input).toBe("PaymentsClientChargeInput");
    expect(extractedAir.spec.ports?.payments?.operations.charge?.failures.requestfailed?.retryable).toBe(false);
    expect(parseSystem(await readFile(resolve(extracted.output, "system.yaml"), "utf8")).apiVersion).toBe("air.dev/system/v0.2");
  });

  it("blocks extraction when exact outbound observations are reordered or lack failure evidence", async () => {
    const root = await springFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "air-evidence-ordering-"));
    const output = await mkdtemp(resolve(tmpdir(), "air-evidence-ordering-output-"));
    const result = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, result.bundle);
    const endpoint = result.bundle.nodes.find((node) => node.kind === "endpoint" && node.name === "place")!;
    for (const node of result.bundle.nodes) {
      await saveDecision(directory, { subjectId: node.id, action: node.confidence === "opaque" ? "mark-opaque" : "approve", ...(node.confidence === "opaque" ? { reason: "Retain as a typed foreign boundary in this fixture." } : {}), evidenceHash: evidenceHash(node.sources), decidedAt: new Date().toISOString(), reviewer: "test-reviewer" });
    }
    const reordered = resolve(directory, "reordered.json");
    await writeFile(reordered, JSON.stringify([
      { name: "payments charge", kind: "outbound-call", attributes: { "air.identity": "outbound:payments:POST:/charge", "air.invocation.order": 2, "air.failure.name": "requestFailed", "air.failure.retryable": false } },
      { name: "inventory reserve", kind: "outbound-call", attributes: { "air.identity": "outbound:inventory:POST:/reserve/{sku}", "air.invocation.order": 1 } },
    ]), "utf8");
    await ingestEvidence(reordered, directory);
    const extraction = await extractCapability(directory, endpoint.id, resolve(output, "blocked"));
    expect(extraction.blockers).toContain("inventory.reserve: exact failure behavior and retryability evidence are missing");
    expect(extraction.blockers.some((blocker) => blocker.includes("observation order differs"))).toBe(true);
  });

  it("matches runtime evidence only through exact canonical identities", async () => {
    const root = await springFixture();
    const migrations = resolve(root, "orders", "src", "main", "resources", "db", "migration");
    await mkdir(migrations, { recursive: true });
    await writeFile(resolve(migrations, "V1__orders.sql"), "CREATE TABLE public.order_entity (id uuid primary key);\n", "utf8");
    const directory = await mkdtemp(resolve(tmpdir(), "air-exact-evidence-"));
    const result = await discoverSpring(root, { analyzer: "source" });
    await writeDiscoveryBundle(directory, result.bundle);
    const input = resolve(directory, "exact.jsonl");
    await writeFile(input, `${JSON.stringify({ name: "exact", traceId: "t1", attributes: { "http.request.method": "POST", "http.route": "/api/orders" } })}\n${JSON.stringify({ name: "substring", traceId: "t2", attributes: { "http.request.method": "POST", "http.route": "/api/orders/archive" } })}\n${JSON.stringify({ name: "database", kind: "database-change", attributes: { "db.system": "postgresql", "db.namespace": "public", "db.sql.table": "order_entity", "db.operation.name": "*" } })}\n`, "utf8");
    const ingested = await ingestEvidence(input, directory);
    expect(ingested).toMatchObject({ ingested: 3, unmatched: 1, ambiguous: 0 });
    const evidence = (await readDiscoveryBundle(directory)).evidence;
    expect(evidence.find((item) => item.attributes["air.match.status"] === "matched")?.nodeIds).toHaveLength(1);
    expect(evidence.find((item) => item.attributes["air.match.status"] === "unmatched")?.nodeIds).toEqual([]);
    expect(evidence.find((item) => item.kind === "database-change")?.nodeIds).toHaveLength(1);
    expect(canonicalEvidenceIdentities({ "http.request.method": "post", "http.route": "//api/orders/?ignored=true" })).toContain("http:POST:/api/orders");

    const loaded = await readDiscoveryBundle(directory);
    const endpoint = loaded.nodes.find((node) => node.kind === "endpoint" && node.attributes.path === "/api/orders")!;
    await writeDiscoveryBundle(directory, { ...loaded, nodes: [...loaded.nodes, { ...endpoint, id: "endpoint:duplicate-canonical-identity" }] });
    const ambiguousInput = resolve(directory, "ambiguous.json");
    await writeFile(ambiguousInput, JSON.stringify({ name: "ambiguous", attributes: { "http.request.method": "POST", "http.route": "/api/orders" } }), "utf8");
    const ambiguous = await ingestEvidence(ambiguousInput, directory);
    expect(ambiguous).toMatchObject({ ambiguous: 1, unmatched: 0 });
    expect(ambiguous.bundle.evidence.find((item) => item.source === "ambiguous.json")?.nodeIds).toEqual([]);
  });

  it("validates closed, secret-indirect evidence capture profiles", () => {
    const profile = parseEvidenceCaptureProfile(`
apiVersion: air.dev/evidence-capture/v0.1
kind: EvidenceCapture
metadata: { name: capture-test }
spec:
  sources:
    - id: database
      kind: postgres
      connectionEnv: TEST_DATABASE_URL
      schema: public
      tables: [orders]
    - id: payments
      kind: outbound-http
      environment: PAYMENTS_URL
      listen: { host: 127.0.0.1, port: 0 }
      stubs:
        - { method: POST, path: "/charge/{id}", status: 204 }
`);
    expect(profile.spec.sources).toHaveLength(2);
    expect(() => parseEvidenceCaptureProfile(`apiVersion: air.dev/evidence-capture/v0.1\nkind: EvidenceCapture\nmetadata: { name: invalid, secret: plaintext }\nspec: { sources: [] }\n`)).toThrow("additional properties");
  });

  it("captures privacy-safe outbound observations through the CLI", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-evidence-capture-"));
    const profile = resolve(directory, "profile.yaml"); const output = resolve(directory, "evidence.jsonl");
    await writeFile(profile, `apiVersion: air.dev/evidence-capture/v0.1\nkind: EvidenceCapture\nmetadata: { name: capture-test }\nspec:\n  sources:\n    - id: payments\n      kind: outbound-http\n      environment: PAYMENTS_URL\n      listen: { host: 127.0.0.1, port: 0 }\n      stubs:\n        - { method: POST, path: "/charge/{id}", status: 204 }\n`, "utf8");
    let stdout = ""; let stderr = ""; const io: CliIo = { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } };
    const script = "fetch(process.env.PAYMENTS_URL + '/charge/123', {method:'POST', body:'private-body'}).then(r=>{if(r.status!==204)process.exit(2)})";
    expect(await runCli(["evidence", "capture", profile, "--output", output, "--", process.execPath, "-e", script], io)).toBe(0);
    expect(stderr).toBe(""); expect(stdout).toContain("privacy-safe record");
    const captured = await readFile(output, "utf8");
    expect(captured).toContain("outbound:payments:POST:/charge/{id}");
    expect(captured).not.toContain("private-body");
    const marker = resolve(directory, "must-not-run"); stdout = ""; stderr = "";
    const overwriteScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    expect(await runCli(["evidence", "capture", profile, "--output", output, "--", process.execPath, "-e", overwriteScript], io)).toBe(1);
    expect(stderr).toContain("refusing to run a side-effecting command");
    expect(existsSync(marker)).toBe(false);
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

  it("creates privacy-safe immutable check baselines and detects semantic differences", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-check-command-"));
    const implementation = (status: number): string => `const id = crypto.randomUUID(); const now = new Date().toISOString(); console.log(JSON.stringify({http:{status:${status},headers:{"content-type":"application/json"},body:{id,createdAt:now}},database:{rows:[{id,createdAt:now,state:"created"}]},messages:[{id,createdAt:now,type:"created"}],outbound:[{operation:"vendor.create",id}],ordering:["database","outbound","messages"],failures:[],retryability:false}));`;
    await writeFile(resolve(root, "legacy.mjs"), implementation(201), "utf8");
    await writeFile(resolve(root, "candidate.mjs"), implementation(201), "utf8");
    await writeFile(resolve(root, "mutant.mjs"), implementation(202), "utf8");
    const check = parseCheckDocument(`
apiVersion: air.dev/check/v0.1
kind: Check
metadata: { name: create-document }
spec:
  capability: { id: documents.create }
  observations: [http, database, messages, outbound, ordering, failures, retryability]
  scenarios:
    - id: success
      request: { kind: command }
  normalization:
    - { kind: typed-token, pointer: /http/body/id, format: uuid, binding: document-id }
    - { kind: typed-token, pointer: /database/rows/0/id, format: uuid, binding: document-id }
    - { kind: typed-token, pointer: /messages/0/id, format: uuid, binding: document-id }
    - { kind: typed-token, pointer: /outbound/0/id, format: uuid, binding: document-id }
    - { kind: typed-token, pointer: /http/body/createdAt, format: timestamp, binding: created-at }
    - { kind: typed-token, pointer: /database/rows/0/createdAt, format: timestamp, binding: created-at }
    - { kind: typed-token, pointer: /messages/0/createdAt, format: timestamp, binding: created-at }
`);
    const target = (script: string, name: string) => parseCheckTarget(`apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: ${name} }\nspec:\n  type: command\n  fixtureIsolation: process\n  command:\n    argv: [${JSON.stringify(process.execPath)}, ${script}]\n`);
    const baseline = await createCheckBaseline({ check, target: target("legacy.mjs", "legacy"), repositoryRoot: root, repositoryHash: "a".repeat(64), clean: true });
    expect(baseline.releasable).toBe(true);
    expect(JSON.stringify(baseline)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);
    expect(parseCheckBaseline(JSON.stringify(baseline)).baselineId).toBe(baseline.baselineId);
    const equivalent = await runMigrationCheck({ check, baseline, target: target("candidate.mjs", "candidate"), repositoryRoot: root, repositoryHash: "b".repeat(64) });
    expect(equivalent).toMatchObject({ passed: true, mismatches: [] });
    const different = await runMigrationCheck({ check, baseline, target: target("mutant.mjs", "mutant"), repositoryRoot: root, repositoryHash: "c".repeat(64) });
    expect(different.passed).toBe(false);
    expect(different.mismatches).toContainEqual(expect.objectContaining({ classification: "candidate-difference", selector: "/http/status", repair: "candidate-code" }));
    const tampered = structuredClone(baseline) as { baselineId: string; scenarios: { observation: { kind: string; entries?: Record<string, unknown> } }[] };
    tampered.scenarios[0]!.observation = { kind: "object", entries: {} };
    expect(() => parseCheckBaseline(JSON.stringify(tampered))).toThrow("does not match baselineId");
  });

  it("fails closed on unsafe targets, forbidden normalization, and inconsistent bindings", async () => {
    expect(() => parseCheckTarget("apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: unsafe }\nspec: { type: command, workingDirectory: ../escape, command: { argv: [node] } }\n")).toThrow();
    expect(() => parseCheckTarget("apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: secret }\nspec: { type: command, environment: { TOKEN: secret-value }, command: { argv: [node] } }\n")).toThrow();
    const check = parseCheckDocument("apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: strict }\nspec:\n  capability: { id: strict }\n  observations: [http]\n  scenarios: [{ id: one, request: { kind: http, method: GET, path: /one } }]\n  normalization: [{ kind: ignore, pointer: /http/body/noise, reason: nondeterministic legacy field }]\n");
    const policy = parseCheckPolicy("apiVersion: air.dev/check-policy/v0.1\nkind: CheckPolicy\nmetadata: { name: strict }\nspec: { allowedNormalizations: [typed-token], requireCleanBaseline: true }\n");
    expect(validateMigrationCheck(check, policy)).toContain("Normalization ignore at /http/body/noise is not allowed by policy.");
    expect(() => parseCheckDocument("apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: scripts }\nspec: { capability: { id: x }, observations: [http], scenarios: [{ id: one, request: { kind: http, method: GET, path: / } }], normalization: [{ kind: script, pointer: /http }] }\n")).toThrow();
    const stateful = parseCheckDocument("apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: stateful }\nspec: { capability: { id: x }, observations: [database], scenarios: [{ id: one, request: { kind: command } }] }\n");
    const ambiguousFixture = parseCheckTarget(`apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: ambiguous }\nspec: { type: command, command: { argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("console.log('{\\\"database\\\":{}}')")}] } }\n`);
    await expect(createCheckBaseline({ check: stateful, target: ambiguousFixture, repositoryRoot: process.cwd(), repositoryHash: "a".repeat(64), clean: true })).rejects.toThrow("explicitly declare fixtureIsolation");
    const prototypeCheck = parseCheckDocument("apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: prototype-safe }\nspec: { capability: { id: x }, observations: [database], scenarios: [{ id: one, request: { kind: command } }], normalization: [{ kind: ignore, pointer: /__proto__/polluted, reason: adversarial }] }\n");
    const isolated = parseCheckTarget(`apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: isolated }\nspec: { type: command, fixtureIsolation: process, command: { argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("console.log('{\\\"database\\\":{}}')")}] } }\n`);
    await expect(createCheckBaseline({ check: prototypeCheck, target: isolated, repositoryRoot: process.cwd(), repositoryHash: "a".repeat(64), clean: true })).rejects.toThrow("protected prototype-chain segment");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("detects all 15 capability-replacement mutants and passes 20 clean reruns", async () => {
    const benchmark = resolve(process.cwd(), "benchmarks/capability-replacement");
    const [checkSource, policySource, legacySource, candidateSource, mutantsSource] = await Promise.all([
      readFile(resolve(benchmark, "check.yaml"), "utf8"), readFile(resolve(benchmark, "policy.yaml"), "utf8"),
      readFile(resolve(benchmark, "legacy.target.yaml"), "utf8"), readFile(resolve(benchmark, "candidate.target.yaml"), "utf8"),
      readFile(resolve(benchmark, "mutants.json"), "utf8"),
    ]);
    const check = parseCheckDocument(checkSource); const policy = parseCheckPolicy(policySource);
    const legacy = parseCheckTarget(legacySource); const candidate = parseCheckTarget(candidateSource);
    const baseline = await createCheckBaseline({ check, policy, target: legacy, repositoryRoot: process.cwd(), repositoryHash: "d".repeat(64), clean: true });
    for (let run = 0; run < 20; run += 1) {
      const result = await runMigrationCheck({ check, policy, baseline, target: candidate, repositoryRoot: process.cwd(), repositoryHash: "e".repeat(64) });
      expect(result.passed, `clean rerun ${run + 1}`).toBe(true);
    }
    const mutants = JSON.parse(mutantsSource) as string[];
    expect(mutants).toHaveLength(15);
    for (const mutant of mutants) {
      const mutantTarget = structuredClone(candidate) as { metadata: { name: string }; spec: { command?: { argv: string[] } } };
      mutantTarget.metadata.name = `mutant-${mutant}`;
      mutantTarget.spec.command!.argv = ["node", "candidate.mjs", mutant];
      const result = await runMigrationCheck({ check, policy, baseline, target: mutantTarget as never, repositoryRoot: process.cwd(), repositoryHash: "f".repeat(64) });
      expect(result.passed, mutant).toBe(false);
      expect(result.mismatches.length, mutant).toBeGreaterThan(0);
    }
  }, 30_000);
});

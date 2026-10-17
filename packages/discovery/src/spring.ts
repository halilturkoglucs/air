import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentHash, stableId } from "./ids.js";
import { DISCOVERY_API_VERSION, type Confidence, type CoverageDimension, type DiscoveryBundle, type DiscoveryDiagnostic, type DiscoveryEdge, type DiscoveryNode, type NodeKind, type SourceSpan, type SpringDiscoveryResult } from "./types.js";

const EXCLUDED = new Set([".git", ".gradle", ".idea", ".mvn", "build", "dist", "node_modules", "out", "target"]);
const SOURCE_EXTENSIONS = new Set([".java", ".kt", ".xml", ".properties", ".yml", ".yaml"]);

interface SourceFile { readonly absolute: string; readonly relative: string; readonly source: string; readonly hash: string; readonly buildCoordinate?: string }
interface BytecodeFile { readonly relative: string; readonly hash: string }
interface OpenRewriteFinding { readonly path: string; readonly line: number; readonly kind: NodeKind; readonly name: string; readonly semantic: string; readonly annotation: string }
const execFileAsync = promisify(execFile);

async function runOpenRewrite(root: string): Promise<readonly OpenRewriteFinding[] | undefined> {
  const configured = process.env.AIR_OPENREWRITE_ANALYZER_JAR;
  const candidates = [configured, resolve(dirname(fileURLToPath(import.meta.url)), "../analyzers/air-spring-analyzer.jar"), resolve(dirname(fileURLToPath(import.meta.url)), "../spring-analyzer/target/air-spring-analyzer.jar"), resolve(process.cwd(), "packages/discovery/spring-analyzer/target/air-spring-analyzer.jar")].filter((value): value is string => Boolean(value));
  let jar: string | undefined;
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) { jar = candidate; break; } } catch { /* try next location */ }
  }
  if (!jar) return undefined;
  const { stdout } = await execFileAsync("java", ["-jar", jar, root], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as OpenRewriteFinding);
}

async function collectFiles(root: string): Promise<SourceFile[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !EXCLUDED.has(entry.name)) await visit(resolve(directory, entry.name));
      else if (entry.isFile() && (SOURCE_EXTENSIONS.has(extname(entry.name)) || entry.name === "pom.xml" || entry.name.endsWith(".gradle") || entry.name.endsWith(".gradle.kts"))) paths.push(resolve(directory, entry.name));
    }
  };
  await visit(root);
  return Promise.all(paths.sort().map(async (absolute) => {
    const source = await readFile(absolute, "utf8");
    return { absolute, relative: relative(root, absolute).replaceAll("\\", "/"), source, hash: contentHash(source) };
  }));
}

async function collectBytecode(root: string): Promise<BytecodeFile[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) await visit(resolve(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".class") && !entry.name.includes("$")) paths.push(resolve(directory, entry.name));
      if (paths.length > 10_000) throw new Error("Bytecode inventory exceeds 10,000 classes; scope discovery to the application modules.");
    }
  };
  await visit(root);
  return Promise.all(paths.sort().map(async (absolute) => ({ relative: relative(root, absolute).replaceAll("\\", "/"), hash: contentHash(await readFile(absolute)) })));
}

function lineOf(source: string, offset: number): number { return source.slice(0, offset).split("\n").length; }
function span(file: SourceFile, offset = 0, symbol?: string): SourceSpan {
  const line = lineOf(file.source, offset);
  return { path: file.relative, startLine: line, endLine: line, contentHash: file.hash, ...(symbol ? { symbol } : {}), ...(file.buildCoordinate ? { buildCoordinate: file.buildCoordinate } : {}) };
}

function packageName(source: string): string { return /^\s*package\s+([\w.]+)\s*;/mu.exec(source)?.[1] ?? ""; }
function moduleName(file: SourceFile): string {
  const marker = file.relative.search(/\/(?:src|build\.gradle|pom\.xml)/u);
  return marker > 0 ? file.relative.slice(0, marker).split("/").at(-1) ?? "root" : "root";
}

function addNode(nodes: Map<string, DiscoveryNode>, node: DiscoveryNode): DiscoveryNode {
  const existing = nodes.get(node.id);
  if (!existing) { nodes.set(node.id, node); return node; }
  const rank: Record<Confidence, number> = { opaque: 0, inferred: 1, observed: 2, proven: 3, conflicting: 4 };
  const confidence = rank[node.confidence] > rank[existing.confidence] ? node.confidence : existing.confidence;
  const merged = { ...existing, confidence, observable: existing.observable || node.observable, attributes: { ...existing.attributes, ...node.attributes }, sources: [...new Map([...existing.sources, ...node.sources].map((source) => [`${source.path}:${source.startLine ?? 0}:${source.symbol ?? ""}`, source])).values()] };
  nodes.set(node.id, merged);
  return merged;
}

function addFinding(nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>, file: SourceFile, moduleId: string, kind: NodeKind, name: string, offset: number, attributes: Record<string, unknown>, confidence: Confidence = "proven", observable = false, diagnostics?: readonly string[]): DiscoveryNode {
  const qualified = `${packageName(file.source)}.${name}`.replace(/^\./u, "");
  const source = span(file, offset, qualified);
  const node = addNode(nodes, { id: stableId(kind, file.relative, qualified, JSON.stringify(attributes)), kind, name, qualifiedName: qualified, module: moduleName(file), confidence, observable, attributes, sources: [source], ...(diagnostics ? { diagnostics } : {}) });
  const edge: DiscoveryEdge = { id: stableId("edge", "contains", moduleId, node.id), kind: "contains", from: moduleId, to: node.id, confidence, sources: [source] };
  edges.set(edge.id, edge);
  return node;
}

function annotationArgument(annotation: string, key = "value"): string | undefined {
  const named = new RegExp(`${key}\\s*=\\s*\"([^\"]+)\"`, "u").exec(annotation)?.[1];
  return named ?? /\(\s*"([^"]+)"/u.exec(annotation)?.[1];
}

function discoverJava(file: SourceFile, moduleId: string, nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>, diagnostics: DiscoveryDiagnostic[]): void {
  const source = file.source;
  const classMatch = /((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:public\s+)?(?:abstract\s+)?(?:class|interface|record|enum)\s+(\w+)/gmu;
  let match: RegExpExecArray | null;
  while ((match = classMatch.exec(source)) !== null) {
    const annotations = match[1] ?? "";
    const name = match[2] ?? "Anonymous";
    const offset = match.index;
    const declarationWindow = source.slice(offset, offset + 1200);
    const recordComponents = new RegExp(`record\\s+${name}\\s*\\(([^)]*)\\)`, "u").exec(declarationWindow)?.[1]?.split(",").map((component) => component.trim().split(/\s+/u).at(-1)).filter((field): field is string => Boolean(field)) ?? [];
    const validation = [...declarationWindow.matchAll(/@(NotNull|NotBlank|Size|Min|Max|Pattern|Email)\b/gu)].map((item) => item[1]!);
    const serialization = [...declarationWindow.matchAll(/@(JsonProperty|JsonAlias|JsonIgnore|JsonFormat)\b/gu)].map((item) => item[1]!);
    if (/@(?:Entity|Document)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "entity", name, offset, { persistence: /@Entity/u.test(annotations) ? "jpa" : "document", relationships: [...declarationWindow.matchAll(/@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b/gu)].map((item) => item[1]!) }, "proven", true);
    else if (/@(?:RestController|Controller)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: "spring", role: "http-controller" });
    else if (/@(?:FeignClient)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "vendor-call", name, offset, { client: "feign", target: annotationArgument(annotations, "name") ?? annotationArgument(annotations) ?? "dynamic" }, annotationArgument(annotations, "url")?.includes("${") ? "opaque" : "proven", true);
    else if (/(?:Repository|JpaRepository|CrudRepository|PagingAndSortingRepository)\b/u.test(match[0]) || /@Repository\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "repository", name, offset, { persistence: "jpa" }, "proven", true);
    else if (/@(?:JsonDeserialize|JsonSerialize|Valid|Validated)\b/u.test(annotations) || /(?:Request|Response|Dto|DTO|Payload)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "contract", name, offset, { boundary: /(?:Request|Response|Payload)$/u.test(name), serialization: serialization.length > 0 || /@Json/u.test(annotations) ? "jackson" : "java", fields: recordComponents, validation: [...new Set(validation)] });
    else if (/Mapper$/u.test(name) || /@Mapper\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "mapper", name, offset, { implementation: /@Mapper/u.test(annotations) ? "mapstruct" : "manual" }, /\b(?:Repository|WebClient|RestClient)\b/u.test(source) ? "opaque" : "inferred", false, /\b(?:Repository|WebClient|RestClient)\b/u.test(source) ? ["Mapper performs a lookup or effect and cannot be reduced to a pure transformation."] : undefined);
  }

  const method = /((?:@[\w.]+(?:\([^)]*\))?\s*)+)(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:[\w<>?,.@\[\]]+\s+)+(\w+)\s*\([^)]*\)/gmu;
  while ((match = method.exec(source)) !== null) {
    const annotations = match[1] ?? "";
    const name = match[2] ?? "operation";
    const offset = match.index;
    const mapping = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(\([^)]*\))?/u.exec(annotations);
    if (mapping) {
      const verb = mapping[1] === "Request" ? (/method\s*=\s*RequestMethod\.(\w+)/u.exec(mapping[2] ?? "")?.[1] ?? "GET") : mapping[1]?.toUpperCase();
      addFinding(nodes, edges, file, moduleId, "endpoint", name, offset, { method: verb, path: annotationArgument(mapping[0]) ?? "/", framework: "spring-mvc" }, "proven", true);
    }
    const listenerKinds: readonly [RegExp, string][] = [[/@KafkaListener\b/u, "kafka"], [/@RabbitListener\b/u, "rabbitmq"], [/@EventListener\b/u, "spring-event"]];
    for (const [pattern, transport] of listenerKinds) if (pattern.test(annotations)) addFinding(nodes, edges, file, moduleId, "listener", name, offset, { transport, destination: annotationArgument(annotations, transport === "kafka" ? "topics" : "queues") ?? annotationArgument(annotations) ?? "dynamic" }, annotations.includes("${") ? "opaque" : "proven", true);
    if (/@Scheduled\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "schedule", name, offset, { cron: annotationArgument(annotations, "cron"), fixedDelay: annotationArgument(annotations, "fixedDelayString") }, annotations.includes("${") ? "inferred" : "proven", true);
    if (/@Transactional\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "transaction", name, offset, { propagation: /propagation\s*=\s*Propagation\.(\w+)/u.exec(annotations)?.[1] ?? "REQUIRED" }, "proven", true);
    if (/@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "security", name, offset, { declaration: annotations.trim() }, /@PreAuthorize\([^)]*[+]/u.test(annotations) ? "opaque" : "proven", true);
    if (/@Cacheable\b/u.test(annotations) || /@CachePut\b/u.test(annotations) || /@CacheEvict\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "cache", name, offset, { operation: /@(Cacheable|CachePut|CacheEvict)/u.exec(annotations)?.[1], cache: annotationArgument(annotations, "cacheNames") ?? annotationArgument(annotations) }, annotations.includes("key =") ? "inferred" : "proven", true);
    if (/@Query\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "query", name, offset, { query: annotationArgument(annotations), native: /nativeQuery\s*=\s*true/u.test(annotations) }, "proven", true);
  }

  let lineOffset = 0;
  let pendingAnnotations = "";
  let pendingOffset = 0;
  for (const line of source.split(/(?<=\n)/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@") && !/[{;}]/u.test(trimmed)) {
      if (!pendingAnnotations) pendingOffset = lineOffset;
      pendingAnnotations += line;
      lineOffset += line.length;
      continue;
    }
    const annotatedLine = `${pendingAnnotations}${line}`;
    const annotationOffset = pendingAnnotations ? pendingOffset : lineOffset;
    if (annotatedLine.includes("@")) {
      const calls = [...annotatedLine.matchAll(/\b(\w+)\s*\(/gu)].map((candidate) => candidate[1]!).filter((name) => !["hasRole", "hasAuthority", "value"].includes(name));
      const name = calls.at(-1);
      if (name) {
        const mapping = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b/u.exec(annotatedLine);
        if (mapping) addFinding(nodes, edges, file, moduleId, "endpoint", name, annotationOffset, { method: mapping[1] === "Request" ? "GET" : mapping[1]?.toUpperCase(), path: annotationArgument(annotatedLine) ?? "/", framework: "spring-mvc" }, "proven", true);
        if (/@Transactional\b/u.test(annotatedLine)) addFinding(nodes, edges, file, moduleId, "transaction", name, annotationOffset, { propagation: /Propagation\.(\w+)/u.exec(annotatedLine)?.[1] ?? "REQUIRED" }, "proven", true);
        if (/@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b/u.test(annotatedLine)) addFinding(nodes, edges, file, moduleId, "security", name, annotationOffset, { declaration: annotatedLine.trim() }, annotatedLine.includes("+") ? "opaque" : "proven", true);
      }
    }
    pendingAnnotations = "";
    lineOffset += line.length;
  }

  const expressions: readonly [RegExp, NodeKind, Record<string, unknown>, boolean][] = [
    [/\b(?:KafkaTemplate|StreamBridge)\b|\.send\s*\(/gu, "publisher", { transport: "kafka-or-broker" }, true],
    [/\bRabbitTemplate\b|\.convertAndSend\s*\(/gu, "publisher", { transport: "rabbitmq" }, true],
    [/\.publishEvent\s*\(/gu, "publisher", { transport: "spring-event" }, true],
    [/\bIntegrationFlow\b|IntegrationFlows\./gu, "operation", { framework: "spring-integration" }, true],
    [/\bWebClient\b|\bRestClient\b|\bRestTemplate\b/gu, "vendor-call", { client: "spring-http", target: "dynamic" }, true],
    [/\bRedisTemplate\b|\bReactiveRedisTemplate\b/gu, "cache", { provider: "redis", usage: "unknown" }, true],
    [/Class\.forName|Method\.invoke|\.getBean\s*\(|spel|GroovyShell|ScriptEngine/giu, "dynamic-routing", { mechanism: "runtime-dispatch" }, true],
  ];
  for (const [pattern, kind, attributes, observable] of expressions) {
    let index = 0;
    for (const occurrence of source.matchAll(pattern)) {
      const confidence: Confidence = kind === "dynamic-routing" || (kind === "cache" && attributes.usage === "unknown") || kind === "vendor-call" ? "opaque" : "inferred";
      addFinding(nodes, edges, file, moduleId, kind, `${kind}-${++index}`, occurrence.index, attributes, confidence, observable, confidence === "opaque" ? ["Runtime behavior requires review or runtime evidence."] : undefined);
    }
  }

  if (/\$\{|Environment\.getProperty|@Value\b/u.test(source)) addFinding(nodes, edges, file, moduleId, "configuration", basename(file.relative), 0, { profileDependent: true }, "inferred", false);
  if (/\bIntegrationFlow\b|IntegrationFlows\./u.test(source)) diagnostics.push({ code: "SPRING_INTEGRATION_FLOW_REVIEW", severity: "warning", message: "Spring Integration flow topology was inventoried but requires review before semantic extraction.", source: span(file, source.search(/\bIntegrationFlow\b|IntegrationFlows\./u)) });
  if (/routing|destinationResolver|resolveDestination/iu.test(source)) diagnostics.push({ code: "SPRING_DYNAMIC_ROUTING", severity: "warning", message: "Dynamic routing was retained as an opaque dependency.", source: span(file, source.search(/routing|destinationResolver|resolveDestination/iu)) });
}

function coverage(nodes: readonly DiscoveryNode[]): Record<string, CoverageDimension> {
  const result: Record<string, CoverageDimension> = {};
  for (const node of nodes) {
    const current = result[node.kind] ?? { supported: 0, proven: 0, observed: 0, inferred: 0, opaque: 0, conflicting: 0 };
    result[node.kind] = { ...current, supported: current.supported + 1, [node.confidence]: current[node.confidence] + 1 };
  }
  return result;
}

export async function discoverSpring(repository: string, options: { readonly name?: string; readonly analyzer?: "auto" | "source" | "openrewrite" } = {}): Promise<SpringDiscoveryResult> {
  const root = resolve(repository);
  const analyzerRequested = options.analyzer ?? "auto";
  if (!(await stat(root)).isDirectory()) throw new Error("Spring discovery input must be a directory.");
  let files = await collectFiles(root);
  const coordinates = new Map(files.filter((file) => file.relative.endsWith("pom.xml") || /build\.gradle(?:\.kts)?$/u.test(file.relative)).map((file) => {
    const maven = file.relative.endsWith("pom.xml");
    const group = (maven ? /<groupId>([^<]+)<\/groupId>/u : /\bgroup\s*=\s*["']([^"']+)["']/u).exec(file.source)?.[1] ?? "unknown";
    const artifact = (maven ? /<artifactId>([^<]+)<\/artifactId>/u : /\barchivesName\s*=\s*["']([^"']+)["']/u).exec(file.source)?.[1] ?? moduleName(file);
    const version = (maven ? /<version>([^<]+)<\/version>/u : /\bversion\s*=\s*["']([^"']+)["']/u).exec(file.source)?.[1] ?? "inherited";
    return [moduleName(file), `${group}:${artifact}:${version}`] as const;
  }));
  files = files.map((file) => {
    const buildCoordinate = coordinates.get(moduleName(file));
    return buildCoordinate ? { ...file, buildCoordinate } : file;
  });
  const bytecode = files.some((file) => file.relative.endsWith(".java")) ? [] : await collectBytecode(root);
  if (files.length === 0 && bytecode.length === 0) throw new Error("No supported Spring source, build, or bytecode files were found.");
  const nodes = new Map<string, DiscoveryNode>();
  const edges = new Map<string, DiscoveryEdge>();
  const diagnostics: DiscoveryDiagnostic[] = [];
  const buildFiles = files.filter((file) => file.relative.endsWith("pom.xml") || /(?:build|settings)\.gradle(?:\.kts)?$/u.test(file.relative));
  for (const build of buildFiles.length > 0 ? buildFiles : files.length > 0 ? [files[0]!] : []) {
    const name = moduleName(build);
    addNode(nodes, { id: stableId("module", name), kind: "module", name, confidence: "proven", observable: false, attributes: { build: build.relative.endsWith("pom.xml") ? "maven" : build.relative.includes("gradle") ? "gradle" : "unknown" }, sources: [span(build)] });
  }
  for (const compiled of bytecode) {
    const name = basename(compiled.relative, ".class");
    const source: SourceSpan = { path: compiled.relative, contentHash: compiled.hash, symbol: name };
    const module = compiled.relative.split("/").find((part) => part !== "target" && part !== "build") ?? "root";
    const moduleId = stableId("module", module);
    if (!nodes.has(moduleId)) addNode(nodes, { id: moduleId, kind: "module", name: module, confidence: "inferred", observable: false, attributes: { build: "bytecode" }, sources: [source] });
    const node = addNode(nodes, { id: stableId("service", compiled.relative, name), kind: "service", name, module, confidence: "opaque", observable: false, attributes: { language: "jvm-bytecode", sourceAttribution: "unavailable" }, sources: [source], diagnostics: ["Bytecode was inventoried because Java source attribution was unavailable."] });
    edges.set(stableId("edge", "contains", moduleId, node.id), { id: stableId("edge", "contains", moduleId, node.id), kind: "contains", from: moduleId, to: node.id, confidence: "inferred", sources: [source] });
  }
  for (const file of files) {
    const module = moduleName(file);
    const moduleId = stableId("module", module);
    if (!nodes.has(moduleId)) addNode(nodes, { id: moduleId, kind: "module", name: module, confidence: "proven", observable: false, attributes: { build: "inherited" }, sources: [span(file)] });
    if (file.relative.endsWith(".java")) discoverJava(file, moduleId, nodes, edges, diagnostics);
    else if (file.relative.endsWith(".kt")) {
      addFinding(nodes, edges, file, moduleId, "service", basename(file.relative, ".kt"), 0, { language: "kotlin", support: "inventory" }, "opaque", false, ["Deep Kotlin semantic extraction is not available in discovery v0.1."]);
      diagnostics.push({ code: "KOTLIN_INVENTORY_ONLY", severity: "warning", message: `${file.relative} was inventoried without deep Kotlin semantics.`, source: span(file) });
    } else if (/application.*\.(?:properties|ya?ml)$/u.test(file.relative)) addFinding(nodes, edges, file, moduleId, "configuration", basename(file.relative), 0, { format: extname(file.relative).slice(1), redacted: true }, "proven", false);
  }
  const openRewrite = analyzerRequested === "source" ? undefined : await runOpenRewrite(root);
  if (openRewrite) {
    const byPath = new Map(files.map((file) => [file.relative, file]));
    for (const finding of openRewrite) {
      const file = byPath.get(finding.path);
      if (!file) continue;
      const existing = [...nodes.values()].find((node) => node.kind === finding.kind && node.name === finding.name && node.sources.some((source) => source.path === finding.path));
      if (existing) nodes.set(existing.id, { ...existing, confidence: "proven", attributes: { ...existing.attributes, analyzer: "openrewrite", analyzerVersion: "8.90.4", annotation: finding.annotation } });
      else addFinding(nodes, edges, file, stableId("module", moduleName(file)), finding.kind, finding.name, Math.max(0, file.source.split(/\r?\n/u).slice(0, Math.max(0, finding.line - 1)).join("\n").length), { analyzer: "openrewrite", analyzerVersion: "8.90.4", annotation: finding.annotation }, "proven", ["endpoint", "listener", "schedule", "vendor-call", "transaction", "query", "cache"].includes(finding.kind));
    }
  }
  const entries = [...nodes.values()].filter((node) => node.kind === "endpoint" || node.kind === "listener" || node.kind === "schedule");
  const effects = [...nodes.values()].filter((node) => ["transaction", "publisher", "vendor-call", "repository", "query", "cache", "dynamic-routing", "foreign-operation"].includes(node.kind));
  for (const entry of entries) {
    const paths = new Set(entry.sources.map((source) => source.path));
    for (const effect of effects) {
      const source = effect.sources.find((candidate) => paths.has(candidate.path));
      if (!source || entry.id === effect.id) continue;
      const kind = effect.kind === "publisher" ? "publishes" : effect.kind === "repository" || effect.kind === "query" ? "writes" : "calls";
      const edge: DiscoveryEdge = { id: stableId("edge", kind, entry.id, effect.id), kind, from: entry.id, to: effect.id, confidence: "inferred", sources: [source] };
      edges.set(edge.id, edge);
    }
  }
  if (analyzerRequested !== "source" && !openRewrite) diagnostics.unshift({ code: "DISCOVERY_OPENREWRITE_REQUIRED", severity: analyzerRequested === "openrewrite" ? "error" : "warning", message: "The pinned OpenRewrite 8.90.4 analyzer is the authoritative deep Java analyzer. Build packages/discovery/spring-analyzer or set AIR_OPENREWRITE_ANALYZER_JAR; the source analyzer produced review-required findings for this run." });
  const now = new Date().toISOString();
  const repositoryHash = contentHash([...files.map((file) => `${file.relative}:${file.hash}`), ...bytecode.map((file) => `${file.relative}:${file.hash}`)].join("\n"));
  const bundle: DiscoveryBundle = {
    manifest: { apiVersion: DISCOVERY_API_VERSION, kind: "DiscoveryBundle", metadata: { name: options.name ?? basename(root), repository: root, repositoryHash, createdAt: now, updatedAt: now, analyzer: openRewrite ? "spring-openrewrite" : "spring-source-review", analyzerVersion: openRewrite ? "8.90.4" : "0.1.0" }, files: { nodes: "nodes.jsonl", edges: "edges.jsonl", evidence: "evidence.jsonl", decisions: "decisions.yaml", coverage: "coverage.json", index: "index.sqlite" } },
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [], decisions: [], coverage: coverage([...nodes.values()]),
  };
  return { bundle, diagnostics };
}

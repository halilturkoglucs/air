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
interface JavaAnnotation { readonly source: string; readonly end: number }
interface ControllerContext { readonly offset: number; readonly path?: string; readonly pathExpression?: string }
interface JavaConstants { readonly simple: ReadonlyMap<string, string>; readonly qualified: ReadonlyMap<string, string> }
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

function isTestSource(path: string): boolean {
  return /(^|\/)src\/(?:test|integrationTest|it)(?:\/|$)/u.test(path);
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

function readJavaAnnotation(source: string, offset: number): JavaAnnotation | undefined {
  if (source[offset] !== "@") return undefined;
  let cursor = offset + 1;
  while (cursor < source.length && /[\w.$]/u.test(source[cursor]!)) cursor += 1;
  const nameEnd = cursor;
  while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
  if (source[cursor] !== "(") return { source: source.slice(offset, nameEnd), end: nameEnd };
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return { source: source.slice(offset, cursor + 1), end: cursor + 1 };
  }
  return { source: source.slice(offset), end: source.length };
}

function skipJavaTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    const whitespace = /^\s+/u.exec(source.slice(cursor));
    if (whitespace) { cursor += whitespace[0].length; continue; }
    if (source.startsWith("//", cursor)) { cursor = source.indexOf("\n", cursor + 2); if (cursor < 0) return source.length; continue; }
    if (source.startsWith("/*", cursor)) { const end = source.indexOf("*/", cursor + 2); return end < 0 ? source.length : skipJavaTrivia(source, end + 2); }
    break;
  }
  return cursor;
}

function methodFollowingAnnotation(source: string, start: number): string | undefined {
  let cursor = start;
  while (cursor < source.length) {
    cursor = skipJavaTrivia(source, cursor);
    if (source[cursor] !== "@") break;
    const annotation = readJavaAnnotation(source, cursor);
    if (!annotation) break;
    cursor = annotation.end;
  }
  cursor = skipJavaTrivia(source, cursor);
  const boundaryCandidates = [source.indexOf("{", cursor), source.indexOf(";", cursor)].filter((value) => value >= 0);
  const boundary = Math.min(...boundaryCandidates, cursor + 8000);
  const declaration = source.slice(cursor, Math.min(boundary, cursor + 8000));
  if (/\b(?:class|interface|record|enum|@interface)\b/u.test(declaration)) return undefined;
  const open = declaration.indexOf("(");
  if (open < 0) return undefined;
  return /([A-Za-z_$][\w$]*)\s*$/u.exec(declaration.slice(0, open))?.[1];
}

function argumentExpression(annotation: string, keys: readonly string[] = ["path", "value"]): string | undefined {
  const open = annotation.indexOf("(");
  const close = annotation.lastIndexOf(")");
  if (open < 0 || close <= open) return undefined;
  const body = annotation.slice(open + 1, close);
  const argumentsList: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if ("({[".includes(character)) depth += 1;
    else if (")}]".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) { argumentsList.push(body.slice(start, index).trim()); start = index + 1; }
  }
  argumentsList.push(body.slice(start).trim());
  for (const key of keys) {
    const named = argumentsList.map((argument) => new RegExp(`^${key}\\s*=\\s*([\\s\\S]+)$`, "u").exec(argument)?.[1]?.trim()).find(Boolean);
    if (named) return named;
  }
  const positional = argumentsList[0];
  return positional && !/^\w+\s*=/u.test(positional) ? positional : undefined;
}

function annotationNamed(annotations: string, name: string): string | undefined {
  const match = new RegExp(`@(?:[\\w.]+\\.)?${name}\\b`, "u").exec(annotations);
  return match ? readJavaAnnotation(annotations, match.index)?.source : undefined;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if ("({[<".includes(character)) depth += 1;
    else if (")}]>".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) { parts.push(source.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function recordComponentNames(source: string, name: string, offset: number): string[] {
  const declaration = new RegExp(`\\brecord\\s+${name}\\s*\\(`, "gu");
  declaration.lastIndex = offset;
  const match = declaration.exec(source);
  if (!match || match.index - offset > 2000) return [];
  const open = source.indexOf("(", match.index);
  const close = matchingDelimiter(source, open, "(", ")");
  if (close === undefined) return [];
  return splitTopLevel(source.slice(open + 1, close)).map((component) => {
    const withoutAnnotations = component.replace(/@(?:[\w.]+)(?:\s*\((?:[^()"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\([^()]*\))*\))?\s*/gu, "");
    return /([A-Za-z_$][\w$]*)\s*$/u.exec(withoutAnnotations)?.[1];
  }).filter((field): field is string => Boolean(field));
}

function collectStringConstants(files: readonly SourceFile[]): JavaConstants {
  const expressions = new Map<string, string>();
  for (const file of files.filter((candidate) => candidate.relative.endsWith(".java") && !isTestSource(candidate.relative))) {
    const types = [...file.source.matchAll(/\b(?:class|interface|record|enum)\s+(\w+)/gu)].map((match) => ({ name: match[1]!, offset: match.index }));
    for (const match of file.source.matchAll(/\b(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?String\s+(\w+)\s*=\s*([^;]+);/gu)) {
      const owner = types.filter((type) => type.offset < match.index).at(-1)?.name;
      if (owner) expressions.set(`${packageName(file.source)}.${owner}.${match[1]}`.replace(/^\./u, ""), match[2]!.trim());
    }
  }
  const qualified = new Map<string, string>();
  const resolveExpression = (key: string, expression: string): string | undefined => {
    const owner = key.slice(0, key.lastIndexOf("."));
    const tokens = expression.split("+").map((token) => token.trim());
    if (tokens.length === 0 || tokens.some((token) => token.length === 0)) return undefined;
    const resolved = tokens.map((token) => {
      if (/^"(?:\\.|[^"\\])*"$/u.test(token)) { try { return JSON.parse(token) as string; } catch { return undefined; } }
      const local = qualified.get(`${owner}.${token}`);
      if (local !== undefined) return local;
      const matches = [...qualified].filter(([name]) => name.endsWith(`.${token}`)).map(([, value]) => value);
      const unique = [...new Set(matches)];
      return unique.length === 1 ? unique[0] : undefined;
    });
    return resolved.every((value): value is string => value !== undefined) ? resolved.join("") : undefined;
  };
  for (let pass = 0; pass < expressions.size + 1; pass += 1) {
    let changed = false;
    for (const [key, expression] of expressions) {
      if (qualified.has(key)) continue;
      const value = resolveExpression(key, expression);
      if (value !== undefined) { qualified.set(key, value); changed = true; }
    }
    if (!changed) break;
  }
  const bySimple = new Map<string, Set<string>>();
  for (const [key, value] of qualified) {
    const name = key.split(".").at(-1)!;
    bySimple.set(name, new Set([...(bySimple.get(name) ?? []), value]));
  }
  const simple = new Map([...bySimple].filter(([, values]) => values.size === 1).map(([name, values]) => [name, [...values][0]!]));
  return { simple, qualified };
}

function mappingPath(annotation: string, constants: JavaConstants, file: SourceFile): { readonly path?: string; readonly pathExpression?: string } {
  const expression = argumentExpression(annotation);
  if (!expression) return { path: "/" };
  const candidate = expression.replace(/^\{\s*/u, "").replace(/\s*\}$/u, "").split(",", 1)[0]!.trim();
  if (/^"(?:\\.|[^"\\])*"$/u.test(candidate)) { try { return { path: JSON.parse(candidate) as string }; } catch { /* retain expression */ } }
  const exactImport = new RegExp(`\\bimport\\s+static\\s+([\\w.]+\\.${candidate.replaceAll(".", "\\.")})\\s*;`, "u").exec(file.source)?.[1];
  const wildcardOwner = new RegExp("\\bimport\\s+static\\s+([\\w.]+)\\.\\*\\s*;", "gu");
  const wildcardMatches = [...file.source.matchAll(wildcardOwner)].map((match) => constants.qualified.get(`${match[1]}.${candidate}`)).filter((value): value is string => value !== undefined);
  const qualifiedMatches = [...constants.qualified].filter(([name]) => name.endsWith(`.${candidate}`)).map(([, value]) => value);
  const fileSpecific = exactImport ? constants.qualified.get(exactImport) : undefined;
  const choices = [...new Set([fileSpecific, ...wildcardMatches, ...(candidate.includes(".") ? qualifiedMatches : []), constants.simple.get(candidate)].filter((value): value is string => value !== undefined))];
  const resolved = choices.length === 1 ? choices[0] : undefined;
  return resolved === undefined ? { pathExpression: candidate } : { path: resolved };
}

function joinRoute(base: string, route: string): string {
  const parts = [base, route].filter((part) => part && part !== "/").map((part) => part.replace(/^\/+|\/+$/gu, ""));
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function discoverJava(file: SourceFile, moduleId: string, nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>, diagnostics: DiscoveryDiagnostic[], constants: JavaConstants): void {
  const source = file.source;
  const controllers: ControllerContext[] = [];
  const publisherAdapters: { readonly name: string; readonly attributes: Record<string, unknown>; readonly start: number; readonly end: number }[] = [];
  const classMatch = /((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:public\s+)?(?:abstract\s+)?(class|interface|record|enum)\s+(\w+)/gmu;
  let match: RegExpExecArray | null;
  while ((match = classMatch.exec(source)) !== null) {
    const annotations = match[1] ?? "";
    const declarationKind = match[2] ?? "class";
    const name = match[3] ?? "Anonymous";
    const offset = match.index;
    const recordOpen = declarationKind === "record" ? source.indexOf("(", match.index + match[0].length) : -1;
    const recordClose = recordOpen >= 0 ? matchingDelimiter(source, recordOpen, "(", ")") : undefined;
    const bodyOpen = source.indexOf("{", recordClose === undefined ? match.index + match[0].length : recordClose + 1);
    const bodyClose = bodyOpen >= 0 ? matchingDelimiter(source, bodyOpen, "{", "}") : undefined;
    const declarationWindow = source.slice(offset, bodyClose === undefined ? offset + 1200 : bodyClose + 1);
    const recordComponents = declarationKind === "record" ? recordComponentNames(source, name, offset) : [];
    const validation = [...declarationWindow.matchAll(/@(NotNull|NotBlank|Null|Size|Min|Max|DecimalMin|DecimalMax|Positive|PositiveOrZero|Negative|NegativeOrZero|Pattern|Email|AssertTrue|AssertFalse|Future|FutureOrPresent|Past|PastOrPresent)\b/gu)].map((item) => item[1]!);
    const serialization = [...declarationWindow.matchAll(/@(JsonProperty|JsonAlias|JsonIgnore|JsonFormat)\b/gu)].map((item) => item[1]!);
    const controller = /@(?:RestController|Controller)\b/u.test(annotations);
    const graphqlController = controller && /@(QueryMapping|MutationMapping|SubscriptionMapping)\b/u.test(declarationWindow);
    const profile = annotationArgument(annotationNamed(annotations, "Profile") ?? "");
    const publisherTransport = /\b(?:KafkaTemplate|StreamBridge)\b/u.test(declarationWindow) ? "kafka" : /\bRabbitTemplate\b/u.test(declarationWindow) ? "rabbitmq" : /\bApplicationEventPublisher\b/u.test(declarationWindow) ? "spring-event" : undefined;
    if (controller) {
      const mappingOffset = annotations.search(/@RequestMapping\b/u);
      const mapping = mappingOffset >= 0 ? readJavaAnnotation(annotations, mappingOffset) : undefined;
      controllers.push({ offset, ...(mapping ? mappingPath(mapping.source, constants, file) : { path: "/" }) });
    }
    if (/@(?:Entity|Document)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "entity", name, offset, { persistence: /@Entity/u.test(annotations) ? "jpa" : "document", relationships: [...declarationWindow.matchAll(/@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b/gu)].map((item) => item[1]!) }, "proven", true);
    else if (controller) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: graphqlController ? "spring-graphql" : "spring", role: graphqlController ? "graphql-controller" : "http-controller" });
    else if (/@ConfigurationProperties\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "configuration", name, offset, { framework: "spring", role: "configuration-properties", prefix: annotationArgument(annotations) });
    else if (/@Configuration\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "configuration", name, offset, { framework: "spring", role: "configuration-class" });
    else if (/@(?:FeignClient)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "vendor-call", name, offset, { client: "feign", target: annotationArgument(annotations, "name") ?? annotationArgument(annotations) ?? "dynamic" }, annotationArgument(annotations, "url")?.includes("${") ? "opaque" : "proven", true);
    else if (/(?:Repository|JpaRepository|CrudRepository|PagingAndSortingRepository)\b/u.test(match[0]) || /@Repository\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "repository", name, offset, { persistence: "jpa" }, "proven", true);
    else if (/(?:DAO|Dao)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "repository", name, offset, { persistence: "custom-dao" }, "inferred", true, ["Custom DAO semantics require source or runtime evidence before extraction."]);
    else if (declarationKind === "interface" && /(?:Publisher|Producer)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "publisher", name, offset, { framework: "java", role: "publisher-contract", transport: "dynamic" }, "inferred", true);
    else if (publisherTransport && /(?:Publisher|Producer)$/u.test(name)) {
      const attributes = { framework: "spring", role: "publisher-adapter", transport: publisherTransport, ...(profile ? { profiles: [profile] } : {}) };
      addFinding(nodes, edges, file, moduleId, "publisher", name, offset, attributes, "proven", true);
      publisherAdapters.push({ name, attributes, start: offset, end: bodyClose ?? source.length });
    } else if (declarationKind === "interface" && /Service$/u.test(name)) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: "java", role: "service-contract" }, "inferred");
    else if (/@(?:JsonDeserialize|JsonSerialize|Valid|Validated)\b/u.test(annotations) || /(?:Request|Response|Dto|DTO|Payload)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "contract", name, offset, { boundary: /(?:Request|Response|Payload)$/u.test(name), serialization: serialization.length > 0 || /@Json/u.test(annotations) ? "jackson" : "java", fields: recordComponents, validation: [...new Set(validation)] });
    else if (/Mapper$/u.test(name) || /@Mapper\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "mapper", name, offset, { implementation: /@Mapper/u.test(annotations) ? "mapstruct" : "manual" }, /\b(?:Repository|WebClient|RestClient)\b/u.test(source) ? "opaque" : "inferred", false, /\b(?:Repository|WebClient|RestClient)\b/u.test(source) ? ["Mapper performs a lookup or effect and cannot be reduced to a pure transformation."] : undefined);
    else if (/@(?:Service|Component)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: "spring", role: /@Service\b/u.test(annotations) ? "service" : "component" });
  }

  for (const occurrence of source.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (!name) continue;
    const local = mappingPath(annotation.source, constants, file);
    const controller = controllers.filter((candidate) => candidate.offset < occurrence.index).at(-1);
    const unresolved = controller?.pathExpression !== undefined || local.pathExpression !== undefined;
    const path = unresolved ? undefined : local.path !== undefined && controller?.path !== undefined ? joinRoute(controller.path, local.path) : local.path;
    const pathExpression = unresolved ? [controller?.pathExpression ?? (controller?.path !== undefined ? JSON.stringify(controller.path) : undefined), local.pathExpression ?? (local.path !== undefined ? JSON.stringify(local.path) : undefined)].filter(Boolean).join(" + ") : undefined;
    const verb = occurrence[1] === "Request" ? (/method\s*=\s*RequestMethod\.(\w+)/u.exec(annotation.source)?.[1] ?? "GET") : occurrence[1]?.toUpperCase();
    addFinding(nodes, edges, file, moduleId, "endpoint", name, occurrence.index, { method: verb, ...(path !== undefined ? { path } : {}), ...(pathExpression ? { pathExpression } : {}), framework: "spring-mvc" }, pathExpression ? "inferred" : "proven", true, pathExpression ? ["Route contains a source expression that requires build attribution or review."] : undefined);
  }

  for (const occurrence of source.matchAll(/@(QueryMapping|MutationMapping|SubscriptionMapping)\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (!name) continue;
    const operation = occurrence[1] === "QueryMapping" ? "query" : occurrence[1] === "MutationMapping" ? "mutation" : "subscription";
    addFinding(nodes, edges, file, moduleId, "endpoint", name, occurrence.index, { method: "POST", path: "/graphql", protocol: "graphql", operation, field: annotationArgument(annotation.source) ?? name, framework: "spring-graphql" }, "proven", true);
  }

  for (const occurrence of source.matchAll(/@(KafkaListener|RabbitListener|EventListener|Scheduled|Transactional|PreAuthorize|PostAuthorize|Secured|RolesAllowed|Cacheable|CachePut|CacheEvict|Query)\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (!name) continue;
    const annotationName = occurrence[1]!;
    if (["KafkaListener", "RabbitListener", "EventListener"].includes(annotationName)) {
      const transport = annotationName === "KafkaListener" ? "kafka" : annotationName === "RabbitListener" ? "rabbitmq" : "spring-event";
      const destinationKey = transport === "kafka" ? "topics" : transport === "rabbitmq" ? "queues" : "value";
      addFinding(nodes, edges, file, moduleId, "listener", name, occurrence.index, { transport, destination: annotationArgument(annotation.source, destinationKey) ?? annotationArgument(annotation.source) ?? "dynamic" }, annotation.source.includes("${") ? "opaque" : "proven", true);
    } else if (annotationName === "Scheduled") addFinding(nodes, edges, file, moduleId, "schedule", name, occurrence.index, { cron: annotationArgument(annotation.source, "cron"), fixedDelay: annotationArgument(annotation.source, "fixedDelayString") }, annotation.source.includes("${") ? "inferred" : "proven", true);
    else if (annotationName === "Transactional") addFinding(nodes, edges, file, moduleId, "transaction", name, occurrence.index, { propagation: /propagation\s*=\s*Propagation\.(\w+)/u.exec(annotation.source)?.[1] ?? "REQUIRED" }, "proven", true);
    else if (["PreAuthorize", "PostAuthorize", "Secured", "RolesAllowed"].includes(annotationName)) addFinding(nodes, edges, file, moduleId, "security", name, occurrence.index, { declaration: annotation.source.trim() }, annotation.source.includes("+") ? "opaque" : "proven", true);
    else if (["Cacheable", "CachePut", "CacheEvict"].includes(annotationName)) addFinding(nodes, edges, file, moduleId, "cache", name, occurrence.index, { operation: annotationName, cache: annotationArgument(annotation.source, "cacheNames") ?? annotationArgument(annotation.source) }, annotation.source.includes("key =") ? "inferred" : "proven", true);
    else if (annotationName === "Query") addFinding(nodes, edges, file, moduleId, "query", name, occurrence.index, { query: annotationArgument(annotation.source), native: /nativeQuery\s*=\s*true/u.test(annotation.source) }, "proven", true);
  }

  for (const occurrence of source.matchAll(/@Bean\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (name) addFinding(nodes, edges, file, moduleId, "configuration", name, occurrence.index, { framework: "spring", role: "bean", beanName: annotationArgument(annotation.source) });
  }

  const messageClients = new Map<string, { readonly transport: string; readonly method: string }>();
  for (const client of source.matchAll(/\b(KafkaTemplate|StreamBridge|RabbitTemplate|ApplicationEventPublisher)(?:\s*<[^;=()]+>)?\s+([A-Za-z_$][\w$]*)/gu)) {
    const type = client[1]!;
    messageClients.set(client[2]!, { transport: type === "RabbitTemplate" ? "rabbitmq" : type === "ApplicationEventPublisher" ? "spring-event" : "kafka", method: type === "RabbitTemplate" ? "convertAndSend" : type === "ApplicationEventPublisher" ? "publishEvent" : "send" });
  }
  for (const [receiver, client] of messageClients) {
    const invocation = new RegExp(`\\b${receiver}\\s*\\.\\s*${client.method}\\s*\\(`, "gu");
    for (const occurrence of source.matchAll(invocation)) {
      const adapter = publisherAdapters.find((candidate) => candidate.start <= occurrence.index && occurrence.index <= candidate.end);
      if (adapter) addFinding(nodes, edges, file, moduleId, "publisher", adapter.name, occurrence.index, adapter.attributes, "proven", true);
      else addFinding(nodes, edges, file, moduleId, "publisher", `${receiver}.${client.method}`, occurrence.index, { role: "publish-operation", transport: client.transport }, "proven", true);
    }
  }

  const expressions: readonly [RegExp, NodeKind, Record<string, unknown>, boolean][] = [
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
  const dynamicRouting = /Class\.forName|Method\.invoke|\.getBean\s*\(|\bspel\b|GroovyShell|ScriptEngine|destinationResolver|resolveDestination/iu;
  if (dynamicRouting.test(source)) diagnostics.push({ code: "SPRING_DYNAMIC_ROUTING", severity: "warning", message: "Dynamic routing was retained as an opaque dependency.", source: span(file, source.search(dynamicRouting)) });
}

function matchingDelimiter(source: string, offset: number, open: string, close: string): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let cursor = offset; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === open) depth += 1;
    else if (character === close && --depth === 0) return cursor;
  }
  return undefined;
}

function methodBody(source: string, name: string, startLine: number): { readonly body: string; readonly offset: number } | undefined {
  const lineOffset = source.split(/(?<=\n)/u).slice(0, Math.max(0, startLine - 1)).join("").length;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declaration = new RegExp(`\\b${escaped}\\s*\\(`, "gu");
  declaration.lastIndex = lineOffset;
  const match = declaration.exec(source);
  if (!match || match.index - lineOffset > 8000) return undefined;
  const parametersStart = source.indexOf("(", match.index + name.length);
  const parametersEnd = matchingDelimiter(source, parametersStart, "(", ")");
  if (parametersEnd === undefined) return undefined;
  const bodyStart = source.indexOf("{", parametersEnd);
  if (bodyStart < 0 || bodyStart - parametersEnd > 2000) return undefined;
  const bodyEnd = matchingDelimiter(source, bodyStart, "{", "}");
  return bodyEnd === undefined ? undefined : { body: source.slice(bodyStart + 1, bodyEnd), offset: bodyStart + 1 };
}

function addSourceDependencyEdges(files: readonly SourceFile[], nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>): void {
  const filesByPath = new Map(files.map((file) => [file.relative, file]));
  const dependencyKinds = new Set<NodeKind>(["service", "repository", "vendor-call", "publisher"]);
  const candidates = [...nodes.values()].filter((node) => dependencyKinds.has(node.kind));
  const byName = new Map<string, DiscoveryNode[]>();
  for (const node of candidates) byName.set(node.name, [...byName.get(node.name) ?? [], node]);
  const resolveType = (type: string, file: SourceFile): DiscoveryNode | undefined => {
    const simple = type.replace(/<.*$/u, "").replace(/\[\]$/u, "").split(".").at(-1)!;
    const matches = byName.get(simple) ?? [];
    if (matches.length <= 1) return matches[0];
    const imported = new RegExp(`\\bimport\\s+([\\w.]+\\.${simple})\\s*;`, "u").exec(file.source)?.[1];
    return matches.find((node) => node.qualifiedName === imported) ?? matches.find((node) => node.module === moduleName(file)) ?? matches[0];
  };

  const fieldsByPath = new Map<string, Map<string, { readonly type: string; readonly offset: number }>>();
  for (const file of files.filter((candidate) => candidate.relative.endsWith(".java") && !isTestSource(candidate.relative))) {
    const fields = new Map<string, { readonly type: string; readonly offset: number }>();
    for (const match of file.source.matchAll(/\b(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?([A-Z][\w$.]*(?:\s*<[^;=]+>)?)\s+([A-Za-z_$][\w$]*)\s*(?:[;=])/gu)) fields.set(match[2]!, { type: match[1]!.replace(/\s+/gu, ""), offset: match.index });
    fieldsByPath.set(file.relative, fields);
  }

  for (const owner of candidates.filter((node) => node.kind === "service" || node.kind === "repository")) {
    const source = owner.sources[0];
    const file = source ? filesByPath.get(source.path) : undefined;
    if (!file) continue;
    for (const field of fieldsByPath.get(file.relative)?.values() ?? []) {
      const target = resolveType(field.type, file);
      if (!target || target.id === owner.id) continue;
      const edge: DiscoveryEdge = { id: stableId("edge", "depends-on", owner.id, target.id), kind: "depends-on", from: owner.id, to: target.id, confidence: "inferred", sources: [span(file, field.offset, `${owner.name}->${target.name}`)] };
      edges.set(edge.id, edge);
    }
  }

  for (const contract of candidates.filter((node) => typeof node.attributes.role === "string" && node.attributes.role.endsWith("-contract"))) {
    for (const implementation of candidates.filter((node) => node.kind === contract.kind && node.id !== contract.id)) {
      const source = implementation.sources[0];
      const file = source ? filesByPath.get(source.path) : undefined;
      if (!file || !new RegExp(`\\bimplements\\s+[^\\{;]*\\b${contract.name}\\b`, "u").test(file.source)) continue;
      const edge: DiscoveryEdge = { id: stableId("edge", "calls", contract.id, implementation.id), kind: "calls", from: contract.id, to: implementation.id, confidence: "inferred", sources: [span(file, file.source.search(new RegExp(`\\b${contract.name}\\b`, "u")), `${implementation.name} implements ${contract.name}`)] };
      edges.set(edge.id, edge);
    }
  }

  for (const entry of [...nodes.values()].filter((node) => ["endpoint", "listener", "schedule"].includes(node.kind))) {
    const source = entry.sources[0];
    const file = source ? filesByPath.get(source.path) : undefined;
    const body = file && source?.startLine ? methodBody(file.source, entry.name, source.startLine) : undefined;
    if (!file || !body) continue;
    const fields = fieldsByPath.get(file.relative) ?? new Map();
    for (const call of body.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/gu)) {
      const field = fields.get(call[1]!);
      const target = field ? resolveType(field.type, file) : undefined;
      if (!target || target.id === entry.id) continue;
      const edge: DiscoveryEdge = { id: stableId("edge", "calls", entry.id, target.id), kind: "calls", from: entry.id, to: target.id, confidence: "inferred", sources: [span(file, body.offset + call.index, `${target.name}.${call[2]}`)] };
      edges.set(edge.id, edge);
    }
  }
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
  const rootCoordinate = coordinates.get("root")?.split(":");
  const inheritedGroup = rootCoordinate?.[0] === "unknown" ? undefined : rootCoordinate?.[0];
  const inheritedVersion = rootCoordinate?.[2] === "inherited" ? undefined : rootCoordinate?.[2];
  for (const [module, coordinate] of coordinates) {
    if (module === "root") continue;
    const [group, artifact, version] = coordinate.split(":");
    coordinates.set(module, `${group === "unknown" ? inheritedGroup ?? group : group}:${artifact}:${version === "inherited" ? inheritedVersion ?? version : version}`);
  }
  files = files.map((file) => {
    const buildCoordinate = coordinates.get(moduleName(file));
    return buildCoordinate ? { ...file, buildCoordinate } : file;
  });
  const semanticFiles = files.filter((file) => !isTestSource(file.relative));
  const bytecode = files.some((file) => file.relative.endsWith(".java")) ? [] : await collectBytecode(root);
  if (files.length === 0 && bytecode.length === 0) throw new Error("No supported Spring source, build, or bytecode files were found.");
  const nodes = new Map<string, DiscoveryNode>();
  const edges = new Map<string, DiscoveryEdge>();
  const diagnostics: DiscoveryDiagnostic[] = [];
  const stringConstants = collectStringConstants(semanticFiles);
  const buildFiles = semanticFiles.filter((file) => file.relative.endsWith("pom.xml") || /(?:build|settings)\.gradle(?:\.kts)?$/u.test(file.relative));
  for (const build of buildFiles.length > 0 ? buildFiles : semanticFiles.length > 0 ? [semanticFiles[0]!] : []) {
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
  for (const file of semanticFiles) {
    const module = moduleName(file);
    const moduleId = stableId("module", module);
    if (!nodes.has(moduleId)) addNode(nodes, { id: moduleId, kind: "module", name: module, confidence: "proven", observable: false, attributes: { build: "inherited" }, sources: [span(file)] });
    if (file.relative.endsWith(".java")) discoverJava(file, moduleId, nodes, edges, diagnostics, stringConstants);
    else if (file.relative.endsWith(".kt")) {
      addFinding(nodes, edges, file, moduleId, "service", basename(file.relative, ".kt"), 0, { language: "kotlin", support: "inventory" }, "opaque", false, ["Deep Kotlin semantic extraction is not available in discovery v0.1."]);
      diagnostics.push({ code: "KOTLIN_INVENTORY_ONLY", severity: "warning", message: `${file.relative} was inventoried without deep Kotlin semantics.`, source: span(file) });
    } else if (/application.*\.(?:properties|ya?ml)$/u.test(file.relative)) addFinding(nodes, edges, file, moduleId, "configuration", basename(file.relative), 0, { format: extname(file.relative).slice(1), redacted: true }, "proven", false);
  }
  const openRewrite = analyzerRequested === "source" ? undefined : await runOpenRewrite(root);
  if (openRewrite) {
    const byPath = new Map(semanticFiles.map((file) => [file.relative, file]));
    for (const finding of openRewrite) {
      const file = byPath.get(finding.path);
      if (!file) continue;
      const existing = [...nodes.values()].find((node) => node.kind === finding.kind && node.name === finding.name && node.sources.some((source) => source.path === finding.path));
      if (existing) nodes.set(existing.id, { ...existing, confidence: "proven", attributes: { ...existing.attributes, analyzer: "openrewrite", analyzerVersion: "8.90.4", annotation: finding.annotation } });
      else addFinding(nodes, edges, file, stableId("module", moduleName(file)), finding.kind, finding.name, Math.max(0, file.source.split(/\r?\n/u).slice(0, Math.max(0, finding.line - 1)).join("\n").length), { analyzer: "openrewrite", analyzerVersion: "8.90.4", annotation: finding.annotation }, "proven", ["endpoint", "listener", "schedule", "vendor-call", "transaction", "query", "cache"].includes(finding.kind));
    }
  }
  addSourceDependencyEdges(semanticFiles, nodes, edges);
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

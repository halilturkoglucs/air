import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { contentHash, stableId } from "./ids.js";
import { DISCOVERY_API_VERSION, type Confidence, type CoverageDimension, type DiscoveryBundle, type DiscoveryDiagnostic, type DiscoveryEdge, type DiscoveryNode, type NodeKind, type SourceSpan, type SpringDiscoveryResult } from "./types.js";

const EXCLUDED = new Set([".git", ".gradle", ".idea", ".mvn", "build", "dist", "node_modules", "out", "target"]);
const SOURCE_EXTENSIONS = new Set([".java", ".kt", ".xml", ".properties", ".yml", ".yaml", ".sql"]);

interface SourceFile { readonly absolute: string; readonly relative: string; readonly source: string; readonly hash: string; readonly buildCoordinate?: string }
interface BytecodeFile { readonly relative: string; readonly hash: string }
interface OpenRewriteFinding { readonly path: string; readonly line: number; readonly kind: NodeKind; readonly name: string; readonly semantic: string; readonly annotation: string }
interface JavaAnnotation { readonly source: string; readonly end: number }
interface ControllerContext { readonly offset: number; readonly end: number; readonly path?: string; readonly pathExpression?: string }
interface JavaConstants { readonly simple: ReadonlyMap<string, string>; readonly qualified: ReadonlyMap<string, string> }
interface JavaParameter { readonly name: string; readonly javaType: string; readonly type: string; readonly source: string }
interface JavaMethod { readonly name: string; readonly returnJavaType: string; readonly returnType: string; readonly parameters: readonly JavaParameter[]; readonly descriptor: string }
interface OpenApiOperation { readonly operationId?: unknown }
interface OpenApiDocument { readonly servers?: readonly { readonly url?: unknown }[]; readonly paths?: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>> }
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
  return /(^|\/)src\/(?:test|[^/]*test|it)(?:\/|$)/iu.test(path);
}

function isEntryNode(node: DiscoveryNode): boolean {
  return ["endpoint", "listener", "schedule"].includes(node.kind) || (node.kind === "operation" && node.attributes.entryPoint === true);
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

function airType(javaType: string): "string" | "integer" | "number" | "boolean" | "uuid" | "date" | "datetime" | "json" {
  const type = javaType.replace(/\s+/gu, "").replace(/^(?:Optional|ResponseEntity|Mono|CompletableFuture)</u, "").replace(/^<|>$/gu, "").replace(/\?extends/u, "");
  const simple = type.split(/[.<]/u).at(-1)?.replace(/\[\]$/u, "") ?? type;
  if (["String", "char", "Character", "URI", "URL"].includes(simple)) return "string";
  if (["byte", "short", "int", "long", "Byte", "Short", "Integer", "Long", "BigInteger"].includes(simple)) return "integer";
  if (["float", "double", "Float", "Double", "BigDecimal"].includes(simple)) return "number";
  if (["boolean", "Boolean"].includes(simple)) return "boolean";
  if (simple === "UUID") return "uuid";
  if (simple === "LocalDate") return "date";
  if (["Date", "Instant", "LocalDateTime", "OffsetDateTime", "ZonedDateTime"].includes(simple)) return "datetime";
  return "json";
}

function stripJavaAnnotations(source: string): string {
  return source.replace(/@(?:[\w.]+)(?:\s*\((?:[^()"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\([^()]*\))*\))?\s*/gu, "").trim();
}

function methodSignatureFollowingAnnotation(source: string, start: number): JavaMethod | undefined {
  let cursor = start;
  while (cursor < source.length) {
    cursor = skipJavaTrivia(source, cursor);
    if (source[cursor] !== "@") break;
    const annotation = readJavaAnnotation(source, cursor);
    if (!annotation) break;
    cursor = annotation.end;
  }
  cursor = skipJavaTrivia(source, cursor);
  const open = source.indexOf("(", cursor);
  if (open < 0 || open - cursor > 2000) return undefined;
  const close = matchingDelimiter(source, open, "(", ")");
  if (close === undefined) return undefined;
  const prefix = source.slice(cursor, open).replace(/\s+/gu, " ").trim();
  if (/\b(?:class|interface|record|enum)\b/u.test(prefix)) return undefined;
  const name = /([A-Za-z_$][\w$]*)\s*$/u.exec(prefix)?.[1];
  if (!name) return undefined;
  const beforeName = prefix.slice(0, prefix.lastIndexOf(name)).trim().replace(/^(?:(?:public|protected|private|static|final|abstract|default|synchronized|native|strictfp)\s+)+/u, "").replace(/^<[^>]+>\s*/u, "");
  const returnJavaType = beforeName.split(/\s+/u).at(-1);
  if (!returnJavaType) return undefined;
  const parameters = splitTopLevel(source.slice(open + 1, close)).flatMap((parameter): JavaParameter[] => {
    const cleaned = stripJavaAnnotations(parameter).replace(/\bfinal\s+/gu, "").trim();
    const match = /([\w.$?<>,\[\]\s]+)\s+([A-Za-z_$][\w$]*)$/u.exec(cleaned);
    return match ? [{ name: match[2]!, javaType: match[1]!.trim(), type: airType(match[1]!), source: parameter.trim() }] : [];
  });
  return { name, returnJavaType, returnType: airType(returnJavaType), parameters, descriptor: `(${parameters.map((parameter) => parameter.javaType).join(",")})->${returnJavaType}` };
}

function javaFields(source: string, name: string, declarationKind: string, offset: number, declarationWindow: string): readonly Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];
  const add = (fieldName: string, javaType: string, annotations: string): void => {
    const validation: Record<string, unknown> = {};
    const size = annotationNamed(annotations, "Size");
    const minimum = annotationArgument(size ?? "", "min"); const maximum = annotationArgument(size ?? "", "max");
    if (minimum && /^\d+$/u.test(minimum)) validation.minLength = Number(minimum);
    if (maximum && /^\d+$/u.test(maximum)) validation.maxLength = Number(maximum);
    const min = annotationArgument(annotationNamed(annotations, "Min") ?? ""); const max = annotationArgument(annotationNamed(annotations, "Max") ?? "");
    if (min && /^-?\d+(?:\.\d+)?$/u.test(min)) validation.minimum = Number(min);
    if (max && /^-?\d+(?:\.\d+)?$/u.test(max)) validation.maximum = Number(max);
    const pattern = annotationArgument(annotationNamed(annotations, "Pattern") ?? "", "regexp") ?? annotationArgument(annotationNamed(annotations, "Pattern") ?? "");
    if (pattern) validation.pattern = pattern;
    const primitive = /^(?:byte|short|int|long|float|double|boolean|char)$/u.test(javaType.trim());
    const required = primitive || /@(NotNull|NotBlank)\b/u.test(annotations) || /@Column\s*\([^)]*nullable\s*=\s*false/u.test(annotations);
    const columnName = annotationArgument(annotationNamed(annotations, "Column") ?? "", "name");
    const primaryKey = /@Id\b/u.test(annotations);
    const generated = /@GeneratedValue\b/u.test(annotations) ? airType(javaType) === "uuid" ? "uuid" : "auto-increment" : undefined;
    fields.push({ name: fieldName, javaType: javaType.trim(), type: airType(javaType), required, nullable: !required, ...(primaryKey ? { primaryKey: true } : {}), ...(/@Column\s*\([^)]*unique\s*=\s*true/u.test(annotations) ? { unique: true } : {}), ...(generated ? { generated } : {}), ...(columnName ? { column: columnName } : {}), ...(Object.keys(validation).length > 0 ? { validation } : {}) });
  };
  if (declarationKind === "record") {
    const declaration = new RegExp(`\\brecord\\s+${name}\\s*\\(`, "gu"); declaration.lastIndex = offset;
    const match = declaration.exec(source); const open = match ? source.indexOf("(", match.index) : -1; const close = open >= 0 ? matchingDelimiter(source, open, "(", ")") : undefined;
    if (open >= 0 && close !== undefined) for (const component of splitTopLevel(source.slice(open + 1, close))) {
      const cleaned = stripJavaAnnotations(component); const parsed = /([\w.$?<>,\[\]\s]+)\s+([A-Za-z_$][\w$]*)$/u.exec(cleaned);
      if (parsed) add(parsed[2]!, parsed[1]!, component);
    }
  } else {
    const fieldPattern = /(?:^|\n)\s*((?:@(?:[\w.]+)(?:\s*\([^\n;]*\))?\s*)*)(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?([\w.$?<>,\[\]]+)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/gu;
    for (const field of declarationWindow.matchAll(fieldPattern)) add(field[3]!, field[2]!, field[1] ?? "");
  }
  return fields;
}

function httpOperations(source: string, start: number, end: number, constants: JavaConstants, file: SourceFile): readonly Record<string, unknown>[] {
  const operations: Record<string, unknown>[] = [];
  const pattern = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b/gu; pattern.lastIndex = start;
  let occurrence: RegExpExecArray | null;
  while ((occurrence = pattern.exec(source)) !== null && occurrence.index < end) {
    const annotation = readJavaAnnotation(source, occurrence.index); if (!annotation) continue;
    const signature = methodSignatureFollowingAnnotation(source, annotation.end); if (!signature) continue;
    const route = mappingPath(annotation.source, constants, file);
    const method = occurrence[1] === "Request" ? (/method\s*=\s*RequestMethod\.(\w+)/u.exec(annotation.source)?.[1] ?? "GET") : occurrence[1]!.toUpperCase();
    operations.push({ name: signature.name, method, ...(route.path ? { path: route.path } : {}), ...(route.pathExpression ? { pathExpression: route.pathExpression } : {}), inputType: signature.parameters.find((parameter) => /@RequestBody\b/u.test(parameter.source))?.javaType ?? signature.parameters.find((parameter) => airType(parameter.javaType) === "json")?.javaType, outputType: signature.returnJavaType, outputPrimitive: signature.returnType, parameters: signature.parameters, jvmDescriptor: signature.descriptor });
  }
  return operations;
}

function mapperMetadata(source: string): Readonly<Record<string, unknown>> {
  const method = /(?:^|\n)\s*(?:public\s+|default\s+|abstract\s+)*([A-Za-z_$][\w$<>., ?]*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:;|\{)/mu.exec(source);
  const parameter = method ? splitTopLevel(method[3] ?? "")[0] : undefined;
  const inputType = parameter ? /([\w.$?<>,\[\]]+)\s+[A-Za-z_$][\w$]*$/u.exec(stripJavaAnnotations(parameter))?.[1] : undefined;
  const mappings = [...source.matchAll(/@Mapping\s*\(([^)]*)\)/gu)].flatMap((match) => {
    const annotation = `@Mapping(${match[1]})`;
    const from = annotationArgument(annotation, "source"); const to = annotationArgument(annotation, "target");
    return from && to ? [{ source: from, target: to }] : [];
  });
  return { ...(inputType ? { inputType } : {}), ...(method?.[1] ? { outputType: method[1].trim() } : {}), mappings };
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

function annotationsBeforeDeclaration(source: string, declarationOffset: number): string {
  const searchStart = Math.max(0, declarationOffset - 16_384);
  let earliest = declarationOffset;
  const annotationPattern = /@(?:[\w.]+)(?=\s|\()/gu;
  annotationPattern.lastIndex = searchStart;
  let match: RegExpExecArray | null;
  while ((match = annotationPattern.exec(source)) !== null && match.index < declarationOffset) {
    const first = readJavaAnnotation(source, match.index);
    if (!first || first.end > declarationOffset) continue;
    let cursor = first.end;
    while (cursor < declarationOffset) {
      cursor = skipJavaTrivia(source, cursor);
      if (source[cursor] !== "@") break;
      const next = readJavaAnnotation(source, cursor);
      if (!next || next.end > declarationOffset) break;
      cursor = next.end;
    }
    if (skipJavaTrivia(source, cursor) === declarationOffset) earliest = Math.min(earliest, match.index);
  }
  return source.slice(earliest, declarationOffset);
}

function javaStructure(source: string): string {
  const output = [...source];
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") { output[index] = " "; output[index + 1] = " "; index += 1; blockComment = false; }
      else if (character !== "\n" && character !== "\r") output[index] = " ";
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      if (character !== "\n" && character !== "\r") output[index] = " ";
      continue;
    }
    if (character === "/" && next === "/") { output[index] = " "; output[index + 1] = " "; index += 1; lineComment = true; }
    else if (character === "/" && next === "*") { output[index] = " "; output[index + 1] = " "; index += 1; blockComment = true; }
    else if (character === "\"" || character === "'") { output[index] = " "; quote = character; }
  }
  return output.join("");
}

const JAVA_TYPE_DECLARATION = /\b(?:(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp)\s+)*(class|interface|record|enum)\s+(\w+)/gmu;

function controllerRanges(file: SourceFile): readonly { readonly start: number; readonly end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const declarations = new RegExp(JAVA_TYPE_DECLARATION.source, JAVA_TYPE_DECLARATION.flags);
  for (const match of javaStructure(file.source).matchAll(declarations)) {
    if (!["class", "record"].includes(match[1] ?? "")) continue;
    if (!/@(?:RestController|Controller)\b/u.test(annotationsBeforeDeclaration(file.source, match.index))) continue;
    const open = file.source.indexOf("{", match.index + match[0].length);
    const close = open >= 0 ? matchingDelimiter(file.source, open, "{", "}") : undefined;
    if (open >= 0) ranges.push({ start: open, end: close ?? file.source.length });
  }
  return ranges;
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

function springContextPath(files: readonly SourceFile[]): string {
  for (const file of files.filter((candidate) => /application.*\.properties$/u.test(candidate.relative))) {
    const value = /^\s*server\.servlet\.context-path\s*=\s*([^#\r\n]+)/mu.exec(file.source)?.[1]?.trim();
    if (value) return value === "/" ? "" : `/${value.replace(/^\/+|\/+$/gu, "")}`;
  }
  return "";
}

function openApiBasePath(document: OpenApiDocument, contextPath: string): string {
  const server = document.servers?.find((candidate) => typeof candidate.url === "string")?.url;
  if (typeof server !== "string" || server.includes("{")) return "";
  try {
    const path = new URL(server, "http://air.invalid").pathname.replace(/\/$/u, "");
    return contextPath && (path === contextPath || path.startsWith(`${contextPath}/`)) ? path.slice(contextPath.length) : path;
  } catch { return ""; }
}

function discoverOpenApi(files: readonly SourceFile[], nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>): void {
  const java = files.filter((file) => file.relative.endsWith(".java") && /@(?:RestController|Controller)\b/u.test(file.source)).map((file) => ({ file, ranges: controllerRanges(file) }));
  const contextPath = springContextPath(files);
  for (const contract of files.filter((file) => /(^|\/)(?:openapi|swagger)\.ya?ml$/iu.test(file.relative))) {
    let document: OpenApiDocument;
    try { document = parseYaml(contract.source) as OpenApiDocument; } catch { continue; }
    const base = openApiBasePath(document, contextPath);
    for (const [route, pathItem] of Object.entries(document.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = pathItem[method];
        if (!operation) continue;
        const operationId = typeof operation.operationId === "string" && operation.operationId.trim() ? operation.operationId.trim() : `${method}-${route}`;
        const path = joinRoute(base, route);
        const escaped = operationId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const declaration = new RegExp(`\\b(?:public|protected)\\s+(?:(?:static|final|synchronized|abstract|default|native|strictfp)\\s+)*(?:<[^>{};]+>\\s*)?[^{};=]{1,300}?\\b${escaped}\\s*\\(`, "gu");
        const implementations = java.flatMap(({ file, ranges }) => [...file.source.matchAll(declaration)].filter((match) => ranges.some((range) => range.start < match.index && match.index < range.end)).map((match) => ({ file, offset: match.index + match[0].lastIndexOf(operationId) })));
        const contractOffset = contract.source.indexOf(`operationId: ${operationId}`);
        const attributes = { method: method.toUpperCase(), path, operationId, framework: "openapi-spring", contract: contract.relative };
        if (implementations.length === 1) {
          const implementation = implementations[0]!;
          const moduleId = stableId("module", moduleName(implementation.file));
          const endpoint = addFinding(nodes, edges, implementation.file, moduleId, "endpoint", operationId, implementation.offset, attributes, "proven", true);
          addNode(nodes, { ...endpoint, sources: [...endpoint.sources, span(contract, Math.max(0, contractOffset), operationId)] });
        } else {
          const moduleId = stableId("module", moduleName(contract));
          const endpoint = addFinding(nodes, edges, contract, moduleId, "endpoint", operationId, Math.max(0, contractOffset), { ...attributes, implementationMatches: implementations.length }, "inferred", true, [implementations.length === 0 ? "OpenAPI operation has no uniquely attributed source implementation." : "OpenAPI operation matches multiple source implementations."]);
          addNode(nodes, endpoint);
        }
      }
    }
  }
}

function discoverSql(file: SourceFile, moduleId: string, nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>): void {
  const createTable = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([A-Za-z_][\w$]*)"|([A-Za-z_][\w$]*))\s*\.\s*)?(?:"([A-Za-z_][\w$]*)"|([A-Za-z_][\w$]*))/giu;
  for (const match of file.source.matchAll(createTable)) {
    const schema = match[1] ?? match[2] ?? "public";
    const table = match[3] ?? match[4];
    if (table) addFinding(nodes, edges, file, moduleId, "table", table, match.index, { database: "postgresql", schema, table, source: "migration" }, "proven", true);
  }
}

function discoverJava(file: SourceFile, moduleId: string, nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>, diagnostics: DiscoveryDiagnostic[], constants: JavaConstants): void {
  const source = file.source;
  const controllers: ControllerContext[] = [];
  const publisherAdapters: { readonly name: string; readonly attributes: Record<string, unknown>; readonly start: number; readonly end: number }[] = [];
  const classMatch = new RegExp(JAVA_TYPE_DECLARATION.source, JAVA_TYPE_DECLARATION.flags);
  const structure = javaStructure(source);
  let match: RegExpExecArray | null;
  while ((match = classMatch.exec(structure)) !== null) {
    const annotations = annotationsBeforeDeclaration(source, match.index);
    const declarationKind = match[1] ?? "class";
    const name = match[2] ?? "Anonymous";
    const offset = match.index;
    const recordOpen = declarationKind === "record" ? source.indexOf("(", match.index + match[0].length) : -1;
    const recordClose = recordOpen >= 0 ? matchingDelimiter(source, recordOpen, "(", ")") : undefined;
    const bodyOpen = source.indexOf("{", recordClose === undefined ? match.index + match[0].length : recordClose + 1);
    const bodyClose = bodyOpen >= 0 ? matchingDelimiter(source, bodyOpen, "{", "}") : undefined;
    const declarationWindow = source.slice(offset, bodyClose === undefined ? offset + 1200 : bodyClose + 1);
    const recordComponents = declarationKind === "record" ? recordComponentNames(source, name, offset) : [];
    const fieldDetails = javaFields(source, name, declarationKind, offset, declarationWindow);
    const validation = [...declarationWindow.matchAll(/@(NotNull|NotBlank|Null|Size|Min|Max|DecimalMin|DecimalMax|Positive|PositiveOrZero|Negative|NegativeOrZero|Pattern|Email|AssertTrue|AssertFalse|Future|FutureOrPresent|Past|PastOrPresent)\b/gu)].map((item) => item[1]!);
    const serialization = [...declarationWindow.matchAll(/@(JsonProperty|JsonAlias|JsonIgnore|JsonFormat)\b/gu)].map((item) => item[1]!);
    const controller = /@(?:RestController|Controller)\b/u.test(annotations);
    const graphqlController = controller && /@(QueryMapping|MutationMapping|SubscriptionMapping)\b/u.test(declarationWindow);
    const profile = annotationArgument(annotationNamed(annotations, "Profile") ?? "");
    const conditional = annotationNamed(annotations, "ConditionalOnProperty");
    const publisherTransport = /\b(?:KafkaTemplate|StreamBridge)\b/u.test(declarationWindow) ? "kafka" : /\bRabbitTemplate\b/u.test(declarationWindow) ? "rabbitmq" : /\bApplicationEventPublisher\b/u.test(declarationWindow) ? "spring-event" : undefined;
    if (controller) {
      const mappingOffset = annotations.search(/@RequestMapping\b/u);
      const mapping = mappingOffset >= 0 ? readJavaAnnotation(annotations, mappingOffset) : undefined;
      controllers.push({ offset, end: bodyClose ?? source.length, ...(mapping ? mappingPath(mapping.source, constants, file) : { path: "/" }) });
    }
    if (/@(?:Entity|Document)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "entity", name, offset, { persistence: /@Entity/u.test(annotations) ? "jpa" : "document", role: "entity", table: annotationArgument(annotationNamed(annotations, "Table") ?? "", "name") ?? name, fields: fieldDetails, relationships: [...declarationWindow.matchAll(/@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b/gu)].map((item) => item[1]!) }, "proven", true);
    else if (/@MappedSuperclass\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "entity", name, offset, { persistence: "jpa", role: "mapped-superclass" }, "proven", false);
    else if (controller) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: graphqlController ? "spring-graphql" : "spring", role: graphqlController ? "graphql-controller" : "http-controller" });
    else if (/@ConfigurationProperties\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "configuration", name, offset, { framework: "spring", role: "configuration-properties", prefix: annotationArgument(annotations) });
    else if (/@Configuration\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "configuration", name, offset, { framework: "spring", role: "configuration-class", ...(conditional ? { condition: { property: annotationArgument(conditional, "name"), havingValue: annotationArgument(conditional, "havingValue") } } : {}), ...(profile ? { profiles: [profile] } : {}) });
    else if (/@(?:FeignClient)\b/u.test(annotations)) {
      const target = annotationArgument(annotations, "name") ?? annotationArgument(annotations) ?? "dynamic";
      const binding = annotationArgument(annotations, "url");
      addFinding(nodes, edges, file, moduleId, "vendor-call", name, offset, { client: "feign", target, ...(binding ? { bindingProperty: binding } : {}), operations: httpOperations(source, bodyOpen >= 0 ? bodyOpen : offset, bodyClose ?? source.length, constants, file) }, binding?.includes("${") ? "inferred" : "proven", true);
    }
    else if (/(?:Repository|JpaRepository|CrudRepository|PagingAndSortingRepository)\b/u.test(match[0]) || /@Repository\b/u.test(annotations)) {
      const contract = declarationKind === "interface" && !profile && !/extends\s+[^\{;]*\b(?:Repository|JpaRepository|CrudRepository|PagingAndSortingRepository)\s*</u.test(declarationWindow);
      const persistence = profile === "jdbc" ? "jdbc" : profile === "spring-data-jpa" ? "spring-data-jpa" : profile === "jpa" || /\bEntityManager\b/u.test(declarationWindow) ? "jpa" : contract ? "abstract" : "jpa";
      const entityType = /extends\s+[^\{;]*\b(?:Repository|JpaRepository|CrudRepository|PagingAndSortingRepository)\s*<\s*([\w.]+)/u.exec(declarationWindow)?.[1];
      addFinding(nodes, edges, file, moduleId, "repository", name, offset, { persistence, role: contract ? "repository-contract" : "repository-adapter", ...(entityType ? { entityType: entityType.split(".").at(-1) } : {}), ...(profile ? { profiles: [profile] } : {}) }, contract ? "inferred" : "proven", true);
    }
    else if (/(?:DAO|Dao)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "repository", name, offset, { persistence: "custom-dao" }, "inferred", true, ["Custom DAO semantics require source or runtime evidence before extraction."]);
    else if (declarationKind === "interface" && /(?:Publisher|Producer)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "publisher", name, offset, { framework: "java", role: "publisher-contract", transport: "dynamic" }, "inferred", true);
    else if (publisherTransport && /(?:Publisher|Producer)$/u.test(name)) {
      const attributes = { framework: "spring", role: "publisher-adapter", transport: publisherTransport, ...(profile ? { profiles: [profile] } : {}) };
      addFinding(nodes, edges, file, moduleId, "publisher", name, offset, attributes, "proven", true);
      publisherAdapters.push({ name, attributes, start: offset, end: bodyClose ?? source.length });
    } else if (declarationKind === "interface" && /Service$/u.test(name)) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: "java", role: "service-contract" }, "inferred");
    else if (/@(?:JsonDeserialize|JsonSerialize|Valid|Validated)\b/u.test(annotations) || /(?:Request|Response|Dto|DTO|Payload|Command|Result)$/u.test(name)) addFinding(nodes, edges, file, moduleId, "contract", name, offset, { boundary: /(?:Request|Response|Payload|Command|Result)$/u.test(name), serialization: serialization.length > 0 || /@Json/u.test(annotations) ? "jackson" : "java", fields: recordComponents.length > 0 ? recordComponents : fieldDetails.map((field) => field.name), fieldDetails, validation: [...new Set(validation)] });
    else if (/Mapper$/u.test(name) || /@Mapper\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "mapper", name, offset, { implementation: /@Mapper/u.test(annotations) ? "mapstruct" : "manual", ...mapperMetadata(declarationWindow) }, /\b(?:Repository|WebClient|RestClient)\b/u.test(declarationWindow) ? "opaque" : "inferred", false, /\b(?:Repository|WebClient|RestClient)\b/u.test(declarationWindow) ? ["Mapper performs a lookup or effect and cannot be reduced to a pure transformation."] : undefined);
    else if (/@(?:Service|Component)\b/u.test(annotations)) addFinding(nodes, edges, file, moduleId, "service", name, offset, { framework: "spring", role: /@Service\b/u.test(annotations) ? "service" : "component", ...(profile ? { profiles: [profile] } : {}) });

    const caffeineOffset = declarationWindow.search(/\bCaffeine\s*\.\s*newBuilder\s*\(/u);
    if (caffeineOffset >= 0 && /\b(?:Cache|LoadingCache)\s*</u.test(declarationWindow)) {
      addFinding(nodes, edges, file, moduleId, "cache", name, offset + caffeineOffset, {
        provider: "caffeine",
        role: "programmatic-cache",
        loading: /\bLoadingCache\s*</u.test(declarationWindow),
        invalidation: /\.invalidate(?:All)?\s*\(/u.test(declarationWindow),
      }, "inferred", true, ["Programmatic Caffeine policy, keys, loader effects, and invalidation behavior require review before semantic extraction."]);
    }

    const header = source.slice(offset, bodyOpen >= 0 ? bodyOpen : Math.min(source.length, offset + 1000));
    if (declarationKind === "class" && /\bimplements\s+[^\{;]*\bRunnable\b/u.test(header)) {
      const run = /\b(?:public\s+)?void\s+run\s*\(\s*\)/gu;
      run.lastIndex = bodyOpen >= 0 ? bodyOpen : offset;
      const runMethod = run.exec(source);
      if (runMethod && runMethod.index < (bodyClose ?? source.length)) {
        const task = addFinding(nodes, edges, file, moduleId, "operation", name, runMethod.index, { framework: "spring", role: "runnable-task", entryPoint: true, method: "run", selector: `${name[0]!.toLowerCase()}${name.slice(1)}` }, "inferred", true, ["Runnable task invocation is selected outside the application or through runtime configuration; review its scheduler/deployer binding."]);
        const owner = [...nodes.values()].find((node) => node.kind === "service" && node.name === name && node.sources.some((item) => item.path === file.relative));
        if (owner) edges.set(stableId("edge", "calls", task.id, owner.id), { id: stableId("edge", "calls", task.id, owner.id), kind: "calls", from: task.id, to: owner.id, confidence: "inferred", sources: [span(file, runMethod.index, `${name}.run`)] });
      }
    }
  }

  for (const occurrence of source.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (!name) continue;
    const local = mappingPath(annotation.source, constants, file);
    const controller = controllers.find((candidate) => candidate.offset < occurrence.index && occurrence.index < candidate.end);
    if (!controller) continue;
    const unresolved = controller?.pathExpression !== undefined || local.pathExpression !== undefined;
    const path = unresolved ? undefined : local.path !== undefined && controller?.path !== undefined ? joinRoute(controller.path, local.path) : local.path;
    const pathExpression = unresolved ? [controller?.pathExpression ?? (controller?.path !== undefined ? JSON.stringify(controller.path) : undefined), local.pathExpression ?? (local.path !== undefined ? JSON.stringify(local.path) : undefined)].filter(Boolean).join(" + ") : undefined;
    const verb = occurrence[1] === "Request" ? (/method\s*=\s*RequestMethod\.(\w+)/u.exec(annotation.source)?.[1] ?? "GET") : occurrence[1]?.toUpperCase();
    const signature = methodSignatureFollowingAnnotation(source, annotation.end);
    addFinding(nodes, edges, file, moduleId, "endpoint", name, occurrence.index, { method: verb, ...(path !== undefined ? { path } : {}), ...(pathExpression ? { pathExpression } : {}), framework: "spring-mvc", ...(signature ? { inputType: signature.parameters.find((parameter) => /@RequestBody\b/u.test(parameter.source))?.javaType, outputType: signature.returnJavaType, outputPrimitive: signature.returnType, parameters: signature.parameters, jvmDescriptor: signature.descriptor } : {}) }, pathExpression ? "inferred" : "proven", true, pathExpression ? ["Route contains a source expression that requires build attribution or review."] : undefined);
  }

  for (const occurrence of source.matchAll(/@(QueryMapping|MutationMapping|SubscriptionMapping)\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (!name) continue;
    const operation = occurrence[1] === "QueryMapping" ? "query" : occurrence[1] === "MutationMapping" ? "mutation" : "subscription";
    addFinding(nodes, edges, file, moduleId, "endpoint", name, occurrence.index, { method: "POST", path: "/graphql", protocol: "graphql", operation, field: annotationArgument(annotation.source) ?? name, framework: "spring-graphql" }, "proven", true);
  }

  for (const occurrence of source.matchAll(/@(KafkaListener|RabbitListener|TransactionalEventListener|EventListener|Scheduled|Transactional|PreAuthorize|PostAuthorize|Secured|RolesAllowed|Cacheable|CachePut|CacheEvict|Query)\b/gu)) {
    const annotation = readJavaAnnotation(source, occurrence.index);
    if (!annotation) continue;
    const name = methodFollowingAnnotation(source, annotation.end);
    if (!name) continue;
    const signature = methodSignatureFollowingAnnotation(source, annotation.end);
    const annotationName = occurrence[1]!;
    if (["KafkaListener", "RabbitListener", "EventListener", "TransactionalEventListener"].includes(annotationName)) {
      const transport = annotationName === "KafkaListener" ? "kafka" : annotationName === "RabbitListener" ? "rabbitmq" : "spring-event";
      const destinationKey = transport === "kafka" ? "topics" : transport === "rabbitmq" ? "queues" : "value";
      const eventType = signature?.parameters[0]?.javaType;
      addFinding(nodes, edges, file, moduleId, "listener", name, occurrence.index, {
        transport,
        destination: annotationArgument(annotation.source, destinationKey) ?? annotationArgument(annotation.source) ?? eventType ?? "dynamic",
        ...(annotationName === "TransactionalEventListener" ? { transactional: true, phase: annotationArgument(annotation.source, "phase") ?? /phase\s*=\s*TransactionPhase\.(\w+)/u.exec(annotation.source)?.[1] ?? "AFTER_COMMIT" } : {}),
        ...(signature ? { inputType: eventType, outputType: signature.returnJavaType, parameters: signature.parameters, jvmDescriptor: signature.descriptor } : {}),
      }, annotation.source.includes("${") ? "opaque" : "proven", true);
    } else if (annotationName === "Scheduled") addFinding(nodes, edges, file, moduleId, "schedule", name, occurrence.index, { cron: annotationArgument(annotation.source, "cron"), fixedDelay: annotationArgument(annotation.source, "fixedDelayString"), ...(signature ? { outputType: signature.returnJavaType, parameters: signature.parameters, jvmDescriptor: signature.descriptor } : {}) }, annotation.source.includes("${") ? "inferred" : "proven", true);
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

  for (const client of source.matchAll(/\b(BlobServiceClient|BlobContainerClient|CloudBlobClient|IdamClient|AuthTokenGenerator)\s+([A-Za-z_$][\w$]*)/gu)) {
    const type = client[1]!;
    const provider = type.startsWith("Blob") || type.startsWith("CloudBlob") ? "azure-blob" : type === "IdamClient" ? "idam" : "service-auth";
    addFinding(nodes, edges, file, moduleId, "foreign-operation", type, client.index, { provider, interface: type }, "opaque", true, ["External SDK behavior is retained as a typed foreign operation until runtime evidence verifies it."]);
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

function serviceMethodInventory(file: SourceFile, owner: DiscoveryNode, fields: ReadonlyMap<string, { readonly type: string; readonly offset: number }>): readonly Record<string, unknown>[] {
  const source = file.source;
  const startOffset = source.split(/(?<=\n)/u).slice(0, Math.max(0, (owner.sources[0]?.startLine ?? 1) - 1)).join("").length;
  const escapedOwner = owner.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declaration = new RegExp(`\\b(?:class|record)\\s+${escapedOwner}\\b`, "gu");
  declaration.lastIndex = startOffset;
  const type = declaration.exec(source);
  const classOpen = type ? source.indexOf("{", type.index + type[0].length) : -1;
  const classClose = classOpen >= 0 ? matchingDelimiter(source, classOpen, "{", "}") : undefined;
  if (classOpen < 0 || classClose === undefined) return [];
  const region = source.slice(classOpen + 1, classClose);
  const regionStructure = javaStructure(region);
  const headers: { readonly name: string; readonly bodyStart: number; readonly bodyEnd: number }[] = [];
  const methodPattern = /(?:^|\n)\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|synchronized|default)\s+)*(?:<[^>{};]+>\s*)?[A-Za-z_$][\w$?.<>,\[\]]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{}]+)?\{/gu;
  for (const match of regionStructure.matchAll(methodPattern)) {
    const name = match[1]!;
    const bodyStart = classOpen + 1 + match.index + match[0].lastIndexOf("{");
    const bodyEnd = matchingDelimiter(source, bodyStart, "{", "}");
    if (bodyEnd !== undefined && bodyEnd <= classClose) headers.push({ name, bodyStart, bodyEnd });
  }
  const methodNames = new Set(headers.map((item) => item.name));
  return headers.map((method) => {
    const body = source.slice(method.bodyStart + 1, method.bodyEnd);
    const calls: { receiver: string; target: string; operation: string; order: number; line: number }[] = [];
    const occupied = new Set<number>();
    for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\.|::)\s*([A-Za-z_$][\w$]*)\s*(?:\(|\b)/gu)) {
      const field = fields.get(call[1]!);
      if (!field) continue;
      calls.push({ receiver: call[1]!, target: field.type.replace(/<.*$/u, "").split(".").at(-1)!, operation: call[2]!, order: method.bodyStart + 1 + call.index, line: lineOf(source, method.bodyStart + 1 + call.index) });
      occupied.add(call.index);
    }
    for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
      if (occupied.has(call.index) || /[.:]\s*$/u.test(body.slice(0, call.index)) || !methodNames.has(call[1]!)) continue;
      calls.push({ receiver: "this", target: owner.name, operation: call[1]!, order: method.bodyStart + 1 + call.index, line: lineOf(source, method.bodyStart + 1 + call.index) });
    }
    return { name: method.name, calls: calls.sort((left, right) => left.order - right.order).map(({ receiver, target, operation, line }) => ({ receiver, target, operation, line })) };
  }).filter((method) => (method.calls as readonly unknown[]).length > 0);
}

function addSourceDependencyEdges(files: readonly SourceFile[], nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>): void {
  const filesByPath = new Map(files.map((file) => [file.relative, file]));
  const dependencyKinds = new Set<NodeKind>(["service", "repository", "vendor-call", "publisher", "foreign-operation"]);
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
    if (owner.kind === "service") {
      const methods = serviceMethodInventory(file, owner, fieldsByPath.get(file.relative) ?? new Map());
      if (methods.length > 0) nodes.set(owner.id, { ...nodes.get(owner.id)!, attributes: { ...nodes.get(owner.id)!.attributes, methods } });
    }
  }

  for (const contract of candidates.filter((node) => typeof node.attributes.role === "string" && node.attributes.role.endsWith("-contract"))) {
    for (const implementation of candidates.filter((node) => node.kind === contract.kind && node.id !== contract.id)) {
      const source = implementation.sources[0];
      const file = source ? filesByPath.get(source.path) : undefined;
      if (!file || !new RegExp(`\\b(?:implements|extends)\\s+[^\\{;]*\\b${contract.name}\\b`, "u").test(file.source)) continue;
      const edge: DiscoveryEdge = { id: stableId("edge", "calls", contract.id, implementation.id), kind: "calls", from: contract.id, to: implementation.id, confidence: "inferred", sources: [span(file, file.source.search(new RegExp(`\\b${contract.name}\\b`, "u")), `${implementation.name} implements ${contract.name}`)] };
      edges.set(edge.id, edge);
    }
  }

  for (const entry of [...nodes.values()].filter(isEntryNode)) {
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

function referencedType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const unwrapped = value.replace(/^(?:ResponseEntity|Optional|Mono|Flux|CompletableFuture|List|Set|Collection|Page)\s*</u, "").replace(/>+$/gu, "");
  const name = unwrapped.split(/[.,\s]/u).filter(Boolean).at(-1);
  return name && !["void", "Void", "Object", "String", "boolean", "Boolean", "int", "Integer", "long", "Long"].includes(name) ? name : undefined;
}

function addSemanticTypeEdges(nodes: Map<string, DiscoveryNode>, edges: Map<string, DiscoveryEdge>): void {
  const types = [...nodes.values()].filter((node) => node.kind === "contract" || node.kind === "entity");
  const byName = new Map(types.map((node) => [node.name, node]));
  const connect = (from: DiscoveryNode, type: unknown, kind: DiscoveryEdge["kind"]): void => {
    const target = byName.get(referencedType(type) ?? "");
    if (!target || target.id === from.id) return;
    const sources = [...from.sources, ...target.sources].slice(0, 2);
    const edge: DiscoveryEdge = { id: stableId("edge", kind, from.id, target.id), kind, from: from.id, to: target.id, confidence: "inferred", sources };
    edges.set(edge.id, edge);
  };
  for (const node of nodes.values()) {
    if (isEntryNode(node)) {
      connect(node, node.attributes.inputType, "maps");
      connect(node, node.attributes.outputType, "maps");
    }
    if (node.kind === "repository") connect(node, node.attributes.entityType, "depends-on");
    if (node.kind === "vendor-call" && Array.isArray(node.attributes.operations)) for (const value of node.attributes.operations) {
      if (!value || typeof value !== "object") continue;
      const operation = value as Record<string, unknown>;
      connect(node, operation.inputType, "maps"); connect(node, operation.outputType, "maps");
    }
  }
  const normalizeRelation = (value: unknown): string => typeof value === "string" ? value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase() : "";
  const tables = [...nodes.values()].filter((node) => node.kind === "table");
  for (const entity of [...nodes.values()].filter((node) => node.kind === "entity")) {
    const identity = normalizeRelation(entity.attributes.table ?? entity.name);
    const matches = tables.filter((table) => normalizeRelation(table.attributes.table ?? table.name) === identity);
    if (matches.length !== 1) continue;
    const table = matches[0]!;
    const edge: DiscoveryEdge = { id: stableId("edge", "maps", entity.id, table.id), kind: "maps", from: entity.id, to: table.id, confidence: "inferred", sources: [...entity.sources, ...table.sources].slice(0, 2) };
    edges.set(edge.id, edge);
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
    else if (file.relative.endsWith(".sql")) discoverSql(file, moduleId, nodes, edges);
  }
  discoverOpenApi(semanticFiles, nodes, edges);
  const openRewrite = analyzerRequested === "source" ? undefined : await runOpenRewrite(root);
  if (openRewrite) {
    const byPath = new Map(semanticFiles.map((file) => [file.relative, file]));
    for (const finding of openRewrite) {
      const file = byPath.get(finding.path);
      if (!file) continue;
      const existing = [...nodes.values()].find((node) => node.kind === finding.kind && node.name === finding.name && node.sources.some((source) => source.path === finding.path));
      if (existing) nodes.set(existing.id, { ...existing, attributes: { ...existing.attributes, analyzer: "openrewrite", analyzerVersion: "8.90.4", annotation: finding.annotation } });
      else addFinding(nodes, edges, file, stableId("module", moduleName(file)), finding.kind, finding.name, Math.max(0, file.source.split(/\r?\n/u).slice(0, Math.max(0, finding.line - 1)).join("\n").length), { analyzer: "openrewrite", analyzerVersion: "8.90.4", annotation: finding.annotation }, "proven", ["endpoint", "listener", "schedule", "vendor-call", "transaction", "query", "cache"].includes(finding.kind));
    }
  }
  addSourceDependencyEdges(semanticFiles, nodes, edges);
  addSemanticTypeEdges(nodes, edges);
  const entries = [...nodes.values()].filter(isEntryNode);
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

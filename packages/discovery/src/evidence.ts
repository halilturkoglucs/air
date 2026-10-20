import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { contentHash, stableId } from "./ids.js";
import { readDiscoveryBundle, writeDiscoveryBundle } from "./store.js";
import type { DiscoveryBundle, DiscoveryNode, RuntimeEvidence } from "./types.js";

const SENSITIVE = /(?:^|[._-])(?:authorization|cookie|set-cookie|secret|token|api[._-]?key|password|passwd|payload|body|content|email|phone|address|user[._-]?id|username|first[._-]?name|last[._-]?name|full[._-]?name|birth(?:date|day)?|date[._-]?of[._-]?birth|dob|ssn|national[._-]?id|passport|card|account|iban|statement|query[._-]?text)(?:$|[._-])/iu;

function flatten(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.flatMap(flatten);
  if (!input || typeof input !== "object") return [];
  const object = input as Record<string, unknown>;
  const own = [object];
  for (const key of ["resourceSpans", "scopeSpans", "instrumentationLibrarySpans", "spans", "records", "events", "evidence"]) if (key in object) own.push(...flatten(object[key]));
  return own;
}

function attributesOf(record: Record<string, unknown>): Record<string, unknown> {
  const attributes = record.attributes;
  if (Array.isArray(attributes)) {
    return Object.fromEntries(attributes.flatMap((attribute) => {
      if (!attribute || typeof attribute !== "object") return [];
      const item = attribute as Record<string, unknown>;
      const value = item.value && typeof item.value === "object" ? Object.values(item.value as Record<string, unknown>)[0] : item.value;
      return typeof item.key === "string" ? [[item.key, value]] : [];
    }));
  }
  return attributes && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
}

function redact(attributes: Record<string, unknown>, allowFields: ReadonlySet<string>): { attributes: Record<string, string | number | boolean | null>; redacted: boolean } {
  const output: Record<string, string | number | boolean | null> = {};
  let redacted = false;
  for (const [key, raw] of Object.entries(attributes)) {
    if (SENSITIVE.test(key) && !allowFields.has(key)) { output[key] = "[REDACTED]"; redacted = true; continue; }
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) output[key] = raw as string | number | boolean | null;
  }
  return { attributes: output, redacted };
}

function stringAttribute(attributes: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalizeHttpRoute(value: string): string {
  const withoutQuery = value.split("?", 1)[0] ?? value;
  const normalized = `/${withoutQuery.replace(/^\/+|\/+$/gu, "")}`.replace(/\/+/gu, "/");
  return normalized === "/" ? normalized : normalized.replace(/\/$/u, "");
}

function scopedIdentity(kind: string, module: string | undefined, parts: readonly string[]): string[] {
  const value = `${kind}:${parts.join(":")}`;
  return module ? [`${kind}:${module}:${parts.join(":")}`, value] : [value];
}

export function canonicalEvidenceIdentities(attributes: Readonly<Record<string, unknown>>): readonly string[] {
  const explicit = stringAttribute(attributes, "air.identity");
  if (explicit) return [explicit];
  const module = stringAttribute(attributes, "air.module", "service.name");
  const method = stringAttribute(attributes, "http.request.method", "http.method")?.toUpperCase();
  const route = stringAttribute(attributes, "http.route");
  if (method && route) return scopedIdentity("http", module, [method, normalizeHttpRoute(route)]);
  const namespace = stringAttribute(attributes, "code.namespace");
  const functionName = stringAttribute(attributes, "code.function.name");
  const symbol = stringAttribute(attributes, "code.function.symbol") ?? (namespace && functionName ? `${namespace}.${functionName}` : undefined);
  if (symbol) {
    const descriptor = stringAttribute(attributes, "code.function.signature") ?? "*";
    const coordinate = stringAttribute(attributes, "code.build.coordinate");
    return coordinate ? [`jvm:${coordinate}:${symbol}:${descriptor}`, `jvm:${symbol}:${descriptor}`] : [`jvm:${symbol}:${descriptor}`];
  }
  const database = stringAttribute(attributes, "db.system");
  const relation = stringAttribute(attributes, "db.sql.table", "db.collection.name");
  if (database && relation) {
    const namespaceValue = stringAttribute(attributes, "db.namespace", "db.name") ?? "public";
    const operation = stringAttribute(attributes, "db.operation.name", "db.operation")?.toUpperCase() ?? "*";
    return [`db:${database.toLowerCase()}:${namespaceValue}:${relation}:${operation}`];
  }
  const messaging = stringAttribute(attributes, "messaging.system");
  const destination = stringAttribute(attributes, "messaging.destination.name");
  if (messaging && destination) {
    const operation = stringAttribute(attributes, "messaging.operation.type") ?? "*";
    const schema = stringAttribute(attributes, "messaging.message.schema.id", "messaging.message.schema.version") ?? "*";
    return [`message:${messaging.toLowerCase()}:${destination}:${operation.toLowerCase()}:${schema}`];
  }
  return [];
}

export function canonicalNodeIdentities(node: DiscoveryNode): readonly string[] {
  const explicit = typeof node.attributes.identity === "string" ? node.attributes.identity : undefined;
  if (explicit) return [explicit];
  if (node.kind === "endpoint" && typeof node.attributes.method === "string" && typeof node.attributes.path === "string") {
    return scopedIdentity("http", node.module, [node.attributes.method.toUpperCase(), normalizeHttpRoute(node.attributes.path)]);
  }
  if ((node.kind === "listener" || node.kind === "publisher") && typeof node.attributes.transport === "string" && typeof node.attributes.destination === "string") {
    const operation = node.kind === "listener" ? "receive" : "publish";
    const schema = typeof node.attributes.schema === "string" ? node.attributes.schema : "*";
    return [`message:${node.attributes.transport.toLowerCase()}:${node.attributes.destination}:${operation}:${schema}`];
  }
  if (node.kind === "vendor-call" && typeof node.attributes.target === "string" && Array.isArray(node.attributes.operations)) {
    return node.attributes.operations.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const operation = value as Record<string, unknown>;
      return typeof operation.method === "string" && typeof operation.path === "string"
        ? [`outbound:${node.attributes.target}:${operation.method.toUpperCase()}:${normalizeHttpRoute(operation.path)}`]
        : [];
    });
  }
  if (["entity", "table", "repository", "query"].includes(node.kind)) {
    const relation = typeof node.attributes.table === "string" ? node.attributes.table : node.kind === "entity" ? node.name : undefined;
    if (relation) {
      const namespace = typeof node.attributes.schema === "string" ? node.attributes.schema : "public";
      const operation = typeof node.attributes.operation === "string" ? node.attributes.operation.toUpperCase() : "*";
      return [`db:postgresql:${namespace}:${relation}:${operation}`];
    }
  }
  const source = node.sources.find((item) => item.symbol);
  if (source?.symbol) {
    const descriptor = typeof node.attributes.jvmDescriptor === "string" ? node.attributes.jvmDescriptor : "*";
    return source.buildCoordinate
      ? [`jvm:${source.buildCoordinate}:${source.symbol}:${descriptor}`, `jvm:${source.symbol}:${descriptor}`]
      : [`jvm:${source.symbol}:${descriptor}`];
  }
  return [];
}

function parseEvidenceDocuments(source: string): Record<string, unknown>[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return flatten(JSON.parse(trimmed) as unknown);
  if (trimmed.startsWith("{")) {
    try { return flatten(JSON.parse(trimmed) as unknown); }
    catch (error) {
      if (!(error instanceof SyntaxError) || !trimmed.includes("\n")) throw error;
    }
  }
  return trimmed.split(/\r?\n/u).filter(Boolean).flatMap((line) => flatten(JSON.parse(line) as unknown));
}

function matchNodes(nodes: readonly DiscoveryNode[], attributes: Readonly<Record<string, unknown>>): { readonly ids: readonly string[]; readonly status: "matched" | "ambiguous" | "unmatched" } {
  const identities = new Set(canonicalEvidenceIdentities(attributes));
  if (identities.size === 0) return { ids: [], status: "unmatched" };
  const matches = nodes.filter((node) => canonicalNodeIdentities(node).some((identity) => identities.has(identity))).map((node) => node.id);
  return matches.length === 1 ? { ids: matches, status: "matched" } : { ids: [], status: matches.length > 1 ? "ambiguous" : "unmatched" };
}

export async function ingestEvidence(inputPath: string, discoveryDirectory: string, options: { readonly allowFields?: readonly string[] } = {}): Promise<{ readonly bundle: DiscoveryBundle; readonly ingested: number; readonly unmatched: number; readonly ambiguous: number }> {
  const bundle = await readDiscoveryBundle(resolve(discoveryDirectory));
  const source = await readFile(resolve(inputPath), "utf8");
  const documents = parseEvidenceDocuments(source);
  const allowFields = new Set(options.allowFields ?? []);
  const evidence: RuntimeEvidence[] = [];
  let unmatched = 0;
  let ambiguous = 0;
  for (const record of documents) {
    if (!(typeof record.name === "string" || "traceId" in record || "spanId" in record || "kind" in record)) continue;
    const rawAttributes = attributesOf(record);
    const safe = redact(rawAttributes, allowFields);
    const match = matchNodes(bundle.nodes, safe.attributes);
    if (match.status === "unmatched") unmatched += 1;
    if (match.status === "ambiguous") ambiguous += 1;
    safe.attributes["air.match.status"] = match.status;
    const id = stableId("evidence", basename(inputPath), String(record.traceId ?? ""), String(record.spanId ?? ""), String(record.name ?? ""), contentHash(JSON.stringify(safe.attributes)));
    evidence.push({ id, kind: typeof record.kind === "string" && ["test", "database-change", "message", "schema-contract", "outbound-call"].includes(record.kind) ? record.kind as RuntimeEvidence["kind"] : "trace", observedAt: typeof record.observedAt === "string" ? record.observedAt : new Date().toISOString(), source: basename(inputPath), nodeIds: match.ids, attributes: safe.attributes, redacted: safe.redacted });
  }
  const mergedEvidence = [...new Map([...bundle.evidence, ...evidence].map((item) => [item.id, item])).values()];
  const evidenceByNode = new Map<string, string[]>();
  for (const item of mergedEvidence) for (const nodeId of item.nodeIds) evidenceByNode.set(nodeId, [...(evidenceByNode.get(nodeId) ?? []), item.id]);
  const nodes = bundle.nodes.map((node) => {
    const evidenceIds = evidenceByNode.get(node.id);
    return evidenceIds?.length ? { ...node, confidence: node.confidence === "inferred" ? "observed" as const : node.confidence, evidenceIds: [...new Set(evidenceIds)].sort() } : node;
  });
  const updated: DiscoveryBundle = { ...bundle, manifest: { ...bundle.manifest, metadata: { ...bundle.manifest.metadata, updatedAt: new Date().toISOString() } }, nodes, evidence: mergedEvidence };
  return { bundle: await writeDiscoveryBundle(resolve(discoveryDirectory), updated), ingested: evidence.length, unmatched, ambiguous };
}

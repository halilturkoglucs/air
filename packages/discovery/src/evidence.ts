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

function matchNodes(nodes: readonly DiscoveryNode[], attributes: Readonly<Record<string, unknown>>, record: Readonly<Record<string, unknown>>): string[] {
  const candidates = [attributes["code.function.name"], attributes["http.route"], attributes["url.path"], attributes["messaging.destination.name"], record.name].filter((value): value is string => typeof value === "string");
  return nodes.filter((node) => candidates.some((candidate) => candidate === node.name || candidate.includes(node.name) || String(node.attributes.path ?? "") === candidate)).map((node) => node.id);
}

export async function ingestEvidence(inputPath: string, discoveryDirectory: string, options: { readonly allowFields?: readonly string[] } = {}): Promise<{ readonly bundle: DiscoveryBundle; readonly ingested: number; readonly unmatched: number }> {
  const bundle = await readDiscoveryBundle(resolve(discoveryDirectory));
  const source = await readFile(resolve(inputPath), "utf8");
  const documents = source.trim().startsWith("[") || source.trim().startsWith("{")
    ? flatten(JSON.parse(source) as unknown)
    : source.split(/\r?\n/u).filter(Boolean).flatMap((line) => flatten(JSON.parse(line) as unknown));
  const allowFields = new Set(options.allowFields ?? []);
  const evidence: RuntimeEvidence[] = [];
  let unmatched = 0;
  for (const record of documents) {
    if (!(typeof record.name === "string" || "traceId" in record || "spanId" in record || "kind" in record)) continue;
    const rawAttributes = attributesOf(record);
    const nodes = matchNodes(bundle.nodes, rawAttributes, record);
    if (nodes.length === 0) unmatched += 1;
    const safe = redact(rawAttributes, allowFields);
    const id = stableId("evidence", basename(inputPath), String(record.traceId ?? ""), String(record.spanId ?? ""), String(record.name ?? ""), contentHash(JSON.stringify(safe.attributes)));
    evidence.push({ id, kind: typeof record.kind === "string" && ["test", "database-change", "message", "schema-contract", "outbound-call"].includes(record.kind) ? record.kind as RuntimeEvidence["kind"] : "trace", observedAt: typeof record.observedAt === "string" ? record.observedAt : new Date().toISOString(), source: basename(inputPath), nodeIds: nodes, attributes: safe.attributes, redacted: safe.redacted });
  }
  const mergedEvidence = [...new Map([...bundle.evidence, ...evidence].map((item) => [item.id, item])).values()];
  const evidenceByNode = new Map<string, string[]>();
  for (const item of mergedEvidence) for (const nodeId of item.nodeIds) evidenceByNode.set(nodeId, [...(evidenceByNode.get(nodeId) ?? []), item.id]);
  const nodes = bundle.nodes.map((node) => {
    const evidenceIds = evidenceByNode.get(node.id);
    return evidenceIds?.length ? { ...node, confidence: node.confidence === "inferred" ? "observed" as const : node.confidence, evidenceIds: [...new Set(evidenceIds)].sort() } : node;
  });
  const updated: DiscoveryBundle = { ...bundle, manifest: { ...bundle.manifest, metadata: { ...bundle.manifest.metadata, updatedAt: new Date().toISOString() } }, nodes, evidence: mergedEvidence };
  return { bundle: await writeDiscoveryBundle(resolve(discoveryDirectory), updated), ingested: evidence.length, unmatched };
}

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import discoverySchema from "../schema/discovery-0.1.schema.json" with { type: "json" };
import { type DiscoveryBundle, type DiscoveryEdge, type DiscoveryManifest, type DiscoveryNode, type ReviewerDecision, type RuntimeEvidence } from "./types.js";
import { evidenceHash } from "./ids.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(discoverySchema);
const validateManifest: ValidateFunction<unknown> = ajv.getSchema("https://air.dev/schema/discovery-0.1.schema.json")!;
const validateNode: ValidateFunction<unknown> = ajv.compile({ $ref: "https://air.dev/schema/discovery-0.1.schema.json#/$defs/node" });
const validateEdge: ValidateFunction<unknown> = ajv.compile({ $ref: "https://air.dev/schema/discovery-0.1.schema.json#/$defs/edge" });
const validateEvidence: ValidateFunction<unknown> = ajv.compile({ $ref: "https://air.dev/schema/discovery-0.1.schema.json#/$defs/evidence" });
const validateDecision: ValidateFunction<unknown> = ajv.compile({ $ref: "https://air.dev/schema/discovery-0.1.schema.json#/$defs/decision" });

function schemaErrors(name: string, errors: readonly ErrorObject[] | null | undefined): Error {
  return new Error(`${name} is invalid: ${(errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
}

function parseJsonLines<T>(source: string, name: string): T[] {
  return source.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch (error) { throw new Error(`${name}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : "");
}

function assertBundle(bundle: DiscoveryBundle): void {
  if (!validateManifest(bundle.manifest)) throw schemaErrors("Discovery manifest", validateManifest.errors);
  const nodeIds = new Set<string>();
  for (const node of bundle.nodes) {
    const label = `Discovery node ${node.id}`;
    if (!validateNode(node)) throw schemaErrors(label, validateNode.errors);
    if (nodeIds.has(node.id)) throw new Error(`Duplicate discovery node ${node.id}.`);
    if (node.sources.length === 0) throw new Error(`Discovery node ${node.id} has no provenance.`);
    nodeIds.add(node.id);
  }
  for (const edge of bundle.edges) {
    const label = `Discovery edge ${edge.id}`;
    if (!validateEdge(edge)) throw schemaErrors(label, validateEdge.errors);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`Discovery edge ${edge.id} has an unresolved endpoint.`);
    if (edge.sources.length === 0 && (edge.evidenceIds?.length ?? 0) === 0) throw new Error(`Discovery edge ${edge.id} has no provenance.`);
  }
  for (const item of bundle.evidence) {
    const label = `Discovery evidence ${item.id}`;
    if (!validateEvidence(item)) throw schemaErrors(label, validateEvidence.errors);
    for (const nodeId of item.nodeIds) if (!nodeIds.has(nodeId)) throw new Error(`Discovery evidence ${item.id} references unknown node ${nodeId}.`);
  }
  const evidenceIds = new Set(bundle.evidence.map((item) => item.id));
  for (const node of bundle.nodes) for (const id of node.evidenceIds ?? []) if (!evidenceIds.has(id)) throw new Error(`Discovery node ${node.id} references unknown evidence ${id}.`);
  for (const edge of bundle.edges) for (const id of edge.evidenceIds ?? []) if (!evidenceIds.has(id)) throw new Error(`Discovery edge ${edge.id} references unknown evidence ${id}.`);
  for (const decision of bundle.decisions) {
    const label = `Discovery decision ${decision.subjectId}`;
    if (!validateDecision(decision)) throw schemaErrors(label, validateDecision.errors);
    if (!nodeIds.has(decision.subjectId) && !decision.invalidated) throw new Error(`Active discovery decision references unknown node ${decision.subjectId}.`);
  }
}

async function atomicWrite(path: string, source: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, source, "utf8");
  await rename(temporary, path);
}

export async function rebuildDiscoveryIndex(directory: string, bundle?: DiscoveryBundle): Promise<void> {
  const loaded = bundle ?? await readDiscoveryBundle(directory);
  const indexPath = resolve(directory, loaded.manifest.files.index);
  await rm(indexPath, { force: true });
  try {
    const sqliteSpecifier = ["node", "sqlite"].join(":");
    const { DatabaseSync } = await import(sqliteSpecifier) as typeof import("node:sqlite");
    const database = new DatabaseSync(indexPath);
    try {
      database.exec("PRAGMA journal_mode=WAL; CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, confidence TEXT NOT NULL, observable INTEGER NOT NULL, json TEXT NOT NULL); CREATE TABLE edges(id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, confidence TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE evidence(id TEXT PRIMARY KEY, kind TEXT NOT NULL, observed_at TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX edges_source ON edges(source); CREATE INDEX edges_target ON edges(target);");
      const nodeStatement = database.prepare("INSERT INTO nodes VALUES(?, ?, ?, ?, ?, ?)");
      const edgeStatement = database.prepare("INSERT INTO edges VALUES(?, ?, ?, ?, ?, ?)");
      const evidenceStatement = database.prepare("INSERT INTO evidence VALUES(?, ?, ?, ?)");
      database.exec("BEGIN");
      for (const node of loaded.nodes) nodeStatement.run(node.id, node.kind, node.name, node.confidence, node.observable ? 1 : 0, JSON.stringify(node));
      for (const edge of loaded.edges) edgeStatement.run(edge.id, edge.kind, edge.from, edge.to, edge.confidence, JSON.stringify(edge));
      for (const evidence of loaded.evidence) evidenceStatement.run(evidence.id, evidence.kind, evidence.observedAt, JSON.stringify(evidence));
      database.exec("COMMIT");
    } finally { database.close(); }
  } catch (error) {
    throw new Error(`Could not rebuild discovery SQLite index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeDiscoveryBundle(directory: string, bundle: DiscoveryBundle, options: { readonly preserveDecisions?: boolean } = {}): Promise<DiscoveryBundle> {
  await mkdir(directory, { recursive: true });
  let decisions = [...bundle.decisions];
  let manifest = bundle.manifest;
  if (options.preserveDecisions !== false) {
    try {
      const existing = await readDiscoveryBundle(directory);
      manifest = { ...bundle.manifest, metadata: { ...bundle.manifest.metadata, createdAt: existing.manifest.metadata.createdAt } };
      const nodes = new Map(bundle.nodes.map((node) => [node.id, node]));
      decisions = existing.decisions.map((decision) => {
        const node = nodes.get(decision.subjectId);
        const currentHash = node ? evidenceHash(node.sources) : "missing";
        return currentHash === decision.evidenceHash ? decision : { ...decision, invalidated: true, reason: node ? "source evidence changed" : "subject disappeared" };
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const materialized = { ...bundle, manifest, decisions } satisfies DiscoveryBundle;
  assertBundle(materialized);
  await Promise.all([
    atomicWrite(resolve(directory, materialized.manifest.files.nodes), jsonLines(materialized.nodes)),
    atomicWrite(resolve(directory, materialized.manifest.files.edges), jsonLines(materialized.edges)),
    atomicWrite(resolve(directory, materialized.manifest.files.evidence), jsonLines(materialized.evidence)),
    atomicWrite(resolve(directory, materialized.manifest.files.decisions), stringify({ decisions: materialized.decisions }, { lineWidth: 0 })),
    atomicWrite(resolve(directory, materialized.manifest.files.coverage), `${JSON.stringify(materialized.coverage, null, 2)}\n`),
    atomicWrite(resolve(directory, "manifest.json"), `${JSON.stringify(materialized.manifest, null, 2)}\n`),
  ]);
  await rebuildDiscoveryIndex(directory, materialized);
  return materialized;
}

export async function readDiscoveryBundle(directory: string): Promise<DiscoveryBundle> {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as DiscoveryManifest;
  if (!validateManifest(manifest)) throw schemaErrors("Discovery manifest", validateManifest.errors);
  const [nodes, edges, evidence, decisionSource, coverage] = await Promise.all([
    readFile(resolve(directory, manifest.files.nodes), "utf8"),
    readFile(resolve(directory, manifest.files.edges), "utf8"),
    readFile(resolve(directory, manifest.files.evidence), "utf8"),
    readFile(resolve(directory, manifest.files.decisions), "utf8"),
    readFile(resolve(directory, manifest.files.coverage), "utf8"),
  ]);
  const decisionDocument = parse(decisionSource) as { readonly decisions?: readonly ReviewerDecision[] } | null;
  const bundle: DiscoveryBundle = {
    manifest,
    nodes: parseJsonLines<DiscoveryNode>(nodes, manifest.files.nodes),
    edges: parseJsonLines<DiscoveryEdge>(edges, manifest.files.edges),
    evidence: parseJsonLines<RuntimeEvidence>(evidence, manifest.files.evidence),
    decisions: decisionDocument?.decisions ?? [],
    coverage: JSON.parse(coverage) as DiscoveryBundle["coverage"],
  };
  assertBundle(bundle);
  return bundle;
}

export async function saveDecision(directory: string, decision: ReviewerDecision): Promise<void> {
  const bundle = await readDiscoveryBundle(directory);
  const node = bundle.nodes.find((candidate) => candidate.id === decision.subjectId);
  if (!node) throw new Error(`Unknown discovery subject ${decision.subjectId}.`);
  if (decision.evidenceHash !== evidenceHash(node.sources)) throw new Error("Decision evidence hash does not match current source evidence.");
  const decisions = [...bundle.decisions.filter((candidate) => candidate.subjectId !== decision.subjectId), decision];
  await atomicWrite(resolve(directory, bundle.manifest.files.decisions), stringify({ decisions }, { lineWidth: 0 }));
}

export async function ensureDiscoveryParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

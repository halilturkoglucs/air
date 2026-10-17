import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { stringify } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import capabilitySchema from "../schema/capability-0.1.schema.json" with { type: "json" };
import adoptionSchema from "../schema/adoption-0.2.schema.json" with { type: "json" };
import verificationResultSchema from "../schema/verification-result-0.3.schema.json" with { type: "json" };
import { contentHash, evidenceHash, stableId } from "./ids.js";
import { readDiscoveryBundle } from "./store.js";
import type { DiscoveryEdge, DiscoveryNode, ReviewerDecision } from "./types.js";

const capabilityValidator = new Ajv2020({ allErrors: true, strict: true }).compile(capabilitySchema);
const adoptionValidator = new Ajv2020({ allErrors: true, strict: true }).compile(adoptionSchema);
const verificationResultValidator = new Ajv2020({ allErrors: true, strict: true }).compile(verificationResultSchema);

function requireValid(validate: typeof capabilityValidator, value: unknown, label: string): void {
  if (!validate(value)) throw new Error(`${label} is invalid: ${(validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
}

export interface ExtractionResult {
  readonly capabilityId: string;
  readonly output: string;
  readonly nodes: readonly string[];
  readonly blockers: readonly string[];
}

function activeDecision(node: DiscoveryNode, decisions: readonly ReviewerDecision[]): ReviewerDecision | undefined {
  return decisions.find((decision) => decision.subjectId === node.id && !decision.invalidated && decision.evidenceHash === evidenceHash(node.sources));
}

function sliceGraph(root: string, nodes: readonly DiscoveryNode[], edges: readonly DiscoveryEdge[]): DiscoveryNode[] {
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (selected.has(edge.from) && !selected.has(edge.to)) { selected.add(edge.to); changed = true; }
  }
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return [...selected].flatMap((id) => nodeMap.get(id) ?? []);
}

function safeName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
  return normalized || "capability";
}

export async function extractCapability(discoveryDirectory: string, capabilityId: string, outputDirectory: string): Promise<ExtractionResult> {
  const discovery = await readDiscoveryBundle(resolve(discoveryDirectory));
  const root = discovery.nodes.find((node) => node.id === capabilityId);
  if (!root) throw new Error(`Unknown capability ${capabilityId}.`);
  if (!["endpoint", "listener", "schedule"].includes(root.kind)) throw new Error("A capability must start at an endpoint, listener, or schedule.");
  const selected = sliceGraph(root.id, discovery.nodes, discovery.edges);
  const blockers: string[] = [];
  for (const node of selected) {
    const decision = activeDecision(node, discovery.decisions);
    if (decision?.action === "reject") blockers.push(`${node.id}: rejected by reviewer`);
    if (node.observable && ["opaque", "conflicting"].includes(node.confidence) && decision?.action !== "mark-opaque" && decision?.action !== "approve") blockers.push(`${node.id}: ${node.confidence} observable behavior is unresolved`);
    if (node.observable && node.confidence === "inferred" && decision?.action !== "approve" && decision?.action !== "mark-opaque") blockers.push(`${node.id}: inferred observable behavior requires review`);
  }
  if (!activeDecision(root, discovery.decisions) || activeDecision(root, discovery.decisions)?.action === "reject") blockers.push(`${root.id}: capability entry point is not approved`);
  if (blockers.length > 0) return { capabilityId, output: resolve(outputDirectory), nodes: selected.map((node) => node.id), blockers };

  const name = safeName(activeDecision(root, discovery.decisions)?.value ?? root.name);
  const ports = Object.fromEntries(selected.filter((node) => node.kind === "vendor-call").map((node) => [safeName(node.name), { description: `Imported outbound dependency ${node.name}.`, operations: { invoke: { input: "ImportedInput", output: "ImportedOutput", failures: { unavailable: { retryable: true }, rejected: { retryable: false } }, timeoutMs: 5000, retry: { maxAttempts: 3, backoff: "exponential" }, idempotency: "caller-key" } } }]));
  const transformations = Object.fromEntries(selected.filter((node) => node.kind === "mapper" && node.confidence !== "opaque").map((node) => [safeName(node.name), { input: "ImportedInput", output: "ImportedOutput", steps: [{ kind: "project", fields: ["payload"] }] }]));
  const foreign = selected.filter((node) => node.kind === "foreign-operation" || node.kind === "dynamic-routing" || activeDecision(node, discovery.decisions)?.action === "mark-opaque");
  const document = {
    apiVersion: "air.dev/v0.10", kind: "Application", metadata: { name, displayName: root.name, description: `Reviewed extraction from ${discovery.manifest.metadata.name}.` },
    spec: {
      entities: {},
      contracts: {
        ImportedInput: { fields: { payload: { type: "json", required: true } } },
        ImportedOutput: { fields: { payload: { type: "json", required: true } } },
      },
      ...(Object.keys(ports).length > 0 ? { ports } : {}),
      ...(Object.keys(transformations).length > 0 ? { transformations } : {}),
    },
  };
  const system = {
    apiVersion: "air.dev/system/v0.2", kind: "System", metadata: { name: `${name}-system` }, spec: {
      applications: { [name]: { source: "./air.yaml" } },
      components: {
        capability: { kind: "managed", application: name, role: root.kind === "endpoint" ? "api" : "worker", target: "nextjs", ...(foreign.length > 0 ? { dependsOn: foreign.map((node) => safeName(node.name)) } : {}) },
        ...Object.fromEntries(foreign.map((node) => [safeName(node.name), { kind: "foreign", componentType: node.kind === "dynamic-routing" ? "library" : "service", interfaces: [node.name], description: `Retained legacy boundary ${node.id}.` }])),
      },
    },
  };
  const verification = {
    apiVersion: "air.dev/verification/v0.3", kind: "ImportVerificationSuite", metadata: { name: `${name}-equivalence` },
    spec: { capability: name, scenarios: [{ id: "baseline", request: { method: root.attributes.method ?? "POST", path: root.attributes.path ?? `/${name}`, body: { payload: {} } }, compare: { status: true, body: "json", headers: [] }, observations: { database: [], messages: [], outbound: [] } }] },
  };
  const manifest = { apiVersion: "air.dev/capability/v0.1", kind: "ExtractedCapability", capabilityId: root.id, discoveryRepositoryHash: discovery.manifest.metadata.repositoryHash, evidenceHash: contentHash(selected.flatMap((node) => node.sources.map((source) => source.contentHash)).sort().join(":")), nodes: selected.map((node) => node.id), blockers: [], adopted: false };
  requireValid(capabilityValidator, manifest, "Capability manifest");
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  try { await readFile(resolve(output, "capability.json"), "utf8"); throw new Error("Capability output already exists; refusing to overwrite it."); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await Promise.all([
    writeFile(resolve(output, "air.yaml"), stringify(document, { lineWidth: 0 }), "utf8"),
    writeFile(resolve(output, "system.yaml"), stringify(system, { lineWidth: 0 }), "utf8"),
    writeFile(resolve(output, "verification.yaml"), stringify(verification, { lineWidth: 0 }), "utf8"),
    writeFile(resolve(output, "capability.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);
  return { capabilityId, output, nodes: selected.map((node) => node.id), blockers: [] };
}

export async function adoptExtractedCapability(directory: string): Promise<string> {
  const path = resolve(directory, "capability.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  requireValid(capabilityValidator, manifest, "Capability manifest");
  if (Array.isArray(manifest.blockers) && manifest.blockers.length > 0) throw new Error("Capability still has unresolved extraction blockers.");
  let verification: Record<string, unknown>;
  try { verification = JSON.parse(await readFile(resolve(directory, "verification-result.json"), "utf8")) as Record<string, unknown>; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("Capability has no verification result; run air verify-import before adoption.");
    throw error;
  }
  requireValid(verificationResultValidator, verification, "Import verification result");
  if (verification.passed !== true) throw new Error("Capability verification did not pass.");
  if (verification.capabilityId !== manifest.capabilityId || verification.evidenceHash !== manifest.evidenceHash) throw new Error("Capability verification is stale or belongs to different evidence.");
  const adoption = { apiVersion: "air.dev/adoption/v0.2", kind: "CapabilityAdoption", capabilityId: manifest.capabilityId, evidenceHash: manifest.evidenceHash, adoptedAt: new Date().toISOString(), ownership: "air-managed" };
  requireValid(adoptionValidator, adoption, "Capability adoption");
  await writeFile(resolve(directory, "adoption.json"), `${JSON.stringify(adoption, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return resolve(directory, "adoption.json");
}

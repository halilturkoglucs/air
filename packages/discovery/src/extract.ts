import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { stringify } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import capabilitySchema from "../schema/capability-0.1.schema.json" with { type: "json" };
import adoptionSchema from "../schema/adoption-0.2.schema.json" with { type: "json" };
import verificationResultSchema from "../schema/verification-result-0.3.schema.json" with { type: "json" };
import { contentHash, evidenceHash, stableId } from "./ids.js";
import { readDiscoveryBundle } from "./store.js";
import type { DiscoveryEdge, DiscoveryNode, ReviewerDecision, RuntimeEvidence } from "./types.js";

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

function isEntryNode(node: DiscoveryNode): boolean {
  return ["endpoint", "listener", "schedule"].includes(node.kind) || (node.kind === "operation" && node.attributes.entryPoint === true);
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

function typeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const unwrapped = value.replace(/^(?:ResponseEntity|Optional|Mono|Flux|CompletableFuture|List|Set|Collection|Page)\s*</u, "").replace(/>+$/gu, "");
  const simple = unwrapped.split(/[.,\s]/u).filter(Boolean).at(-1);
  return simple && !["void", "Void", "Object"].includes(simple) ? simple : undefined;
}

function titleName(value: string): string {
  const pieces = value.replace(/[^A-Za-z0-9]+/gu, " ").trim().split(/\s+/u).filter(Boolean);
  const joined = pieces.map((piece) => piece[0]!.toUpperCase() + piece.slice(1)).join("");
  return /^[A-Za-z]/u.test(joined) ? joined : `Imported${joined || "Type"}`;
}

function fieldShape(value: unknown, entity = false): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = value as Record<string, unknown>;
  if (typeof field.name !== "string" || typeof field.type !== "string") return undefined;
  const shape: Record<string, unknown> = { type: field.type };
  for (const key of ["required", "nullable", "primaryKey", "unique", "generated", "default"] as const) if (field[key] !== undefined && (entity || !["primaryKey", "unique", "generated", "default"].includes(key))) shape[key] = field[key];
  if (field.validation && typeof field.validation === "object" && Object.keys(field.validation).length > 0) shape.validation = field.validation;
  return shape;
}

function contractFromNode(node: DiscoveryNode): { readonly name: string; readonly value: Record<string, unknown> } | undefined {
  const details = Array.isArray(node.attributes.fieldDetails) ? node.attributes.fieldDetails : [];
  const fields = Object.fromEntries(details.flatMap((detail) => {
    const shape = fieldShape(detail);
    return detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).name === "string" && shape ? [[safeName((detail as Record<string, unknown>).name as string), shape]] : [];
  }));
  return Object.keys(fields).length > 0 ? { name: titleName(node.name), value: { description: `Reviewed boundary contract ${node.name}.`, fields } } : undefined;
}

function entityFromNode(node: DiscoveryNode): { readonly name: string; readonly value: Record<string, unknown> } | undefined {
  const details = Array.isArray(node.attributes.fields) ? node.attributes.fields : [];
  const fields = Object.fromEntries(details.flatMap((detail) => {
    const shape = fieldShape(detail, true);
    return detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).name === "string" && shape ? [[safeName((detail as Record<string, unknown>).name as string), shape]] : [];
  }));
  if (Object.keys(fields).length === 0) return undefined;
  if (!Object.values(fields).some((field) => field.primaryKey === true)) {
    const id = Object.entries(fields).find(([name]) => name === "id" || name.endsWith("Id"));
    if (id) id[1].primaryKey = true;
  }
  return { name: titleName(node.name), value: { description: `Reviewed persistent entity ${node.name}.`, fields } };
}

function primitiveExample(type: unknown): unknown {
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "uuid") return "00000000-0000-0000-0000-000000000001";
  if (type === "date") return "2000-01-01";
  if (type === "datetime") return "2000-01-01T00:00:00Z";
  if (type === "json") return {};
  return "example";
}

interface PortArtifacts {
  readonly ports: Readonly<Record<string, unknown>>;
  readonly contracts: Readonly<Record<string, unknown>>;
  readonly operations: readonly string[];
  readonly blockers: readonly string[];
}

interface ExpectedInvocation { readonly identity: string; readonly label: string }

function expectedPortInvocations(root: DiscoveryNode, nodes: readonly DiscoveryNode[]): readonly ExpectedInvocation[] {
  const byName = new Map<string, DiscoveryNode[]>();
  for (const node of nodes) byName.set(node.name, [...byName.get(node.name) ?? [], node]);
  const output: ExpectedInvocation[] = [];
  const visited = new Set<string>();
  const walk = (node: DiscoveryNode, methodName: string): void => {
    const key = `${node.id}:${methodName}`;
    if (visited.has(key)) return;
    visited.add(key);
    const methods = Array.isArray(node.attributes.methods) ? node.attributes.methods : [];
    const method = methods.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).name === methodName) as Record<string, unknown> | undefined;
    const calls = Array.isArray(method?.calls) ? method.calls : [];
    for (const value of calls) {
      if (!value || typeof value !== "object") continue;
      const call = value as Record<string, unknown>;
      if (typeof call.target !== "string" || typeof call.operation !== "string") continue;
      const targets = byName.get(call.target) ?? [];
      const target = targets.find((candidate) => candidate.kind === "vendor-call") ?? targets.find((candidate) => candidate.kind === "service");
      if (!target) continue;
      if (target.kind === "service") { walk(target, call.operation); continue; }
      const operation = Array.isArray(target.attributes.operations) ? target.attributes.operations.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).name === call.operation) as Record<string, unknown> | undefined : undefined;
      if (!operation || typeof target.attributes.target !== "string" || typeof operation.method !== "string" || typeof operation.path !== "string") continue;
      output.push({ identity: `outbound:${target.attributes.target}:${operation.method.toUpperCase()}:${operation.path}`, label: `${safeName(target.attributes.target)}.${safeName(call.operation)}` });
    }
  };
  if (root.kind === "operation") {
    const owner = (byName.get(root.name) ?? []).find((node) => node.kind === "service");
    if (owner) walk(owner, typeof root.attributes.method === "string" ? root.attributes.method : "run");
  } else {
    walk(root, root.name);
    const owner = nodes.find((node) => node.kind === "service"
      && Array.isArray(node.attributes.methods)
      && node.attributes.methods.some((method) => method && typeof method === "object" && (method as Record<string, unknown>).name === root.name)
      && node.sources.some((source) => root.sources.some((entry) => entry.path === source.path)))
      ?? nodes.find((node) => node.kind === "service" && node.sources.some((source) => root.sources.some((entry) => entry.path === source.path)));
    if (owner) walk(owner, root.name);
  }
  return output;
}

function evidenceOrderingBlockers(root: DiscoveryNode, selected: readonly DiscoveryNode[], universe: readonly DiscoveryNode[], evidence: readonly { readonly id: string; readonly attributes: Readonly<Record<string, string | number | boolean | null>> }[]): string[] {
  const expected = expectedPortInvocations(root, universe);
  if (expected.length === 0) return [];
  const evidenceIds = new Set(selected.flatMap((node) => node.evidenceIds ?? []));
  const observations = evidence.filter((item) => evidenceIds.has(item.id) && typeof item.attributes["air.identity"] === "string" && String(item.attributes["air.identity"]).startsWith("outbound:"));
  const blockers: string[] = [];
  for (const invocation of expected) if (!observations.some((item) => item.attributes["air.identity"] === invocation.identity)) blockers.push(`${invocation.label}: exact outbound evidence is missing`);
  if (blockers.length > 0) return blockers;
  if (observations.some((item) => !Number.isSafeInteger(item.attributes["air.invocation.order"]))) return ["outbound observations require integer air.invocation.order values"];
  const ordered = [...observations].sort((left, right) => Number(left.attributes["air.invocation.order"]) - Number(right.attributes["air.invocation.order"]));
  const orders = ordered.map((item) => Number(item.attributes["air.invocation.order"]));
  if (new Set(orders).size !== orders.length) return ["outbound observations contain ambiguous duplicate invocation order values"];
  const expectedIdentities = expected.map((item) => item.identity);
  const observedIdentities = ordered.map((item) => String(item.attributes["air.identity"])).filter((identity) => expectedIdentities.includes(identity));
  if (JSON.stringify(observedIdentities) !== JSON.stringify(expectedIdentities)) return [`outbound observation order differs from the source-attributed order: expected ${expected.map((item) => item.label).join(" -> ")}`];
  return [];
}

function provenFailures(node: DiscoveryNode, identity: string, evidence: readonly RuntimeEvidence[]): Readonly<Record<string, unknown>> | undefined {
  const linked = new Set(node.evidenceIds ?? []);
  const failures = evidence.flatMap((item) => {
    if (!linked.has(item.id) || item.attributes["air.identity"] !== identity) return [];
    const name = item.attributes["air.failure.name"];
    const retryable = item.attributes["air.failure.retryable"];
    if (typeof name !== "string" || typeof retryable !== "boolean") return [];
    const description = item.attributes["air.failure.description"];
    return [[safeName(name), { retryable, ...(typeof description === "string" ? { description } : {}) }] as const];
  });
  return failures.length > 0 ? Object.fromEntries(failures) : undefined;
}

function portArtifacts(nodes: readonly DiscoveryNode[], evidence: readonly RuntimeEvidence[]): PortArtifacts {
  const contracts: Record<string, unknown> = {};
  const operationNames: string[] = [];
  const blockers: string[] = [];
  const ports = Object.fromEntries(nodes.filter((node) => node.kind === "vendor-call").flatMap((node) => {
    const portName = safeName(typeof node.attributes.target === "string" ? node.attributes.target : node.name);
    const values = Array.isArray(node.attributes.operations) ? node.attributes.operations : [];
    const operations = Object.fromEntries(values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const operation = value as Record<string, unknown>;
      if (typeof operation.name !== "string") return [];
      const operationName = safeName(operation.name);
      const prefix = `${titleName(node.name)}${titleName(operation.name)}`;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
      const safeParameters = parameters.filter((parameter) => typeof parameter.name === "string" && !/(?:authorization|password|secret|token|cookie)/iu.test(parameter.name) && !/@RequestHeader\b/u.test(String(parameter.source ?? "")));
      const inputFields = Object.fromEntries(safeParameters.map((parameter) => [safeName(String(parameter.name)), { type: typeof parameter.type === "string" ? parameter.type : "json", required: true }]));
      if (Object.keys(inputFields).length === 0 && typeof operation.path === "string") for (const match of operation.path.matchAll(/\{([^}]+)\}/gu)) inputFields[safeName(match[1]!)] = { type: "string", required: true };
      if (Object.keys(inputFields).length === 0) return [];
      if (typeof node.attributes.target !== "string" || typeof operation.method !== "string" || typeof operation.path !== "string") return [];
      const identity = `outbound:${node.attributes.target}:${operation.method.toUpperCase()}:${operation.path}`;
      const failures = provenFailures(node, identity, evidence);
      if (!failures) {
        blockers.push(`${portName}.${operationName}: exact failure behavior and retryability evidence are missing`);
        return [];
      }
      const input = `${prefix}Input`; const output = `${prefix}Output`;
      contracts[input] = { description: `Inputs observed for ${node.name}.${operation.name}.`, fields: inputFields };
      const outputType = operation.outputPrimitive === "json" && typeName(operation.outputType) ? "json" : operation.outputPrimitive ?? "json";
      contracts[output] = { description: `Observable result of ${node.name}.${operation.name}.`, fields: typeName(operation.outputType) ? { result: { type: outputType, required: true } } : { status: { type: "integer", required: true } } };
      operationNames.push(`${portName}.${operationName}`);
      return [[operationName, { input, output, failures }]];
    }));
    return Object.keys(operations).length > 0 ? [[portName, { description: `Reviewed outbound dependency ${node.name}; endpoint binding remains deployment configuration.`, operations }]] : [];
  }));
  return { ports, contracts, operations: operationNames.sort(), blockers };
}

function transformationArtifacts(nodes: readonly DiscoveryNode[], contracts: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(nodes.filter((node) => node.kind === "mapper" && Array.isArray(node.attributes.mappings)).flatMap((node) => {
    const mappings = (node.attributes.mappings as readonly unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    const input = titleName(String(node.attributes.inputType ?? "")); const output = titleName(String(node.attributes.outputType ?? ""));
    if (!(input in contracts) || !(output in contracts) || mappings.length === 0) return [];
    const steps = mappings.flatMap((mapping) => typeof mapping.source === "string" && typeof mapping.target === "string" ? [mapping.source === mapping.target ? { kind: "project", fields: [mapping.source] } : { kind: "rename", from: mapping.source, to: mapping.target }] : []);
    return steps.length > 0 ? [[safeName(node.name), { input, output, steps }]] : [];
  }));
}

function scenarioRequest(root: DiscoveryNode, name: string, contracts: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const input = typeName(root.attributes.inputType);
  const contract = input ? contracts[titleName(input)] as { fields?: Readonly<Record<string, { type?: unknown }>> } | undefined : undefined;
  const body = contract?.fields ? Object.fromEntries(Object.entries(contract.fields).map(([field, value]) => [field, primitiveExample(value.type)])) : undefined;
  if (root.kind === "endpoint" && typeof root.attributes.path === "string") return { method: root.attributes.method ?? "POST", path: root.attributes.path, ...(body ? { body } : {}) };
  return { method: "POST", path: `/_air/capabilities/${name}/invoke`, ...(body ? { body } : {}) };
}

export async function extractCapability(discoveryDirectory: string, capabilityId: string, outputDirectory: string): Promise<ExtractionResult> {
  const discovery = await readDiscoveryBundle(resolve(discoveryDirectory));
  const root = discovery.nodes.find((node) => node.id === capabilityId);
  if (!root) throw new Error(`Unknown capability ${capabilityId}.`);
  if (!isEntryNode(root)) throw new Error("A capability must start at an endpoint, listener, schedule, or discovered runtime task.");
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

  for (const node of selected.filter((candidate) => candidate.kind === "vendor-call")) if (activeDecision(node, discovery.decisions)?.action !== "mark-opaque" && (!Array.isArray(node.attributes.operations) || node.attributes.operations.length === 0)) blockers.push(`${node.id}: outbound dependency has no statically attributable operations`);
  blockers.push(...evidenceOrderingBlockers(root, selected, discovery.nodes, discovery.evidence));
  const portData = portArtifacts(selected, discovery.evidence);
  blockers.push(...portData.blockers);
  if (blockers.length > 0) return { capabilityId, output: resolve(outputDirectory), nodes: selected.map((node) => node.id), blockers };

  const name = safeName(activeDecision(root, discovery.decisions)?.value ?? root.name);
  const derivedContracts = Object.fromEntries(selected.flatMap((node) => node.kind === "contract" ? [contractFromNode(node)].filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.name, item.value]) : []));
  const derivedEntities = Object.fromEntries(selected.flatMap((node) => node.kind === "entity" ? [entityFromNode(node)].filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.name, item.value]) : []));
  const contracts = { ...derivedContracts, ...portData.contracts };
  const transformations = transformationArtifacts(selected, contracts);
  const foreign = selected.filter((node) => node.kind === "foreign-operation" || node.kind === "dynamic-routing" || activeDecision(node, discovery.decisions)?.action === "mark-opaque");
  const document = {
    apiVersion: "air.dev/v0.10", kind: "Application", metadata: { name, displayName: root.name, description: `Reviewed extraction from ${discovery.manifest.metadata.name}.` },
    spec: {
      entities: derivedEntities,
      ...(Object.keys(contracts).length > 0 ? { contracts } : {}),
      ...(Object.keys(portData.ports).length > 0 ? { ports: portData.ports } : {}),
      ...(Object.keys(transformations).length > 0 ? { transformations } : {}),
    },
  };
  const system = {
    apiVersion: "air.dev/system/v0.2", kind: "System", metadata: { name: `${name}-system` }, spec: {
      applications: { [name]: { source: "./air.yaml" } },
      components: {
        capability: { kind: "foreign", componentType: "service", interfaces: [root.name], description: `Reviewed legacy capability ${root.id}; native ownership is not promoted by extraction.` , ...(foreign.length > 0 ? { dependsOn: foreign.map((node) => safeName(node.name)) } : {}) },
        ...Object.fromEntries(foreign.map((node) => [safeName(node.name), { kind: "foreign", componentType: node.kind === "dynamic-routing" ? "library" : "service", interfaces: [node.name], description: `Retained legacy boundary ${node.id}.` }])),
      },
    },
  };
  const verification = {
    apiVersion: "air.dev/verification/v0.3", kind: "ImportVerificationSuite", metadata: { name: `${name}-equivalence` },
    spec: { capability: name, scenarios: [{ id: "observed-baseline", request: scenarioRequest(root, name, contracts), compare: { status: true, body: "json", headers: [] }, observations: { database: selected.filter((node) => node.kind === "entity" || node.kind === "repository").map((node) => safeName(node.name)).sort(), messages: selected.filter((node) => node.kind === "publisher").map((node) => safeName(node.name)).sort(), outbound: portData.operations } }] },
  };
  const selectedEvidence = new Set(selected.flatMap((node) => node.evidenceIds ?? []));
  const evidenceMaterial = discovery.evidence.filter((item) => selectedEvidence.has(item.id)).map((item) => JSON.stringify({ id: item.id, kind: item.kind, nodeIds: item.nodeIds, attributes: item.attributes })).sort();
  const manifest = { apiVersion: "air.dev/capability/v0.1", kind: "ExtractedCapability", capabilityId: root.id, discoveryRepositoryHash: discovery.manifest.metadata.repositoryHash, evidenceHash: contentHash([...selected.flatMap((node) => node.sources.map((source) => source.contentHash)), ...evidenceMaterial].sort().join(":")), nodes: selected.map((node) => node.id), blockers: [], adopted: false };
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

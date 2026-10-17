import type { AirDocument } from "@air/schema";
import { contentHash, stableId } from "./ids.js";
import { DISCOVERY_API_VERSION, type CoverageDimension, type DiscoveryBundle, type DiscoveryEdge, type DiscoveryNode, type NodeKind, type SourceSpan } from "./types.js";

function computeCoverage(nodes: readonly DiscoveryNode[]): Record<string, CoverageDimension> {
  const result: Record<string, CoverageDimension> = {};
  for (const node of nodes) {
    const value = result[node.kind] ?? { supported: 0, proven: 0, observed: 0, inferred: 0, opaque: 0, conflicting: 0 };
    result[node.kind] = { ...value, supported: value.supported + 1, [node.confidence]: value[node.confidence] + 1 };
  }
  return result;
}

export function discoveryFromAirCandidate(document: AirDocument, options: { readonly source: string; readonly analyzer: "postgres" | "openapi" | "nextjs" | "spring-legacy"; readonly sourceContent: string }): DiscoveryBundle {
  const hash = contentHash(options.sourceContent);
  const source: SourceSpan = { path: options.source, contentHash: hash };
  const moduleId = stableId("module", document.metadata.name);
  const nodes: DiscoveryNode[] = [{ id: moduleId, kind: "module", name: document.metadata.name, confidence: "proven", observable: false, attributes: { importer: options.analyzer }, sources: [source] }];
  const edges: DiscoveryEdge[] = [];
  const add = (kind: NodeKind, name: string, attributes: Record<string, unknown>, observable: boolean): void => {
    const id = stableId(kind, options.analyzer, document.metadata.name, name);
    nodes.push({ id, kind, name, confidence: "inferred", observable, attributes: { ...attributes, importer: options.analyzer, reviewRequired: true }, sources: [source] });
    edges.push({ id: stableId("edge", "contains", moduleId, id), kind: "contains", from: moduleId, to: id, confidence: "inferred", sources: [source] });
  };
  for (const [name, entity] of Object.entries(document.spec.entities)) add("entity", name, { fields: Object.keys(entity.fields), relationships: Object.keys(entity.relationships ?? {}) }, true);
  for (const [name, contract] of Object.entries(document.spec.contracts ?? {})) add("contract", name, { fields: Object.keys(contract.fields), boundary: true }, false);
  for (const [name, command] of Object.entries(document.spec.commands ?? {})) add("operation", name, { input: command.input, effect: command.effect.kind }, true);
  for (const operation of document.spec.http?.operations ?? []) add("endpoint", operation.id, { method: operation.method, path: operation.path }, true);
  for (const [name, port] of Object.entries(document.spec.ports ?? {})) add("vendor-call", name, { operations: Object.keys(port.operations) }, true);
  const now = new Date().toISOString();
  return { manifest: { apiVersion: DISCOVERY_API_VERSION, kind: "DiscoveryBundle", metadata: { name: document.metadata.name, repository: options.source, repositoryHash: hash, createdAt: now, updatedAt: now, analyzer: `${options.analyzer}-import-adapter`, analyzerVersion: "0.1.0" }, files: { nodes: "nodes.jsonl", edges: "edges.jsonl", evidence: "evidence.jsonl", decisions: "decisions.yaml", coverage: "coverage.json", index: "index.sqlite" } }, nodes, edges, evidence: [], decisions: [], coverage: computeCoverage(nodes) };
}

export function mergeDiscoveryBundles(primary: DiscoveryBundle, additions: readonly DiscoveryBundle[]): DiscoveryBundle {
  const nodes = new Map(primary.nodes.map((node) => [node.id, node]));
  const edges = new Map(primary.edges.map((edge) => [edge.id, edge]));
  const evidence = new Map(primary.evidence.map((item) => [item.id, item]));
  for (const bundle of additions) {
    for (const node of bundle.nodes) {
      const existing = nodes.get(node.id);
      nodes.set(node.id, existing && JSON.stringify(existing.attributes) !== JSON.stringify(node.attributes)
        ? { ...existing, confidence: "conflicting", sources: [...existing.sources, ...node.sources], diagnostics: [...(existing.diagnostics ?? []), `Conflicting ${bundle.manifest.metadata.analyzer} finding.`] }
        : existing ? { ...existing, sources: [...existing.sources, ...node.sources] } : node);
    }
    for (const edge of bundle.edges) edges.set(edge.id, edges.get(edge.id) ?? edge);
    for (const item of bundle.evidence) evidence.set(item.id, item);
  }
  const mergedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { ...primary, manifest: { ...primary.manifest, metadata: { ...primary.manifest.metadata, repositoryHash: contentHash([primary, ...additions].map((bundle) => bundle.manifest.metadata.repositoryHash).sort().join(":")), updatedAt: new Date().toISOString(), analyzer: [primary, ...additions].map((bundle) => bundle.manifest.metadata.analyzer).join("+") } }, nodes: mergedNodes, edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)), coverage: computeCoverage(mergedNodes) };
}

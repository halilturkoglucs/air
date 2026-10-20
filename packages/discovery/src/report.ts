import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import reportSchema from "../schema/discovery-report-0.1.schema.json" with { type: "json" };
import { evidenceHash } from "./ids.js";
import { readDiscoveryBundle } from "./store.js";
import type { DiscoveryBundle, DiscoveryNode, ReviewerDecision, SourceSpan } from "./types.js";

export const DISCOVERY_REPORT_API_VERSION = "air.dev/discovery-report/v0.1" as const;

type ReviewState = "unreviewed" | "approved" | "rejected" | "renamed" | "merged" | "opaque" | "invalidated";

interface ReportNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly module?: string;
  readonly confidence: DiscoveryNode["confidence"];
  readonly review: ReviewState;
  readonly provenance: readonly SourceSpan[];
}

export interface DiscoveryReport {
  readonly apiVersion: typeof DISCOVERY_REPORT_API_VERSION;
  readonly kind: "DiscoveryReport";
  readonly generatedAt: string;
  readonly repositoryHash: string;
  readonly analyzer: { readonly name: string; readonly version: string };
  readonly summary: { readonly nodes: number; readonly edges: number; readonly evidence: number; readonly entryPoints: number; readonly activeDecisions: number; readonly invalidatedDecisions: number; readonly unreviewed: number; readonly unresolved: number; readonly unmatchedEvidence: number };
  readonly coverage: DiscoveryBundle["coverage"];
  readonly modules: readonly ReportNode[];
  readonly entryPoints: readonly (ReportNode & { readonly method?: string; readonly path?: string; readonly protocol?: string; readonly reachable: readonly string[] })[];
  readonly unresolved: readonly (ReportNode & { readonly reason: string })[];
  readonly diagnostics: readonly { readonly nodeId: string; readonly message: string }[];
  readonly topology: readonly { readonly id: string; readonly kind: string; readonly from: string; readonly to: string; readonly confidence: DiscoveryNode["confidence"]; readonly provenance: readonly SourceSpan[] }[];
}

const validateReport = new Ajv2020({ allErrors: true, strict: true }).compile(reportSchema);

function activeDecision(node: DiscoveryNode, decisions: readonly ReviewerDecision[]): ReviewerDecision | undefined {
  return decisions.find((decision) => decision.subjectId === node.id && !decision.invalidated && decision.evidenceHash === evidenceHash(node.sources));
}

function reviewState(node: DiscoveryNode, decisions: readonly ReviewerDecision[]): ReviewState {
  const current = activeDecision(node, decisions);
  if (current) return current.action === "approve" ? "approved" : current.action === "reject" ? "rejected" : current.action === "rename" ? "renamed" : current.action === "merge" ? "merged" : "opaque";
  return decisions.some((decision) => decision.subjectId === node.id && decision.invalidated) ? "invalidated" : "unreviewed";
}

function summary(node: DiscoveryNode, decisions: readonly ReviewerDecision[]): ReportNode {
  return { id: node.id, kind: node.kind, name: node.name, ...(node.module ? { module: node.module } : {}), confidence: node.confidence, review: reviewState(node, decisions), provenance: [...node.sources].sort((a, b) => `${a.path}:${a.startLine ?? 0}`.localeCompare(`${b.path}:${b.startLine ?? 0}`)) };
}

function reachable(root: string, bundle: DiscoveryBundle): string[] {
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of bundle.edges) if (selected.has(edge.from) && !selected.has(edge.to)) { selected.add(edge.to); changed = true; }
  }
  selected.delete(root);
  return [...selected].sort();
}

export function createDiscoveryReport(bundle: DiscoveryBundle): DiscoveryReport {
  const entries = bundle.nodes.filter((node) => ["endpoint", "listener", "schedule"].includes(node.kind) || (node.kind === "operation" && node.attributes.entryPoint === true));
  const reviewScope = bundle.nodes.filter((node) => node.observable || ["endpoint", "listener", "schedule"].includes(node.kind) || (node.kind === "operation" && node.attributes.entryPoint === true));
  const unresolvedNodes = bundle.nodes.filter((node) => {
    const decision = activeDecision(node, bundle.decisions)?.action;
    if (decision === "approve" || decision === "reject") return false;
    return decision === "mark-opaque" || node.confidence === "opaque" || node.confidence === "conflicting" || (node.observable && node.confidence === "inferred");
  });
  const activeDecisions = bundle.decisions.filter((decision) => !decision.invalidated && bundle.nodes.some((node) => node.id === decision.subjectId && decision.evidenceHash === evidenceHash(node.sources)));
  const report: DiscoveryReport = {
    apiVersion: DISCOVERY_REPORT_API_VERSION,
    kind: "DiscoveryReport",
    generatedAt: bundle.manifest.metadata.updatedAt,
    repositoryHash: bundle.manifest.metadata.repositoryHash,
    analyzer: { name: bundle.manifest.metadata.analyzer, version: bundle.manifest.metadata.analyzerVersion },
    summary: {
      nodes: bundle.nodes.length,
      edges: bundle.edges.length,
      evidence: bundle.evidence.length,
      entryPoints: entries.length,
      activeDecisions: activeDecisions.length,
      invalidatedDecisions: bundle.decisions.filter((decision) => decision.invalidated).length,
      unreviewed: reviewScope.filter((node) => ["unreviewed", "invalidated"].includes(reviewState(node, bundle.decisions))).length,
      unresolved: unresolvedNodes.length,
      unmatchedEvidence: bundle.evidence.filter((item) => item.nodeIds.length === 0).length,
    },
    coverage: Object.fromEntries(Object.entries(bundle.coverage).sort(([a], [b]) => a.localeCompare(b))),
    modules: bundle.nodes.filter((node) => node.kind === "module").map((node) => summary(node, bundle.decisions)).sort((a, b) => a.id.localeCompare(b.id)),
    entryPoints: entries.map((node) => ({ ...summary(node, bundle.decisions), ...(typeof node.attributes.method === "string" ? { method: node.attributes.method } : {}), ...(typeof node.attributes.path === "string" ? { path: node.attributes.path } : {}), ...(typeof node.attributes.protocol === "string" ? { protocol: node.attributes.protocol } : {}), reachable: reachable(node.id, bundle) })).sort((a, b) => `${a.path ?? ""}:${a.method ?? ""}:${a.id}`.localeCompare(`${b.path ?? ""}:${b.method ?? ""}:${b.id}`)),
    unresolved: unresolvedNodes.map((node) => ({ ...summary(node, bundle.decisions), reason: node.confidence === "conflicting" ? "conflicting evidence" : node.confidence === "opaque" ? "opaque behavior" : "inferred observable behavior" })).sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: bundle.nodes.flatMap((node) => (node.diagnostics ?? []).map((message) => ({ nodeId: node.id, message }))).sort((a, b) => `${a.nodeId}:${a.message}`.localeCompare(`${b.nodeId}:${b.message}`)),
    topology: bundle.edges.map((edge) => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, confidence: edge.confidence, provenance: [...edge.sources].sort((a, b) => `${a.path}:${a.startLine ?? 0}`.localeCompare(`${b.path}:${b.startLine ?? 0}`)) })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (!validateReport(report)) throw new Error(`Discovery report is invalid: ${(validateReport.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
  return report;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function reportHtml(report: DiscoveryReport): string {
  const rows = report.entryPoints.map((entry) => `<tr><td>${escapeHtml(entry.method ?? entry.kind)}</td><td>${escapeHtml(entry.path ?? entry.name)}</td><td>${escapeHtml(entry.confidence)}</td><td>${escapeHtml(entry.review)}</td><td>${entry.reachable.length}</td></tr>`).join("");
  const unresolved = report.unresolved.map((node) => `<li><strong>${escapeHtml(node.name)}</strong> — ${escapeHtml(node.reason)} <small>${escapeHtml(node.provenance[0]?.path ?? "")}:${node.provenance[0]?.startLine ?? 1}</small></li>`).join("") || "<li>None</li>";
  const coverage = Object.entries(report.coverage).map(([kind, value]) => `<tr><td>${escapeHtml(kind)}</td><td>${value.supported}</td><td>${value.proven}</td><td>${value.observed}</td><td>${value.inferred}</td><td>${value.opaque + value.conflicting}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIR discovery report</title><style>body{font:14px system-ui;max-width:1200px;margin:40px auto;padding:0 20px;color:#172033}h1,h2{color:#07152e}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{padding:14px 18px;border:1px solid #d8dee9;border-radius:9px;min-width:130px}table{border-collapse:collapse;width:100%;margin:14px 0}th,td{text-align:left;padding:8px;border-bottom:1px solid #d8dee9}small{color:#667085}code{overflow-wrap:anywhere}</style></head><body><h1>AIR discovery report</h1><p><code>${escapeHtml(report.repositoryHash)}</code><br>${escapeHtml(report.analyzer.name)} ${escapeHtml(report.analyzer.version)}</p><div class="cards"><div class="card"><strong>${report.summary.nodes}</strong><br>nodes</div><div class="card"><strong>${report.summary.edges}</strong><br>edges</div><div class="card"><strong>${report.summary.entryPoints}</strong><br>entry points</div><div class="card"><strong>${report.summary.unresolved}</strong><br>unresolved</div><div class="card"><strong>${report.summary.activeDecisions}</strong><br>reviewed</div></div><h2>Coverage</h2><table><thead><tr><th>Kind</th><th>Total</th><th>Proven</th><th>Observed</th><th>Inferred</th><th>Unresolved</th></tr></thead><tbody>${coverage}</tbody></table><h2>Entry points</h2><table><thead><tr><th>Method</th><th>Path/name</th><th>Confidence</th><th>Review</th><th>Reachable nodes</th></tr></thead><tbody>${rows}</tbody></table><h2>Unresolved boundaries</h2><ul>${unresolved}</ul><p><small>Generated from redacted discovery metadata. Source contents and runtime payloads are not embedded.</small></p></body></html>`;
}

export async function writeDiscoveryReport(discoveryDirectory: string, outputDirectory: string): Promise<{ readonly report: DiscoveryReport; readonly json: string; readonly html: string }> {
  const report = createDiscoveryReport(await readDiscoveryBundle(resolve(discoveryDirectory)));
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const json = resolve(output, "report.json");
  const html = resolve(output, "report.html");
  await Promise.all([writeFile(json, `${JSON.stringify(report, null, 2)}\n`, "utf8"), writeFile(html, reportHtml(report), "utf8")]);
  return { report, json, html };
}

export const DISCOVERY_API_VERSION = "air.dev/discovery/v0.1" as const;

export type Confidence = "proven" | "observed" | "inferred" | "opaque" | "conflicting";
export type NodeKind =
  | "module" | "service" | "endpoint" | "contract" | "entity" | "table"
  | "transaction" | "listener" | "publisher" | "schedule" | "cache"
  | "vendor-call" | "configuration" | "repository" | "query" | "mapper"
  | "security" | "operation" | "foreign-operation" | "dynamic-routing";

export interface SourceSpan {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly contentHash: string;
  readonly symbol?: string;
  readonly buildCoordinate?: string;
}

export interface DiscoveryNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly module?: string;
  readonly confidence: Confidence;
  readonly observable: boolean;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly sources: readonly SourceSpan[];
  readonly evidenceIds?: readonly string[];
  readonly diagnostics?: readonly string[];
}

export interface DiscoveryEdge {
  readonly id: string;
  readonly kind: "contains" | "calls" | "reads" | "writes" | "publishes" | "consumes" | "maps" | "guards" | "configures" | "depends-on";
  readonly from: string;
  readonly to: string;
  readonly confidence: Confidence;
  readonly sources: readonly SourceSpan[];
  readonly evidenceIds?: readonly string[];
}

export interface RuntimeEvidence {
  readonly id: string;
  readonly kind: "trace" | "test" | "database-change" | "message" | "schema-contract" | "outbound-call";
  readonly observedAt: string;
  readonly source: string;
  readonly nodeIds: readonly string[];
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly redacted: boolean;
}

export interface EvidenceCaptureProfile {
  readonly apiVersion: "air.dev/evidence-capture/v0.1";
  readonly kind: "EvidenceCapture";
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly timeoutMs?: number;
    readonly sources: readonly EvidenceCaptureSource[];
  };
}

export type EvidenceCaptureSource =
  | { readonly id: string; readonly kind: "postgres"; readonly connectionEnv: string; readonly schema: string; readonly tables: readonly string[] }
  | { readonly id: string; readonly kind: "outbound-http"; readonly environment: string; readonly listen: { readonly host: "127.0.0.1" | "::1"; readonly port: number }; readonly stubs: readonly { readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; readonly path: string; readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }[] }
  | { readonly id: string; readonly kind: "kafka"; readonly brokersEnv: string; readonly topics: readonly string[]; readonly groupId?: string }
  | { readonly id: string; readonly kind: "rabbitmq"; readonly urlEnv: string; readonly queues: readonly string[] };

export interface ReviewerDecision {
  readonly subjectId: string;
  readonly action: "approve" | "reject" | "rename" | "merge" | "mark-opaque";
  readonly value?: string;
  readonly evidenceHash: string;
  readonly decidedAt: string;
  readonly reviewer?: string;
  readonly invalidated?: boolean;
  readonly reason?: string;
}

export interface CoverageDimension {
  readonly supported: number;
  readonly proven: number;
  readonly observed: number;
  readonly inferred: number;
  readonly opaque: number;
  readonly conflicting: number;
}

export interface DiscoveryManifest {
  readonly apiVersion: typeof DISCOVERY_API_VERSION;
  readonly kind: "DiscoveryBundle";
  readonly metadata: {
    readonly name: string;
    readonly repository: string;
    readonly repositoryHash: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly analyzer: string;
    readonly analyzerVersion: string;
  };
  readonly files: {
    readonly nodes: "nodes.jsonl";
    readonly edges: "edges.jsonl";
    readonly evidence: "evidence.jsonl";
    readonly decisions: "decisions.yaml";
    readonly coverage: "coverage.json";
    readonly index: "index.sqlite";
  };
}

export interface DiscoveryBundle {
  readonly manifest: DiscoveryManifest;
  readonly nodes: readonly DiscoveryNode[];
  readonly edges: readonly DiscoveryEdge[];
  readonly evidence: readonly RuntimeEvidence[];
  readonly decisions: readonly ReviewerDecision[];
  readonly coverage: Readonly<Record<string, CoverageDimension>>;
}

export interface DiscoveryDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly source?: SourceSpan;
}

export interface SpringDiscoveryResult {
  readonly bundle: DiscoveryBundle;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

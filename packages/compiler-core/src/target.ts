import type { AirDocument } from "@air/schema";

export const CAPABILITY_MANIFEST_VERSION = "air.dev/target-capabilities/v0.1" as const;

export type CapabilitySupport = "supported" | "conditional" | "unsupported";

export type CapabilityConstraint =
  | { readonly kind: "air-version"; readonly minimum: string; readonly maximum?: string }
  | { readonly kind: "option-in"; readonly option: string; readonly values: readonly (string | number | boolean)[] }
  | { readonly kind: "primary-effect-in"; readonly values: readonly ("create" | "update" | "delete")[] }
  | { readonly kind: "maximum-named-effects"; readonly value: number };

export interface CapabilityDeclaration {
  readonly support: CapabilitySupport;
  readonly notes?: string;
  readonly conditions?: readonly string[];
  readonly constraints?: readonly CapabilityConstraint[];
}

export interface CapabilityManifest {
  readonly apiVersion: typeof CAPABILITY_MANIFEST_VERSION;
  readonly target: {
    readonly id: string;
    readonly displayName: string;
    readonly version: string;
  };
  readonly capabilities: Readonly<Record<string, CapabilityDeclaration>>;
}

export type CompilationMode = "managed" | "detached";

export interface CompilationContext<TOptions = Readonly<Record<string, never>>> {
  readonly air: AirDocument;
  readonly outputDirectory: string;
  readonly mode: CompilationMode;
  readonly options: TOptions;
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface CompilationDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly airPath?: string;
  readonly help?: string;
}

export type ArtifactKind = "source" | "configuration" | "test" | "documentation" | "metadata";

export interface ArtifactProvenance {
  readonly airNodes: readonly string[];
  readonly compilerVersion: string;
  readonly targetId: string;
  readonly targetVersion: string;
}

export interface CompilationArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly checksum: string;
  readonly provenance: ArtifactProvenance;
}

export type CompilationResult =
  | {
      readonly status: "success";
      readonly artifacts: readonly CompilationArtifact[];
      readonly diagnostics: readonly CompilationDiagnostic[];
    }
  | {
      readonly status: "failed";
      readonly artifacts: readonly CompilationArtifact[];
      readonly diagnostics: readonly CompilationDiagnostic[];
    };

export interface TargetAdapter<TOptions = Readonly<Record<string, never>>> {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly manifest: CapabilityManifest;

  analyze(context: CompilationContext<TOptions>): Promise<readonly CompilationDiagnostic[]>;
  compile(context: CompilationContext<TOptions>): Promise<CompilationResult>;
}

import type { ArtifactKind } from "@air/compiler-core";

export interface RustTargetOptions {
  readonly rustEdition?: "2021" | "2024";
  readonly rustVersion?: string;
  readonly database?: "postgres";
  readonly deployment?: "binary" | "container";
}

export interface ResolvedRustTargetOptions {
  readonly rustEdition: "2021" | "2024";
  readonly rustVersion: string;
  readonly database: "postgres";
  readonly deployment: "binary" | "container";
}

export interface PlannedRustFile {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly airNodes: readonly string[];
  readonly content: string;
}

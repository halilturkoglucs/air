import type { ArtifactKind } from "@air/compiler-core";

export interface PythonTargetOptions {
  readonly pythonVersion?: string;
  readonly database?: "postgres";
  readonly deployment?: "process" | "container";
}

export interface ResolvedPythonTargetOptions {
  readonly pythonVersion: string;
  readonly database: "postgres";
  readonly deployment: "process" | "container";
}

export interface PlannedPythonFile {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly airNodes: readonly string[];
  readonly content: string;
}

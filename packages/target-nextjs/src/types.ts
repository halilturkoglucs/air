import type { ArtifactKind } from "@air/compiler-core";

export interface PlannedNextjsFile {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly airNodes: readonly string[];
  readonly content: string;
}

export interface ResolvedNextjsOptions {
  readonly frameworkVersion: string;
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun";
  readonly deployment: "vercel" | "node";
  readonly database: "postgres";
}

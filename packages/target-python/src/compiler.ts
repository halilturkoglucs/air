import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CompilationArtifact,
  CompilationContext,
  CompilationDiagnostic,
  CompilationResult,
} from "@air/compiler-core";
import { renderPythonFiles } from "./render.js";
import type { PlannedPythonFile, PythonTargetOptions, ResolvedPythonTargetOptions } from "./types.js";

const TARGET_ID = "python-fastapi";
const TARGET_VERSION = "0.10.0";
const COMPILER_VERSION = "0.10.0";
const MANIFEST_PATH = ".air/manifest.json";
const LOCK_PATH = ".air/lock.json";
const ADOPTION_PATH = ".air/adoption.json";

interface ManagedManifest {
  readonly format: "air.dev/generated-manifest/v0.1";
  readonly targetId: string;
  readonly artifacts: readonly { readonly path: string }[];
}

function options(input: PythonTargetOptions): ResolvedPythonTargetOptions {
  return {
    pythonVersion: input.pythonVersion ?? "3.12",
    database: input.database ?? "postgres",
    deployment: input.deployment ?? "process",
  };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function diagnostic(code: string, message: string, airPath?: string, help?: string): CompilationDiagnostic {
  return { severity: "error", code, message, ...(airPath ? { airPath } : {}), ...(help ? { help } : {}) };
}

export function validatePythonTarget(context: CompilationContext<PythonTargetOptions>): readonly CompilationDiagnostic[] {
  const diagnostics: CompilationDiagnostic[] = [];
  if (context.options.pythonVersion && !/^3\.\d+(?:\.\d+)?$/.test(context.options.pythonVersion)) {
    diagnostics.push(diagnostic("PYTHON_VERSION_INVALID", `Python version ${context.options.pythonVersion} must be an exact Python 3 version.`));
  }
  for (const [index, operation] of (context.air.spec.http?.operations ?? []).entries()) {
    if (operation.path === "/air-runtime" || operation.path.startsWith("/air-runtime/")) {
      diagnostics.push(diagnostic("PYTHON_RESERVED_RUNTIME_PATH", `Route ${operation.path} uses the target-owned /air-runtime namespace.`, `/spec/http/operations/${index}/path`));
    }
  }
  for (const [entityName, entity] of Object.entries(context.air.spec.entities)) {
    if (Object.values(entity.fields).filter((field) => field.primaryKey === true).length > 1) {
      diagnostics.push(diagnostic("PYTHON_COMPOSITE_PRIMARY_KEY_UNSUPPORTED", `Entity ${entityName} uses a composite primary key.`, `/spec/entities/${entityName}/fields`));
    }
    for (const [relationshipName, relationship] of Object.entries(entity.relationships ?? {})) {
      if (relationship.cardinality === "many-to-many") diagnostics.push(diagnostic("PYTHON_MANY_TO_MANY_REQUIRES_JOIN_ENTITY", `Relationship ${entityName}.${relationshipName} requires an explicit join entity.`, `/spec/entities/${entityName}/relationships/${relationshipName}`));
    }
  }
  for (const [commandName, command] of Object.entries(context.air.spec.commands ?? {})) {
    if (Object.keys(command.effects ?? {}).length > 0 && command.effect.kind !== "create") {
      diagnostics.push(diagnostic("PYTHON_MULTI_EFFECT_PRIMARY_CREATE_REQUIRED", `Command ${commandName} must use a primary create effect after named updates.`, `/spec/commands/${commandName}/effect`));
    }
  }
  return diagnostics;
}

export function planPython(air: CompilationContext<PythonTargetOptions>["air"], input: PythonTargetOptions = {}): readonly PlannedPythonFile[] {
  return renderPythonFiles(air, options(input));
}

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.air-tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function artifact(file: PlannedPythonFile): CompilationArtifact {
  return { path: file.path, kind: file.kind, checksum: sha256(file.content), provenance: { airNodes: file.airNodes, compilerVersion: COMPILER_VERSION, targetId: TARGET_ID, targetVersion: TARGET_VERSION } };
}

export async function compilePython(context: CompilationContext<PythonTargetOptions>): Promise<CompilationResult> {
  const diagnostics = [...validatePythonTarget(context)];
  if (diagnostics.length > 0) return { status: "failed", artifacts: [], diagnostics };
  const files = planPython(context.air, context.options);
  try {
    const manifestSource = await readText(join(context.outputDirectory, MANIFEST_PATH));
    let owned = new Set<string>();
    if (manifestSource) {
      try {
        const manifest = JSON.parse(manifestSource) as ManagedManifest;
        if (manifest.format === "air.dev/generated-manifest/v0.1" && manifest.targetId === TARGET_ID) owned = new Set(manifest.artifacts.map((item) => item.path));
      } catch { /* Invalid manifests own nothing. */ }
    }
    const adoptionSource = await readText(join(context.outputDirectory, ADOPTION_PATH));
    let userOwned = new Set<string>();
    if (adoptionSource) {
      try {
        const adoption = JSON.parse(adoptionSource) as { format?: unknown; targetId?: unknown; userOwned?: unknown };
        if (adoption.format === "air.dev/adoption-boundary/v0.1" && adoption.targetId === TARGET_ID && Array.isArray(adoption.userOwned)) userOwned = new Set(adoption.userOwned.filter((item): item is string => typeof item === "string"));
      } catch { diagnostics.push({ severity: "warning", code: "AIR_ADOPTION_INVALID", message: "Ignoring invalid .air/adoption.json." }); }
    }
    const generatedFiles = files.filter((file) => !userOwned.has(file.path));
    const artifacts = generatedFiles.map(artifact);
    for (const file of generatedFiles) {
      const current = await readText(join(context.outputDirectory, file.path));
      if (current === undefined || current === file.content || (context.mode === "managed" && owned.has(file.path))) continue;
      diagnostics.push(diagnostic("AIR_OUTPUT_CONFLICT", `Refusing to overwrite non-generated file ${file.path}.`));
    }
    if (diagnostics.length > 0) return { status: "failed", artifacts: [], diagnostics };
    for (const file of generatedFiles) await writeAtomic(join(context.outputDirectory, file.path), file.content);
    if (context.mode === "managed") {
      const sourceHash = sha256(JSON.stringify(canonicalize(context.air)));
      const resolved = options(context.options);
      const lockContent = `${JSON.stringify({
        format: "air.dev/compiler-lock/v0.1",
        source: { apiVersion: context.air.apiVersion, hash: sourceHash },
        compiler: { version: COMPILER_VERSION },
        target: { id: TARGET_ID, version: TARGET_VERSION, options: resolved },
        dependencies: { fastapi: "0.115", psycopg: "3.2", psycopgPool: "3.2", pydantic: "2", pyjwt: "2.10", python: resolved.pythonVersion, uvicorn: "0.34" },
        artifacts: artifacts.map((item) => ({ path: item.path, checksum: item.checksum })),
      }, null, 2)}\n`;
      await writeAtomic(join(context.outputDirectory, LOCK_PATH), lockContent);
      artifacts.push({ path: LOCK_PATH, kind: "metadata", checksum: sha256(lockContent), provenance: { airNodes: ["/"], compilerVersion: COMPILER_VERSION, targetId: TARGET_ID, targetVersion: TARGET_VERSION } });
      const manifestContent = `${JSON.stringify({ format: "air.dev/generated-manifest/v0.1", targetId: TARGET_ID, targetVersion: TARGET_VERSION, sourceHash, artifacts: artifacts.map((item) => ({ path: item.path, checksum: item.checksum, airNodes: item.provenance.airNodes })) }, null, 2)}\n`;
      await writeAtomic(join(context.outputDirectory, MANIFEST_PATH), manifestContent);
      artifacts.push({ path: MANIFEST_PATH, kind: "metadata", checksum: sha256(manifestContent), provenance: { airNodes: ["/"], compilerVersion: COMPILER_VERSION, targetId: TARGET_ID, targetVersion: TARGET_VERSION } });
    }
    return { status: "success", artifacts, diagnostics };
  } catch (error) {
    diagnostics.push(diagnostic("AIR_TARGET_WRITE_FAILED", error instanceof Error ? error.message : String(error)));
    return { status: "failed", artifacts: [], diagnostics };
  }
}

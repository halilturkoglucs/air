import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CompilationArtifact,
  CompilationContext,
  CompilationDiagnostic,
  CompilationResult,
} from "@air/compiler-core";
import type {
  AirDocument,
  CrudAction,
  CrudHttpOperation,
  EntityDefinition,
  HttpMethod,
  HttpOperation,
} from "@air/schema";
import type { NextjsTargetOptions } from "./index.js";
import { entityNames, routePathToDirectory } from "./naming.js";
import { renderNextjsFiles } from "./render.js";
import type { PlannedNextjsFile, ResolvedNextjsOptions } from "./types.js";

const TARGET_ID = "nextjs";
const TARGET_VERSION = "0.10.0";
const COMPILER_VERSION = "0.10.0";
const MANIFEST_PATH = ".air/manifest.json";
const LOCK_PATH = ".air/lock.json";
const ADOPTION_PATH = ".air/adoption.json";

interface ManagedManifest {
  readonly format: "air.dev/generated-manifest/v0.1";
  readonly targetId: string;
  readonly targetVersion: string;
  readonly sourceHash: string;
  readonly artifacts: readonly {
    readonly path: string;
    readonly checksum: string;
    readonly airNodes: readonly string[];
  }[];
}

interface AirCompilationLock {
  readonly format: "air.dev/compiler-lock/v0.1";
  readonly source: { readonly apiVersion: string; readonly hash: string };
  readonly compiler: { readonly version: string };
  readonly target: {
    readonly id: string;
    readonly version: string;
    readonly options: ResolvedNextjsOptions;
  };
  readonly dependencies: Readonly<Record<string, string>>;
  readonly artifacts: readonly { readonly path: string; readonly checksum: string }[];
}

function resolveOptions(options: NextjsTargetOptions): ResolvedNextjsOptions {
  return {
    frameworkVersion: options.frameworkVersion ?? "16.0.0",
    packageManager: options.packageManager ?? "pnpm",
    deployment: options.deployment ?? "vercel",
    database: options.database ?? "postgres",
  };
}

function diagnostic(
  code: string,
  message: string,
  airPath?: string,
  help?: string,
): CompilationDiagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(airPath === undefined ? {} : { airPath }),
    ...(help === undefined ? {} : { help }),
  };
}

const allowedMethods: Readonly<Record<CrudAction, readonly HttpMethod[]>> = {
  list: ["GET"],
  read: ["GET"],
  create: ["POST"],
  update: ["PUT", "PATCH"],
  delete: ["DELETE"],
};

function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? "");
}

function primaryField(entity: EntityDefinition) {
  return (
    Object.entries(entity.fields).find(([, field]) => field.primaryKey === true) ??
    (entity.fields.id ? (["id", entity.fields.id] as const) : undefined)
  );
}

function isCrudOperation(operation: HttpOperation): operation is CrudHttpOperation {
  return "entity" in operation;
}

export function validateNextjsTarget(
  context: CompilationContext<NextjsTargetOptions>,
): readonly CompilationDiagnostic[] {
  const diagnostics: CompilationDiagnostic[] = [];
  const { air } = context;
  const operations = air.spec.http?.operations ?? [];
  const operationRoutes = new Map<string, { owner: string; methods: Set<string> }>();
  const tableOwners = new Map<string, string>();

  for (const [entityName, entity] of Object.entries(air.spec.entities)) {
    const entityPath = `/spec/entities/${entityName}`;
    const table = entityNames(entityName).table;
    const previousOwner = tableOwners.get(table);
    if (previousOwner) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_TABLE_NAME_COLLISION",
          `${previousOwner} and ${entityName} both map to PostgreSQL table ${table}.`,
          entityPath,
          "Rename one entity so its normalized plural table name is unique.",
        ),
      );
    }
    tableOwners.set(table, entityName);

    for (const [relationshipName, relationship] of Object.entries(entity.relationships ?? {})) {
      if (relationship.cardinality === "many-to-many") {
        diagnostics.push(
          diagnostic(
            "NEXTJS_MANY_TO_MANY_NOT_IMPLEMENTED",
            `Relationship ${entityName}.${relationshipName} requires a join entity, which is not generated yet.`,
            `${entityPath}/relationships/${relationshipName}`,
            "Model the join as an explicit AIR entity for now.",
          ),
        );
      }
    }

    const primary = primaryField(entity);
    const actions = new Set(
      operations
        .filter(isCrudOperation)
        .filter((operation) => operation.entity === entityName)
        .map((operation) => operation.action),
    );
    if (primary && !["string", "uuid", "integer"].includes(primary[1].type)) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_UNSUPPORTED_ID_TYPE",
          `Entity ${entityName} uses ${primary[1].type} for its primary key; route parameters support string, uuid, and integer IDs.`,
          `${entityPath}/fields/${primary[0]}/type`,
        ),
      );
    }
    if ((["read", "update", "delete"] as const).some((action) => actions.has(action)) && !primary) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_ENTITY_ID_REQUIRED",
          `Entity ${entityName} needs an id field for read, update, or delete operations.`,
          `${entityPath}/fields`,
        ),
      );
    }
    if (
      actions.has("update") &&
      Object.entries(entity.fields).every(
        ([fieldName, field]) => fieldName === primary?.[0] || field.generated !== undefined,
      )
    ) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_UPDATE_HAS_NO_FIELDS",
          `Entity ${entityName} has no mutable fields for its update operation.`,
          `${entityPath}/fields`,
        ),
      );
    }
  }

  for (const [index, operation] of operations.entries()) {
    const airPath = `/spec/http/operations/${index}`;
    if (operation.path === "/air-runtime" || operation.path.startsWith("/air-runtime/")) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_RESERVED_RUNTIME_PATH",
          `Route ${operation.path} uses the target-owned /air-runtime namespace.`,
          `${airPath}/path`,
          "Choose an application route outside /air-runtime.",
        ),
      );
    }
    if (isCrudOperation(operation) && !allowedMethods[operation.action].includes(operation.method)) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_CRUD_METHOD_MISMATCH",
          `${operation.action} operation ${operation.id} cannot use HTTP ${operation.method}.`,
          `${airPath}/method`,
          `Allowed method(s): ${allowedMethods[operation.action].join(", ")}.`,
        ),
      );
    }

    if (!/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*$/.test(operation.path)) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_UNSUPPORTED_HTTP_PATH",
          `Path ${operation.path} cannot be mapped deterministically to an App Router route.`,
          `${airPath}/path`,
          "Use literal segments and {parameter} segments only.",
        ),
      );
    }

    const parameters = pathParameters(operation.path);
    if (!isCrudOperation(operation)) {
      if (operation.method !== "POST") {
        diagnostics.push(
          diagnostic(
            "NEXTJS_COMMAND_METHOD_REQUIRES_POST",
            `Command operation ${operation.id} must use HTTP POST.`,
            `${airPath}/method`,
          ),
        );
      }
      if (parameters.length > 0) {
        diagnostics.push(
          diagnostic(
            "NEXTJS_COMMAND_PATH_HAS_PARAMETERS",
            `Command operation ${operation.id} receives its explicit contract from the request body and cannot use path parameters.`,
            `${airPath}/path`,
          ),
        );
      }
    }
    const itemAction = isCrudOperation(operation) && ["read", "update", "delete"].includes(operation.action);
    if (itemAction && (parameters.length !== 1 || parameters[0] !== "id")) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_ITEM_PATH_REQUIRES_ID",
          `${operation.action} operation ${operation.id} must have exactly one {id} path parameter.`,
          `${airPath}/path`,
        ),
      );
    }
    if (isCrudOperation(operation) && !itemAction && parameters.length > 0) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_COLLECTION_PATH_HAS_PARAMETERS",
          `${operation.action} operation ${operation.id} must use a collection path without parameters.`,
          `${airPath}/path`,
        ),
      );
    }

    const routePath = routePathToDirectory(operation.path);
    const route = operationRoutes.get(routePath);
    const owner = isCrudOperation(operation)
      ? `entity ${operation.entity}`
      : `command ${operation.command}`;
    if (route && route.owner !== owner) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_ROUTE_ENTITY_CONFLICT",
          `Route ${operation.path} mixes ${route.owner} and ${owner}.`,
          airPath,
        ),
      );
    }
    if (route?.methods.has(operation.method)) {
      diagnostics.push(
        diagnostic(
          "NEXTJS_ROUTE_METHOD_CONFLICT",
          `Route ${operation.path} declares HTTP ${operation.method} more than once.`,
          airPath,
        ),
      );
    }
    if (route) route.methods.add(operation.method);
    else operationRoutes.set(routePath, { owner, methods: new Set([operation.method]) });
  }

  for (const [commandName, command] of Object.entries(air.spec.commands ?? {})) {
    if (Object.keys(command.effects ?? {}).length > 0 && command.effect.kind !== "create") {
      diagnostics.push(
        diagnostic(
          "NEXTJS_MULTI_EFFECT_PRIMARY_CREATE_REQUIRED",
          `Command ${commandName} uses named effects, but its primary effect is not a create effect.`,
          `/spec/commands/${commandName}/effect/kind`,
          "Use named updates followed by a primary create effect in the current Next.js target.",
        ),
      );
    }
  }

  return diagnostics;
}

export function planNextjs(
  air: AirDocument,
  options: NextjsTargetOptions = {},
): readonly PlannedNextjsFile[] {
  return renderNextjsFiles(air, resolveOptions(options));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readManagedManifest(outputDirectory: string): Promise<ManagedManifest | undefined> {
  const source = await readText(join(outputDirectory, MANIFEST_PATH));
  if (!source) return undefined;
  try {
    const parsed = JSON.parse(source) as Partial<ManagedManifest>;
    if (parsed.format !== "air.dev/generated-manifest/v0.1" || parsed.targetId !== TARGET_ID) {
      return undefined;
    }
    return parsed as ManagedManifest;
  } catch {
    return undefined;
  }
}

function toArtifact(file: PlannedNextjsFile): CompilationArtifact {
  return {
    path: file.path,
    kind: file.kind,
    checksum: sha256(file.content),
    provenance: {
      airNodes: file.airNodes,
      compilerVersion: COMPILER_VERSION,
      targetId: TARGET_ID,
      targetVersion: TARGET_VERSION,
    },
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.air-tmp-${process.pid}`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

export async function compileNextjs(
  context: CompilationContext<NextjsTargetOptions>,
): Promise<CompilationResult> {
  const diagnostics = [...validateNextjsTarget(context)];
  if (diagnostics.some((item) => item.severity === "error")) {
    return { status: "failed", artifacts: [], diagnostics };
  }

  const files = planNextjs(context.air, context.options);

  try {
    const previousManifest = await readManagedManifest(context.outputDirectory);
    const ownedPaths = new Set(previousManifest?.artifacts.map((artifact) => artifact.path) ?? []);
    const adoptionSource = await readText(join(context.outputDirectory, ADOPTION_PATH));
    let userOwned = new Set<string>();
    if (adoptionSource) {
      try {
        const adoption = JSON.parse(adoptionSource) as { format?: unknown; targetId?: unknown; userOwned?: unknown };
        if (adoption.format === "air.dev/adoption-boundary/v0.1" && adoption.targetId === TARGET_ID && Array.isArray(adoption.userOwned)) userOwned = new Set(adoption.userOwned.filter((item): item is string => typeof item === "string"));
      } catch { diagnostics.push(diagnostic("AIR_ADOPTION_INVALID", "Ignoring invalid .air/adoption.json.")); }
    }
    const generatedFiles = files.filter((file) => !userOwned.has(file.path));
    const artifacts = generatedFiles.map(toArtifact);

    for (const file of generatedFiles) {
      const current = await readText(join(context.outputDirectory, file.path));
      if (current === undefined || current === file.content) continue;
      if (context.mode === "managed" && ownedPaths.has(file.path)) continue;
      diagnostics.push(
        diagnostic(
          "AIR_OUTPUT_CONFLICT",
          `Refusing to overwrite non-generated file ${file.path}.`,
          undefined,
          "Choose an empty output directory or remove the conflicting file yourself.",
        ),
      );
    }

    if (diagnostics.some((item) => item.severity === "error")) {
      return { status: "failed", artifacts: [], diagnostics };
    }

    await mkdir(context.outputDirectory, { recursive: true });
    for (const file of generatedFiles) {
      await writeAtomic(join(context.outputDirectory, file.path), file.content);
    }

    if (context.mode === "managed") {
      const sourceHash = sha256(JSON.stringify(canonicalize(context.air)));
      const resolvedOptions = resolveOptions(context.options);
      const lock: AirCompilationLock = {
        format: "air.dev/compiler-lock/v0.1",
        source: { apiVersion: context.air.apiVersion, hash: sourceHash },
        compiler: { version: COMPILER_VERSION },
        target: { id: TARGET_ID, version: TARGET_VERSION, options: resolvedOptions },
        dependencies: {
          next: resolvedOptions.frameworkVersion,
          drizzleOrm: "0.45.1",
          jose: "6.1.3",
          postgres: "3.4.8",
          zod: "4.3.6",
        },
        artifacts: artifacts.map((artifact) => ({
          path: artifact.path,
          checksum: artifact.checksum,
        })),
      };
      const lockContent = `${JSON.stringify(lock, null, 2)}\n`;
      await writeAtomic(join(context.outputDirectory, LOCK_PATH), lockContent);
      artifacts.push({
        path: LOCK_PATH,
        kind: "metadata",
        checksum: sha256(lockContent),
        provenance: {
          airNodes: ["/"],
          compilerVersion: COMPILER_VERSION,
          targetId: TARGET_ID,
          targetVersion: TARGET_VERSION,
        },
      });

      const manifest: ManagedManifest = {
        format: "air.dev/generated-manifest/v0.1",
        targetId: TARGET_ID,
        targetVersion: TARGET_VERSION,
        sourceHash,
        artifacts: artifacts.map((artifact) => ({
          path: artifact.path,
          checksum: artifact.checksum,
          airNodes: artifact.provenance.airNodes,
        })),
      };
      const content = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeAtomic(join(context.outputDirectory, MANIFEST_PATH), content);
      artifacts.push({
        path: MANIFEST_PATH,
        kind: "metadata",
        checksum: sha256(content),
        provenance: {
          airNodes: ["/"],
          compilerVersion: COMPILER_VERSION,
          targetId: TARGET_ID,
          targetVersion: TARGET_VERSION,
        },
      });
    }

    return { status: "success", artifacts, diagnostics };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "AIR_TARGET_WRITE_FAILED",
        error instanceof Error ? error.message : String(error),
        undefined,
        "Check output-directory permissions and retry.",
      ),
    );
    return { status: "failed", artifacts: [], diagnostics };
  }
}

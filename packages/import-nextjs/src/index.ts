import { readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { AirDocument, EntityDefinition, FieldDefinition, HttpOperation } from "@air/schema";

export interface NextjsImportDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly source?: string;
}

export interface NextjsImportSource {
  readonly path: string;
  readonly kind: "drizzle-schema" | "route";
  readonly confidence: "high" | "review";
  readonly airPaths: readonly string[];
}

export interface NextjsImportResult {
  readonly document: AirDocument;
  readonly diagnostics: readonly NextjsImportDiagnostic[];
  readonly sources: readonly NextjsImportSource[];
}

export interface NextjsImportOptions {
  readonly name?: string;
  readonly schemaPath?: string;
}

function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part.toLowerCase());
}

function pascal(value: string): string { return words(value).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(""); }
function camel(value: string): string { const name = pascal(value); return name[0]!.toLowerCase() + name.slice(1); }
function singular(value: string): string {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/i.test(value)) return value.slice(0, -2);
  return value.endsWith("s") ? value.slice(0, -1) : value;
}

function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function fieldType(builder: string): FieldDefinition["type"] | undefined {
  if (/^uuid\(/.test(builder)) return "uuid";
  if (/^(integer|bigint|serial|bigserial)\(/.test(builder)) return "integer";
  if (/^(real|doublePrecision|numeric|decimal)\(/.test(builder)) return "number";
  if (/^boolean\(/.test(builder)) return "boolean";
  if (/^date\(/.test(builder)) return "date";
  if (/^timestamp\(/.test(builder)) return "datetime";
  if (/^jsonb?\(/.test(builder)) return "json";
  if (/^(text|varchar|char)\(/.test(builder)) return "string";
  return undefined;
}

function parseDefault(builder: string): string | number | boolean | undefined {
  const value = /\.default\(([^)]+)\)/.exec(builder)?.[1]?.trim();
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return undefined;
}

function parseDrizzle(source: string, path: string, diagnostics: NextjsImportDiagnostic[]): { entities: Record<string, EntityDefinition>; tables: Map<string, string> } {
  const entities: Record<string, EntityDefinition> = {};
  const tables = new Map<string, string>();
  const expression = /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*["']([^"']+)["']\s*,\s*\{/g;
  for (const match of source.matchAll(expression)) {
    const variable = match[1]!;
    const table = match[2]!;
    const open = (match.index ?? 0) + match[0].lastIndexOf("{");
    const close = matchingBrace(source, open);
    if (close < 0) {
      diagnostics.push({ severity: "error", code: "NEXTJS_DRIZZLE_OBJECT_UNCLOSED", message: `Could not find the end of pgTable ${table}.`, source: path });
      continue;
    }
    const body = source.slice(open + 1, close);
    const fields: Record<string, FieldDefinition> = {};
    for (const line of body.split(/\r?\n/)) {
      const field = /^\s*(\w+)\s*:\s*(.+?),?\s*$/.exec(line);
      if (!field) continue;
      const name = field[1]!;
      const builder = field[2]!;
      const type = fieldType(builder);
      if (!type) {
        diagnostics.push({ severity: "warning", code: "NEXTJS_DRIZZLE_TYPE_UNSUPPORTED", message: `Field ${variable}.${name} uses an unsupported Drizzle builder.`, source: path });
        continue;
      }
      const generated = builder.includes(".defaultRandom()") ? "uuid" as const : builder.includes(".defaultNow()") ? "created-at" as const : undefined;
      const defaultValue = parseDefault(builder);
      const primaryKey = builder.includes(".primaryKey()");
      const required = !generated && defaultValue === undefined && (builder.includes(".notNull()") || primaryKey);
      fields[name] = {
        type,
        ...(primaryKey ? { primaryKey: true } : {}),
        ...(builder.includes(".unique()") ? { unique: true } : {}),
        ...(generated ? { generated } : {}),
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        ...(required ? { required: true } : !builder.includes(".notNull()") && !primaryKey ? { nullable: true } : {}),
      };
    }
    const entityName = pascal(singular(variable));
    if (!Object.values(fields).some((field) => field.primaryKey)) {
      diagnostics.push({ severity: "warning", code: "NEXTJS_PRIMARY_KEY_UNCERTAIN", message: `Table ${table} has no statically recognized primary key.`, source: path });
    }
    entities[entityName] = { fields };
    tables.set(table, entityName);
    tables.set(variable, entityName);
  }
  if (Object.keys(entities).length === 0) diagnostics.push({ severity: "error", code: "NEXTJS_NO_DRIZZLE_TABLES", message: "No pgTable declarations were found.", source: path });
  return { entities, tables };
}

async function routeFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "route.ts") result.push(path);
    }
  };
  try { await visit(resolve(root, "src/app")); } catch { /* Missing App Router is diagnosed by the caller. */ }
  return result.sort();
}

function routePath(root: string, file: string): string {
  const directory = relative(resolve(root, "src/app"), resolve(file, ".."));
  return `/${directory.split(sep).filter((part) => !part.startsWith("(")).map((part) => part.replace(/^\[(.+)]$/, "{$1}")).join("/")}`;
}

export async function importNextjs(directory: string, options: NextjsImportOptions = {}): Promise<NextjsImportResult> {
  const root = resolve(directory);
  const diagnostics: NextjsImportDiagnostic[] = [];
  const sources: NextjsImportSource[] = [];
  const schemaCandidates = options.schemaPath ? [resolve(root, options.schemaPath)] : [resolve(root, "src/db/schema.ts"), resolve(root, "db/schema.ts"), resolve(root, "src/schema.ts")];
  let schemaPath: string | undefined;
  let schemaSource: string | undefined;
  for (const candidate of schemaCandidates) {
    try { schemaSource = await readFile(candidate, "utf8"); schemaPath = candidate; break; } catch { /* Try the next conventional location. */ }
  }
  if (!schemaPath || schemaSource === undefined) throw new Error("Could not find a Drizzle schema. Use --schema <path>.");
  const parsed = parseDrizzle(schemaSource, relative(root, schemaPath), diagnostics);
  sources.push({ path: relative(root, schemaPath), kind: "drizzle-schema", confidence: "high", airPaths: ["/spec/entities"] });

  const operations: HttpOperation[] = [];
  const files = await routeFiles(root);
  if (files.length === 0) diagnostics.push({ severity: "warning", code: "NEXTJS_NO_APP_ROUTES", message: "No App Router route.ts files were found under src/app." });
  for (const file of files) {
    const path = routePath(root, file);
    if (path.startsWith("/air-runtime") || path.startsWith("/_air")) continue;
    const source = await readFile(file, "utf8");
    const methods = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)\s*\(/g)].map((match) => match[1]!);
    const first = path.split("/").filter(Boolean)[0]?.replace(/[{}]/g, "") ?? "";
    const entity = parsed.tables.get(first) ?? Object.keys(parsed.entities).find((name) => name.toLowerCase() === singular(first).toLowerCase());
    const airPaths: string[] = [];
    for (const method of methods) {
      if (source.includes("@/commands/") || source.includes("/commands/")) {
        diagnostics.push({ severity: "warning", code: "NEXTJS_COMMAND_REQUIRES_REVIEW", message: `${method} ${path} invokes command code whose transactional semantics cannot be reconstructed statically.`, source: relative(root, file) });
        continue;
      }
      if (!entity) {
        diagnostics.push({ severity: "warning", code: "NEXTJS_ROUTE_ENTITY_UNCERTAIN", message: `${method} ${path} could not be matched to a Drizzle entity.`, source: relative(root, file) });
        continue;
      }
      const parameterized = path.includes("{");
      const action = method === "GET" ? (parameterized ? "read" : "list") : method === "POST" ? "create" : method === "DELETE" ? "delete" : "update";
      const id = camel(`${action} ${entity}`);
      operations.push({ id, method: method === "PUT" ? "PATCH" : method as "GET" | "POST" | "PATCH" | "DELETE", path, entity, action });
      airPaths.push(`/spec/http/operations/${operations.length - 1}`);
    }
    sources.push({ path: relative(root, file), kind: "route", confidence: methods.length > 0 && airPaths.length === methods.length ? "high" : "review", airPaths });
  }
  const name = options.name ?? (basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "imported-nextjs");
  const document: AirDocument = {
    apiVersion: "air.dev/v0.8",
    kind: "Application",
    metadata: { name, displayName: pascal(name), version: "0.1.0", description: "Imported from a Next.js App Router and Drizzle project; review diagnostics before adoption." },
    spec: { entities: parsed.entities, ...(operations.length > 0 ? { http: { operations } } : {}) },
  };
  return { document, diagnostics, sources };
}

import { parse } from "yaml";
import {
  AIR_API_VERSION,
  AIR_KIND,
  type AirDocument,
  type EntityDefinition,
  type FieldDefinition,
  type PrimitiveType,
} from "@air/schema";

type JsonObject = Record<string, unknown>;

export interface OpenApiImportDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly sourcePath: string;
}

export interface OpenApiImportOptions {
  readonly applicationName: string;
  readonly displayName?: string;
}

export interface OpenApiImportResult {
  readonly air: AirDocument;
  readonly diagnostics: readonly OpenApiImportDiagnostic[];
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function words(value: string): string[] {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function pascalCase(value: string): string {
  return words(value).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
}

function camelCase(value: string): string {
  const result = pascalCase(value);
  return `${result[0]?.toLowerCase() ?? ""}${result.slice(1)}`;
}

function primitive(schema: JsonObject): PrimitiveType | undefined {
  if (schema.type === "integer") return "integer";
  if (schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string") {
    if (schema.format === "uuid") return "uuid";
    if (schema.format === "date") return "date";
    if (schema.format === "date-time") return "datetime";
    return "string";
  }
  if (schema.type === "object" || schema.type === "array") return "json";
  return undefined;
}

function referenceName(value: unknown): string | undefined {
  const schema = object(value);
  if (!schema) return undefined;
  if (typeof schema.$ref === "string") return schema.$ref.split("/").at(-1);
  if (schema.type === "array") return referenceName(schema.items);
  return undefined;
}

function responseSchema(operation: JsonObject): unknown {
  const responses = object(operation.responses);
  for (const status of ["200", "201", "202", "default"]) {
    const response = object(responses?.[status]);
    const content = object(response?.content);
    const media = object(content?.["application/json"]);
    if (media?.schema) return media.schema;
  }
  return undefined;
}

function requestSchema(operation: JsonObject): unknown {
  const requestBody = object(operation.requestBody);
  const content = object(requestBody?.content);
  return object(content?.["application/json"])?.schema;
}

function inferAction(method: string, path: string): "create" | "read" | "update" | "delete" | "list" | undefined {
  const item = /\{[^}]+\}/.test(path);
  if (method === "get") return item ? "read" : "list";
  if (method === "post" && !item) return "create";
  if ((method === "put" || method === "patch") && item) return "update";
  if (method === "delete" && item) return "delete";
  return undefined;
}

export function importOpenApiDocument(
  input: unknown,
  options: OpenApiImportOptions,
): OpenApiImportResult {
  const root = object(input);
  if (!root || typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) {
    throw new Error("OpenAPI import requires an OpenAPI 3.x document.");
  }
  const diagnostics: OpenApiImportDiagnostic[] = [];
  const schemas = object(object(root.components)?.schemas) ?? {};
  const entities: Record<string, EntityDefinition> = {};
  for (const schemaName of Object.keys(schemas).sort()) {
    const schema = object(schemas[schemaName]);
    if (!schema || schema.type !== "object") {
      diagnostics.push({ severity: "warning", code: "OPENAPI_NON_OBJECT_SCHEMA_OMITTED", message: `Schema ${schemaName} is not an object and was omitted.`, sourcePath: `#/components/schemas/${schemaName}` });
      continue;
    }
    const properties = object(schema.properties) ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
    const fields: Record<string, FieldDefinition> = {};
    for (const propertyName of Object.keys(properties).sort()) {
      const property = object(properties[propertyName]);
      if (!property) continue;
      const type = primitive(property);
      const path = `#/components/schemas/${schemaName}/properties/${propertyName}`;
      if (!type) {
        diagnostics.push({ severity: "warning", code: "OPENAPI_TYPE_APPROXIMATED_AS_JSON", message: `Property ${schemaName}.${propertyName} has no portable scalar mapping and was approximated as json.`, sourcePath: path });
      } else if (type === "json") {
        diagnostics.push({ severity: "warning", code: "OPENAPI_STRUCTURED_VALUE_APPROXIMATED_AS_JSON", message: `Property ${schemaName}.${propertyName} remains opaque json; nested behavior was not inferred.`, sourcePath: path });
      }
      const validation = {
        ...(typeof property.minLength === "number" ? { minLength: property.minLength } : {}),
        ...(typeof property.maxLength === "number" ? { maxLength: property.maxLength } : {}),
        ...(typeof property.pattern === "string" ? { pattern: property.pattern } : {}),
        ...(typeof property.minimum === "number" ? { minimum: property.minimum } : {}),
        ...(typeof property.maximum === "number" ? { maximum: property.maximum } : {}),
        ...(Array.isArray(property.enum) ? { enum: property.enum.filter((item): item is string | number | boolean | null => item === null || ["string", "number", "boolean"].includes(typeof item)) } : {}),
      };
      fields[camelCase(propertyName)] = {
        type: type ?? "json",
        ...(propertyName === "id" ? { primaryKey: true } : {}),
        ...(!required.has(propertyName) || property.nullable === true ? { nullable: true } : {}),
        ...(typeof property.description === "string" ? { description: property.description } : {}),
        ...(Object.keys(validation).length > 0 ? { validation } : {}),
      };
    }
    if (!fields.id) {
      fields.id = { type: "uuid", primaryKey: true, generated: "uuid" };
      diagnostics.push({ severity: "warning", code: "OPENAPI_SYNTHETIC_PRIMARY_KEY", message: `Schema ${schemaName} has no id property; a generated UUID id was proposed and requires review.`, sourcePath: `#/components/schemas/${schemaName}` });
    } else {
      const { nullable: _nullable, ...idField } = fields.id;
      fields.id = { ...idField, primaryKey: true };
    }
    entities[pascalCase(schemaName)] = { ...(typeof schema.description === "string" ? { description: schema.description } : {}), fields };
  }

  const operations: NonNullable<AirDocument["spec"]["http"]>["operations"][number][] = [];
  const paths = object(root.paths) ?? {};
  for (const path of Object.keys(paths).sort()) {
    const pathItem = object(paths[path]);
    if (!pathItem) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = object(pathItem[method]);
      if (!operation) continue;
      const action = inferAction(method, path);
      if (!action) {
        diagnostics.push({ severity: "warning", code: "OPENAPI_OPERATION_NOT_CRUD", message: `${method.toUpperCase()} ${path} was not imported because its semantics are not unambiguous CRUD.`, sourcePath: `#/paths/${path}/${method}` });
        continue;
      }
      const referenced = referenceName(responseSchema(operation)) ?? referenceName(requestSchema(operation));
      const fallback = pascalCase(path.split("/").find((part) => part && !part.startsWith("{")) ?? "");
      const entity = referenced ? pascalCase(referenced) : [...Object.keys(entities)].find((name) => name.toLowerCase() === fallback.replace(/s$/i, "").toLowerCase());
      if (!entity || !entities[entity]) {
        diagnostics.push({ severity: "warning", code: "OPENAPI_OPERATION_ENTITY_UNCERTAIN", message: `${method.toUpperCase()} ${path} could not be tied to one imported entity and was omitted.`, sourcePath: `#/paths/${path}/${method}` });
        continue;
      }
      if (operation.security !== undefined || root.security !== undefined) {
        diagnostics.push({ severity: "warning", code: "OPENAPI_SECURITY_REQUIRES_POLICY_REVIEW", message: `${method.toUpperCase()} ${path} declares security, but OpenAPI does not encode enough authorization semantics to generate AIR policy safely.`, sourcePath: `#/paths/${path}/${method}/security` });
      }
      const operationId = typeof operation.operationId === "string"
        ? camelCase(operation.operationId)
        : `${action}${entity}`;
      operations.push({
        id: operationId,
        method: method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path,
        entity,
        action,
        ...(typeof operation.description === "string" ? { description: operation.description } : {}),
      });
    }
  }

  return {
    air: {
      apiVersion: AIR_API_VERSION,
      kind: AIR_KIND,
      metadata: {
        name: options.applicationName,
        ...(options.displayName ? { displayName: options.displayName } : {}),
        description: "Imported from OpenAPI. Review every uncertainty diagnostic before making AIR authoritative.",
      },
      spec: { entities, ...(operations.length > 0 ? { http: { operations } } : {}) },
    },
    diagnostics,
  };
}

export function importOpenApiSource(source: string, options: OpenApiImportOptions): OpenApiImportResult {
  return importOpenApiDocument(parse(source, { uniqueKeys: true }), options);
}

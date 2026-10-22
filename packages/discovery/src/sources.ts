import type { CheckDocument } from "./check.js";

// Framework-neutral inputs teams already have: OpenTelemetry traces and OpenAPI specs.

export interface TraceEndpoint {
  readonly method: string;
  readonly route: string;
  readonly service: string;
  readonly calls: number;
  readonly database: readonly string[];
  readonly outbound: readonly string[];
  readonly messages: readonly string[];
}
export interface TraceMap { readonly apiVersion: "air.dev/trace-map/v0.1"; readonly services: readonly string[]; readonly endpoints: readonly TraceEndpoint[] }

type OtlpValue = { readonly stringValue?: string; readonly intValue?: string | number };
type OtlpAttribute = { readonly key: string; readonly value?: OtlpValue };
type OtlpSpan = { readonly traceId?: string; readonly spanId?: string; readonly parentSpanId?: string; readonly name?: string; readonly kind?: number | string; readonly attributes?: readonly OtlpAttribute[] };

const attribute = (span: OtlpSpan, ...keys: string[]): string | undefined => {
  for (const key of keys) { const value = span.attributes?.find((item) => item.key === key)?.value; if (value?.stringValue !== undefined) return value.stringValue; if (value?.intValue !== undefined) return String(value.intValue); }
  return undefined;
};
// OTLP JSON encodes SpanKind as a number (2 = server, 3 = client, 4 = producer) or as SPAN_KIND_* names.
const kindOf = (span: OtlpSpan): "server" | "client" | "producer" | "consumer" | "internal" => {
  const kind = String(span.kind ?? "");
  if (kind === "2" || kind.endsWith("SERVER")) return "server";
  if (kind === "3" || kind.endsWith("CLIENT")) return "client";
  if (kind === "4" || kind.endsWith("PRODUCER")) return "producer";
  if (kind === "5" || kind.endsWith("CONSUMER")) return "consumer";
  return "internal";
};
const TABLE = /\b(?:from|into|update|join)\s+["`[]?([a-z_][\w.]*)/iu;

export function traceMapFromOtlp(otlp: unknown, options: { readonly service?: string } = {}): TraceMap {
  const resourceSpans = (otlp as { resourceSpans?: readonly { resource?: { attributes?: readonly OtlpAttribute[] }; scopeSpans?: readonly { spans?: readonly OtlpSpan[] }[] }[] })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) throw new Error("Not an OTLP JSON trace export: resourceSpans is missing.");
  const spans: { span: OtlpSpan; service: string }[] = [];
  for (const resource of resourceSpans) {
    const service = resource.resource?.attributes?.find((item: OtlpAttribute) => item.key === "service.name")?.value?.stringValue ?? "unknown";
    for (const scope of resource.scopeSpans ?? []) for (const span of scope.spans ?? []) spans.push({ span, service });
  }
  const byId = new Map(spans.filter(({ span }) => span.spanId).map((entry) => [`${entry.span.traceId}:${entry.span.spanId}`, entry]));
  // Walk up the parent chain to the nearest server span: that endpoint owns the work.
  const ownerOf = (entry: { span: OtlpSpan; service: string }): { span: OtlpSpan; service: string } | undefined => {
    let current: { span: OtlpSpan; service: string } | undefined = entry;
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (kindOf(current.span) === "server" && current !== entry) return current;
      current = current.span.parentSpanId ? byId.get(`${current.span.traceId}:${current.span.parentSpanId}`) : undefined;
    }
    return undefined;
  };
  const endpoints = new Map<string, { method: string; route: string; service: string; calls: number; database: Set<string>; outbound: Set<string>; messages: Set<string> }>();
  const keyOf = (entry: { span: OtlpSpan; service: string }) => {
    const method = (attribute(entry.span, "http.request.method", "http.method") ?? "GET").toUpperCase();
    const route = attribute(entry.span, "http.route") ?? attribute(entry.span, "url.path", "http.target")?.split("?")[0] ?? entry.span.name ?? "/";
    return { key: `${entry.service} ${method} ${route}`, method, route };
  };
  for (const entry of spans) {
    if (kindOf(entry.span) !== "server" || (options.service && entry.service !== options.service)) continue;
    const { key, method, route } = keyOf(entry);
    const endpoint = endpoints.get(key) ?? { method, route, service: entry.service, calls: 0, database: new Set(), outbound: new Set(), messages: new Set() };
    endpoint.calls += 1; endpoints.set(key, endpoint);
  }
  for (const entry of spans) {
    const kind = kindOf(entry.span); if (kind === "server") continue;
    const owner = ownerOf(entry);
    if (!owner) continue;
    const endpoint = endpoints.get(keyOf(owner).key); if (!endpoint) continue;
    const system = attribute(entry.span, "db.system.name", "db.system");
    if (system) {
      const table = attribute(entry.span, "db.collection.name", "db.sql.table", "db.mongodb.collection") ?? TABLE.exec(attribute(entry.span, "db.query.text", "db.statement") ?? "")?.[1];
      const operation = attribute(entry.span, "db.operation.name", "db.operation");
      endpoint.database.add(`${system}${table ? `:${table}` : ""}${operation ? ` ${operation.toUpperCase()}` : ""}`);
      continue;
    }
    const destination = attribute(entry.span, "messaging.destination.name");
    if (destination || kind === "producer") { endpoint.messages.add(`${attribute(entry.span, "messaging.system") ?? "messaging"}:${destination ?? entry.span.name ?? "unknown"}`); continue; }
    if (kind === "client") {
      const host = attribute(entry.span, "server.address", "net.peer.name", "http.host");
      const method = attribute(entry.span, "http.request.method", "http.method");
      const route = attribute(entry.span, "http.route", "url.template", "url.path");
      endpoint.outbound.add([method?.toUpperCase(), host, route].filter(Boolean).join(" ") || entry.span.name || "unknown");
    }
  }
  const sorted = [...endpoints.values()].map((item) => ({ method: item.method, route: item.route, service: item.service, calls: item.calls, database: [...item.database].sort(), outbound: [...item.outbound].sort(), messages: [...item.messages].sort() }))
    .sort((left, right) => left.service.localeCompare(right.service) || left.route.localeCompare(right.route) || left.method.localeCompare(right.method));
  return { apiVersion: "air.dev/trace-map/v0.1", services: [...new Set(spans.map((item) => item.service))].sort(), endpoints: sorted };
}

export function formatTraceMap(map: TraceMap): string {
  const lines = [`${map.endpoints.length} endpoint(s) across ${map.services.length} service(s): ${map.services.join(", ")}`];
  for (const endpoint of map.endpoints) {
    lines.push(`${endpoint.service} ${endpoint.method} ${endpoint.route} (${endpoint.calls} call${endpoint.calls === 1 ? "" : "s"})`);
    for (const [label, items] of [["db", endpoint.database], ["out", endpoint.outbound], ["msg", endpoint.messages]] as const) if (items.length > 0) lines.push(`  ${label}: ${items.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

// --- OpenAPI ---------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;
export interface ApiOperation { readonly method: string; readonly path: string; readonly operationId?: string }

export function operationsFromOpenApi(spec: unknown): ApiOperation[] {
  const paths = (spec as { paths?: Record<string, JsonObject> })?.paths;
  if (!paths || typeof paths !== "object") throw new Error("Not an OpenAPI document: paths is missing.");
  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(paths)) for (const method of HTTP_METHODS) {
    const operation = item?.[method] as JsonObject | undefined;
    if (operation) operations.push({ method: method.toUpperCase(), path, ...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}) });
  }
  return operations;
}

function resolveRef(spec: JsonObject, value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 8) return value;
  const ref = (value as JsonObject).$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return value;
  let current: unknown = spec;
  for (const part of ref.slice(2).split("/")) current = (current as JsonObject | undefined)?.[part.replaceAll("~1", "/").replaceAll("~0", "~")];
  return resolveRef(spec, current, depth + 1);
}

// Builds a deterministic example from a JSON schema: explicit examples first, then type defaults for required fields.
function exampleFor(spec: JsonObject, schemaInput: unknown, depth = 0): unknown {
  const schema = resolveRef(spec, schemaInput) as JsonObject | undefined;
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : Object.keys(properties));
    return Object.fromEntries(Object.entries(properties).filter(([name]) => required.has(name)).map(([name, property]) => [name, exampleFor(spec, property, depth + 1)]));
  }
  if (type === "array") return [exampleFor(spec, schema.items, depth + 1)];
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "string") return schema.format === "uuid" ? "00000000-0000-4000-8000-000000000001" : schema.format === "date-time" ? "2026-01-01T00:00:00.000Z" : "example";
  return null;
}

export function checkFromOpenApi(spec: unknown, options: { readonly name: string }): { readonly check: CheckDocument; readonly baseUrl?: string } {
  const document = spec as JsonObject;
  const scenarios: CheckDocument["spec"]["scenarios"][number][] = []; const ids = new Map<string, number>();
  for (const operation of operationsFromOpenApi(spec)) {
    const item = (document.paths as Record<string, JsonObject>)[operation.path]!;
    const definition = item[operation.method.toLowerCase()] as JsonObject;
    const parameters = [...((item.parameters ?? []) as unknown[]), ...((definition.parameters ?? []) as unknown[])].map((parameter) => resolveRef(document, parameter) as JsonObject);
    const valueFor = (parameter: JsonObject): string => String(parameter.example ?? exampleFor(document, parameter.schema) ?? "1");
    const path = operation.path.replace(/\{([^}]+)\}/gu, (_match, name: string) => encodeURIComponent(valueFor(parameters.find((parameter) => parameter.in === "path" && parameter.name === name) ?? {})));
    const query = parameters.filter((parameter) => parameter.in === "query" && parameter.required === true).map((parameter) => `${encodeURIComponent(String(parameter.name))}=${encodeURIComponent(valueFor(parameter))}`).join("&");
    const content = ((resolveRef(document, definition.requestBody) as JsonObject | undefined)?.content ?? {}) as Record<string, JsonObject>;
    const json = content["application/json"];
    const body = json ? (json.example ?? (json.examples ? (resolveRef(document, Object.values(json.examples as JsonObject)[0]) as JsonObject | undefined)?.value : undefined) ?? exampleFor(document, json.schema)) : undefined;
    const base = (operation.operationId ?? `${operation.method.toLowerCase()}-${operation.path}`).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 100) || "operation";
    const count = (ids.get(base) ?? 0) + 1; ids.set(base, count);
    scenarios.push({ id: count === 1 ? base : `${base}-${count}`, description: `TODO review: ${operation.method} ${operation.path}${typeof definition.summary === "string" ? ` (${definition.summary})` : ""}`, request: { kind: "http", method: operation.method, path: `${path}${query ? `?${query}` : ""}`, ...(body === undefined ? {} : { body }) } });
  }
  if (scenarios.length === 0) throw new Error("The OpenAPI document has no operations.");
  const servers = document.servers as { url?: string }[] | undefined;
  const baseUrl = servers?.[0]?.url && /^https?:\/\//u.test(servers[0].url) ? servers[0].url : undefined;
  return { check: { apiVersion: "air.dev/check/v0.1", kind: "Check", metadata: { name: options.name }, spec: { capability: { id: options.name }, observations: ["http"], scenarios } }, ...(baseUrl ? { baseUrl } : {}) };
}

// --- Coverage --------------------------------------------------------------------------------

export interface CoverageReport { readonly total: number; readonly covered: number; readonly operations: readonly { readonly method: string; readonly path: string; readonly sources: readonly string[]; readonly scenarios: readonly string[] }[] }

export const templatePattern = (template: string): RegExp => new RegExp(`^${template.split(/(\{[^}]+\}|:[A-Za-z_]\w*)/u).map((part) => (/^(\{[^}]+\}|:[A-Za-z_]\w*)$/u.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))).join("")}/?$`, "u");

export function checkCoverage(check: CheckDocument, sources: { readonly openapi?: unknown; readonly traces?: TraceMap }): CoverageReport {
  const wanted = new Map<string, { method: string; path: string; sources: Set<string> }>();
  const add = (method: string, path: string, source: string) => { const key = `${method} ${path}`; const entry = wanted.get(key) ?? { method, path, sources: new Set<string>() }; entry.sources.add(source); wanted.set(key, entry); };
  if (sources.openapi) for (const operation of operationsFromOpenApi(sources.openapi)) add(operation.method, operation.path, "openapi");
  for (const endpoint of sources.traces?.endpoints ?? []) add(endpoint.method, endpoint.route, "traces");
  const requests = check.spec.scenarios.flatMap((scenario) => (scenario.request.kind === "http" ? [{ id: scenario.id, method: scenario.request.method, path: scenario.request.path.split("?")[0]! }] : []));
  const operations = [...wanted.values()].sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method)).map((entry) => {
    const pattern = templatePattern(entry.path);
    return { method: entry.method, path: entry.path, sources: [...entry.sources].sort(), scenarios: requests.filter((request) => request.method === entry.method && pattern.test(request.path)).map((request) => request.id) };
  });
  return { total: operations.length, covered: operations.filter((operation) => operation.scenarios.length > 0).length, operations };
}

export function formatCoverage(report: CoverageReport): string {
  const percent = report.total === 0 ? 100 : Math.round((report.covered / report.total) * 100);
  const lines = [`COVERAGE ${report.covered}/${report.total} operations (${percent}%)`];
  for (const operation of report.operations) lines.push(`${operation.scenarios.length > 0 ? "covered  " : "UNCOVERED"} ${operation.method} ${operation.path} [${operation.sources.join(",")}]${operation.scenarios.length > 0 ? ` <- ${operation.scenarios.join(", ")}` : ""}`);
  return `${lines.join("\n")}\n`;
}

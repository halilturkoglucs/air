import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import verificationSchema from "../schema/verification-0.3.schema.json" with { type: "json" };
import verificationResultSchema from "../schema/verification-result-0.3.schema.json" with { type: "json" };
import capabilitySchema from "../schema/capability-0.1.schema.json" with { type: "json" };

interface Scenario { readonly id: string; readonly timeoutMs?: number; readonly request: { readonly method: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: unknown }; readonly compare?: { readonly status?: boolean; readonly body?: "json" | "text"; readonly headers?: readonly string[] }; readonly observations?: { readonly database?: readonly string[]; readonly messages?: readonly string[]; readonly outbound?: readonly string[] } }
interface SideEffectObservations { readonly database: Record<string, unknown>; readonly messages: Record<string, unknown>; readonly outbound: Record<string, unknown> }
interface HttpObservation { readonly status: number; readonly headers: Record<string, string>; readonly body: unknown; readonly bodyText: string }
const validateVerification = new Ajv2020({ allErrors: true, strict: true }).compile(verificationSchema);
const validateVerificationResult = new Ajv2020({ allErrors: true, strict: true }).compile(verificationResultSchema);
const validateCapability = new Ajv2020({ allErrors: true, strict: true }).compile(capabilitySchema);

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizeJson(item)]));
  return value;
}

function scopedUrl(base: string, path: string): URL {
  const root = new URL(base);
  const target = new URL(path, root);
  if (target.origin !== root.origin) throw new Error(`Scenario path ${path} escapes configured origin ${root.origin}.`);
  return target;
}

async function observe(base: string, scenario: Scenario): Promise<HttpObservation> {
  const response = await fetch(scopedUrl(base, scenario.request.path), { method: scenario.request.method, headers: { "content-type": "application/json", ...scenario.request.headers }, signal: AbortSignal.timeout(scenario.timeoutMs ?? 30_000), redirect: "manual", ...(scenario.request.body === undefined ? {} : { body: JSON.stringify(scenario.request.body) }) });
  const source = await response.text();
  let body: unknown = source;
  try { body = normalizeJson(JSON.parse(source) as unknown); } catch { /* text response */ }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, bodyText: source };
}

async function observeSideEffects(base: string, scenario: Scenario): Promise<SideEffectObservations> {
  const requested = scenario.observations;
  if (!requested || [...(requested.database ?? []), ...(requested.messages ?? []), ...(requested.outbound ?? [])].length === 0) return { database: {}, messages: {}, outbound: {} };
  const response = await fetch(scopedUrl(base, `/_air/observations/${encodeURIComponent(scenario.id)}`), { signal: AbortSignal.timeout(scenario.timeoutMs ?? 30_000), redirect: "manual" });
  if (!response.ok) throw new Error(`Observation adapter at ${base} returned HTTP ${response.status} for ${scenario.id}.`);
  const value = await response.json() as Partial<SideEffectObservations>;
  const record = (candidate: unknown, category: string): Record<string, unknown> => {
    if (candidate === undefined) return {};
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Observation adapter ${category} result must be an object.`);
    return candidate as Record<string, unknown>;
  };
  return { database: record(value.database, "database"), messages: record(value.messages, "messages"), outbound: record(value.outbound, "outbound") };
}

function digest(value: unknown): { readonly sha256: string; readonly bytes: number } {
  const serialized = typeof value === "string" ? value : JSON.stringify(normalizeJson(value));
  const source = serialized === undefined ? "undefined" : serialized;
  return { sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source) };
}

function reportHttp(observation: HttpObservation, scenario: Scenario): { readonly status: number; readonly headers: Record<string, string>; readonly body: Record<string, unknown> } {
  const selectedHeaders = new Set(["content-type", ...(scenario.compare?.headers ?? []).map((header) => header.toLowerCase())]);
  const sensitive = /^(?:set-cookie|authorization|proxy-authorization)$/iu;
  const headers = Object.fromEntries([...selectedHeaders].flatMap((header) => {
    const value = observation.headers[header];
    return value === undefined ? [] : [[header, sensitive.test(header) ? `[REDACTED sha256=${digest(value).sha256}]` : value]];
  }));
  const mode = scenario.compare?.body ?? "json";
  return { status: observation.status, headers, body: { format: mode, ...digest(mode === "text" ? observation.bodyText : observation.body) } };
}

function reportSideEffects(observations: SideEffectObservations, requested: Scenario["observations"]): SideEffectObservations {
  const summarize = (category: keyof SideEffectObservations): Record<string, unknown> => Object.fromEntries((requested?.[category] ?? []).map((selector) => [selector, digest(observations[category][selector])]));
  return { database: summarize("database"), messages: summarize("messages"), outbound: summarize("outbound") };
}

export async function verifyImportedCapability(capabilityDirectory: string, legacy: string, candidate: string, outputPath?: string): Promise<{ readonly passed: boolean; readonly report: Record<string, unknown>; readonly output: string }> {
  const capability = JSON.parse(await readFile(resolve(capabilityDirectory, "capability.json"), "utf8")) as { readonly capabilityId?: string; readonly evidenceHash?: string; readonly blockers?: readonly string[] };
  if (!validateCapability(capability)) throw new Error(`Invalid extracted capability: ${(validateCapability.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
  if ((capability.blockers?.length ?? 0) > 0) throw new Error("Capability still has unresolved extraction blockers.");
  const suite = parse(await readFile(resolve(capabilityDirectory, "verification.yaml"), "utf8")) as { readonly apiVersion?: string; readonly spec?: { readonly scenarios?: readonly Scenario[] } };
  if (!validateVerification(suite)) throw new Error(`Invalid import verification v0.3 suite: ${(validateVerification.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
  const scenarios = suite.spec!.scenarios!;
  const results = [];
  for (const scenario of scenarios) {
    const [legacyObservation, candidateObservation] = await Promise.all([observe(legacy, scenario), observe(candidate, scenario)]);
    const [legacySideEffects, candidateSideEffects] = await Promise.all([observeSideEffects(legacy, scenario), observeSideEffects(candidate, scenario)]);
    const mismatches: string[] = [];
    if (scenario.compare?.status !== false && legacyObservation.status !== candidateObservation.status) mismatches.push("status");
    const bodyMode = scenario.compare?.body ?? "json";
    const legacyBody = bodyMode === "text" ? legacyObservation.bodyText : legacyObservation.body;
    const candidateBody = bodyMode === "text" ? candidateObservation.bodyText : candidateObservation.body;
    if (JSON.stringify(legacyBody) !== JSON.stringify(candidateBody)) mismatches.push("body");
    for (const header of scenario.compare?.headers ?? []) if (legacyObservation.headers[header.toLowerCase()] !== candidateObservation.headers[header.toLowerCase()]) mismatches.push(`header:${header}`);
    for (const category of ["database", "messages", "outbound"] as const) for (const selector of scenario.observations?.[category] ?? []) {
      if (JSON.stringify(normalizeJson(legacySideEffects[category][selector])) !== JSON.stringify(normalizeJson(candidateSideEffects[category][selector]))) mismatches.push(`${category}:${selector}`);
    }
    results.push({ id: scenario.id, passed: mismatches.length === 0, mismatches, legacy: { http: reportHttp(legacyObservation, scenario), ...reportSideEffects(legacySideEffects, scenario.observations) }, candidate: { http: reportHttp(candidateObservation, scenario), ...reportSideEffects(candidateSideEffects, scenario.observations) } });
  }
  const passed = results.every((result) => result.passed);
  const safeEndpoint = (value: string): string => { const url = new URL(value); url.username = ""; url.password = ""; return url.toString(); };
  const report = { apiVersion: "air.dev/verification-result/v0.3", kind: "ImportVerificationResult", generatedAt: new Date().toISOString(), capabilityId: capability.capabilityId!, evidenceHash: capability.evidenceHash!, legacy: safeEndpoint(legacy), candidate: safeEndpoint(candidate), passed, observations: { http: results, database: [], messages: [], outbound: [] } };
  if (!validateVerificationResult(report)) throw new Error(`Invalid import verification result: ${(validateVerificationResult.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
  const output = resolve(outputPath ?? resolve(capabilityDirectory, "verification-result.json"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { passed, report, output };
}

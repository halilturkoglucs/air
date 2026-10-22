import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";
import checkSchema from "../schema/check-0.1.schema.json" with { type: "json" };
import targetSchema from "../schema/check-target-0.1.schema.json" with { type: "json" };
import policySchema from "../schema/check-policy-0.1.schema.json" with { type: "json" };
import baselineSchema from "../schema/check-baseline-0.1.schema.json" with { type: "json" };
import resultSchema from "../schema/check-result-0.1.schema.json" with { type: "json" };
import { readDiscoveryBundle } from "./store.js";

// Built-in categories have adapters; any other lowercase name (cache, events, files, emails, ...) is reported by a harness.
export type KnownObservationCategory = "http" | "database" | "messages" | "outbound" | "ordering" | "failures" | "retryability";
export type ObservationCategory = KnownObservationCategory | (string & {});
export type FailureClassification = "candidate-difference" | "baseline-stale" | "missing-observation" | "policy-violation" | "infrastructure-error";
type EnvironmentReferences = Readonly<Record<string, { readonly fromEnv: string }>>;
type CommandDefinition = { readonly argv: readonly string[]; readonly workingDirectory?: string; readonly environment?: EnvironmentReferences };
type CheckRequest =
  | { readonly kind: "http"; readonly method: string; readonly path: string; readonly headers?: Readonly<Record<string, string>>; readonly headersFrom?: Readonly<Record<string, { readonly scenario: string; readonly pointer?: string; readonly setCookie?: string; readonly template: string }>>; readonly body?: unknown }
  | { readonly kind: "command"; readonly arguments?: readonly string[]; readonly input?: unknown };
// Any rule may be limited to some scenarios; generated values usually exist only in a few responses.
export type NormalizationRule = (
  | { readonly kind: "ignore"; readonly pointer: string; readonly reason: string }
  | { readonly kind: "typed-token"; readonly pointer: string; readonly format: "uuid" | "timestamp" | "jwt"; readonly binding?: string }
  | { readonly kind: "unordered-array"; readonly pointer: string; readonly key: string }
  | { readonly kind: "rename"; readonly pointer: string; readonly to: string; readonly reason: string }
  | { readonly kind: "internal-boundary"; readonly pointer: string; readonly match: unknown; readonly reason: string }
) & { readonly scenarios?: readonly string[] };

export interface CheckDocument {
  readonly apiVersion: "air.dev/check/v0.1";
  readonly kind: "Check";
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly capability: { readonly id: string; readonly discoveryHash?: string; readonly repositoryHash?: string };
    readonly scenarios: readonly { readonly id: string; readonly description?: string; readonly timeoutMs?: number; readonly request: CheckRequest }[];
    readonly observations: readonly ObservationCategory[];
    readonly normalization?: readonly NormalizationRule[];
  };
}

export interface CheckTarget {
  readonly apiVersion: "air.dev/check-target/v0.1";
  readonly kind: "CheckTarget";
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly type: "http" | "command";
    readonly fixtureIsolation?: "process" | "reset-command";
    readonly workingDirectory?: string;
    readonly environment?: EnvironmentReferences;
    readonly baseUrl?: string;
    readonly baseUrlEnv?: string;
    // Request headers for HTTP targets (e.g. a session cookie). Only the environment variable name is stored.
    readonly headers?: Readonly<Record<string, { readonly fromEnv: string }>>;
    readonly command?: CommandDefinition;
    readonly observationPath?: string;
    readonly lifecycle?: { readonly start?: CommandDefinition; readonly reset?: CommandDefinition; readonly readiness?: { readonly path: string; readonly timeoutMs?: number }; readonly resetScope?: "scenario" | "run"; readonly services?: readonly { readonly name: string; readonly command: CommandDefinition; readonly readinessUrl?: string; readonly timeoutMs?: number }[] };
    readonly evidenceCaptureProfile?: string;
  };
}

export interface CheckPolicy {
  readonly apiVersion: "air.dev/check-policy/v0.1";
  readonly kind: "CheckPolicy";
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly requiredScenarios?: readonly string[];
    readonly requiredObservations?: readonly ObservationCategory[];
    readonly allowedNormalizations?: readonly NormalizationRule["kind"][];
    readonly requireCleanBaseline?: boolean;
    readonly unmatchedEvidence?: "fail" | "report";
    readonly reveal?: "allow" | "deny";
  };
}

export type DigestNode =
  | { readonly kind: "leaf"; readonly type: "null" | "boolean" | "number" | "string" | "undefined"; readonly bytes: number; readonly sha256: string; readonly token?: string }
  | { readonly kind: "object"; readonly entries: Readonly<Record<string, DigestNode>> }
  | { readonly kind: "array"; readonly items: readonly DigestNode[] };

export interface CheckBaseline {
  readonly apiVersion: "air.dev/check-baseline/v0.1";
  readonly kind: "CheckBaseline";
  readonly baselineId: string;
  readonly createdAt: string;
  readonly releasable: boolean;
  readonly hashes: { readonly repository: string; readonly discovery?: string; readonly check: string; readonly policy: string; readonly normalization: string; readonly target: string };
  readonly target: { readonly name: string; readonly type: "http" | "command" };
  readonly scenarios: readonly { readonly id: string; readonly observation: DigestNode }[];
  readonly approvals?: readonly BaselineApproval[];
}

export interface BaselineApproval { readonly scenario: string; readonly reason: string; readonly approvedAt: string; readonly previousBaselineId: string; readonly target: string }

export interface CheckMismatch {
  readonly classification: FailureClassification;
  readonly scenario: string;
  readonly category: string;
  readonly selector: string;
  readonly expected?: { readonly type: string; readonly bytes: number; readonly sha256: string; readonly token?: string };
  readonly actual?: { readonly type: string; readonly bytes: number; readonly sha256: string; readonly token?: string };
  readonly provenance: string;
  readonly repair: "candidate-code" | "harness";
}

export interface CheckResult {
  readonly apiVersion: "air.dev/check-result/v0.1";
  readonly kind: "CheckResult";
  readonly generatedAt: string;
  readonly baselineId: string;
  readonly candidate: { readonly name: string; readonly targetHash: string };
  readonly passed: boolean;
  readonly policy: { readonly passed: boolean; readonly violations: readonly string[] };
  readonly scenarios: readonly { readonly id: string; readonly passed: boolean }[];
  readonly mismatches: readonly CheckMismatch[];
}

export class CheckInputError extends Error {}
export class CheckInfrastructureError extends Error {}
const MAX_OBSERVATION_BYTES = 10 * 1024 * 1024;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, formats: { uri: true, "date-time": true } });
const validateCheck = ajv.compile(checkSchema) as ValidateFunction<unknown>;
const validateTarget = ajv.compile(targetSchema) as ValidateFunction<unknown>;
const validatePolicy = ajv.compile(policySchema) as ValidateFunction<unknown>;
const validateBaseline = ajv.compile(baselineSchema) as ValidateFunction<unknown>;
const validateResult = ajv.compile(resultSchema) as ValidateFunction<unknown>;

const DEFAULT_POLICY: CheckPolicy = {
  apiVersion: "air.dev/check-policy/v0.1",
  kind: "CheckPolicy",
  metadata: { name: "air-default" },
  spec: { allowedNormalizations: ["ignore", "typed-token", "unordered-array", "rename", "internal-boundary"], requireCleanBaseline: true, unmatchedEvidence: "fail" },
};

function validationError(label: string, validate: ValidateFunction<unknown>): CheckInputError {
  return new CheckInputError(`${label} is invalid: ${(validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
}

function parseDocument<T>(source: string, label: string, validate: ValidateFunction<unknown>): T {
  let value: unknown;
  try { value = parse(source) as unknown; }
  catch (error) { throw new CheckInputError(`${label} could not be parsed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!validate(value)) throw validationError(label, validate);
  return value as T;
}

export function parseCheckDocument(source: string): CheckDocument {
  const check = parseDocument<CheckDocument>(source, "Check", validateCheck);
  const ids = new Set<string>();
  for (const scenario of check.spec.scenarios) {
    if (ids.has(scenario.id)) throw new CheckInputError(`Check scenario id ${scenario.id} is duplicated.`);
    ids.add(scenario.id);
  }
  return check;
}

export function parseCheckTarget(source: string): CheckTarget {
  const target = parseDocument<CheckTarget>(source, "Check target", validateTarget);
  for (const path of [target.spec.workingDirectory, target.spec.evidenceCaptureProfile, target.spec.command?.workingDirectory, target.spec.lifecycle?.start?.workingDirectory, target.spec.lifecycle?.reset?.workingDirectory]) {
    if (path && (isAbsolute(path) || path.split(/[\\/]/u).includes(".."))) throw new CheckInputError(`Check target path ${path} must remain repository-relative.`);
  }
  return target;
}

export function parseCheckPolicy(source: string): CheckPolicy { return parseDocument<CheckPolicy>(source, "Check policy", validatePolicy); }
export const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;
function isUtcTimestamp(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) && !Number.isNaN(Date.parse(value)); }
export function parseCheckBaseline(source: string): CheckBaseline {
  const baseline = parseDocument<CheckBaseline>(source, "Check baseline", validateBaseline);
  if (!isUtcTimestamp(baseline.createdAt)) throw new CheckInputError("Check baseline createdAt must be a valid UTC timestamp.");
  if (baseline.baselineId !== baselineIdentity(baseline)) throw new CheckInputError("Check baseline content does not match baselineId; the pack may be stale or tampered with.");
  return baseline;
}
export function parseCheckResult(source: string): CheckResult { const result = parseDocument<CheckResult>(source, "Check result", validateResult); if (!isUtcTimestamp(result.generatedAt)) throw new CheckInputError("Check result generatedAt must be a valid UTC timestamp."); return result; }
export function defaultCheckPolicy(): CheckPolicy { return DEFAULT_POLICY; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function checkContentHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function withoutBaselineIdentity(baseline: CheckBaseline): unknown { const { baselineId: _baselineId, ...material } = baseline; return material; }
export function baselineIdentity(baseline: CheckBaseline): string { return checkContentHash(withoutBaselineIdentity(baseline)); }

function policyViolations(check: CheckDocument, policy: CheckPolicy, clean: boolean): string[] {
  const scenarioIds = new Set(check.spec.scenarios.map((scenario) => scenario.id));
  const observations = new Set(check.spec.observations);
  const allowed = new Set(policy.spec.allowedNormalizations ?? []);
  const violations: string[] = [];
  for (const id of policy.spec.requiredScenarios ?? []) if (!scenarioIds.has(id)) violations.push(`Required scenario ${id} is absent.`);
  for (const category of policy.spec.requiredObservations ?? []) if (!observations.has(category)) violations.push(`Required observation category ${category} is absent.`);
  for (const rule of check.spec.normalization ?? []) if (!allowed.has(rule.kind)) violations.push(`Normalization ${rule.kind} at ${rule.pointer} is not allowed by policy.`);
  if ((policy.spec.requireCleanBaseline ?? true) && !clean) violations.push("Policy requires a clean tracked tree for baseline creation.");
  return violations;
}

export function validateMigrationCheck(check: CheckDocument, policy: CheckPolicy = DEFAULT_POLICY): readonly string[] {
  return policyViolations(check, policy, true);
}

const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function decodePointer(pointer: string): string[] {
  const parts = pointer === "" ? [] : pointer.slice(1).split("/").map((item) => item.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  if (parts.some((part) => PROTOTYPE_KEYS.has(part))) throw new CheckInputError(`Normalization pointer ${pointer} contains a protected prototype-chain segment.`);
  return parts;
}
function getParent(root: unknown, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string } {
  const parts = decodePointer(pointer); const key = parts.pop();
  if (key === undefined) throw new CheckInputError("Normalization cannot replace the observation root.");
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") throw new CheckInputError(`Normalization pointer ${pointer} does not exist.`);
    if (!Object.hasOwn(current, part)) throw new CheckInputError(`Normalization pointer ${pointer} does not exist.`);
    current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  if (!current || typeof current !== "object") throw new CheckInputError(`Normalization pointer ${pointer} does not exist.`);
  return { parent: current as Record<string, unknown> | unknown[], key };
}

function at(parent: Record<string, unknown> | unknown[], key: string): unknown { return Array.isArray(parent) ? parent[Number(key)] : Object.hasOwn(parent, key) ? parent[key] : undefined; }
function setAt(parent: Record<string, unknown> | unknown[], key: string, value: unknown): void { if (Array.isArray(parent)) parent[Number(key)] = value; else Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true }); }
function deleteAt(parent: Record<string, unknown> | unknown[], key: string): void { if (Array.isArray(parent)) parent.splice(Number(key), 1); else Reflect.deleteProperty(parent, key); }

function optionalParent(root: unknown, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string } | undefined {
  try { return getParent(root, pointer); } catch (error) { if (error instanceof CheckInputError && error.message.endsWith("does not exist.")) return undefined; throw error; }
}

function matchesPattern(value: unknown, pattern: unknown): boolean {
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(pattern as Record<string, unknown>).every(([key, expected]) => Object.hasOwn(value, key) && matchesPattern((value as Record<string, unknown>)[key], expected));
  }
  return canonical(value) === canonical(pattern);
}

function applyTopologyRule(root: unknown, rule: Extract<NormalizationRule, { kind: "rename" | "internal-boundary" }>): void {
  const location = optionalParent(root, rule.pointer); if (!location) return;
  const value = at(location.parent, location.key); if (value === undefined) return;
  if (rule.kind === "internal-boundary") {
    if (!Array.isArray(value)) throw new CheckInputError(`internal-boundary ${rule.pointer} must point to an array.`);
    setAt(location.parent, location.key, value.filter((item) => !matchesPattern(item, rule.match)));
    return;
  }
  const destination = getParent(root, rule.to);
  if (at(destination.parent, destination.key) !== undefined) throw new CheckInputError(`rename target ${rule.to} already exists.`);
  deleteAt(location.parent, location.key);
  setAt(destination.parent, destination.key, value);
}

function applyNormalization(observation: unknown, rules: readonly NormalizationRule[]): unknown {
  const copy = JSON.parse(JSON.stringify(observation)) as unknown;
  const bindings = new Map<string, string>();
  for (const rule of rules) {
    // Topology rules apply only where one side has the data (a split moves tables or adds internal calls), so a missing pointer is a no-op.
    if (rule.kind === "rename" || rule.kind === "internal-boundary") { applyTopologyRule(copy, rule); continue; }
    const { parent, key } = getParent(copy, rule.pointer);
    const value = at(parent, key);
    if (value === undefined) throw new CheckInputError(`Normalization pointer ${rule.pointer} does not exist.`);
    if (rule.kind === "ignore") { deleteAt(parent, key); continue; }
    if (rule.kind === "unordered-array") {
      if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item) || (item as Record<string, unknown>)[rule.key] === undefined)) throw new CheckInputError(`Unordered array ${rule.pointer} must contain objects with key ${rule.key}.`);
      const keys = value.map((item) => canonical((item as Record<string, unknown>)[rule.key]));
      if (new Set(keys).size !== keys.length) throw new CheckInputError(`Unordered array ${rule.pointer} contains duplicate ${rule.key} values.`);
      setAt(parent, key, [...value].sort((left, right) => canonical((left as Record<string, unknown>)[rule.key]).localeCompare(canonical((right as Record<string, unknown>)[rule.key]))));
      continue;
    }
    if (typeof value !== "string" || (rule.format === "uuid" ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) : rule.format === "jwt" ? !JWT.test(value) : !isUtcTimestamp(value))) throw new CheckInputError(`Value at ${rule.pointer} is not a valid ${rule.format}.`);
    if (rule.binding) {
      const encoded = canonical(value); const existing = bindings.get(rule.binding);
      if (existing !== undefined && existing !== encoded) throw new CheckInputError(`Named binding ${rule.binding} is inconsistent within this observation.`);
      bindings.set(rule.binding, encoded);
    }
    setAt(parent, key, { $airToken: rule.format, ...(rule.binding ? { binding: rule.binding } : {}) });
  }
  return copy;
}

function summarize(value: unknown): DigestNode {
  if (Array.isArray(value)) return { kind: "array", items: value.map(summarize) };
  if (value && typeof value === "object") {
    const token = (value as Record<string, unknown>).$airToken;
    if (typeof token === "string") {
      const binding = (value as Record<string, unknown>).binding;
      const label = `${token}${typeof binding === "string" ? `:${binding}` : ""}`;
      const source = JSON.stringify({ token: label });
      return { kind: "leaf", type: "string", bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex"), token: label };
    }
    return { kind: "object", entries: Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, summarize(item)])) };
  }
  const type = value === null ? "null" : value === undefined ? "undefined" : typeof value as "boolean" | "number" | "string";
  const source = canonical(value);
  return { kind: "leaf", type, bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex") };
}

function leafMetadata(node: DigestNode | undefined): CheckMismatch["expected"] {
  if (!node) return undefined;
  if (node.kind === "leaf") return { type: node.type, bytes: node.bytes, sha256: node.sha256, ...(node.token ? { token: node.token } : {}) };
  const source = canonical(node); return { type: node.kind, bytes: Buffer.byteLength(source), sha256: checkContentHash(node) };
}

function compareNodes(expected: DigestNode | undefined, actual: DigestNode | undefined, pointer: string, scenario: string, mismatches: CheckMismatch[]): void {
  if (!expected || !actual || expected.kind !== actual.kind) {
    const expectedMetadata = leafMetadata(expected); const actualMetadata = leafMetadata(actual);
    mismatches.push({ classification: actual ? "candidate-difference" : "missing-observation", scenario, category: pointer.split("/")[1] ?? "observation", selector: pointer || "/", ...(expectedMetadata ? { expected: expectedMetadata } : {}), ...(actualMetadata ? { actual: actualMetadata } : {}), provenance: `baseline:${scenario}${pointer}`, repair: actual ? "candidate-code" : "harness" });
    return;
  }
  if (expected.kind === "leaf" && actual.kind === "leaf") {
    if (expected.sha256 !== actual.sha256 || expected.type !== actual.type || expected.bytes !== actual.bytes) mismatches.push({ classification: "candidate-difference", scenario, category: pointer.split("/")[1] ?? "observation", selector: pointer || "/", expected: leafMetadata(expected)!, actual: leafMetadata(actual)!, provenance: `baseline:${scenario}${pointer}`, repair: "candidate-code" });
    return;
  }
  if (expected.kind === "array" && actual.kind === "array") {
    const maximum = Math.max(expected.items.length, actual.items.length);
    for (let index = 0; index < maximum; index += 1) compareNodes(expected.items[index], actual.items[index], `${pointer}/${index}`, scenario, mismatches);
    return;
  }
  if (expected.kind === "object" && actual.kind === "object") {
    const keys = new Set([...Object.keys(expected.entries), ...Object.keys(actual.entries)]);
    for (const key of [...keys].sort()) compareNodes(expected.entries[key], actual.entries[key], `${pointer}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`, scenario, mismatches);
  }
}

function commandEnvironment(references: EnvironmentReferences | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [targetName, reference] of Object.entries(references ?? {})) {
    const value = process.env[reference.fromEnv];
    if (value === undefined) throw new CheckInfrastructureError(`Required environment variable ${reference.fromEnv} is not set.`);
    environment[targetName] = value;
  }
  return environment;
}

function safeBaseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "JAVA_HOME", "SystemRoot", "PATHEXT"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function safeWorkingDirectory(root: string, ...parts: readonly (string | undefined)[]): string {
  const directory = resolve(root, ...parts.filter((part): part is string => Boolean(part)));
  if (relative(root, directory).startsWith("..") || isAbsolute(relative(root, directory))) throw new CheckInputError("Target working directory escapes the repository root.");
  return directory;
}

async function executeCommand(definition: CommandDefinition, target: CheckTarget, root: string, extra: readonly string[] = [], input?: unknown, timeoutMs = 30_000): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const [program, ...arguments_] = definition.argv;
  if (!program) throw new CheckInputError("Explicit command argv cannot be empty.");
  const cwd = safeWorkingDirectory(root, target.spec.workingDirectory, definition.workingDirectory);
  const env = { ...safeBaseEnvironment(), ...commandEnvironment(target.spec.environment), ...commandEnvironment(definition.environment) };
  return await new Promise((complete, reject) => {
    const child = spawn(program, [...arguments_, ...extra], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false; let outputBytes = 0;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new CheckInfrastructureError(`Command ${program} exceeded ${timeoutMs}ms.`)); } }, timeoutMs);
    const append = (stream: "stdout" | "stderr", chunk: string): void => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OBSERVATION_BYTES) {
        settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new CheckInfrastructureError(`Command ${program} exceeded the ${MAX_OBSERVATION_BYTES}-byte observation limit.`)); return;
      }
      if (stream === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => append("stderr", chunk));
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(new CheckInfrastructureError(`Could not execute ${program}: ${error.message}`)); } });
    child.once("exit", (code) => { if (!settled) { settled = true; clearTimeout(timer); complete({ code: code ?? 1, stdout, stderr }); } });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function targetBaseUrl(target: CheckTarget): string {
  const value = target.spec.baseUrl ?? (target.spec.baseUrlEnv ? process.env[target.spec.baseUrlEnv] : undefined);
  if (!value) throw new CheckInfrastructureError(`HTTP target ${target.metadata.name} has no resolved base URL.`);
  try { return new URL(value).toString(); } catch { throw new CheckInfrastructureError(`HTTP target ${target.metadata.name} has an invalid base URL.`); }
}

function scopedUrl(base: string, path: string): URL { const root = new URL(base); const target = new URL(path, root); if (root.origin !== target.origin) throw new CheckInputError(`Request path ${path} escapes the configured target origin.`); return target; }

async function readBoundedResponse(response: Response, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_OBSERVATION_BYTES) throw new CheckInfrastructureError(`${label} exceeds the ${MAX_OBSERVATION_BYTES}-byte observation limit.`);
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let total = 0; let source = "";
  while (true) {
    const item = await reader.read(); if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_OBSERVATION_BYTES) { await reader.cancel(); throw new CheckInfrastructureError(`${label} exceeds the ${MAX_OBSERVATION_BYTES}-byte observation limit.`); }
    source += decoder.decode(item.value, { stream: true });
  }
  return source + decoder.decode();
}

async function waitForUrl(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* retry bounded readiness */ }
    await new Promise((complete) => setTimeout(complete, 100));
  }
  throw new CheckInfrastructureError(`${label} did not become ready within ${timeoutMs}ms.`);
}

async function waitForReadiness(target: CheckTarget): Promise<void> {
  const readiness = target.spec.lifecycle?.readiness; if (!readiness) return;
  const deadline = Date.now() + (readiness.timeoutMs ?? 30_000); const url = scopedUrl(targetBaseUrl(target), readiness.path);
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* retry bounded readiness */ }
    await new Promise((complete) => setTimeout(complete, 100));
  }
  throw new CheckInfrastructureError(`Target ${target.metadata.name} did not become ready within ${readiness.timeoutMs ?? 30_000}ms.`);
}

function targetHeaders(target: CheckTarget): Record<string, string> {
  return Object.fromEntries(Object.entries(target.spec.headers ?? {}).map(([name, reference]) => {
    const value = process.env[reference.fromEnv];
    if (value === undefined) throw new CheckInputError(`Header ${name} needs environment variable ${reference.fromEnv}, which is not set.`);
    return [name, value];
  }));
}

type HttpResponseMemory = { readonly body: unknown; readonly setCookies: readonly string[] };

async function observeHttp(base: string, scenario: CheckDocument["spec"]["scenarios"][number], categories: readonly ObservationCategory[], observationPath: string, extraHeaders: Readonly<Record<string, string>> = {}, remember?: (memory: HttpResponseMemory) => void): Promise<unknown> {
  if (scenario.request.kind !== "http") throw new CheckInputError(`HTTP target cannot execute command scenario ${scenario.id}.`);
  const response = await fetch(scopedUrl(base, scenario.request.path), { method: scenario.request.method, headers: { "content-type": "application/json", ...extraHeaders, ...scenario.request.headers }, redirect: "manual", signal: AbortSignal.timeout(scenario.timeoutMs ?? 30_000), ...(scenario.request.body === undefined ? {} : { body: JSON.stringify(scenario.request.body) }) });
  const bodyText = await readBoundedResponse(response, `HTTP response for ${scenario.id}`); let body: unknown = bodyText;
  try { body = JSON.parse(bodyText) as unknown; } catch { /* preserve text */ }
  remember?.({ body, setCookies: response.headers.getSetCookie() });
  const selected = new Set(categories); const observation: Record<string, unknown> = {};
  if (selected.has("http")) observation.http = { status: response.status, headers: Object.fromEntries([...response.headers.entries()].filter(([name]) => name.toLowerCase() === "content-type")), body };
  const sideCategories = categories.filter((category) => category !== "http");
  if (sideCategories.length > 0) {
    const path = observationPath.replace("{scenario}", encodeURIComponent(scenario.id));
    const sideResponse = await fetch(scopedUrl(base, path), { redirect: "manual", signal: AbortSignal.timeout(scenario.timeoutMs ?? 30_000) });
    if (!sideResponse.ok) throw new CheckInfrastructureError(`Observation adapter returned HTTP ${sideResponse.status} for ${scenario.id}.`);
    let side: Record<string, unknown>;
    try { side = JSON.parse(await readBoundedResponse(sideResponse, `Observation adapter response for ${scenario.id}`)) as Record<string, unknown>; }
    catch (error) { if (error instanceof CheckInfrastructureError) throw error; throw new CheckInfrastructureError(`Observation adapter returned invalid JSON for ${scenario.id}.`); }
    for (const category of sideCategories) {
      if (!(category in side)) throw new CheckInfrastructureError(`Observation adapter omitted required ${category} evidence for ${scenario.id}.`);
      observation[category] = side[category];
    }
  }
  return observation;
}

interface ExecutionIssue { readonly scenario: string; readonly kind: "missing" | "unmatched" | "normalization"; readonly selector: string; readonly message: string }
interface CheckExecution { readonly scenarios: readonly { readonly id: string; readonly observation: DigestNode; readonly raw?: unknown }[]; readonly issues: readonly ExecutionIssue[] }

// keepRaw retains normalized observations in memory only, for local value reveal; nothing raw is ever written to disk.
async function executeScenarios(check: CheckDocument, target: CheckTarget, repositoryRoot: string, keepRaw = false): Promise<CheckExecution> {
  let started: ReturnType<typeof spawn> | undefined; const services: ReturnType<typeof spawn>[] = [];
  try {
    const observesEffects = check.spec.observations.some((category) => category !== "http");
    if (observesEffects && !target.spec.fixtureIsolation) throw new CheckInputError(`Target ${target.metadata.name} must explicitly declare fixtureIsolation for observable side effects.`);
    if (target.spec.fixtureIsolation === "process" && target.spec.type !== "command") throw new CheckInputError("Process fixture isolation is valid only for command targets that start a fresh process per scenario.");
    if (target.spec.fixtureIsolation === "reset-command" && !target.spec.lifecycle?.reset) throw new CheckInputError("reset-command fixture isolation requires an explicit lifecycle.reset argv command.");
    for (const service of target.spec.lifecycle?.services ?? []) {
      const [program, ...arguments_] = service.command.argv;
      if (!program) throw new CheckInputError(`Service ${service.name} argv cannot be empty.`);
      const child = spawn(program, arguments_, { cwd: safeWorkingDirectory(repositoryRoot, target.spec.workingDirectory, service.command.workingDirectory), env: { ...safeBaseEnvironment(), ...commandEnvironment(target.spec.environment), ...commandEnvironment(service.command.environment) }, shell: false, stdio: "ignore" });
      services.push(child);
      await new Promise<void>((complete, reject) => { child.once("spawn", complete); child.once("error", (error) => reject(new CheckInfrastructureError(`Could not start service ${service.name}: ${error.message}`))); });
      if (service.readinessUrl) await waitForUrl(service.readinessUrl, service.timeoutMs ?? 30_000, `Service ${service.name}`);
    }
    if (target.spec.lifecycle?.start) {
      const definition = target.spec.lifecycle.start; const [program, ...arguments_] = definition.argv;
      if (!program) throw new CheckInputError("Start command argv cannot be empty.");
      started = spawn(program, arguments_, { cwd: safeWorkingDirectory(repositoryRoot, target.spec.workingDirectory, definition.workingDirectory), env: { ...safeBaseEnvironment(), ...commandEnvironment(target.spec.environment), ...commandEnvironment(definition.environment) }, shell: false, stdio: "ignore" });
      await new Promise<void>((complete, reject) => { started!.once("spawn", complete); started!.once("error", (error) => reject(new CheckInfrastructureError(`Could not start ${program}: ${error.message}`))); });
    }
    await waitForReadiness(target);
    const output: { id: string; observation: DigestNode; raw?: unknown }[] = []; const issues: ExecutionIssue[] = [];
    // Responses stay in memory so later requests can reuse credentials they issued (headersFrom); nothing is stored.
    const responses = new Map<string, HttpResponseMemory>();
    for (const [index, scenario] of check.spec.scenarios.entries()) {
      if (target.spec.lifecycle?.reset && (target.spec.lifecycle.resetScope !== "run" || index === 0)) {
        const reset = await executeCommand(target.spec.lifecycle.reset, target, repositoryRoot);
        if (reset.code !== 0) throw new CheckInfrastructureError(`Fixture reset failed for ${scenario.id} with exit ${reset.code}: ${reset.stderr.trim()}`);
      }
      let raw: unknown;
      if (target.spec.type === "http") {
        const chained: Record<string, string> = {};
        for (const [name, source] of Object.entries(scenario.request.kind === "http" ? scenario.request.headersFrom ?? {} : {})) {
          const memory = responses.get(source.scenario);
          const value = !memory ? undefined : source.setCookie ? memory.setCookies.map((header) => header.split(";")[0]!).find((pair) => pair.startsWith(`${source.setCookie}=`))?.slice(source.setCookie.length + 1) : (() => { let current: unknown = memory.body; for (const part of decodePointer(source.pointer ?? "")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined; return typeof current === "string" ? current : undefined; })();
          if (value === undefined) issues.push({ scenario: scenario.id, kind: "missing", selector: "/http", message: `Credential for header ${name} was not available from scenario ${source.scenario}.` });
          else chained[name] = source.template.replace("{value}", value);
        }
        raw = await observeHttp(targetBaseUrl(target), scenario, check.spec.observations, target.spec.observationPath ?? "/_air/observations/{scenario}", { ...targetHeaders(target), ...chained }, (memory) => responses.set(scenario.id, memory));
      }
      else {
        if (scenario.request.kind !== "command" || !target.spec.command) throw new CheckInputError(`Command target cannot execute HTTP scenario ${scenario.id}.`);
        const execution = await executeCommand(target.spec.command, target, repositoryRoot, scenario.request.arguments ?? [], scenario.request.input, scenario.timeoutMs ?? 30_000);
        if (execution.code !== 0) throw new CheckInfrastructureError(`Command target exited ${execution.code} for ${scenario.id}: ${execution.stderr.trim()}`);
        try { raw = JSON.parse(execution.stdout) as unknown; } catch { throw new CheckInfrastructureError(`Command target did not return JSON observations for ${scenario.id}.`); }
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CheckInfrastructureError(`Target observations for ${scenario.id} must be a JSON object.`);
      const rawRecord = raw as Record<string, unknown>; const selected: Record<string, unknown> = {};
      for (const category of check.spec.observations) {
        if (rawRecord[category] === undefined) issues.push({ scenario: scenario.id, kind: "missing", selector: `/${category}`, message: `Target omitted required ${category} observation.` });
        else selected[category] = rawRecord[category];
      }
      for (const category of Object.keys(rawRecord)) if (!check.spec.observations.includes(category as ObservationCategory)) issues.push({ scenario: scenario.id, kind: "unmatched", selector: `/${category}`, message: `Target returned undeclared ${category} evidence.` });
      const applicableRules = (check.spec.normalization ?? []).filter((rule) => Object.hasOwn(selected, decodePointer(rule.pointer)[0] ?? "") && (!rule.scenarios || rule.scenarios.includes(scenario.id)));
      try { const normalized = applyNormalization(selected, applicableRules); output.push({ id: scenario.id, observation: summarize(normalized), ...(keepRaw ? { raw: normalized } : {}) }); }
      catch (error) {
        issues.push({ scenario: scenario.id, kind: "normalization", selector: "/normalization", message: error instanceof Error ? error.message : String(error) });
        output.push({ id: scenario.id, observation: summarize(selected), ...(keepRaw ? { raw: selected } : {}) });
      }
    }
    return { scenarios: output, issues };
  } finally {
    if (started && !started.killed) started.kill("SIGTERM");
    for (const service of services.reverse()) if (!service.killed) service.kill("SIGTERM");
  }
}

function hashesFor(check: CheckDocument, policy: CheckPolicy, target: CheckTarget, repositoryHash: string): CheckBaseline["hashes"] {
  return { repository: repositoryHash, ...(check.spec.capability.discoveryHash ? { discovery: check.spec.capability.discoveryHash } : {}), check: checkContentHash(check), policy: checkContentHash(policy), normalization: checkContentHash(check.spec.normalization ?? []), target: checkContentHash(target) };
}

type BaselineInput = { readonly check: CheckDocument; readonly policy?: CheckPolicy; readonly target: CheckTarget; readonly repositoryRoot: string; readonly repositoryHash: string; readonly clean: boolean; readonly allowDirty?: boolean };

export async function createCheckBaseline(input: BaselineInput): Promise<CheckBaseline> {
  return (await createCheckBaselineDetailed(input)).baseline;
}

// Digest of a normalized observation, comparable with baseline digests (used to validate locally cached values).
export function observationDigest(normalized: unknown): DigestNode { return summarize(normalized); }

// Same as createCheckBaseline, plus the normalized observations in memory so callers can keep a local, uncommitted value cache.
export async function createCheckBaselineDetailed(input: BaselineInput & { readonly keepObservations?: boolean }): Promise<{ readonly baseline: CheckBaseline; readonly observations: ReadonlyMap<string, unknown> }> {
  const policy = input.policy ?? DEFAULT_POLICY; const cleanForPolicy = input.clean || input.allowDirty === true;
  const violations = policyViolations(input.check, policy, cleanForPolicy);
  if (violations.length > 0) throw new CheckInputError(violations.join(" "));
  const material = {
    apiVersion: "air.dev/check-baseline/v0.1" as const, kind: "CheckBaseline" as const,
    baselineId: "", createdAt: new Date().toISOString(), releasable: input.clean,
    hashes: hashesFor(input.check, policy, input.target, input.repositoryHash),
    target: { name: input.target.metadata.name, type: input.target.spec.type },
    scenarios: [] as readonly { readonly id: string; readonly observation: DigestNode }[],
  };
  const execution = await executeScenarios(input.check, input.target, input.repositoryRoot, input.keepObservations === true);
  const blockingIssues = execution.issues.filter((issue) => issue.kind !== "unmatched" || policy.spec.unmatchedEvidence !== "report");
  if (blockingIssues.length > 0) throw new CheckInputError(blockingIssues.map((issue) => `${issue.scenario}${issue.selector}: ${issue.message}`).join(" "));
  const completedMaterial = { ...material, scenarios: execution.scenarios.map(({ id, observation }) => ({ id, observation })) };
  const baseline: CheckBaseline = { ...completedMaterial, baselineId: checkContentHash(withoutBaselineIdentity(completedMaterial)) };
  if (!validateBaseline(baseline)) throw validationError("Generated check baseline", validateBaseline);
  return { baseline, observations: new Map(execution.scenarios.filter((scenario) => scenario.raw !== undefined).map((scenario) => [scenario.id, scenario.raw])) };
}

type RunCheckInput = { readonly check: CheckDocument; readonly policy?: CheckPolicy; readonly target: CheckTarget; readonly baseline: CheckBaseline; readonly repositoryRoot: string; readonly repositoryHash: string };

export async function runMigrationCheck(input: RunCheckInput): Promise<CheckResult> {
  return (await runMigrationCheckDetailed(input)).result;
}

// Same as runMigrationCheck, plus the candidate's normalized observations kept in memory for local reveal.
export async function runMigrationCheckDetailed(input: RunCheckInput & { readonly keepObservations?: boolean }): Promise<{ readonly result: CheckResult; readonly observations: ReadonlyMap<string, unknown> }> {
  const policy = input.policy ?? DEFAULT_POLICY; const mismatches: CheckMismatch[] = [];
  const expectedHashes = hashesFor(input.check, policy, { ...input.target, metadata: { name: input.baseline.target.name } }, input.baseline.hashes.repository);
  for (const key of ["check", "policy", "normalization", "discovery"] as const) if (expectedHashes[key] !== input.baseline.hashes[key]) mismatches.push({ classification: "baseline-stale", scenario: "*", category: "baseline", selector: `/hashes/${key}`, provenance: `baseline:${input.baseline.baselineId}`, repair: "harness" });
  if (input.baseline.baselineId !== baselineIdentity(input.baseline)) mismatches.push({ classification: "baseline-stale", scenario: "*", category: "baseline", selector: "/baselineId", provenance: "baseline manifest", repair: "harness" });
  const violations = policyViolations(input.check, policy, true);
  if ((policy.spec.requireCleanBaseline ?? true) && !input.baseline.releasable) violations.push("Policy requires a releasable clean-tree baseline.");
  for (const violation of violations) mismatches.push({ classification: "policy-violation", scenario: "*", category: "policy", selector: "/", provenance: policy.metadata.name, repair: "harness" });
  let execution: CheckExecution = { scenarios: [], issues: [] };
  if (!mismatches.some((item) => item.classification === "baseline-stale")) execution = await executeScenarios(input.check, input.target, input.repositoryRoot, input.keepObservations === true);
  for (const issue of execution.issues) {
    if (issue.kind === "unmatched" && policy.spec.unmatchedEvidence === "report") continue;
    mismatches.push({ classification: issue.kind === "unmatched" ? "policy-violation" : "missing-observation", scenario: issue.scenario, category: issue.kind === "unmatched" ? "policy" : issue.selector.split("/")[1] ?? "observation", selector: issue.selector, provenance: input.target.metadata.name, repair: "harness" });
  }
  const actualById = new Map(execution.scenarios.map((scenario) => [scenario.id, scenario.observation]));
  const scenarioResults = input.baseline.scenarios.map((scenario) => {
    const before = mismatches.length; compareNodes(scenario.observation, actualById.get(scenario.id), "", scenario.id, mismatches);
    return { id: scenario.id, passed: mismatches.length === before };
  });
  const result: CheckResult = {
    apiVersion: "air.dev/check-result/v0.1", kind: "CheckResult", generatedAt: new Date().toISOString(), baselineId: input.baseline.baselineId,
    candidate: { name: input.target.metadata.name, targetHash: checkContentHash(input.target) }, passed: mismatches.length === 0,
    policy: { passed: violations.length === 0, violations }, scenarios: scenarioResults, mismatches,
  };
  if (!validateResult(result)) throw validationError("Generated check result", validateResult);
  return { result, observations: new Map(execution.scenarios.filter((scenario) => scenario.raw !== undefined).map((scenario) => [scenario.id, scenario.raw])) };
}

// Re-observes selected scenarios on a target (normally the legacy one) for local reveal. Returns the
// normalized value and its digest so callers can confirm it still matches the approved baseline.
export async function observeCheckTarget(input: { readonly check: CheckDocument; readonly target: CheckTarget; readonly repositoryRoot: string; readonly scenarioIds: readonly string[] }): Promise<ReadonlyMap<string, { readonly raw: unknown; readonly digest: DigestNode }>> {
  const wanted = new Set(input.scenarioIds);
  const check = { ...input.check, spec: { ...input.check.spec, scenarios: input.check.spec.scenarios.filter((scenario) => wanted.has(scenario.id)) } };
  if (check.spec.scenarios.length === 0) return new Map();
  const execution = await executeScenarios(check, input.target, input.repositoryRoot, true);
  return new Map(execution.scenarios.map((scenario) => [scenario.id, { raw: scenario.raw, digest: scenario.observation }]));
}

// Runs every scenario once on a target and returns normalized values, digests, and observation issues (no baseline needed).
export async function observeAllScenarios(input: { readonly check: CheckDocument; readonly target: CheckTarget; readonly repositoryRoot: string }): Promise<{ readonly scenarios: readonly { readonly id: string; readonly raw: unknown; readonly digest: DigestNode }[]; readonly issues: readonly { readonly scenario: string; readonly selector: string; readonly message: string }[] }> {
  const execution = await executeScenarios(input.check, input.target, input.repositoryRoot, true);
  return { scenarios: execution.scenarios.map((scenario) => ({ id: scenario.id, raw: scenario.raw, digest: scenario.observation })), issues: execution.issues.map(({ scenario, selector, message }) => ({ scenario, selector, message })) };
}

export function sameDigest(left: DigestNode | undefined, right: DigestNode | undefined): boolean {
  return left !== undefined && right !== undefined && canonical(left) === canonical(right);
}

export async function initializeMigrationCheck(discoveryDirectory: string, capabilityId: string, outputDirectory: string): Promise<string> {
  const bundle = await readDiscoveryBundle(discoveryDirectory); const root = bundle.nodes.find((node) => node.id === capabilityId);
  if (!root) throw new CheckInputError(`Discovery capability ${capabilityId} was not found.`);
  const reachable = new Set([root.id]); let changed = true;
  while (changed) { changed = false; for (const edge of bundle.edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } }
  const nodes = bundle.nodes.filter((node) => reachable.has(node.id)); const endpoint = root.kind === "endpoint" ? root : nodes.find((node) => node.kind === "endpoint");
  const method = typeof endpoint?.attributes.method === "string" ? endpoint.attributes.method.toUpperCase() : undefined;
  const path = typeof endpoint?.attributes.path === "string" ? endpoint.attributes.path : undefined;
  const observations = new Set<ObservationCategory>(endpoint ? ["http"] : []);
  if (nodes.some((node) => ["entity", "table", "repository", "query", "transaction"].includes(node.kind))) observations.add("database");
  if (nodes.some((node) => ["publisher", "listener"].includes(node.kind))) observations.add("messages");
  if (nodes.some((node) => node.kind === "vendor-call")) observations.add("outbound");
  const check: CheckDocument = {
    apiVersion: "air.dev/check/v0.1", kind: "Check", metadata: { name: `${root.name}-replacement` },
    spec: { capability: { id: root.id, discoveryHash: bundle.manifest.metadata.repositoryHash, repositoryHash: bundle.manifest.metadata.repositoryHash }, scenarios: [{ id: "review-me", description: "Review and replace this generated scenario before baselining.", request: method && path ? { kind: "http", method, path } : { kind: "command" } }], observations: observations.size > 0 ? [...observations] : ["failures"] },
  };
  if (!validateCheck(check)) throw validationError("Generated check", validateCheck);
  await mkdir(dirname(outputDirectory), { recursive: true }); await mkdir(outputDirectory, { recursive: false }); const output = resolve(outputDirectory, "check.yaml");
  await writeFile(output, stringify(check, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
  return output;
}

export async function loadMigrationCheck(path: string): Promise<CheckDocument> { return parseCheckDocument(await readFile(resolve(path), "utf8")); }
export async function loadCheckTarget(path: string): Promise<CheckTarget> { return parseCheckTarget(await readFile(resolve(path), "utf8")); }
export async function loadCheckPolicy(path?: string): Promise<CheckPolicy> { return path ? parseCheckPolicy(await readFile(resolve(path), "utf8")) : DEFAULT_POLICY; }
export async function loadCheckBaseline(directory: string): Promise<CheckBaseline> { return parseCheckBaseline(await readFile(resolve(directory, "baseline.json"), "utf8")); }
export async function writeCheckBaseline(directory: string, baseline: CheckBaseline): Promise<string> { await mkdir(dirname(directory), { recursive: true }); await mkdir(directory, { recursive: false }); const output = resolve(directory, "baseline.json"); await writeFile(output, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); return output; }
export async function writeCheckResult(directory: string, result: CheckResult): Promise<string> { await mkdir(dirname(directory), { recursive: true }); await mkdir(directory, { recursive: false }); const output = resolve(directory, "result.json"); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); return output; }

// Accepts the candidate's current behavior for chosen scenarios as intended, keeping every other scenario's
// approved digest. The reason and previous baseline are recorded so intentional changes stay reviewable.
export async function approveBaselineScenarios(input: { readonly check: CheckDocument; readonly baseline: CheckBaseline; readonly target: CheckTarget; readonly repositoryRoot: string; readonly clean: boolean; readonly scenarioIds: readonly string[]; readonly reason: string }): Promise<CheckBaseline> {
  const known = new Set(input.baseline.scenarios.map((scenario) => scenario.id));
  const unknown = input.scenarioIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new CheckInputError(`Unknown baseline scenario(s): ${unknown.join(", ")}.`);
  if (!input.reason.trim()) throw new CheckInputError("An approval needs a non-empty --reason.");
  const wanted = new Set(input.scenarioIds);
  const check = { ...input.check, spec: { ...input.check.spec, scenarios: input.check.spec.scenarios.filter((scenario) => wanted.has(scenario.id)) } };
  const execution = await executeScenarios(check, input.target, input.repositoryRoot);
  if (execution.issues.length > 0) throw new CheckInputError(execution.issues.map((issue) => `${issue.scenario}${issue.selector}: ${issue.message}`).join(" "));
  const observed = new Map(execution.scenarios.map((scenario) => [scenario.id, scenario.observation]));
  const approvedAt = new Date().toISOString();
  const material = {
    ...withoutBaselineIdentity(input.baseline) as Omit<CheckBaseline, "baselineId">,
    createdAt: approvedAt, releasable: input.baseline.releasable && input.clean,
    scenarios: input.baseline.scenarios.map((scenario) => ({ id: scenario.id, observation: observed.get(scenario.id) ?? scenario.observation })),
    approvals: [...(input.baseline.approvals ?? []), ...input.scenarioIds.map((scenario) => ({ scenario, reason: input.reason.trim(), approvedAt, previousBaselineId: input.baseline.baselineId, target: input.target.metadata.name }))],
  };
  const baseline: CheckBaseline = { ...material, baselineId: checkContentHash(material) };
  if (!validateBaseline(baseline)) throw validationError("Approved check baseline", validateBaseline);
  return baseline;
}

// Extends a baseline with scenarios newly added to its check (coverage grown with `air protect --add`). Existing
// digests are kept; only the new scenarios are observed. The check hash is updated so later runs are not stale.
export async function addBaselineScenarios(input: { readonly check: CheckDocument; readonly policy?: CheckPolicy; readonly baseline: CheckBaseline; readonly target: CheckTarget; readonly repositoryRoot: string; readonly scenarioIds: readonly string[]; readonly reason: string }): Promise<{ readonly baseline: CheckBaseline; readonly observations: ReadonlyMap<string, unknown> }> {
  const known = new Set(input.baseline.scenarios.map((scenario) => scenario.id));
  const fresh = input.scenarioIds.filter((id) => !known.has(id));
  const check = { ...input.check, spec: { ...input.check.spec, scenarios: input.check.spec.scenarios.filter((scenario) => fresh.includes(scenario.id)) } };
  const execution = fresh.length > 0 ? await executeScenarios(check, input.target, input.repositoryRoot, true) : { scenarios: [], issues: [] };
  if (execution.issues.length > 0) throw new CheckInputError(execution.issues.map((issue) => `${issue.scenario}${issue.selector}: ${issue.message}`).join(" "));
  const addedAt = new Date().toISOString();
  const material = {
    ...withoutBaselineIdentity(input.baseline) as Omit<CheckBaseline, "baselineId">,
    createdAt: addedAt,
    hashes: { ...input.baseline.hashes, check: checkContentHash(input.check), policy: checkContentHash(input.policy ?? DEFAULT_POLICY), normalization: checkContentHash(input.check.spec.normalization ?? []) },
    scenarios: [...input.baseline.scenarios, ...execution.scenarios.map(({ id, observation }) => ({ id, observation }))],
    approvals: [...(input.baseline.approvals ?? []), ...fresh.map((scenario) => ({ scenario, reason: input.reason, approvedAt: addedAt, previousBaselineId: input.baseline.baselineId, target: input.target.metadata.name }))],
  };
  const baseline: CheckBaseline = { ...material, baselineId: checkContentHash(material) };
  if (!validateBaseline(baseline)) throw validationError("Extended check baseline", validateBaseline);
  return { baseline, observations: new Map(execution.scenarios.map((scenario) => [scenario.id, scenario.raw])) };
}

// Structural differences between two baselines of the same check, e.g. before and after an approval.
export function diffBaselines(before: CheckBaseline, after: CheckBaseline): readonly CheckMismatch[] {
  const mismatches: CheckMismatch[] = [];
  const afterById = new Map(after.scenarios.map((scenario) => [scenario.id, scenario.observation]));
  for (const scenario of before.scenarios) compareNodes(scenario.observation, afterById.get(scenario.id), "", scenario.id, mismatches);
  for (const scenario of after.scenarios) if (!before.scenarios.some((item) => item.id === scenario.id)) mismatches.push({ classification: "candidate-difference", scenario: scenario.id, category: "scenario", selector: "/", provenance: `baseline:${after.baselineId}`, repair: "harness" });
  return mismatches;
}


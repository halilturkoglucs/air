import type { AirDocument } from "@air/schema";
import type { CapabilityConstraint, CompilationDiagnostic, TargetAdapter } from "./target.js";

export interface TargetCandidate {
  readonly adapter: TargetAdapter<any>;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface TargetSolveRequest {
  readonly air: AirDocument;
  readonly candidates: readonly TargetCandidate[];
  readonly required?: readonly string[];
  readonly preferred?: readonly string[];
}

export interface TargetCompatibilityResult {
  readonly targetId: string;
  readonly displayName: string;
  readonly compatible: boolean;
  readonly preferenceScore: number;
  readonly requiredCapabilities: readonly string[];
  readonly diagnostics: readonly CompilationDiagnostic[];
}

export interface TargetCompatibilityReport {
  readonly format: "air.dev/target-compatibility/v0.1";
  readonly airVersion: string;
  readonly results: readonly TargetCompatibilityResult[];
}

export function inferRequiredCapabilities(air: AirDocument): readonly string[] {
  const operations = air.spec.http?.operations ?? [];
  const commands = Object.values(air.spec.commands ?? {});
  const required = new Set<string>(["persistence.relational"]);
  if (operations.some((operation) => "entity" in operation)) required.add("http.crud");
  if (operations.some((operation) => "entity" in operation && operation.action === "list" && operation.collection)) required.add("http.collections");
  if (commands.length > 0) required.add("domain.commands");
  if (commands.some((command) => command.invariants && command.invariants.length > 0)) required.add("domain.invariants");
  if (commands.some((command) => Object.keys(command.effects ?? {}).length > 0)) required.add("domain.multi_effect");
  if (commands.some((command) => command.idempotency !== undefined)) required.add("domain.idempotency");
  if (commands.some((command) => command.effect.kind === "delete")) required.add("domain.delete");
  if (commands.some((command) => (command.emits?.length ?? 0) > 0)) required.add("messaging.publish");
  if (commands.some((command) => (command.enqueues?.length ?? 0) > 0)) required.add("messaging.tasks");
  if (Object.keys(air.spec.consumers ?? {}).length > 0) required.add("messaging.consume");
  if (Object.keys(air.spec.schedules ?? {}).length > 0) required.add("background.schedules");
  if (Object.keys(air.spec.cachedReads ?? {}).length > 0) required.add("cache.derived");
  const realtime = Object.values(air.spec.realtime ?? {});
  if (realtime.some((channel) => channel.transports.includes("websocket"))) required.add("realtime.websocket");
  if (realtime.some((channel) => channel.transports.includes("sse"))) required.add("realtime.sse");
  const authorizations = [
    ...commands.flatMap((command) => command.authorization?.rules ?? []),
    ...operations.flatMap((operation) => "entity" in operation ? operation.authorization?.rules ?? [] : []),
  ];
  if (authorizations.some((rule) => rule.kind === "input-equals-principal" || rule.kind === "record-field-equals-principal")) required.add("authorization.ownership");
  if (authorizations.some((rule) => rule.kind === "principal-field-in")) required.add("authorization.roles-scopes");
  return [...required].sort();
}

function versionNumber(value: string): number {
  const match = /v(\d+)$/.exec(value);
  return Number(match?.[1] ?? -1);
}

function constraintFailure(air: AirDocument, options: Readonly<Record<string, unknown>>, constraint: CapabilityConstraint): string | undefined {
  if (constraint.kind === "air-version") {
    const version = versionNumber(air.apiVersion);
    if (version < versionNumber(constraint.minimum)) return `requires AIR ${constraint.minimum} or newer`;
    if (constraint.maximum && version > versionNumber(constraint.maximum)) return `supports AIR through ${constraint.maximum}`;
  } else if (constraint.kind === "option-in") {
    const value = options[constraint.option];
    if (!constraint.values.includes(value as never)) return `option ${constraint.option} must be one of ${constraint.values.join(", ")}`;
  } else if (constraint.kind === "primary-effect-in") {
    const unsupported = Object.entries(air.spec.commands ?? {}).filter(([, command]) => !constraint.values.includes(command.effect.kind)).map(([name]) => name);
    if (unsupported.length > 0) return `commands ${unsupported.join(", ")} use unsupported primary effects`;
  } else {
    const unsupported = Object.entries(air.spec.commands ?? {}).filter(([, command]) => Object.keys(command.effects ?? {}).length > constraint.value).map(([name]) => name);
    if (unsupported.length > 0) return `commands ${unsupported.join(", ")} exceed ${constraint.value} named effects`;
  }
  return undefined;
}

export async function solveTargetCompatibility(request: TargetSolveRequest): Promise<TargetCompatibilityReport> {
  const required = [...new Set([...(inferRequiredCapabilities(request.air)), ...(request.required ?? [])])].sort();
  const preferred = [...new Set(request.preferred ?? [])];
  const results = await Promise.all(request.candidates.map(async ({ adapter, options }) => {
    const diagnostics: CompilationDiagnostic[] = [];
    for (const capability of required) {
      const declaration = adapter.manifest.capabilities[capability];
      if (!declaration || declaration.support === "unsupported") {
        diagnostics.push({ severity: "error", code: "TARGET_CAPABILITY_UNSUPPORTED", message: `${adapter.displayName} does not support required capability ${capability}.`, airPath: "/spec" });
        continue;
      }
      for (const constraint of declaration.constraints ?? []) {
        const failure = constraintFailure(request.air, options, constraint);
        if (failure) diagnostics.push({ severity: "error", code: "TARGET_CAPABILITY_CONSTRAINT", message: `${adapter.displayName} capability ${capability} ${failure}.`, airPath: "/spec" });
      }
    }
    diagnostics.push(...await adapter.analyze({ air: request.air, outputDirectory: ".", mode: "managed", options }));
    const preferenceScore = preferred.reduce((score, capability) => {
      const support = adapter.manifest.capabilities[capability]?.support;
      return score + (support === "supported" ? 2 : support === "conditional" ? 1 : 0);
    }, 0);
    return { targetId: adapter.id, displayName: adapter.displayName, compatible: !diagnostics.some((item) => item.severity === "error"), preferenceScore, requiredCapabilities: required, diagnostics };
  }));
  return { format: "air.dev/target-compatibility/v0.1", airVersion: request.air.apiVersion, results: results.sort((left, right) => Number(right.compatible) - Number(left.compatible) || right.preferenceScore - left.preferenceScore || left.targetId.localeCompare(right.targetId)) };
}

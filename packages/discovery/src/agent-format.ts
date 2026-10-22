import { createHash } from "node:crypto";
import type { CheckMismatch, CheckResult, FailureClassification } from "./check.js";

// Compact, deterministic report for coding agents. Same result in, same bytes out, within a line budget.
export const AGENT_PROTOCOL = "air.dev/agent/v1";

export type AgentDifferenceKind = "diff" | "missing" | "stale" | "policy" | "infra";
export interface AgentDifference { readonly s: string; readonly p: string; readonly k: AgentDifferenceKind; readonly n: number; readonly e?: unknown; readonly a?: unknown }
export interface AgentReport {
  readonly v: typeof AGENT_PROTOCOL;
  readonly ok: boolean;
  readonly passed: number;
  readonly total: number;
  readonly differences: number;
  readonly fixed?: number;
  readonly added?: number;
  readonly diffs: readonly AgentDifference[];
  readonly omitted: number;
  readonly notes: readonly string[];
  readonly next: string;
}
export type ScenarioValues = ReadonlyMap<string, { readonly expected: unknown; readonly actual: unknown }>;

const kinds: Record<FailureClassification, AgentDifferenceKind> = {
  "candidate-difference": "diff", "missing-observation": "missing", "baseline-stale": "stale", "policy-violation": "policy", "infrastructure-error": "infra",
};

// Keyed on what is expected, not on the candidate's current value, so "fixed" means resolved rather than merely changed.
export function differenceKey(mismatch: CheckMismatch): string {
  return createHash("sha256").update([mismatch.scenario, mismatch.selector, mismatch.classification, mismatch.expected?.sha256 ?? ""].join("\0")).digest("hex").slice(0, 16);
}

export function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    current = Array.isArray(current) ? current[Number(key)] : Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

const parentOf = (selector: string): string => selector.split("/").slice(0, -1).join("/");
// Three or more differing siblings collapse into their parent; one or two stay as clearer leaf lines.
const COLLAPSE_AT = 3;
// A failed normalization rule leaves tokens raw, so it is listed first: fixing it often clears the rest.
const rank = (selector: string): number => (selector === "/normalization" ? 0 : 1);

export function buildAgentReport(input: { readonly result: CheckResult; readonly values?: ScenarioValues | undefined; readonly previousKeys?: readonly string[] | undefined; readonly maxLines?: number | undefined; readonly notes?: readonly string[] | undefined }): AgentReport {
  const { result } = input; const maxLines = Math.max(4, input.maxLines ?? 40);
  const scenarioOrder = new Map(result.scenarios.map((scenario, index) => [scenario.id, index]));
  const order = (scenario: string): number => scenarioOrder.get(scenario) ?? -1;
  const scenarios = [...new Set(result.mismatches.map((item) => item.scenario))].sort((left, right) => order(left) - order(right) || left.localeCompare(right));
  const grouped: AgentDifference[] = [];
  for (const scenario of scenarios) {
    const items = result.mismatches.filter((item) => item.scenario === scenario);
    const siblings = new Map<string, number>();
    for (const item of items) siblings.set(parentOf(item.selector), (siblings.get(parentOf(item.selector)) ?? 0) + 1);
    const collapsed = new Map<string, AgentDifference>();
    for (const item of [...items].sort((left, right) => rank(left.selector) - rank(right.selector) || left.selector.localeCompare(right.selector))) {
      const parent = parentOf(item.selector);
      const selector = parent !== "" && (siblings.get(parent) ?? 0) >= COLLAPSE_AT ? parent : item.selector;
      const existing = collapsed.get(selector);
      if (existing) { collapsed.set(selector, { ...existing, n: existing.n + 1 }); continue; }
      const observed = input.values?.get(scenario);
      collapsed.set(selector, { s: scenario, p: selector || "/", k: kinds[item.classification], n: 1, ...(observed ? { e: pointerValue(observed.expected, selector), a: pointerValue(observed.actual, selector) } : {}) });
    }
    grouped.push(...collapsed.values());
  }
  const notes = [...(input.notes ?? []), ...scenarios.filter((scenario) => result.mismatches.some((item) => item.scenario === scenario && item.selector === "/normalization")).map((scenario) => `normalization failed in ${scenario} (a normalized pointer is missing or has the wrong type); fix that first, other differences there may follow from it.`)];
  // Header + NEXT + one heading per scenario + notes come out of the budget before difference lines.
  let budget = maxLines - 2 - scenarios.length - notes.length;
  if (grouped.length > budget) budget -= 1; // the "...(+N more)" line
  const shown: AgentDifference[] = [];
  for (const item of grouped) { if (budget <= 0) break; shown.push(item); budget -= 1; }
  const current = result.mismatches.map(differenceKey);
  const delta = input.previousKeys ? { fixed: input.previousKeys.filter((key) => !current.includes(key)).length, added: current.filter((key) => !input.previousKeys!.includes(key)).length } : {};
  const harness = result.mismatches.some((item) => item.repair === "harness" && item.classification !== "missing-observation");
  const next = result.passed ? "DONE candidate matches the baseline; stop."
    : harness ? "NEXT stale baseline or policy violation: fix the check/policy or re-baseline legacy; do not edit the candidate for these."
      : "NEXT edit candidate code only, then rerun `air check run --agent`.";
  return {
    v: AGENT_PROTOCOL, ok: result.passed, passed: result.scenarios.filter((scenario) => scenario.passed).length, total: result.scenarios.length,
    differences: result.mismatches.length, ...delta, diffs: shown, omitted: grouped.length - shown.length, notes, next,
  };
}

const show = (value: unknown): string => {
  if (value === undefined) return "<missing>";
  // Normalized tokens render as <format:binding> instead of their verbose object form.
  const text = JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && "$airToken" in item ? `<${String((item as Record<string, unknown>).$airToken)}${(item as Record<string, unknown>).binding ? `:${String((item as Record<string, unknown>).binding)}` : ""}>` : item);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

export function formatAgentReport(report: AgentReport): string {
  const delta = report.fixed === undefined ? "" : ` · fixed ${report.fixed}, new ${report.added} since last run`;
  const lines = [`${report.ok ? "PASS" : "FAIL"} ${report.passed}/${report.total} scenarios · ${report.differences} differences${delta}`];
  let scenario: string | undefined;
  for (const item of report.diffs) {
    if (item.s !== scenario) { scenario = item.s; lines.push(`- ${item.s}`); }
    const count = item.n > 1 ? ` (${item.n})` : "";
    const detail = item.e !== undefined || item.a !== undefined ? `: expected ${show(item.e)}, got ${show(item.a)}` : item.k === "missing" ? ": missing" : item.k === "diff" ? ": differs" : `: ${item.k}`;
    lines.push(`  ${item.p}${count}${detail}`);
  }
  if (report.omitted > 0) lines.push(`  ...(+${report.omitted} more)`);
  for (const note of report.notes) lines.push(`NOTE ${note}`);
  lines.push(report.next);
  return `${lines.join("\n")}\n`;
}

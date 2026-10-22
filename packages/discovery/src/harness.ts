import { JWT, observeAllScenarios, sameDigest, type CheckDocument, type CheckTarget, type DigestNode, type NormalizationRule } from "./check.js";

// Acceptance gate for agent-written harnesses. An LLM may write the harness; only these deterministic checks decide
// whether AIR trusts it: stable across runs, sensitive to input, and able to detect a planted behavior change.

export interface HarnessVerdict {
  readonly accepted: boolean;
  readonly runs: number;
  readonly problems: readonly string[];
  readonly proposedNormalization: readonly NormalizationRule[];
  readonly unstable: readonly string[];
  readonly mutationDetected?: boolean;
  // First-run observations, kept so planted changes can be compared without rerunning the normal code.
  readonly reference: readonly { readonly id: string; readonly raw: unknown }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const escapePointer = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

// Lists pointers whose values differ between two observations of the same scenario.
function differingPointers(left: unknown, right: unknown, pointer = ""): { pointer: string; left: unknown; right: unknown }[] {
  if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
    const keys = Array.isArray(left) ? [...Array(Math.max(left.length, (right as unknown[]).length)).keys()].map(String) : [...new Set([...Object.keys(left), ...Object.keys(right as object)])].sort();
    return keys.flatMap((key) => differingPointers((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${pointer}/${escapePointer(key)}`));
  }
  return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ pointer, left, right }];
}

// The format of a value that legitimately changes between identical runs, if it is one AIR can type-check.
export function generatedFormat(left: unknown, right: unknown): "uuid" | "timestamp" | "jwt" | undefined {
  const both = (pattern: RegExp): boolean => [left, right].every((value) => typeof value === "string" && pattern.test(value));
  return both(UUID) ? "uuid" : both(TIMESTAMP) ? "timestamp" : both(JWT) ? "jwt" : undefined;
}

export { differingPointers };

export async function verifyHarness(input: { readonly check: CheckDocument; readonly target: CheckTarget; readonly repositoryRoot: string; readonly runs?: number; readonly mutatedRoot?: string }): Promise<HarnessVerdict> {
  const runs = Math.max(2, input.runs ?? 3);
  const problems: string[] = [];
  const observations: Awaited<ReturnType<typeof observeAllScenarios>>[] = [];
  for (let run = 0; run < runs; run += 1) observations.push(await observeAllScenarios(input));
  for (const issue of observations[0]!.issues) problems.push(`${issue.scenario}${issue.selector}: ${issue.message}`);

  // Stability: values that differ between runs are either generated tokens (proposed normalization) or real instability.
  const tokens = new Map<string, NormalizationRule>(); const unstable = new Set<string>();
  for (const first of observations[0]!.scenarios) for (const later of observations.slice(1)) {
    const other = later.scenarios.find((scenario) => scenario.id === first.id);
    if (!other) { problems.push(`${first.id}: missing in a later run`); continue; }
    for (const difference of differingPointers(first.raw, other.raw)) {
      const format = generatedFormat(difference.left, difference.right);
      if (format) tokens.set(difference.pointer, { kind: "typed-token", pointer: difference.pointer, format });
      else unstable.add(`${first.id}${difference.pointer}`);
    }
  }
  if (unstable.size > 0) problems.push(`not stable across ${runs} runs: ${[...unstable].sort().slice(0, 8).join(", ")}${unstable.size > 8 ? ` (+${unstable.size - 8} more)` : ""}`);

  // Input sensitivity: a harness that returns the same observation for every scenario is not observing behavior.
  const digests = observations[0]!.scenarios.map((scenario) => scenario.digest);
  if (digests.length > 1 && digests.every((digest) => sameDigest(digest, digests[0]))) problems.push("every scenario produced the same observation; the harness does not react to its input");
  if (observations[0]!.scenarios.every((scenario) => !scenario.raw || (typeof scenario.raw === "object" && Object.keys(scenario.raw as object).length === 0))) problems.push("the harness reported no observations");

  // Every declared category must carry data somewhere; a category that is always empty is a promise the harness does not keep.
  for (const category of input.check.spec.observations) {
    const empty = (value: unknown): boolean => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
    if (observations[0]!.scenarios.every((scenario) => empty((scenario.raw as Record<string, unknown> | undefined)?.[category]))) problems.push(`category ${category} was never observed (empty in every scenario); observe it or remove it from check.yaml`);
  }

  // Planted change: the same harness run against a deliberately broken copy must see a difference.
  let mutationDetected: boolean | undefined;
  if (input.mutatedRoot) {
    const mutated = await observeAllScenarios({ ...input, repositoryRoot: input.mutatedRoot });
    const baseline = new Map<string, DigestNode>(observations[0]!.scenarios.map((scenario) => [scenario.id, scenario.digest]));
    mutationDetected = mutated.issues.some((issue) => !problems.includes(`${issue.scenario}${issue.selector}: ${issue.message}`)) || mutated.scenarios.some((scenario) => {
      const before = observations[0]!.scenarios.find((item) => item.id === scenario.id);
      return !before || differingPointers(before.raw, scenario.raw).some((difference) => !tokens.has(difference.pointer)) || !baseline.has(scenario.id);
    });
    if (!mutationDetected) problems.push("the planted change was not detected; the harness does not observe the behavior it claims to cover");
  }
  return { accepted: problems.length === 0, runs, problems, proposedNormalization: [...tokens.values()].sort((left, right) => left.pointer.localeCompare(right.pointer)), unstable: [...unstable].sort(), ...(mutationDetected === undefined ? {} : { mutationDetected }), reference: observations[0]!.scenarios.map((scenario) => ({ id: scenario.id, raw: scenario.raw })) };
}

// Observes a planted change once and reports whether it differs from the reference outside generated values.
// Used when the change must be deployed first (a service in a container), so the normal runs happen before it.
export async function detectsMutation(input: { readonly check: CheckDocument; readonly target: CheckTarget; readonly mutatedRoot: string; readonly verdict: HarnessVerdict }): Promise<boolean> {
  const mutated = await observeAllScenarios({ check: input.check, target: input.target, repositoryRoot: input.mutatedRoot });
  const generated = new Set(input.verdict.proposedNormalization.map((rule) => rule.pointer));
  // An issue the normal code also has (a harness bug) is not evidence that the planted change was noticed.
  const known = new Set(input.verdict.problems);
  return mutated.issues.some((issue) => !known.has(`${issue.scenario}${issue.selector}: ${issue.message}`)) || mutated.scenarios.length !== input.verdict.reference.length || mutated.scenarios.some((scenario) => {
    const before = input.verdict.reference.find((item) => item.id === scenario.id);
    return !before || differingPointers(before.raw, scenario.raw).some((difference) => !generated.has(difference.pointer));
  });
}

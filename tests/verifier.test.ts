import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAirFile } from "@air/parser";
import {
  benchmarkLiveScenario,
  benchmarkMutationScenario,
  benchmarkConflictScenario,
  executeVerificationScenario,
  parseVerificationSuite,
  verifyDifferentialSuite,
  verifyLiveScenario,
  verifySuite,
} from "@air/verifier";

describe("AIR verification kernel", () => {
  it("executes canonical e-commerce scenarios", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ecommerce/verification.yaml"), "utf8"),
    );
    const results = verifySuite(air, suite);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("rolls state back when a domain rule fails", async () => {
    const air = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ecommerce/verification.yaml"), "utf8"),
    );
    const scenario = suite.scenarios.find((item) => item.id === "placeOrderEnforcesApprovedLimit");
    expect(scenario).toBeDefined();
    const result = executeVerificationScenario(air, scenario!);

    expect(result.status).toBe("error");
    expect(result.state).toEqual({});
  });

  it("verifies atomic and idempotent ledger transfers", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ledger/verification.yaml"), "utf8"),
    );
    const results = verifySuite(air, suite);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("verifies v0.8 authorization and transactional deletion", async () => {
    const air = await loadAirFile(resolve("examples/library/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/library/verification.yaml"), "utf8"),
    );
    const results = verifySuite(air, suite);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results[0]?.actual).toMatchObject({ status: "success", state: { Document: [] } });
  });

  it("verifies a live HTTP result and persisted state while accepting valid generated values", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ledger/verification.yaml"), "utf8"),
    );
    const scenario = suite.scenarios[0]!;
    if ("error" in scenario.expect) throw new Error("Expected the success scenario.");
    const createdAt = "2026-10-06T12:00:00.000Z";
    const output = { ...scenario.expect.output, createdAt };
    const state = structuredClone(scenario.expect.state!);
    state.Transfer![0]!.createdAt = createdAt;
    let reset = false;

    const result = await verifyLiveScenario(air, scenario, {
      async reset() { reset = true; },
      async invoke(_, operation) {
        expect(operation).toEqual({ method: "POST", path: "/transfers/execute" });
        return { status: 201, body: output };
      },
      async readState(entities) {
        expect(entities).toEqual(["Account", "Transfer"]);
        return state;
      },
    });

    expect(reset).toBe(true);
    expect(result.passed, result.diagnostics.join("\n")).toBe(true);
  });

  it("reports an incorrect live domain-error status", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ledger/verification.yaml"), "utf8"),
    );
    const scenario = suite.scenarios[1]!;
    const result = await verifyLiveScenario(air, scenario, {
      async reset() {},
      async invoke() {
        return { status: 500, body: { error: { code: "INSUFFICIENT_FUNDS", message: "wrong status" } } };
      },
      async readState() { return structuredClone(scenario.expect.state!); },
    });

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toContain("Expected HTTP 422, received 500.");
  });

  it("compares normalized observations across live targets", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const parsed = parseVerificationSuite(
      await readFile(resolve("examples/ledger/verification.yaml"), "utf8"),
    );
    const scenario = parsed.scenarios[0]!;
    if ("error" in scenario.expect) throw new Error("Expected the success scenario.");
    const suite = { ...parsed, scenarios: [scenario] };
    const target = (createdAt: string, amount = 30) => ({
      async reset() {},
      async invoke() { return { status: 201, body: { ...scenario.expect.output, amount, createdAt } }; },
      async readState() {
        const state = structuredClone(scenario.expect.state!);
        state.Transfer![0]!.amount = amount;
        state.Transfer![0]!.createdAt = createdAt;
        return state;
      },
    });

    const matching = await verifyDifferentialSuite(air, suite, [
      { name: "nextjs", adapter: target("2026-10-06T12:00:00.000Z") },
      { name: "rust", adapter: target("2026-10-06T12:00:01.000Z") },
    ]);
    expect(matching[0]?.passed).toBe(true);

    const mismatching = await verifyDifferentialSuite(air, suite, [
      { name: "nextjs", adapter: target("2026-10-06T12:00:00.000Z") },
      { name: "rust", adapter: target("2026-10-06T12:00:01.000Z", 31) },
    ]);
    expect(mismatching[0]?.passed).toBe(false);
    expect(mismatching[0]?.diagnostics.some((diagnostic) => diagnostic.includes("Differential mismatch"))).toBe(true);
  });

  it("benchmarks a validated idempotent replay workload", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ledger/verification.yaml"), "utf8"),
    );
    const scenario = suite.scenarios[2]!;
    if ("error" in scenario.expect) throw new Error("Expected the replay scenario.");
    let invocations = 0;
    const result = await benchmarkLiveScenario(air, scenario, {
      async reset() {},
      async invoke() {
        invocations += 1;
        return { status: 201, body: scenario.expect.output };
      },
      async readState(entities) {
        return entities.length === 0 ? {} : structuredClone(scenario.expect.state!);
      },
    }, { warmupRequests: 2, measuredRequests: 5, concurrency: 2 });

    expect(result.passed).toBe(true);
    expect(result.metrics.requests).toBe(5);
    expect(result.samplesMs).toHaveLength(5);
    expect(invocations).toBe(8); // baseline + warmup + measured
    expect(result.metrics.throughputPerSecond).toBeGreaterThan(0);
  });

  it("runs idempotent replay for a fixed measurement duration", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(await readFile(resolve("examples/ledger/verification.yaml"), "utf8"));
    const scenario = suite.scenarios[2]!;
    if ("error" in scenario.expect) throw new Error("Expected the replay scenario.");
    const result = await benchmarkLiveScenario(air, scenario, {
      async reset() {},
      async invoke() { return { status: 201, body: scenario.expect.output }; },
      async readState(entities) { return entities.length === 0 ? {} : structuredClone(scenario.expect.state!); },
    }, { warmupRequests: 0, measuredRequests: 1, durationMs: 5, concurrency: 2 });

    expect(result.passed).toBe(true);
    expect(result.metrics.requests).toBeGreaterThan(0);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(5);
    expect(result.samplesMs).toHaveLength(result.metrics.requests);
  });

  it("benchmarks deterministic isolated mutations and verifies aggregate state", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(
      await readFile(resolve("examples/ledger/verification.yaml"), "utf8"),
    );
    const scenario = suite.scenarios[0]!;
    let state: Record<string, Record<string, unknown>[]> = {};
    const result = await benchmarkMutationScenario(air, scenario, {
      async reset(resetScenario) { state = structuredClone(resetScenario.given.state ?? {}); },
      async invoke(requestScenario) {
        const execution = executeVerificationScenario(air, {
          ...requestScenario,
          given: { ...requestScenario.given, state },
        });
        if (execution.status === "error") {
          return { status: execution.error.status, body: { error: execution.error } };
        }
        state = structuredClone(execution.state);
        return { status: 201, body: execution.output };
      },
      async readState(entities) {
        return Object.fromEntries(entities.map((entity) => [entity, structuredClone(state[entity] ?? [])]));
      },
    }, { warmupRequests: 1, measuredRequests: 3, concurrency: 1 });

    expect(result.passed).toBe(true);
    expect(result.workload).toBe("isolated-mutation");
    expect(result.metrics.requests).toBe(3);
    expect(state.Transfer).toHaveLength(4);
    expect(state.Account).toHaveLength(8);
  });

  it("benchmarks a controlled shared-record conflict mix", async () => {
    const air = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const suite = parseVerificationSuite(await readFile(resolve("examples/ledger/verification.yaml"), "utf8"));
    const scenario = suite.scenarios[0]!;
    let state: Record<string, Record<string, unknown>[]> = {};
    const result = await benchmarkConflictScenario(air, scenario, {
      async reset(resetScenario) { state = structuredClone(resetScenario.given.state ?? {}); },
      async invoke(requestScenario) {
        const execution = executeVerificationScenario(air, { ...requestScenario, given: { ...requestScenario.given, state } });
        if (execution.status === "error") return { status: execution.error.status, body: { error: execution.error } };
        state = structuredClone(execution.state);
        return { status: 201, body: execution.output };
      },
      async readState(entities) { return Object.fromEntries(entities.map((entity) => [entity, structuredClone(state[entity] ?? [])])); },
    }, { warmupRequests: 2, measuredRequests: 5, concurrency: 5 });

    expect(result.passed, result.diagnostics.join("\n")).toBe(true);
    expect(result.workload).toBe("shared-record-conflict");
    expect(result.metrics.retryableConflicts).toBe(4);
    expect(state.Transfer).toHaveLength(1);
  });

  it("rejects duplicate scenario identifiers", () => {
    expect(() =>
      parseVerificationSuite(`
apiVersion: air.dev/verification/v0.1
kind: VerificationSuite
scenarios:
  - id: duplicate
    command: one
    given: { input: {} }
    expect: { error: FAILED }
  - id: duplicate
    command: two
    given: { input: {} }
    expect: { error: FAILED }
`),
    ).toThrow(/duplicate scenario id/);
  });
});

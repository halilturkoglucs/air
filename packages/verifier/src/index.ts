import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import verificationSchema from "../schema/verification-0.1.schema.json" with { type: "json" };
import type {
  AirDocument,
  CommandDefinition,
  CommandAssignment,
  CommandCreateEffect,
  CommandErrorDefinition,
  CommandValueReference,
  ConstraintValue,
  EntityDefinition,
  FieldDefinition,
  InvariantExpression,
  InvariantOperand,
} from "@air/schema";

export const VERIFICATION_API_VERSION = "air.dev/verification/v0.1" as const;
export const VERIFICATION_KIND = "VerificationSuite" as const;

export type VerificationRecord = Record<string, unknown>;
export type VerificationState = Record<string, VerificationRecord[]>;

export interface VerificationScenario {
  readonly id: string;
  readonly description?: string;
  readonly command: string;
  readonly given: {
    readonly input: VerificationRecord;
    readonly principal?: VerificationRecord;
    readonly state?: VerificationState;
  };
  readonly expect:
    | { readonly output: VerificationRecord; readonly state?: VerificationState }
    | { readonly error: string; readonly state?: VerificationState };
}

export interface VerificationSuite {
  readonly apiVersion: typeof VERIFICATION_API_VERSION;
  readonly kind: typeof VERIFICATION_KIND;
  readonly scenarios: readonly VerificationScenario[];
}

export interface VerificationExecutionOptions {
  readonly now?: string;
  readonly generateUuid?: (entity: string, field: string, sequence: number) => string;
}

export type VerificationExecutionResult =
  | {
      readonly status: "success";
      readonly output: VerificationRecord;
      readonly state: VerificationState;
    }
  | {
      readonly status: "error";
      readonly error: { readonly code: string; readonly status: number; readonly message: string };
      readonly state: VerificationState;
    };

export interface ScenarioVerificationResult {
  readonly id: string;
  readonly passed: boolean;
  readonly diagnostics: readonly string[];
  readonly actual: VerificationExecutionResult;
}

export interface LiveCommandOperation {
  readonly method: string;
  readonly path: string;
}

export interface LiveInvocationResult {
  readonly status: number;
  readonly body: unknown;
}

export interface LiveVerificationAdapter {
  reset(scenario: VerificationScenario): Promise<void>;
  invoke(scenario: VerificationScenario, operation: LiveCommandOperation): Promise<LiveInvocationResult>;
  readState(entities: readonly string[]): Promise<VerificationState>;
}

export interface LiveScenarioVerificationResult {
  readonly id: string;
  readonly passed: boolean;
  readonly diagnostics: readonly string[];
  readonly httpStatus: number;
  readonly actual: VerificationExecutionResult;
}

export interface NamedLiveVerificationAdapter {
  readonly name: string;
  readonly adapter: LiveVerificationAdapter;
}

export interface DifferentialScenarioVerificationResult {
  readonly id: string;
  readonly passed: boolean;
  readonly diagnostics: readonly string[];
  readonly targets: Readonly<Record<string, LiveScenarioVerificationResult>>;
}

export interface LiveBenchmarkOptions {
  readonly warmupRequests: number;
  readonly measuredRequests: number;
  readonly concurrency: number;
  readonly clientRetryLimit?: number;
  readonly durationMs?: number;
}

export interface LiveBenchmarkResult {
  readonly scenarioId: string;
  readonly workload: "idempotent-replay" | "isolated-mutation" | "shared-record-conflict";
  readonly passed: boolean;
  readonly diagnostics: readonly string[];
  readonly options: LiveBenchmarkOptions;
  readonly metrics: {
    readonly requests: number;
    readonly attempts: number;
    readonly retryableConflicts: number;
    readonly durationMs: number;
    readonly throughputPerSecond: number;
    readonly latencyMs: {
      readonly min: number;
      readonly mean: number;
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
      readonly max: number;
    };
  };
  readonly samplesMs: readonly number[];
}

export class VerificationParseError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `AIR verification suite is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues.join("; ")}`,
    );
    this.name = "VerificationParseError";
  }
}

class ScenarioDomainError extends Error {
  constructor(
    readonly code: string,
    readonly definition: CommandErrorDefinition,
  ) {
    super(definition.message);
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSuite = ajv.compile<VerificationSuite>(verificationSchema);

function schemaIssue(error: ErrorObject): string {
  const property =
    error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string"
      ? `/${error.params.additionalProperty}`
      : "";
  return `${error.instancePath}${property || "/"}: ${error.message ?? "invalid value"}`;
}

export function parseVerificationSuite(source: string): VerificationSuite {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new VerificationParseError(document.errors.map((error) => error.message));
  }
  const value: unknown = document.toJS();
  if (!validateSuite(value)) {
    throw new VerificationParseError((validateSuite.errors ?? []).map(schemaIssue));
  }
  const ids = new Set<string>();
  const duplicateIssues: string[] = [];
  for (const [index, scenario] of value.scenarios.entries()) {
    if (ids.has(scenario.id)) duplicateIssues.push(`/scenarios/${index}/id: duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }
  if (duplicateIssues.length > 0) throw new VerificationParseError(duplicateIssues);
  return value;
}

function cloneState(state: VerificationState | undefined): VerificationState {
  return structuredClone(state ?? {});
}

function rows(state: VerificationState, entity: string): VerificationRecord[] {
  return (state[entity] ??= []);
}

function domainError(command: CommandDefinition, code: string): ScenarioDomainError {
  const definition = command.errors?.[code];
  if (!definition) throw new Error(`Command declares no error ${code}.`);
  return new ScenarioDomainError(code, definition);
}

function commandValue(reference: CommandValueReference, input: VerificationRecord): unknown {
  return "input" in reference ? input[reference.input] : reference.literal;
}

function invariantOperand(
  operand: InvariantOperand,
  input: VerificationRecord,
  record: VerificationRecord | undefined,
  principal: VerificationRecord | undefined,
  namedRecords: Readonly<Record<string, VerificationRecord>> = {},
): unknown {
  if ("input" in operand) return input[operand.input];
  if ("record" in operand) {
    return typeof operand.record === "string"
      ? record?.[operand.record]
      : namedRecords[operand.record.effect]?.[operand.record.field];
  }
  if ("principal" in operand) return principal?.[operand.principal];
  return operand.literal;
}

function invariantValue(
  expression: InvariantExpression,
  input: VerificationRecord,
  record: VerificationRecord | undefined,
  principal: VerificationRecord | undefined,
  namedRecords: Readonly<Record<string, VerificationRecord>> = {},
): boolean {
  if ("all" in expression) return expression.all.every((child) => invariantValue(child, input, record, principal, namedRecords));
  if ("any" in expression) return expression.any.some((child) => invariantValue(child, input, record, principal, namedRecords));
  if ("not" in expression) return !invariantValue(expression.not, input, record, principal, namedRecords);
  const left = invariantOperand(expression.left, input, record, principal, namedRecords) as ConstraintValue;
  const right = invariantOperand(expression.right, input, record, principal, namedRecords) as ConstraintValue;
  switch (expression.operator) {
    case "equals": return left === right;
    case "not-equals": return left !== right;
    case "greater-than": return (left as number) > (right as number);
    case "greater-than-or-equal": return (left as number) >= (right as number);
    case "less-than": return (left as number) < (right as number);
    case "less-than-or-equal": return (left as number) <= (right as number);
  }
}

function checkInvariants(
  command: CommandDefinition,
  input: VerificationRecord,
  record: VerificationRecord | undefined,
  principal: VerificationRecord | undefined,
  namedRecords: Readonly<Record<string, VerificationRecord>> = {},
): void {
  for (const invariant of command.invariants ?? []) {
    if (!invariantValue(invariant.condition, input, record, principal, namedRecords)) {
      throw domainError(command, invariant.error);
    }
  }
}

function defaultUuid(entity: string, field: string, sequence: number): string {
  void entity;
  void field;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function generatedValue(
  entityName: string,
  fieldName: string,
  field: FieldDefinition,
  state: VerificationState,
  sequence: number,
  options: VerificationExecutionOptions,
): unknown {
  switch (field.generated) {
    case "uuid": return (options.generateUuid ?? defaultUuid)(entityName, fieldName, sequence);
    case "created-at":
    case "updated-at": return options.now ?? "2026-01-01T00:00:00.000Z";
    case "auto-increment": {
      const values = rows(state, entityName).map((row) => row[fieldName]).filter((value): value is number => typeof value === "number");
      return Math.max(0, ...values) + 1;
    }
    case undefined: return undefined;
  }
}

function createRecord(
  entityName: string,
  entity: EntityDefinition,
  effect: CommandCreateEffect,
  input: VerificationRecord,
  state: VerificationState,
  options: VerificationExecutionOptions,
): VerificationRecord {
  const result: VerificationRecord = {};
  let sequence = rows(state, entityName).length + 1;
  for (const [fieldName, field] of Object.entries(entity.fields)) {
    const assignment = effect.values[fieldName];
    if (assignment && !("increment" in assignment) && !("decrement" in assignment)) {
      result[fieldName] = commandValue(assignment, input);
    }
    else if (field.generated) result[fieldName] = generatedValue(entityName, fieldName, field, state, sequence++, options);
    else if (field.default !== undefined) result[fieldName] = field.default;
    else if (field.nullable) result[fieldName] = null;
  }
  rows(state, entityName).push(result);
  return result;
}

function outputRecord(command: CommandDefinition, record: VerificationRecord): VerificationRecord {
  return Object.fromEntries(command.output.fields.map((field) => [field, record[field]]));
}

function applyAssignments(
  record: VerificationRecord,
  assignments: Readonly<Record<string, CommandAssignment>>,
  input: VerificationRecord,
): void {
  for (const [field, assignment] of Object.entries(assignments)) {
    if ("increment" in assignment || "decrement" in assignment) {
      const change = "increment" in assignment ? assignment.increment : assignment.decrement;
      const amount = typeof change === "number" ? change : input[change.input] as number;
      record[field] = (record[field] as number) + ("increment" in assignment ? amount : -amount);
    } else {
      record[field] = commandValue(assignment, input);
    }
  }
}

export function executeVerificationScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  options: VerificationExecutionOptions = {},
): VerificationExecutionResult {
  const initialState = cloneState(scenario.given.state);
  const workingState = cloneState(scenario.given.state);
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const input = scenario.given.input;
  const principal = scenario.given.principal;

  try {
    if (command.authorization) {
      if (!principal) throw domainError(command, command.authorization.unauthenticatedError);
      for (const rule of command.authorization.rules) {
        if (rule.kind === "input-equals-principal" && input[rule.input] !== principal[rule.principalField]) {
          throw domainError(command, rule.error);
        }
        if (rule.kind === "principal-field-in" &&
            !rule.values.includes(String(principal[rule.principalField]))) {
          throw domainError(command, rule.error);
        }
      }
    }

    if (command.idempotency) {
      const idempotency = command.idempotency;
      const existing = rows(workingState, idempotency.entity).find(
        (record) =>
          record[idempotency.field] === input[idempotency.input] &&
          record[idempotency.scopeField] === principal?.[idempotency.scopePrincipalField],
      );
      if (existing) {
        return { status: "success", output: outputRecord(command, existing), state: workingState };
      }
    }

    if (command.effect.kind === "create" && !command.effects) {
      checkInvariants(command, input, undefined, principal);
    }

    for (const guard of command.guards ?? []) {
      const expected = input[guard.value.input];
      if (!rows(workingState, guard.entity).some((record) => record[guard.field] === expected)) {
        throw domainError(command, guard.error);
      }
    }

    const entity = air.spec.entities[command.effect.entity];
    if (!entity) throw new Error(`Unknown effect entity ${command.effect.entity}.`);
    const namedRecords: Record<string, VerificationRecord> = {};
    for (const [effectName, effect] of Object.entries(command.effects ?? {})) {
      const identify = commandValue(effect.identify.value, input);
      const selected = rows(workingState, effect.entity).find(
        (record) => record[effect.identify.field] === identify,
      );
      if (!selected) throw domainError(command, effect.identify.error);
      namedRecords[effectName] = selected;
    }
    for (const rule of command.authorization?.rules ?? []) {
      if (
        rule.kind === "record-field-equals-principal" &&
        rule.effect &&
        namedRecords[rule.effect]?.[rule.field] !== principal?.[rule.principalField]
      ) {
        throw domainError(command, rule.error);
      }
    }
    if (command.effects) {
      checkInvariants(command, input, undefined, principal, namedRecords);
      for (const [effectName, effect] of Object.entries(command.effects)) {
        const selected = namedRecords[effectName];
        if (!selected) throw new Error(`Named effect ${effectName} was not selected.`);
        for (const precondition of effect.preconditions ?? []) {
          if (selected[precondition.field] !== commandValue(precondition.equals, input)) {
            throw domainError(command, precondition.error);
          }
        }
      }
      for (const [effectName, effect] of Object.entries(command.effects)) {
        const selected = namedRecords[effectName];
        if (!selected) throw new Error(`Named effect ${effectName} was not selected.`);
        applyAssignments(selected, effect.values, input);
      }
    }
    let result: VerificationRecord;
    if (command.effect.kind === "create") {
      result = createRecord(command.effect.entity, entity, command.effect, input, workingState, options);
    } else {
      const effect = command.effect;
      const identify = commandValue(effect.identify.value, input);
      result = rows(workingState, effect.entity).find(
        (record) => record[effect.identify.field] === identify,
      ) as VerificationRecord | undefined ?? (() => { throw domainError(command, effect.identify.error); })();

      for (const rule of command.authorization?.rules ?? []) {
        if (rule.kind === "record-field-equals-principal" && !rule.effect && result[rule.field] !== principal?.[rule.principalField]) {
          throw domainError(command, rule.error);
        }
      }
      checkInvariants(command, input, result, principal);
      for (const precondition of effect.preconditions ?? []) {
        if (result[precondition.field] !== commandValue(precondition.equals, input)) {
          throw domainError(command, precondition.error);
        }
      }
      if (effect.kind === "update") {
        applyAssignments(result, effect.values, input);
        for (const [fieldName, field] of Object.entries(entity.fields)) {
          if (field.generated === "updated-at") {
            result[fieldName] = options.now ?? "2026-01-01T00:00:00.000Z";
          }
        }
      } else {
        const records = rows(workingState, effect.entity);
        records.splice(records.indexOf(result), 1);
      }
    }
    return { status: "success", output: outputRecord(command, result), state: workingState };
  } catch (error) {
    if (!(error instanceof ScenarioDomainError)) throw error;
    return {
      status: "error",
      error: { code: error.code, status: error.definition.status, message: error.definition.message },
      state: initialState,
    };
  }
}

export function verifyScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  options: VerificationExecutionOptions = {},
): ScenarioVerificationResult {
  const actual = executeVerificationScenario(air, scenario, options);
  const diagnostics: string[] = [];
  if ("error" in scenario.expect) {
    if (actual.status !== "error") diagnostics.push(`Expected error ${scenario.expect.error}, but command succeeded.`);
    else if (actual.error.code !== scenario.expect.error) diagnostics.push(`Expected error ${scenario.expect.error}, received ${actual.error.code}.`);
  } else if (actual.status !== "success") {
    diagnostics.push(`Expected success, received error ${actual.error.code}.`);
  } else if (!isDeepStrictEqual(actual.output, scenario.expect.output)) {
    diagnostics.push(`Output mismatch: expected ${JSON.stringify(scenario.expect.output)}, received ${JSON.stringify(actual.output)}.`);
  }
  if (scenario.expect.state && !isDeepStrictEqual(actual.state, scenario.expect.state)) {
    diagnostics.push(`State mismatch: expected ${JSON.stringify(scenario.expect.state)}, received ${JSON.stringify(actual.state)}.`);
  }
  return { id: scenario.id, passed: diagnostics.length === 0, diagnostics, actual };
}

export function verifySuite(
  air: AirDocument,
  suite: VerificationSuite,
  options: VerificationExecutionOptions = {},
): readonly ScenarioVerificationResult[] {
  return suite.scenarios.map((scenario) => verifyScenario(air, scenario, options));
}

const GENERATED_MARKER = "__AIR_VALID_GENERATED_VALUE__";

function isRecord(value: unknown): value is VerificationRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGeneratedValue(field: FieldDefinition, value: unknown): boolean {
  switch (field.generated) {
    case "uuid":
      return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    case "created-at":
    case "updated-at":
      return (typeof value === "string" && Number.isFinite(Date.parse(value))) || value instanceof Date;
    case "auto-increment":
      return typeof value === "number" && Number.isInteger(value);
    case undefined:
      return false;
    default:
      return false;
  }
}

function comparableRecord(
  air: AirDocument,
  entityName: string,
  record: VerificationRecord,
  generatedFields: ReadonlySet<string> = new Set(),
): VerificationRecord {
  const entity = air.spec.entities[entityName];
  if (!entity) return record;
  return Object.fromEntries(Object.entries(record).map(([fieldName, value]) => {
    const field = entity.fields[fieldName];
    if (generatedFields.has(fieldName) && field?.generated && validGeneratedValue(field, value)) {
      return [fieldName, GENERATED_MARKER];
    }
    return [fieldName, value instanceof Date ? value.toISOString() : value];
  }));
}

function comparableState(
  air: AirDocument,
  state: VerificationState,
  generatedEntity: string,
  generatedFields: ReadonlySet<string>,
): VerificationState {
  return Object.fromEntries(Object.entries(state).map(([entityName, records]) => {
    const entity = air.spec.entities[entityName];
    const primaryField = entity
      ? Object.entries(entity.fields).find(([, field]) => field.primaryKey)?.[0]
      : undefined;
    const normalized = records.map((record) => comparableRecord(
      air,
      entityName,
      record,
      entityName === generatedEntity ? generatedFields : new Set(),
    ));
    if (primaryField) normalized.sort((left, right) => String(left[primaryField]).localeCompare(String(right[primaryField])));
    return [entityName, normalized];
  }));
}

function liveExecutionResult(
  command: CommandDefinition,
  response: LiveInvocationResult,
  state: VerificationState,
): VerificationExecutionResult {
  if (response.status >= 200 && response.status < 300 && isRecord(response.body)) {
    return { status: "success", output: response.body, state };
  }
  const body = isRecord(response.body) ? response.body : {};
  const error = isRecord(body.error) ? body.error : {};
  const code = typeof error.code === "string" ? error.code : "INVALID_ERROR_RESPONSE";
  const definition = command.errors?.[code];
  return {
    status: "error",
    error: {
      code,
      status: response.status,
      message: typeof error.message === "string" ? error.message : definition?.message ?? "Invalid error response.",
    },
    state,
  };
}

export async function verifyLiveScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  adapter: LiveVerificationAdapter,
): Promise<LiveScenarioVerificationResult> {
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const operation = (air.spec.http?.operations ?? []).find(
    (candidate) => "command" in candidate && candidate.command === scenario.command,
  );
  if (!operation) throw new Error(`Command ${scenario.command} has no HTTP operation for live verification.`);

  await adapter.reset(scenario);
  const response = await adapter.invoke(scenario, { method: operation.method, path: operation.path });
  const expectedState = scenario.expect.state;
  const state = await adapter.readState(expectedState ? Object.keys(expectedState) : []);
  const actual = liveExecutionResult(command, response, state);
  const diagnostics: string[] = [];
  const outputEntity = air.spec.entities[command.output.entity];
  const effectValues = command.effect.kind === "delete" ? {} : command.effect.values;
  const generatedFields = new Set(Object.entries(outputEntity?.fields ?? {})
    .filter(([fieldName, field]) => field.generated !== undefined && !(fieldName in effectValues))
    .map(([fieldName]) => fieldName));

  if ("error" in scenario.expect) {
    const expectedError = command.errors?.[scenario.expect.error];
    if (actual.status !== "error") diagnostics.push(`Expected error ${scenario.expect.error}, but command succeeded.`);
    else {
      if (actual.error.code !== scenario.expect.error) diagnostics.push(`Expected error ${scenario.expect.error}, received ${actual.error.code}.`);
      if (expectedError && actual.error.status !== expectedError.status) diagnostics.push(`Expected HTTP ${expectedError.status}, received ${actual.error.status}.`);
    }
  } else if (actual.status !== "success") {
    diagnostics.push(`Expected success, received error ${actual.error.code}.`);
  } else {
    const expectedOutput = comparableRecord(air, command.output.entity, scenario.expect.output, generatedFields);
    const actualOutput = comparableRecord(air, command.output.entity, actual.output, generatedFields);
    if (!isDeepStrictEqual(actualOutput, expectedOutput)) {
      diagnostics.push(`Output mismatch: expected ${JSON.stringify(expectedOutput)}, received ${JSON.stringify(actualOutput)}.`);
    }
  }

  if (expectedState) {
    const comparableActual = comparableState(air, actual.state, command.output.entity, generatedFields);
    const comparableExpected = comparableState(air, expectedState, command.output.entity, generatedFields);
    if (!isDeepStrictEqual(comparableActual, comparableExpected)) {
      diagnostics.push(`State mismatch: expected ${JSON.stringify(comparableExpected)}, received ${JSON.stringify(comparableActual)}.`);
    }
  }

  return { id: scenario.id, passed: diagnostics.length === 0, diagnostics, httpStatus: response.status, actual };
}

export async function verifyLiveSuite(
  air: AirDocument,
  suite: VerificationSuite,
  adapter: LiveVerificationAdapter,
): Promise<readonly LiveScenarioVerificationResult[]> {
  const results: LiveScenarioVerificationResult[] = [];
  for (const scenario of suite.scenarios) results.push(await verifyLiveScenario(air, scenario, adapter));
  return results;
}

function comparableLiveResult(
  air: AirDocument,
  scenario: VerificationScenario,
  result: LiveScenarioVerificationResult,
): unknown {
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const outputEntity = air.spec.entities[command.output.entity];
  const effectValues = command.effect.kind === "delete" ? {} : command.effect.values;
  const generatedFields = new Set(Object.entries(outputEntity?.fields ?? {})
    .filter(([fieldName, field]) => field.generated !== undefined && !(fieldName in effectValues))
    .map(([fieldName]) => fieldName));
  const state = comparableState(air, result.actual.state, command.output.entity, generatedFields);
  return result.actual.status === "success"
    ? {
        status: result.actual.status,
        httpStatus: result.httpStatus,
        output: comparableRecord(air, command.output.entity, result.actual.output, generatedFields),
        state,
      }
    : {
        status: result.actual.status,
        httpStatus: result.httpStatus,
        error: result.actual.error,
        state,
      };
}

export async function verifyDifferentialSuite(
  air: AirDocument,
  suite: VerificationSuite,
  targets: readonly NamedLiveVerificationAdapter[],
): Promise<readonly DifferentialScenarioVerificationResult[]> {
  if (targets.length < 2) throw new Error("Differential verification requires at least two targets.");
  const names = new Set<string>();
  for (const target of targets) {
    if (names.has(target.name)) throw new Error(`Duplicate differential target name ${target.name}.`);
    names.add(target.name);
  }

  const results: DifferentialScenarioVerificationResult[] = [];
  for (const scenario of suite.scenarios) {
    const targetResults = await Promise.all(targets.map(async (target) => [
      target.name,
      await verifyLiveScenario(air, scenario, target.adapter),
    ] as const));
    const byTarget = Object.fromEntries(targetResults);
    const diagnostics: string[] = [];
    for (const [name, result] of targetResults) {
      for (const diagnostic of result.diagnostics) diagnostics.push(`${name}: ${diagnostic}`);
    }
    const [baselineName, baselineResult] = targetResults[0]!;
    const baseline = comparableLiveResult(air, scenario, baselineResult);
    for (const [name, result] of targetResults.slice(1)) {
      const actual = comparableLiveResult(air, scenario, result);
      if (!isDeepStrictEqual(actual, baseline)) {
        diagnostics.push(`Differential mismatch between ${baselineName} and ${name}: ${JSON.stringify(baseline)} != ${JSON.stringify(actual)}.`);
      }
    }
    results.push({
      id: scenario.id,
      passed: diagnostics.length === 0,
      diagnostics,
      targets: byTarget,
    });
  }
  return results;
}

function percentile(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]!;
}

function replayScenario(air: AirDocument, scenario: VerificationScenario): boolean {
  const command = air.spec.commands?.[scenario.command];
  const idempotency = command?.idempotency;
  if (!idempotency) return false;
  return (scenario.given.state?.[idempotency.entity] ?? []).some((record) =>
    record[idempotency.field] === scenario.given.input[idempotency.input] &&
    record[idempotency.scopeField] === scenario.given.principal?.[idempotency.scopePrincipalField]
  );
}

async function requestBatch(
  count: number,
  concurrency: number,
  request: (index: number) => Promise<number>,
): Promise<readonly number[]> {
  const samples = new Array<number>(count);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (cursor < count) {
      const index = cursor++;
      samples[index] = await request(index);
    }
  }));
  return samples;
}

async function requestForDuration(
  durationMs: number,
  concurrency: number,
  request: (index: number) => Promise<number>,
): Promise<readonly number[]> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Benchmark durationMs must be positive.");
  const samples: number[] = [];
  let cursor = 0;
  const deadline = performance.now() + durationMs;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const index = cursor++;
      samples[index] = await request(index);
    }
  }));
  return samples;
}

export async function benchmarkLiveScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  adapter: LiveVerificationAdapter,
  options: LiveBenchmarkOptions,
): Promise<LiveBenchmarkResult> {
  if (!Number.isInteger(options.warmupRequests) || options.warmupRequests < 0) throw new Error("Benchmark warmupRequests must be a non-negative integer.");
  if (!Number.isInteger(options.measuredRequests) || options.measuredRequests < 1) throw new Error("Benchmark measuredRequests must be a positive integer.");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("Benchmark concurrency must be a positive integer.");
  if (!replayScenario(air, scenario)) throw new Error(`Benchmark scenario ${scenario.id} must begin in an idempotent replay state.`);
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const operation = (air.spec.http?.operations ?? []).find(
    (candidate) => "command" in candidate && candidate.command === scenario.command,
  );
  if (!operation) throw new Error(`Command ${scenario.command} has no HTTP operation for live benchmarking.`);

  const baseline = await verifyLiveScenario(air, scenario, adapter);
  const diagnostics = baseline.diagnostics.map((diagnostic) => `Baseline: ${diagnostic}`);
  if (!baseline.passed) {
    return {
      scenarioId: scenario.id,
      workload: "idempotent-replay",
      passed: false,
      diagnostics,
      options,
      metrics: { requests: 0, attempts: 0, retryableConflicts: 0, durationMs: 0, throughputPerSecond: 0, latencyMs: { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 } },
      samplesMs: [],
    };
  }

  const expected = comparableLiveResult(air, scenario, baseline);
  const expectedStateNames = scenario.expect.state ? Object.keys(scenario.expect.state) : [];
  await adapter.reset(scenario);
  const invoke = async (): Promise<number> => {
    const started = performance.now();
    const response = await adapter.invoke(scenario, { method: operation.method, path: operation.path });
    const elapsed = performance.now() - started;
    const state = await adapter.readState([]);
    const actual = liveExecutionResult(command, response, state);
    const comparable = comparableLiveResult(air, scenario, {
      id: scenario.id,
      passed: true,
      diagnostics: [],
      httpStatus: response.status,
      actual,
    });
    const expectedWithoutState = { ...(expected as Record<string, unknown>), state: {} };
    if (!isDeepStrictEqual(comparable, expectedWithoutState)) {
      diagnostics.push(`Response mismatch during benchmark: ${JSON.stringify(comparable)}.`);
    }
    return elapsed;
  };

  await requestBatch(options.warmupRequests, options.concurrency, invoke);
  const started = performance.now();
  const samples = options.durationMs
    ? await requestForDuration(options.durationMs, options.concurrency, invoke)
    : await requestBatch(options.measuredRequests, options.concurrency, invoke);
  const durationMs = performance.now() - started;
  const finalState = await adapter.readState(expectedStateNames);
  if (scenario.expect.state) {
    const outputEntity = command.output.entity;
    const entity = air.spec.entities[outputEntity];
    const effectValues = command.effect.kind === "delete" ? {} : command.effect.values;
    const generatedFields = new Set(Object.entries(entity?.fields ?? {})
      .filter(([fieldName, field]) => field.generated !== undefined && !(fieldName in effectValues))
      .map(([fieldName]) => fieldName));
    if (!isDeepStrictEqual(
      comparableState(air, finalState, outputEntity, generatedFields),
      comparableState(air, scenario.expect.state, outputEntity, generatedFields),
    )) diagnostics.push("Persisted state changed during idempotent replay benchmark.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  return {
    scenarioId: scenario.id,
    workload: "idempotent-replay",
    passed: diagnostics.length === 0,
    diagnostics,
    options,
    metrics: {
      requests: samples.length,
      attempts: samples.length,
      retryableConflicts: 0,
      durationMs,
      throughputPerSecond: samples.length / (durationMs / 1000),
      latencyMs: {
        min: sorted[0]!,
        mean,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.at(-1)!,
      },
    },
    samplesMs: samples,
  };
}

function deterministicBenchmarkUuid(requestIndex: number, valueIndex: number): string {
  const suffix = String((requestIndex + 1) * 100 + valueIndex).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

function replaceScenarioValues(value: unknown, replacements: ReadonlyMap<unknown, unknown>): unknown {
  if (replacements.has(value)) return replacements.get(value);
  if (Array.isArray(value)) return value.map((child) => replaceScenarioValues(child, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, replaceScenarioValues(child, replacements)]));
  }
  return value;
}

function mutationScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  requestIndex: number,
): VerificationScenario {
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const contract = air.spec.contracts?.[command.input];
  if (!contract) throw new Error(`Command ${scenario.command} references unknown contract ${command.input}.`);
  const principalValues = new Set(Object.values(scenario.given.principal ?? {}));
  const replacements = new Map<unknown, unknown>();
  let valueIndex = 1;
  for (const [fieldName, field] of Object.entries(contract.fields)) {
    const value = scenario.given.input[fieldName];
    if (field.type !== "uuid" || typeof value !== "string" || principalValues.has(value) || replacements.has(value)) continue;
    replacements.set(value, deterministicBenchmarkUuid(requestIndex, valueIndex++));
  }
  return replaceScenarioValues(scenario, replacements) as VerificationScenario;
}

function combinedState(states: readonly VerificationState[]): VerificationState {
  const result: Record<string, VerificationRecord[]> = {};
  for (const state of states) {
    for (const [entityName, records] of Object.entries(state)) {
      (result[entityName] ??= []).push(...structuredClone(records));
    }
  }
  return result;
}

export async function benchmarkMutationScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  adapter: LiveVerificationAdapter,
  options: LiveBenchmarkOptions,
): Promise<LiveBenchmarkResult> {
  if (!Number.isInteger(options.warmupRequests) || options.warmupRequests < 0) throw new Error("Benchmark warmupRequests must be a non-negative integer.");
  if (!Number.isInteger(options.measuredRequests) || options.measuredRequests < 1) throw new Error("Benchmark measuredRequests must be a positive integer.");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("Benchmark concurrency must be a positive integer.");
  if ("error" in scenario.expect) throw new Error(`Mutation benchmark scenario ${scenario.id} must expect success.`);
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const operation = (air.spec.http?.operations ?? []).find(
    (candidate) => "command" in candidate && candidate.command === scenario.command,
  );
  if (!operation) throw new Error(`Command ${scenario.command} has no HTTP operation for live benchmarking.`);

  const baseline = await verifyLiveScenario(air, scenario, adapter);
  const diagnostics = baseline.diagnostics.map((diagnostic) => `Baseline: ${diagnostic}`);
  if (!baseline.passed) {
    return {
      scenarioId: scenario.id,
      workload: "isolated-mutation",
      passed: false,
      diagnostics,
      options,
      metrics: { requests: 0, attempts: 0, retryableConflicts: 0, durationMs: 0, throughputPerSecond: 0, latencyMs: { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 } },
      samplesMs: [],
    };
  }

  const total = options.warmupRequests + options.measuredRequests;
  const scenarios = Array.from({ length: total }, (_, index) => mutationScenario(air, scenario, index));
  const canonical = scenarios.map((variant) => executeVerificationScenario(air, variant));
  if (canonical.some((result) => result.status !== "success")) {
    throw new Error(`Generated mutation fixtures for ${scenario.id} did not pass canonical execution.`);
  }
  const initialState = combinedState(scenarios.map((variant) => variant.given.state ?? {}));
  const expectedFinalState = combinedState(canonical.map((result) => result.state));
  const resetScenario: VerificationScenario = {
    ...scenarios[0]!,
    given: { ...scenarios[0]!.given, state: initialState },
  };
  await adapter.reset(resetScenario);

  const outputEntity = command.output.entity;
  const entity = air.spec.entities[outputEntity];
  const effectValues = command.effect.kind === "delete" ? {} : command.effect.values;
  const generatedFields = new Set(Object.entries(entity?.fields ?? {})
    .filter(([fieldName, field]) => field.generated !== undefined && !(fieldName in effectValues))
    .map(([fieldName]) => fieldName));
  const clientRetryLimit = options.clientRetryLimit ?? 20;
  if (!Number.isInteger(clientRetryLimit) || clientRetryLimit < 0) throw new Error("Benchmark clientRetryLimit must be a non-negative integer.");
  let attempts = 0;
  let retryableConflicts = 0;
  const invoke = async (index: number): Promise<number> => {
    const variant = scenarios[index]!;
    const expected = canonical[index]!;
    const started = performance.now();
    for (let clientAttempt = 0; clientAttempt <= clientRetryLimit; clientAttempt += 1) {
      attempts += 1;
      const response = await adapter.invoke(variant, { method: operation.method, path: operation.path });
      if (response.status === 409 && isRecord(response.body) && isRecord(response.body.error) && response.body.error.retryable === true && clientAttempt < clientRetryLimit) {
        retryableConflicts += 1;
        continue;
      }
      const elapsed = performance.now() - started;
      if (expected.status !== "success" || response.status !== baseline.httpStatus || !isRecord(response.body)) {
        diagnostics.push(`Request ${index} returned unexpected HTTP ${response.status} after ${clientAttempt + 1} client attempt(s).`);
        return elapsed;
      }
      if (!isDeepStrictEqual(
        comparableRecord(air, outputEntity, response.body, generatedFields),
        comparableRecord(air, outputEntity, expected.output, generatedFields),
      )) diagnostics.push(`Request ${index} output mismatch.`);
      return elapsed;
    }
    throw new Error("Unreachable mutation benchmark retry state.");
  };

  await requestBatch(options.warmupRequests, options.concurrency, invoke);
  attempts = 0;
  retryableConflicts = 0;
  const started = performance.now();
  const samples = await requestBatch(
    options.measuredRequests,
    options.concurrency,
    (index) => invoke(options.warmupRequests + index),
  );
  const durationMs = performance.now() - started;
  const finalState = await adapter.readState(Object.keys(expectedFinalState));
  if (!isDeepStrictEqual(
    comparableState(air, finalState, outputEntity, generatedFields),
    comparableState(air, expectedFinalState, outputEntity, generatedFields),
  )) diagnostics.push("Persisted state did not match the canonical aggregate mutation result.");
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  return {
    scenarioId: scenario.id,
    workload: "isolated-mutation",
    passed: diagnostics.length === 0,
    diagnostics,
    options,
    metrics: {
      requests: samples.length,
      attempts,
      retryableConflicts,
      durationMs,
      throughputPerSecond: samples.length / (durationMs / 1000),
      latencyMs: {
        min: sorted[0]!, mean, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99), max: sorted.at(-1)!,
      },
    },
    samplesMs: samples,
  };
}

function conflictScenario(air: AirDocument, scenario: VerificationScenario, requestIndex: number): VerificationScenario {
  const command = air.spec.commands?.[scenario.command];
  if (!command) throw new Error(`Scenario ${scenario.id} references unknown command ${scenario.command}.`);
  const contract = air.spec.contracts?.[command.input];
  if (!contract) throw new Error(`Command ${scenario.command} references unknown contract ${command.input}.`);
  const preservedInputs = new Set<string>();
  for (const effect of Object.values(command.effects ?? {})) {
    if ("input" in effect.identify.value) preservedInputs.add(effect.identify.value.input);
  }
  if (command.effect.kind !== "create" && "input" in command.effect.identify.value) preservedInputs.add(command.effect.identify.value.input);
  const principalValues = new Set(Object.values(scenario.given.principal ?? {}));
  const replacements = new Map<unknown, unknown>();
  let valueIndex = 1;
  for (const [fieldName, field] of Object.entries(contract.fields)) {
    const value = scenario.given.input[fieldName];
    if (field.type !== "uuid" || typeof value !== "string" || principalValues.has(value) || preservedInputs.has(fieldName) || replacements.has(value)) continue;
    replacements.set(value, deterministicBenchmarkUuid(requestIndex, valueIndex++));
  }
  return replaceScenarioValues(scenario, replacements) as VerificationScenario;
}

export async function benchmarkConflictScenario(
  air: AirDocument,
  scenario: VerificationScenario,
  adapter: LiveVerificationAdapter,
  options: LiveBenchmarkOptions,
): Promise<LiveBenchmarkResult> {
  if (!Number.isInteger(options.warmupRequests) || options.warmupRequests < 0) throw new Error("Benchmark warmupRequests must be a non-negative integer.");
  if (!Number.isInteger(options.measuredRequests) || options.measuredRequests < 2) throw new Error("Conflict benchmark measuredRequests must be at least two.");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 2) throw new Error("Conflict benchmark concurrency must be at least two.");
  if ("error" in scenario.expect) throw new Error(`Conflict benchmark scenario ${scenario.id} must expect success.`);
  const command = air.spec.commands?.[scenario.command];
  if (!command?.transaction?.conflictError) throw new Error(`Conflict benchmark command ${scenario.command} must declare transaction.conflictError.`);
  const conflictDefinition = command.errors?.[command.transaction.conflictError];
  if (!conflictDefinition) throw new Error(`Conflict benchmark command ${scenario.command} has no declared conflict error.`);
  if (Object.keys(command.effects ?? {}).length === 0) throw new Error(`Conflict benchmark command ${scenario.command} must select named records.`);
  const operation = (air.spec.http?.operations ?? []).find((candidate) => "command" in candidate && candidate.command === scenario.command);
  if (!operation) throw new Error(`Command ${scenario.command} has no HTTP operation for live benchmarking.`);
  const baseline = await verifyLiveScenario(air, scenario, adapter);
  const diagnostics = baseline.diagnostics.map((diagnostic) => `Baseline: ${diagnostic}`);
  if (!baseline.passed) {
    return { scenarioId: scenario.id, workload: "shared-record-conflict", passed: false, diagnostics, options, metrics: { requests: 0, attempts: 0, retryableConflicts: 0, durationMs: 0, throughputPerSecond: 0, latencyMs: { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 } }, samplesMs: [] };
  }
  const run = async (count: number, offset: number): Promise<{ samples: readonly number[]; successes: number; conflicts: number; attempts: number }> => {
    const variants = Array.from({ length: count }, (_, index) => conflictScenario(air, scenario, offset + index));
    let successes = 0;
    let conflicts = 0;
    let attempts = 0;
    const samples = await requestBatch(count, options.concurrency, async (index) => {
      const started = performance.now();
      attempts += 1;
      const response = await adapter.invoke(variants[index]!, { method: operation.method, path: operation.path });
      if (response.status === baseline.httpStatus) successes += 1;
      else if (response.status === conflictDefinition.status) {
        const returnedCode = isRecord(response.body) && isRecord(response.body.error) && typeof response.body.error.code === "string"
          ? response.body.error.code
          : undefined;
        if (returnedCode !== undefined && returnedCode !== command.transaction!.conflictError) {
          diagnostics.push(`Conflict request ${index} returned error ${returnedCode}; expected ${command.transaction!.conflictError}.`);
        } else {
          conflicts += 1;
        }
      }
      else diagnostics.push(`Conflict request ${index} returned unexpected HTTP ${response.status}: ${JSON.stringify(response.body)}.`);
      return performance.now() - started;
    });
    return { samples, successes, conflicts, attempts };
  };
  if (options.warmupRequests > 0) {
    await adapter.reset(scenario);
    await run(options.warmupRequests, 0);
  }
  await adapter.reset(scenario);
  const started = performance.now();
  const measured = await run(options.measuredRequests, options.warmupRequests);
  const durationMs = performance.now() - started;
  if (measured.successes !== 1) diagnostics.push(`Expected exactly one committed shared-record mutation, received ${measured.successes}.`);
  if (measured.successes + measured.conflicts !== options.measuredRequests) diagnostics.push("Not every conflict request produced a success or declared retryable conflict.");
  const state = await adapter.readState(Object.keys(scenario.expect.state ?? {}));
  const canonical = executeVerificationScenario(air, scenario);
  if (canonical.status === "success" && scenario.expect.state) {
    const withoutOutput = (value: VerificationState): VerificationState => Object.fromEntries(Object.entries(value).filter(([name]) => name !== command.output.entity));
    if (!isDeepStrictEqual(comparableState(air, withoutOutput(state), "", new Set()), comparableState(air, withoutOutput(canonical.state), "", new Set()))) diagnostics.push("Shared records did not match one canonical committed mutation.");
    const initialCount = (scenario.given.state?.[command.output.entity] ?? []).length;
    if ((state[command.output.entity] ?? []).length !== initialCount + 1) diagnostics.push("Conflict workload did not persist exactly one output record.");
  }
  const sorted = [...measured.samples].sort((left, right) => left - right);
  const mean = measured.samples.reduce((sum, sample) => sum + sample, 0) / measured.samples.length;
  return {
    scenarioId: scenario.id,
    workload: "shared-record-conflict",
    passed: diagnostics.length === 0,
    diagnostics,
    options,
    metrics: {
      requests: measured.samples.length,
      attempts: measured.attempts,
      retryableConflicts: measured.conflicts,
      durationMs,
      throughputPerSecond: measured.samples.length / (durationMs / 1000),
      latencyMs: { min: sorted[0]!, mean, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1)! },
    },
    samplesMs: measured.samples,
  };
}

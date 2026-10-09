import { readFile } from "node:fs/promises";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";
import {
  AIR_SCHEMA_V0_4,
  SYSTEM_SCHEMA_V0_1,
  DEPLOYMENT_SCHEMA_V0_1,
  type AirSystemDocument,
  type AirDeploymentDocument,
  type AirDocument,
} from "@air/schema";
import { AirParseError, AirValidationError, parseAir } from "./parser.js";
import type { ValidationIssue } from "./validation.js";

export type SystemValidationResult =
  | { readonly valid: true; readonly document: AirSystemDocument; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };
export type DeploymentValidationResult =
  | { readonly valid: true; readonly document: AirDeploymentDocument; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(AIR_SCHEMA_V0_4);
const validateSystemSchema = ajv.compile<AirSystemDocument>(SYSTEM_SCHEMA_V0_1);
const validateDeploymentSchema = ajv.compile<AirDeploymentDocument>(DEPLOYMENT_SCHEMA_V0_1);

function schemaIssue(error: ErrorObject): ValidationIssue {
  const property = error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string"
    ? `/${error.params.additionalProperty}`
    : "";
  return {
    kind: "schema",
    path: `${error.instancePath}${property}` || "/",
    code: `schema.${error.keyword}`,
    message: error.message ?? "does not satisfy the document schema",
  };
}

function semanticIssue(path: string, code: string, message: string): ValidationIssue {
  return { kind: "semantic", path, code, message };
}

export function validateSystem(value: unknown): SystemValidationResult {
  if (!validateSystemSchema(value)) return { valid: false, issues: (validateSystemSchema.errors ?? []).map(schemaIssue) };
  const issues: ValidationIssue[] = [];
  const applicationNames = new Set(Object.keys(value.spec.applications));
  const componentNames = new Set(Object.keys(value.spec.components));
  for (const [name, component] of Object.entries(value.spec.components)) {
    const path = `/spec/components/${name}`;
    if (!applicationNames.has(component.application)) issues.push(semanticIssue(`${path}/application`, "system.unknown_application", `Application ${component.application} is not declared.`));
    for (const [index, dependency] of (component.dependsOn ?? []).entries()) {
      if (!componentNames.has(dependency)) issues.push(semanticIssue(`${path}/dependsOn/${index}`, "system.unknown_component_dependency", `Component ${dependency} is not declared.`));
      if (dependency === name) issues.push(semanticIssue(`${path}/dependsOn/${index}`, "system.self_dependency", "A component cannot depend on itself."));
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, chain: readonly string[]): void => {
    if (visiting.has(name)) {
      issues.push(semanticIssue(`/spec/components/${name}/dependsOn`, "system.cyclic_topology", `Component dependency cycle: ${[...chain, name].join(" -> ")}.`));
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of value.spec.components[name]?.dependsOn ?? []) if (componentNames.has(dependency)) visit(dependency, [...chain, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of componentNames) visit(name, []);

  for (const [name, channel] of Object.entries(value.spec.channels ?? {})) {
    const path = `/spec/channels/${name}`;
    const [application] = channel.source.split(".");
    if (!applicationNames.has(application ?? "")) issues.push(semanticIssue(`${path}/source`, "system.channel_unknown_application", `Channel source application ${application ?? ""} is not declared.`));
    for (const [index, consumer] of channel.consumers.entries()) if (!componentNames.has(consumer)) issues.push(semanticIssue(`${path}/consumers/${index}`, "system.channel_unknown_consumer", `Consumer component ${consumer} is not declared.`));
  }

  for (const [name, saga] of Object.entries(value.spec.sagas ?? {})) {
    const path = `/spec/sagas/${name}`;
    if (!applicationNames.has(saga.trigger.application)) issues.push(semanticIssue(`${path}/trigger/application`, "saga.unknown_application", `Application ${saga.trigger.application} is not declared.`));
    const stepIds = new Set<string>();
    for (const [index, step] of saga.steps.entries()) {
      const stepPath = `${path}/steps/${index}`;
      if (stepIds.has(step.id)) issues.push(semanticIssue(`${stepPath}/id`, "saga.duplicate_step", `Saga step ${step.id} is duplicated.`));
      stepIds.add(step.id);
      if ("application" in step && !applicationNames.has(step.application)) issues.push(semanticIssue(`${stepPath}/application`, "saga.unknown_application", `Application ${step.application} is not declared.`));
      if (step.kind === "invoke" && step.compensate === step.command) issues.push(semanticIssue(`${stepPath}/compensate`, "saga.invalid_compensation", "A compensation command must differ from the forward command."));
    }
  }
  return issues.length > 0 ? { valid: false, issues } : { valid: true, document: value, issues: [] };
}

export function validateDeployment(value: unknown): DeploymentValidationResult {
  if (!validateDeploymentSchema(value)) return { valid: false, issues: (validateDeploymentSchema.errors ?? []).map(schemaIssue) };
  const issues: ValidationIssue[] = [];
  for (const [binding, resource] of Object.entries(value.spec.bindings)) {
    if (!value.spec.resources[resource]) issues.push(semanticIssue(`/spec/bindings/${binding}`, "deployment.unknown_resource", `Resource ${resource} is not declared.`));
  }
  return issues.length > 0 ? { valid: false, issues } : { valid: true, document: value, issues: [] };
}

function parseYaml(source: string, sourceName: string): unknown {
  try {
    return parse(source, { uniqueKeys: true });
  } catch (error) {
    throw new AirParseError(sourceName, error);
  }
}

export function parseSystem(source: string, sourceName = "<input>"): AirSystemDocument {
  const result = validateSystem(parseYaml(source, sourceName));
  if (!result.valid) throw new AirValidationError(sourceName, result.issues);
  return result.document;
}

export function parseDeployment(source: string, sourceName = "<input>"): AirDeploymentDocument {
  const result = validateDeployment(parseYaml(source, sourceName));
  if (!result.valid) throw new AirValidationError(sourceName, result.issues);
  return result.document;
}

export async function loadSystemFile(filePath: string): Promise<AirSystemDocument> {
  return parseSystem(await readFile(filePath, "utf8"), filePath);
}

export async function loadDeploymentFile(filePath: string): Promise<AirDeploymentDocument> {
  return parseDeployment(await readFile(filePath, "utf8"), filePath);
}

export type AirSourceDocument = AirDocument | AirSystemDocument | AirDeploymentDocument;

export async function loadAirSourceFile(filePath: string): Promise<AirSourceDocument> {
  const source = await readFile(filePath, "utf8");
  const value = parseYaml(source, filePath);
  const apiVersion = value !== null && typeof value === "object" && "apiVersion" in value
    ? (value as { readonly apiVersion?: unknown }).apiVersion
    : undefined;
  if (apiVersion === "air.dev/system/v0.1") return parseSystem(source, filePath);
  if (apiVersion === "air.dev/deployment/v0.1") return parseDeployment(source, filePath);
  return parseAir(source, filePath);
}

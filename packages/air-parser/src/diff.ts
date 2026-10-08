import { isDeepStrictEqual } from "node:util";
import type { AirDocument, EntityDefinition, EventDefinition, FieldDefinition } from "@air/schema";

export type AirChangeImpact = "safe" | "review" | "breaking";

export interface AirSemanticChange {
  readonly path: string;
  readonly kind: "added" | "removed" | "changed";
  readonly impact: AirChangeImpact;
  readonly summary: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface AirSemanticDiff {
  readonly format: "air.dev/semantic-diff/v0.1";
  readonly before: { readonly name: string; readonly apiVersion: string };
  readonly after: { readonly name: string; readonly apiVersion: string };
  readonly summary: Readonly<Record<AirChangeImpact, number>> & { readonly total: number };
  readonly changes: readonly AirSemanticChange[];
}

export interface AirEvolutionStep {
  readonly id: string;
  readonly action: string;
  readonly path: string;
  readonly impact: AirChangeImpact;
  readonly reversible: boolean;
  readonly requiresDataMigration: boolean;
  readonly description: string;
}

export interface AirEvolutionPlan {
  readonly format: "air.dev/schema-evolution-plan/v0.1";
  readonly application: string;
  readonly executable: boolean;
  readonly summary: AirSemanticDiff["summary"];
  readonly steps: readonly AirEvolutionStep[];
}

function change(
  changes: AirSemanticChange[],
  path: string,
  kind: AirSemanticChange["kind"],
  impact: AirChangeImpact,
  summary: string,
  before?: unknown,
  after?: unknown,
): void {
  changes.push({ path, kind, impact, summary, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
}

function fieldAdditionImpact(field: FieldDefinition): AirChangeImpact {
  return field.nullable || field.default !== undefined || field.generated !== undefined ? "safe" : "breaking";
}

function compareFields(
  entityName: string,
  before: EntityDefinition,
  after: EntityDefinition,
  changes: AirSemanticChange[],
): void {
  const names = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  for (const fieldName of [...names].sort()) {
    const left = before.fields[fieldName];
    const right = after.fields[fieldName];
    const path = `/spec/entities/${entityName}/fields/${fieldName}`;
    if (!left && right) {
      const impact = fieldAdditionImpact(right);
      change(changes, path, "added", impact, impact === "safe"
        ? `Add field ${entityName}.${fieldName} without requiring existing-row data.`
        : `Add required field ${entityName}.${fieldName}; existing rows require a backfill.`, undefined, right);
      continue;
    }
    if (left && !right) {
      change(changes, path, "removed", "breaking", `Remove field ${entityName}.${fieldName} and its stored data.`, left);
      continue;
    }
    if (!left || !right || isDeepStrictEqual(left, right)) continue;
    if (left.type !== right.type) {
      change(changes, `${path}/type`, "changed", "breaking", `Change ${entityName}.${fieldName} type from ${left.type} to ${right.type}.`, left.type, right.type);
    }
    if (left.nullable !== right.nullable) {
      const impact = left.nullable && !right.nullable ? "breaking" : "safe";
      change(changes, `${path}/nullable`, "changed", impact,
        impact === "breaking" ? `Make ${entityName}.${fieldName} non-null; null rows require a backfill.` : `Allow null values for ${entityName}.${fieldName}.`,
        left.nullable ?? false, right.nullable ?? false);
    }
    for (const property of ["primaryKey", "unique", "generated", "default", "validation"] as const) {
      if (!isDeepStrictEqual(left[property], right[property])) {
        const impact: AirChangeImpact = property === "validation" || property === "default" ? "review" : "breaking";
        change(changes, `${path}/${property}`, "changed", impact, `Change ${property} semantics for ${entityName}.${fieldName}.`, left[property], right[property]);
      }
    }
  }
}

function compareNamedObjects(
  root: string,
  label: string,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  changes: AirSemanticChange[],
): void {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].sort()) {
    const left = before[name];
    const right = after[name];
    const path = `${root}/${name}`;
    if (left === undefined) change(changes, path, "added", "safe", `Add ${label} ${name}.`, undefined, right);
    else if (right === undefined) change(changes, path, "removed", "breaking", `Remove ${label} ${name}.`, left);
    else if (!isDeepStrictEqual(left, right)) change(changes, path, "changed", "review", `Change ${label} ${name}; review its behavioral compatibility.`, left, right);
  }
}

function compareEvents(
  before: Readonly<Record<string, EventDefinition>>,
  after: Readonly<Record<string, EventDefinition>>,
  changes: AirSemanticChange[],
): void {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].sort()) {
    const left = before[name]; const right = after[name]; const path = `/spec/events/${name}`;
    if (!left && right) { change(changes, path, "added", "safe", `Add event ${name}.`, undefined, right); continue; }
    if (left && !right) { change(changes, path, "removed", "breaking", `Remove event ${name}; existing producers and consumers become incompatible.`, left); continue; }
    if (!left || !right || isDeepStrictEqual(left, right)) continue;
    if (left.kind !== right.kind) change(changes, `${path}/kind`, "changed", "breaking", `Change event ${name} from ${left.kind} to ${right.kind}.`, left.kind, right.kind);
    const leftMajor = Number(left.version.split(".")[0]); const rightMajor = Number(right.version.split(".")[0]);
    if (left.payload !== right.payload) change(changes, `${path}/payload`, "changed", rightMajor > leftMajor ? "review" : "breaking", rightMajor > leftMajor ? `Change event ${name} payload with a major schema-version bump; review consumer migration.` : `Change event ${name} payload without a major schema-version bump.`, left.payload, right.payload);
    if (left.version !== right.version) change(changes, `${path}/version`, "changed", rightMajor < leftMajor ? "breaking" : "review", `Change event ${name} schema version from ${left.version} to ${right.version}.`, left.version, right.version);
    if (left.description !== right.description) change(changes, `${path}/description`, "changed", "safe", `Change event ${name} documentation.`, left.description, right.description);
  }
}

export function diffAirDocuments(before: AirDocument, after: AirDocument): AirSemanticDiff {
  const changes: AirSemanticChange[] = [];
  if (before.metadata.name !== after.metadata.name) {
    change(changes, "/metadata/name", "changed", "breaking", "Change the stable application name.", before.metadata.name, after.metadata.name);
  }
  const entityNames = new Set([...Object.keys(before.spec.entities), ...Object.keys(after.spec.entities)]);
  for (const entityName of [...entityNames].sort()) {
    const left = before.spec.entities[entityName];
    const right = after.spec.entities[entityName];
    const path = `/spec/entities/${entityName}`;
    if (!left && right) {
      change(changes, path, "added", "safe", `Add entity ${entityName}.`, undefined, right);
    } else if (left && !right) {
      change(changes, path, "removed", "breaking", `Remove entity ${entityName} and its stored data.`, left);
    } else if (left && right) {
      compareFields(entityName, left, right, changes);
      compareNamedObjects(`${path}/relationships`, "relationship", left.relationships ?? {}, right.relationships ?? {}, changes);
    }
  }
  compareNamedObjects("/spec/contracts", "contract", before.spec.contracts ?? {}, after.spec.contracts ?? {}, changes);
  compareNamedObjects("/spec/principals", "principal", before.spec.principals ?? {}, after.spec.principals ?? {}, changes);
  compareNamedObjects("/spec/commands", "command", before.spec.commands ?? {}, after.spec.commands ?? {}, changes);
  compareEvents(before.spec.events ?? {}, after.spec.events ?? {}, changes);
  compareNamedObjects("/spec/tasks", "task", before.spec.tasks ?? {}, after.spec.tasks ?? {}, changes);
  compareNamedObjects("/spec/consumers", "consumer", before.spec.consumers ?? {}, after.spec.consumers ?? {}, changes);
  compareNamedObjects("/spec/schedules", "schedule", before.spec.schedules ?? {}, after.spec.schedules ?? {}, changes);
  compareNamedObjects("/spec/cachedReads", "cached read", before.spec.cachedReads ?? {}, after.spec.cachedReads ?? {}, changes);
  compareNamedObjects("/spec/realtime", "realtime channel", before.spec.realtime ?? {}, after.spec.realtime ?? {}, changes);
  const beforeOperations = Object.fromEntries((before.spec.http?.operations ?? []).map((operation) => [operation.id, operation]));
  const afterOperations = Object.fromEntries((after.spec.http?.operations ?? []).map((operation) => [operation.id, operation]));
  compareNamedObjects("/spec/http/operations", "HTTP operation", beforeOperations, afterOperations, changes);
  changes.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  const summary = {
    safe: changes.filter((item) => item.impact === "safe").length,
    review: changes.filter((item) => item.impact === "review").length,
    breaking: changes.filter((item) => item.impact === "breaking").length,
    total: changes.length,
  };
  return {
    format: "air.dev/semantic-diff/v0.1",
    before: { name: before.metadata.name, apiVersion: before.apiVersion },
    after: { name: after.metadata.name, apiVersion: after.apiVersion },
    summary,
    changes,
  };
}

function actionFor(change: AirSemanticChange): string {
  if (/^\/spec\/entities\/[^/]+$/.test(change.path)) return change.kind === "added" ? "create-entity" : "drop-entity";
  if (/\/fields\/[^/]+$/.test(change.path)) return change.kind === "added" ? "add-field" : "drop-field";
  if (change.path.endsWith("/type")) return "alter-field-type";
  if (change.path.endsWith("/nullable")) return "alter-field-nullability";
  return "review-semantic-change";
}

export function planAirEvolution(before: AirDocument, after: AirDocument): AirEvolutionPlan {
  const diff = diffAirDocuments(before, after);
  const steps = diff.changes.map((item, index): AirEvolutionStep => ({
    id: `step-${String(index + 1).padStart(3, "0")}`,
    action: actionFor(item),
    path: item.path,
    impact: item.impact,
    reversible: item.kind === "added" && item.impact === "safe",
    requiresDataMigration: item.impact === "breaking" && (/\/fields\//.test(item.path) || item.path.startsWith("/spec/entities/")),
    description: item.summary,
  }));
  return {
    format: "air.dev/schema-evolution-plan/v0.1",
    application: after.metadata.name,
    executable: steps.every((step) => step.impact === "safe"),
    summary: diff.summary,
    steps,
  };
}

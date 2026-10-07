import { stringify } from "yaml";
import {
  AIR_API_VERSION_V0_1,
  AIR_API_VERSION_V0_2,
  AIR_API_VERSION_V0_3,
  AIR_API_VERSION_V0_4,
  AIR_API_VERSION_V0_5,
  AIR_API_VERSION_V0_6,
  AIR_API_VERSION_V0_7,
  AIR_API_VERSION_V0_8,
  type AirDocument,
  type AirDocumentV0_2,
  type AirDocumentV0_3,
  type AirDocumentV0_4,
  type AirDocumentV0_5,
  type AirDocumentV0_6,
  type AirDocumentV0_7,
  type AirDocumentV0_8,
  type EntityDefinition,
} from "@air/schema";
import { validateAir } from "./validation.js";

export class AirMigrationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`AIR migration cannot continue (${problems.length} problem${problems.length === 1 ? "" : "s"}).`);
    this.name = "AirMigrationError";
    this.problems = problems;
  }
}

function migrateEntity(entityName: string, entity: EntityDefinition): EntityDefinition {
  if (!entity.fields.id) {
    throw new AirMigrationError([
      `${entityName} has no id field. Choose an explicit primary key before migrating to AIR v0.2.`,
    ]);
  }
  if (Object.keys(entity.relationships ?? {}).length > 0) {
    throw new AirMigrationError([
      `${entityName} has v0.1 relationships without explicit sourceField/targetField mappings. Add those mappings manually in v0.2.`,
    ]);
  }

  return {
    ...entity,
    fields: Object.fromEntries(
      Object.entries(entity.fields).map(([fieldName, field]) => [
        fieldName,
        {
          ...field,
          nullable: field.required !== true,
          ...(fieldName === "id" ? { primaryKey: true } : {}),
        },
      ]),
    ),
  };
}

export function migrateAirDocument(
  document: AirDocument,
  targetVersion:
    | typeof AIR_API_VERSION_V0_2
    | typeof AIR_API_VERSION_V0_3
    | typeof AIR_API_VERSION_V0_4
    | typeof AIR_API_VERSION_V0_5
    | typeof AIR_API_VERSION_V0_6
    | typeof AIR_API_VERSION_V0_7
    | typeof AIR_API_VERSION_V0_8 = AIR_API_VERSION_V0_8,
):
  | AirDocumentV0_2
  | AirDocumentV0_3
  | AirDocumentV0_4
  | AirDocumentV0_5
  | AirDocumentV0_6
  | AirDocumentV0_7
  | AirDocumentV0_8 {
  const versions = [
    AIR_API_VERSION_V0_1,
    AIR_API_VERSION_V0_2,
    AIR_API_VERSION_V0_3,
    AIR_API_VERSION_V0_4,
    AIR_API_VERSION_V0_5,
    AIR_API_VERSION_V0_6,
    AIR_API_VERSION_V0_7,
    AIR_API_VERSION_V0_8,
  ] as const;
  const sourceIndex = versions.indexOf(document.apiVersion);
  const targetIndex = versions.indexOf(targetVersion);
  if (sourceIndex < 0 || targetIndex < 1) {
    throw new AirMigrationError([`Unsupported migration ${String(document.apiVersion)} to ${String(targetVersion)}.`]);
  }
  if (targetIndex < sourceIndex) {
    throw new AirMigrationError([
      `AIR migrations do not support downgrading ${document.apiVersion} to ${targetVersion}.`,
    ]);
  }
  if (targetIndex === sourceIndex) {
    return document as
      | AirDocumentV0_2
      | AirDocumentV0_3
      | AirDocumentV0_4
      | AirDocumentV0_5
      | AirDocumentV0_6
      | AirDocumentV0_7
      | AirDocumentV0_8;
  }

  let entities = document.spec.entities;
  if (document.apiVersion === AIR_API_VERSION_V0_1) {
    const problems: string[] = [];
    const migratedEntities: Record<string, EntityDefinition> = {};
    for (const [entityName, entity] of Object.entries(document.spec.entities)) {
      try {
        migratedEntities[entityName] = migrateEntity(entityName, entity);
      } catch (error) {
        if (error instanceof AirMigrationError) problems.push(...error.problems);
        else throw error;
      }
    }
    if (problems.length > 0) throw new AirMigrationError(problems);
    entities = migratedEntities;
  }

  const migrated = {
    ...document,
    apiVersion: targetVersion,
    spec: { ...document.spec, entities },
  } as
    | AirDocumentV0_2
    | AirDocumentV0_3
    | AirDocumentV0_4
    | AirDocumentV0_5
    | AirDocumentV0_6
    | AirDocumentV0_7
    | AirDocumentV0_8;
  const validation = validateAir(migrated);
  if (!validation.valid) {
    throw new AirMigrationError(
      validation.issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`),
    );
  }
  return migrated;
}

export function serializeAir(document: AirDocument): string {
  return stringify(document, { indent: 2, lineWidth: 100 });
}

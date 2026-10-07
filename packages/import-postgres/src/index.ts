import postgres from "postgres";
import {
  AIR_API_VERSION,
  AIR_KIND,
  type AirDocument,
  type EntityDefinition,
  type FieldDefinition,
  type PrimitiveType,
  type RelationshipDefinition,
  type RelationshipDeleteBehavior,
} from "@air/schema";

export interface PostgresColumn {
  readonly tableName: string;
  readonly columnName: string;
  readonly dataType: string;
  readonly udtName: string;
  readonly nullable: boolean;
  readonly defaultExpression: string | null;
  readonly identity: boolean;
  readonly ordinal: number;
  readonly primaryKey: boolean;
  readonly unique: boolean;
}

export interface PostgresForeignKey {
  readonly constraintName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly targetTableName: string;
  readonly targetColumnName: string;
  readonly deleteRule: string;
}

export interface PostgresCatalog {
  readonly columns: readonly PostgresColumn[];
  readonly foreignKeys: readonly PostgresForeignKey[];
}

export interface ImportDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly databasePath: string;
}

export interface PostgresImportOptions {
  readonly applicationName: string;
  readonly displayName?: string;
  readonly schema?: string;
}

export interface PostgresImportResult {
  readonly air: AirDocument;
  readonly diagnostics: readonly ImportDiagnostic[];
}

function words(value: string): string[] {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part.toLowerCase());
}

function upperFirst(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function pascalCase(value: string): string {
  return words(value).map(upperFirst).join("");
}

function camelCase(value: string): string {
  return words(value).map((part, index) => index === 0 ? part : upperFirst(part)).join("");
}

function singular(value: string): string {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/i.test(value)) return value.slice(0, -2);
  if (/s$/i.test(value) && !/ss$/i.test(value)) return value.slice(0, -1);
  return value;
}

function entityName(table: string): string {
  return pascalCase(singular(table));
}

function primitive(column: PostgresColumn): PrimitiveType | undefined {
  if (column.udtName === "uuid") return "uuid";
  if (["int2", "int4", "int8"].includes(column.udtName)) return "integer";
  if (["float4", "float8", "numeric", "money"].includes(column.udtName)) return "number";
  if (column.udtName === "bool") return "boolean";
  if (column.udtName === "date") return "date";
  if (["timestamp", "timestamptz"].includes(column.udtName)) return "datetime";
  if (["json", "jsonb"].includes(column.udtName)) return "json";
  if (["text", "varchar", "bpchar", "citext", "name", "inet"].includes(column.udtName)) return "string";
  return undefined;
}

function generated(column: PostgresColumn): FieldDefinition["generated"] {
  if (column.identity || /^nextval\(/i.test(column.defaultExpression ?? "")) return "auto-increment";
  if (/gen_random_uuid\(\)|uuid_generate_v4\(\)/i.test(column.defaultExpression ?? "")) return "uuid";
  if (/^(now\(\)|CURRENT_TIMESTAMP)$/i.test(column.defaultExpression ?? "") && /created/i.test(column.columnName)) {
    return "created-at";
  }
  if (/^(now\(\)|CURRENT_TIMESTAMP)$/i.test(column.defaultExpression ?? "") && /updated/i.test(column.columnName)) {
    return "updated-at";
  }
  return undefined;
}

function literalDefault(column: PostgresColumn): FieldDefinition["default"] {
  const expression = column.defaultExpression;
  if (!expression) return undefined;
  if (/^(true|false)$/i.test(expression)) return expression.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?(?:::[\w ]+)?$/.test(expression)) return Number(expression.split("::")[0]);
  const quoted = /^'((?:''|[^'])*)'(?:::[\w ]+)?$/.exec(expression);
  if (quoted) return quoted[1]?.replaceAll("''", "'");
  return undefined;
}

function deleteBehavior(rule: string): RelationshipDeleteBehavior {
  if (rule === "CASCADE") return "cascade";
  if (rule === "SET NULL") return "set-null";
  return "restrict";
}

export function importPostgresCatalog(
  catalog: PostgresCatalog,
  options: PostgresImportOptions,
): PostgresImportResult {
  const diagnostics: ImportDiagnostic[] = [];
  const grouped = new Map<string, PostgresColumn[]>();
  for (const column of catalog.columns) {
    const list = grouped.get(column.tableName) ?? [];
    list.push(column);
    grouped.set(column.tableName, list);
  }

  const entities: Record<string, EntityDefinition> = {};
  const tableEntities = new Map<string, string>();
  for (const table of [...grouped.keys()].sort()) {
    const name = entityName(table);
    if (!name || entities[name]) {
      diagnostics.push({
        severity: "error",
        code: "POSTGRES_ENTITY_NAME_COLLISION",
        message: `Table ${table} cannot be assigned a unique AIR entity name.`,
        databasePath: `${options.schema ?? "public"}.${table}`,
      });
      continue;
    }
    tableEntities.set(table, name);
    const primaryKeyColumns = (grouped.get(table) ?? []).filter((column) => column.primaryKey);
    if (primaryKeyColumns.length > 1) {
      diagnostics.push({
        severity: "error",
        code: "POSTGRES_COMPOSITE_PRIMARY_KEY_UNSUPPORTED",
        message: `Table ${table} uses a composite primary key, which AIR cannot represent yet.`,
        databasePath: `${options.schema ?? "public"}.${table}`,
      });
    }
    const fields: Record<string, FieldDefinition> = {};
    for (const column of [...(grouped.get(table) ?? [])].sort((a, b) => a.ordinal - b.ordinal)) {
      const type = primitive(column);
      const field = camelCase(column.columnName);
      if (!type) {
        diagnostics.push({
          severity: "warning",
          code: "POSTGRES_TYPE_APPROXIMATED_AS_JSON",
          message: `PostgreSQL type ${column.dataType} (${column.udtName}) was approximated as AIR json.`,
          databasePath: `${options.schema ?? "public"}.${table}.${column.columnName}`,
        });
      }
      const generatedValue = generated(column);
      const defaultValue = type ? literalDefault(column) : undefined;
      if (column.defaultExpression && generatedValue === undefined && defaultValue === undefined) {
        diagnostics.push({
          severity: "warning",
          code: "POSTGRES_DEFAULT_NOT_IMPORTED",
          message: `Default expression ${column.defaultExpression} has no portable AIR representation.`,
          databasePath: `${options.schema ?? "public"}.${table}.${column.columnName}`,
        });
      }
      fields[field] = {
        type: type ?? "json",
        ...(column.nullable ? { nullable: true } : {}),
        ...(column.primaryKey ? { primaryKey: true } : {}),
        ...(column.unique && !column.primaryKey ? { unique: true } : {}),
        ...(generatedValue ? { generated: generatedValue } : {}),
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      };
    }
    entities[name] = { fields };
  }

  const relationshipsByEntity = new Map<string, Record<string, RelationshipDefinition>>();
  for (const foreignKey of [...catalog.foreignKeys].sort((a, b) => a.constraintName.localeCompare(b.constraintName))) {
    const source = tableEntities.get(foreignKey.tableName);
    const target = tableEntities.get(foreignKey.targetTableName);
    if (!source || !target) continue;
    const sourceColumn = catalog.columns.find(
      (column) => column.tableName === foreignKey.tableName && column.columnName === foreignKey.columnName,
    );
    const relationships = relationshipsByEntity.get(source) ?? {};
    let relationshipName = camelCase(singular(foreignKey.targetTableName));
    if (relationships[relationshipName]) relationshipName = `${relationshipName}By${pascalCase(foreignKey.columnName)}`;
    relationships[relationshipName] = {
      target,
      cardinality: "many-to-one",
      sourceField: camelCase(foreignKey.columnName),
      targetField: camelCase(foreignKey.targetColumnName),
      required: sourceColumn ? !sourceColumn.nullable : true,
      onDelete: deleteBehavior(foreignKey.deleteRule),
    };
    relationshipsByEntity.set(source, relationships);
  }

  for (const [name, relationships] of relationshipsByEntity) {
    const entity = entities[name];
    if (entity) entities[name] = { ...entity, relationships };
  }

  const operations = [...tableEntities.entries()].flatMap(([table, entity]) => {
    const hasPrimaryKey = catalog.columns.some((column) => column.tableName === table && column.primaryKey);
    const path = `/${table.replaceAll("_", "-")}`;
    const base = [
      { id: `list${pascalCase(table)}`, method: "GET" as const, path, entity, action: "list" as const },
      { id: `create${entity}`, method: "POST" as const, path, entity, action: "create" as const },
    ];
    if (!hasPrimaryKey) {
      diagnostics.push({
        severity: "warning",
        code: "POSTGRES_TABLE_WITHOUT_PRIMARY_KEY",
        message: `Table ${table} has no primary key, so item CRUD operations were omitted.`,
        databasePath: `${options.schema ?? "public"}.${table}`,
      });
      return base;
    }
    return [
      ...base,
      { id: `read${entity}`, method: "GET" as const, path: `${path}/{id}`, entity, action: "read" as const },
      { id: `update${entity}`, method: "PATCH" as const, path: `${path}/{id}`, entity, action: "update" as const },
      { id: `delete${entity}`, method: "DELETE" as const, path: `${path}/{id}`, entity, action: "delete" as const },
    ];
  });

  return {
    air: {
      apiVersion: AIR_API_VERSION,
      kind: AIR_KIND,
      metadata: {
        name: options.applicationName,
        ...(options.displayName ? { displayName: options.displayName } : {}),
        description: `Imported from PostgreSQL schema ${options.schema ?? "public"}. Review import diagnostics before treating AIR as authoritative.`,
      },
      spec: { entities, http: { operations } },
    },
    diagnostics,
  };
}

export async function readPostgresCatalog(
  databaseUrl: string,
  schema = "public",
): Promise<PostgresCatalog> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const columns = await sql<{
      table_name: string; column_name: string; data_type: string; udt_name: string;
      is_nullable: "YES" | "NO"; column_default: string | null; is_identity: "YES" | "NO";
      ordinal_position: number; primary_key: boolean; is_unique: boolean;
    }[]>`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
             c.column_default, c.is_identity, c.ordinal_position,
             EXISTS (
               SELECT 1 FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema
                 AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
             ) AS primary_key,
             EXISTS (
               SELECT 1 FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
               WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = c.table_schema
                 AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
                 AND (SELECT count(*) FROM information_schema.key_column_usage members
                      WHERE members.constraint_schema = tc.constraint_schema
                        AND members.constraint_name = tc.constraint_name) = 1
             ) AS is_unique
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = ${schema} AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
    `;
    const foreignKeys = await sql<{
      constraint_name: string; table_name: string; column_name: string;
      target_table_name: string; target_column_name: string; delete_rule: string;
    }[]>`
      SELECT tc.constraint_name, tc.table_name, kcu.column_name,
             ccu.table_name AS target_table_name, ccu.column_name AS target_column_name,
             rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = ${schema}
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `;
    return {
      columns: columns.map((column) => ({
        tableName: column.table_name,
        columnName: column.column_name,
        dataType: column.data_type,
        udtName: column.udt_name,
        nullable: column.is_nullable === "YES",
        defaultExpression: column.column_default,
        identity: column.is_identity === "YES",
        ordinal: column.ordinal_position,
        primaryKey: column.primary_key,
        unique: column.is_unique,
      })),
      foreignKeys: foreignKeys.map((foreignKey) => ({
        constraintName: foreignKey.constraint_name,
        tableName: foreignKey.table_name,
        columnName: foreignKey.column_name,
        targetTableName: foreignKey.target_table_name,
        targetColumnName: foreignKey.target_column_name,
        deleteRule: foreignKey.delete_rule,
      })),
    };
  } finally {
    await sql.end();
  }
}

export async function importPostgres(
  databaseUrl: string,
  options: PostgresImportOptions,
): Promise<PostgresImportResult> {
  return importPostgresCatalog(
    await readPostgresCatalog(databaseUrl, options.schema ?? "public"),
    options,
  );
}

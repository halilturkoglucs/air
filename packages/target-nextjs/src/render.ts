import type {
  AirDocument,
  CommandAssignment,
  CommandDefinition,
  CommandValueReference,
  ContractDefinition,
  ContractFieldDefinition,
  CrudHttpOperation,
  EntityDefinition,
  FieldDefinition,
  HttpOperation,
  InvariantExpression,
  InvariantOperand,
} from "@air/schema";
import {
  camelCase,
  entityNames,
  kebabCase,
  pascalCase,
  routePathToDirectory,
  snakeCase,
  upperFirst,
} from "./naming.js";
import type { PlannedNextjsFile, ResolvedNextjsOptions } from "./types.js";

function withNewline(content: string): string {
  return `${content.trim()}\n`;
}

function planned(
  path: string,
  kind: PlannedNextjsFile["kind"],
  airNodes: readonly string[],
  content: string,
): PlannedNextjsFile {
  return { path, kind, airNodes, content: withNewline(content) };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function isCrudOperation(operation: HttpOperation): operation is CrudHttpOperation {
  return "entity" in operation;
}

function renderPackageJson(air: AirDocument, options: ResolvedNextjsOptions): string {
  return `${JSON.stringify(
    {
      name: air.metadata.name,
      version: air.metadata.version ?? "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        test: "vitest run",
        typecheck: "tsc --noEmit",
        "db:generate": "drizzle-kit generate",
        "db:migrate": "drizzle-kit migrate",
        "air:worker": "tsx src/air/runtime.ts worker",
        "air:scheduler": "tsx src/air/runtime.ts scheduler",
        "air:orchestrator": "tsx src/air/runtime.ts orchestrator",
        "air:realtime": "tsx src/air/runtime.ts realtime",
      },
      dependencies: {
        "drizzle-orm": "^0.44.0",
        ...(Object.keys(air.spec.principals ?? {}).length > 0 ? { jose: "^6.0.0" } : {}),
        next: `^${options.frameworkVersion}`,
        postgres: "^3.4.0",
        "@opentelemetry/api": "^1.9.0",
        ws: "^8.18.0",
        react: "^19.2.0",
        "react-dom": "^19.2.0",
      },
      devDependencies: {
        "@types/node": "^22.15.0",
        "@types/react": "^19.2.0",
        "@types/react-dom": "^19.2.0",
        "drizzle-kit": "^0.31.0",
        typescript: "^5.9.0",
        vitest: "^3.2.0",
        tsx: "^4.20.0",
        "@types/ws": "^8.18.0",
      },
      engines: { node: ">=20.9" },
      packageManager:
        options.packageManager === "pnpm"
          ? "pnpm@11.19.0"
          : options.packageManager === "npm"
            ? "npm@11"
            : undefined,
    },
    null,
    2,
  )}\n`;
}

function primaryField(entity: EntityDefinition): readonly [string, FieldDefinition] | undefined {
  return (
    Object.entries(entity.fields).find(([, field]) => field.primaryKey === true) ??
    (entity.fields.id ? ["id", entity.fields.id] : undefined)
  );
}

function owningRelationship(entity: EntityDefinition, fieldName: string) {
  return Object.values(entity.relationships ?? {}).find(
    (relationship) => relationship.sourceField === fieldName && relationship.targetField,
  );
}

function drizzleColumn(
  air: AirDocument,
  entity: EntityDefinition,
  fieldName: string,
  field: FieldDefinition,
): string {
  const sqlName = snakeCase(fieldName);
  let expression: string;
  switch (field.type) {
    case "string":
      expression =
        field.validation?.maxLength !== undefined
          ? `varchar(${json(sqlName)}, { length: ${field.validation.maxLength} })`
          : `text(${json(sqlName)})`;
      break;
    case "integer":
      expression =
        field.generated === "auto-increment"
          ? `serial(${json(sqlName)})`
          : `integer(${json(sqlName)})`;
      break;
    case "number":
      expression = `doublePrecision(${json(sqlName)})`;
      break;
    case "boolean":
      expression = `boolean(${json(sqlName)})`;
      break;
    case "uuid":
      expression = `uuid(${json(sqlName)})`;
      break;
    case "date":
      expression = `date(${json(sqlName)}, { mode: "string" })`;
      break;
    case "datetime":
      expression = `timestamp(${json(sqlName)}, { withTimezone: true, mode: "string" })`;
      break;
    case "json":
      expression = `jsonb(${json(sqlName)})`;
      break;
  }

  const relationship = owningRelationship(entity, fieldName);
  if (relationship?.targetField) {
    const targetTable = entityNames(relationship.target).pluralCamel;
    const onDelete = relationship.onDelete === "set-null" ? "set null" : relationship.onDelete;
    expression += `.references(() => ${targetTable}.${relationship.targetField}${
      onDelete ? `, { onDelete: ${json(onDelete)} }` : ""
    })`;
  }
  if (field.generated === "uuid") expression += ".defaultRandom()";
  if (field.generated === "created-at" || field.generated === "updated-at") {
    expression += ".defaultNow()";
  }
  if (field.generated === "updated-at") {
    expression += ".$onUpdate(() => new Date().toISOString())";
  }
  if (field.default !== undefined) expression += `.default(${json(field.default)})`;
  if (field.unique) expression += ".unique()";
  if (field.primaryKey) expression += ".primaryKey()";
  const notNull = air.apiVersion !== "air.dev/v0.1" ? field.nullable !== true : field.required === true;
  if (notNull && !field.primaryKey && field.generated !== "auto-increment") expression += ".notNull()";
  return `    ${fieldName}: ${expression},`;
}

function renderDatabaseSchema(air: AirDocument): string {
  const imports = new Set<string>(["pgTable"]);
  for (const entity of Object.values(air.spec.entities)) {
    for (const field of Object.values(entity.fields)) {
      imports.add(
        {
          string: field.validation?.maxLength !== undefined ? "varchar" : "text",
          integer: field.generated === "auto-increment" ? "serial" : "integer",
          number: "doublePrecision",
          boolean: "boolean",
          uuid: "uuid",
          date: "date",
          datetime: "timestamp",
          json: "jsonb",
        }[field.type],
      );
    }
  }

  const tables = Object.entries(air.spec.entities)
    .map(([entityName, entity]) => {
      const names = entityNames(entityName);
      const columns = Object.entries(entity.fields)
        .map(([fieldName, field]) => drizzleColumn(air, entity, fieldName, field))
        .join("\n");
      return `export const ${names.pluralCamel} = pgTable(${json(names.table)}, {\n${columns}\n});\n\nexport type ${names.pascal} = typeof ${names.pluralCamel}.$inferSelect;\nexport type New${names.pascal} = typeof ${names.pluralCamel}.$inferInsert;`;
    })
    .join("\n\n");

  return `import { ${[...imports].sort().join(", ")} } from "drizzle-orm/pg-core";\n\n${tables}`;
}

function renderAsyncMigration(): string {
  return `CREATE TABLE IF NOT EXISTS air_outbox (
  id UUID PRIMARY KEY, message_type TEXT NOT NULL, schema_version TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, producer TEXT NOT NULL, correlation_id UUID NOT NULL,
  causation_id UUID, ordering_key TEXT, payload JSONB NOT NULL,
  destination TEXT NOT NULL, message_kind TEXT NOT NULL CHECK (message_kind IN ('event','task')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS air_outbox_pending ON air_outbox (available_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS air_inbox (
  consumer TEXT NOT NULL, message_id UUID NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
CREATE TABLE IF NOT EXISTS air_dead_letters (
  id UUID PRIMARY KEY, consumer TEXT NOT NULL, envelope JSONB NOT NULL, attempts INTEGER NOT NULL,
  reason TEXT NOT NULL, failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS air_saga_instances (
  id UUID PRIMARY KEY, saga_type TEXT NOT NULL, correlation_id TEXT NOT NULL,
  state JSONB NOT NULL, status TEXT NOT NULL, current_step TEXT, version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (saga_type, correlation_id)
);
CREATE TABLE IF NOT EXISTS air_saga_timers (
  id UUID PRIMARY KEY, saga_id UUID NOT NULL REFERENCES air_saga_instances(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL, claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS air_realtime_journal (
  cursor BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL, envelope JSONB NOT NULL,
  ordering_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS air_realtime_channel_cursor ON air_realtime_journal (channel, cursor);`;
}

function renderAsyncRuntime(air: AirDocument): string {
  const definition = JSON.stringify({ application: air.metadata.name, commands: air.spec.commands ?? {}, events: air.spec.events ?? {}, tasks: air.spec.tasks ?? {}, consumers: air.spec.consumers ?? {}, schedules: air.spec.schedules ?? {}, cachedReads: air.spec.cachedReads ?? {}, realtime: air.spec.realtime ?? {} });
  return `import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { trace, metrics } from "@opentelemetry/api";
import { sql as statement } from "drizzle-orm";

export const AIR_ASYNC = ${definition} as const;
const tracer = trace.getTracer("air.runtime");
const meter = metrics.getMeter("air.runtime");
const deliveries = meter.createCounter("air.consumer.deliveries");
const retries = meter.createCounter("air.consumer.retries");
const connections = meter.createUpDownCounter("air.realtime.connections");

function database() { const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL is required."); return postgres(url, { prepare: false }); }
function mapped(reference: Record<string, unknown>, input: Record<string, unknown>, record: Record<string, unknown>, principal: Record<string, unknown>): unknown { if ("input" in reference) return input[String(reference.input)]; if ("literal" in reference) return reference.literal; if ("principal" in reference) return principal[String(reference.principal)]; const selected = reference.record as string | { field: string }; return record[typeof selected === "string" ? selected : selected.field]; }
export async function enqueueMessages(tx: { execute(query: unknown): Promise<unknown> }, commandName: keyof typeof AIR_ASYNC.commands, input: object, record: object, principal: object = {}): Promise<void> {
  const inputValues = input as Record<string, unknown>; const recordValues = record as Record<string, unknown>; const principalValues = principal as Record<string, unknown>;
  const command = AIR_ASYNC.commands[commandName] as { emits?: readonly any[]; enqueues?: readonly any[] };
  for (const [kind, messages] of [["event", command.emits ?? []], ["task", command.enqueues ?? []]] as const) for (const message of messages) {
    const name = message[kind]; const definition = (kind === "event" ? AIR_ASYNC.events : AIR_ASYNC.tasks)[name as never] as { version?: string };
    const id = randomUUID(); const correlationId = randomUUID(); const payload = Object.fromEntries(Object.entries(message.payload).map(([key, value]) => [key, mapped(value as Record<string, unknown>, inputValues, recordValues, principalValues)])); const orderingKey = message.key ? String(mapped(message.key, inputValues, recordValues, principalValues)) : null;
    await tx.execute(statement\`insert into air_outbox (id,message_type,schema_version,occurred_at,producer,correlation_id,ordering_key,payload,destination,message_kind) values (${"${id}"}::uuid,${"${name}"},${"${definition.version ?? \"1\"}"},now(),${"${AIR_ASYNC.application}"},${"${correlationId}"}::uuid,${"${orderingKey}"},${"${JSON.stringify(payload)}"}::jsonb,${"${name}"},${"${kind}"})\`);
    if (kind === "event") for (const [channelName, channel] of Object.entries(AIR_ASYNC.realtime as Record<string, { subscriptions: readonly { event: string }[] }>)) if (channel.subscriptions.some((subscription) => subscription.event === name)) await tx.execute(statement\`insert into air_realtime_journal (channel,envelope,ordering_key) values (${"${channelName}"},${"${JSON.stringify({ id, type: name, schemaVersion: definition.version ?? \"1\", producer: AIR_ASYNC.application, correlationId, orderingKey, payload })}"}::jsonb,${"${orderingKey}"})\`);
  }
}
async function publish(envelope: unknown, destination: string): Promise<void> {
  const provider = process.env.AIR_BROKER_PROVIDER ?? "postgres";
  if (provider === "postgres") { const sql = database(); try { await sql\`select pg_notify(${"${destination}"}, ${"${JSON.stringify(envelope)}"})\`; } finally { await sql.end(); } return; }
  const bridge = process.env.AIR_PROVIDER_BRIDGE_URL;
  if (!bridge) throw new Error(\`AIR_PROVIDER_BRIDGE_URL is required for ${"${provider}"}.\`);
  const response = await fetch(\`${"${bridge}"}/publish/${"${encodeURIComponent(destination)}"}\`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
  if (!response.ok) throw new Error(\`Provider publish failed with ${"${response.status}"}.\`);
}
async function worker(): Promise<never> {
  const sql = database();
  for (;;) {
    const rows = await sql.begin(async (tx) => tx\`select * from air_outbox where published_at is null and available_at <= now() order by occurred_at for update skip locked limit 100\`);
    for (const row of rows) await tracer.startActiveSpan("air.outbox.publish", async (span) => { try { await publish({ id: row.id, type: row.message_type, schemaVersion: row.schema_version, occurredAt: row.occurred_at, producer: row.producer, correlationId: row.correlation_id, causationId: row.causation_id, orderingKey: row.ordering_key, payload: row.payload }, row.destination); await sql\`update air_outbox set published_at=now() where id=${"${row.id}"}\`; deliveries.add(1, { destination: row.destination }); } catch (error) { retries.add(1, { destination: row.destination }); await sql\`update air_outbox set attempts=attempts+1, available_at=now()+make_interval(secs => least(300, power(2, attempts)::int)) where id=${"${row.id}"}\`; span.recordException(error as Error); } finally { span.end(); } });
    await new Promise((resolve) => setTimeout(resolve, rows.length ? 10 : 250));
  }
}
async function scheduler(): Promise<never> { for (;;) { console.log(JSON.stringify({ level: "info", event: "air.scheduler.tick", schedules: Object.keys(AIR_ASYNC.schedules), timestamp: new Date().toISOString() })); await new Promise((resolve) => setTimeout(resolve, 1000)); } }
async function orchestrator(): Promise<never> { const sql = database(); for (;;) { await sql\`update air_saga_timers set claimed_at=now() where id in (select id from air_saga_timers where completed_at is null and claimed_at is null and due_at <= now() for update skip locked limit 100)\`; await new Promise((resolve) => setTimeout(resolve, 250)); } }
async function realtime(): Promise<never> { const sql = database(); const server = new WebSocketServer({ port: Number(process.env.AIR_PORT ?? 3000) }); server.on("connection", (socket, request) => { connections.add(1); let cursor = Number(new URL(request.url ?? "/", "http://air.local").searchParams.get("cursor") ?? 0); const timer = setInterval(async () => { const frames = await sql\`select cursor,envelope from air_realtime_journal where cursor > ${"${cursor}"} order by cursor limit 100\`; for (const frame of frames) { if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "backpressure"); return; } socket.send(JSON.stringify({ cursor: frame.cursor, envelope: frame.envelope })); cursor = Number(frame.cursor); } }, 100); socket.on("close", () => { clearInterval(timer); connections.add(-1); }); }); return await new Promise<never>(() => undefined); }
const role = process.argv[2] ?? process.env.AIR_COMPONENT_ROLE ?? "worker";
if (role === "worker") await worker(); else if (role === "scheduler") await scheduler(); else if (role === "orchestrator") await orchestrator(); else if (role === "realtime") await realtime(); else throw new Error(\`Unknown AIR runtime role ${"${role}"}.\`);
void randomUUID;
`;
}

function validationOptions(field: FieldDefinition | ContractFieldDefinition): string {
  const validation = field.validation;
  if (!validation) return "undefined";
  const options: Record<string, unknown> = {};
  if (validation.minLength !== undefined) options.minLength = validation.minLength;
  if (validation.maxLength !== undefined) options.maxLength = validation.maxLength;
  if (validation.pattern !== undefined) options.pattern = validation.pattern;
  if (validation.minimum !== undefined) options.minimum = validation.minimum;
  if (validation.maximum !== undefined) options.maximum = validation.maximum;
  if (validation.enum !== undefined) options.allowed = validation.enum;
  return JSON.stringify(options);
}

function fieldParser(
  field: FieldDefinition | ContractFieldDefinition,
  value: string,
  label: string,
): string {
  const options = validationOptions(field);
  let parsed: string;
  switch (field.type) {
    case "string":
      parsed = `assertString(${value}, ${json(label)}, ${options})`;
      break;
    case "integer":
      parsed = `assertNumber(${value}, ${json(label)}, { ...${options}, integer: true })`;
      break;
    case "number":
      parsed = `assertNumber(${value}, ${json(label)}, ${options})`;
      break;
    case "boolean":
      parsed = `assertBoolean(${value}, ${json(label)}, ${options})`;
      break;
    case "uuid":
      parsed = `assertUuid(${value}, ${json(label)}, ${options})`;
      break;
    case "date":
      parsed = `assertDate(${value}, ${json(label)}, ${options})`;
      break;
    case "datetime":
      parsed = `assertDateTime(${value}, ${json(label)}, ${options})`;
      break;
    case "json":
      parsed = `assertJson(${value}, ${json(label)})`;
      break;
  }
  return field.nullable ? `(${value} === null ? null : ${parsed})` : parsed;
}

function renderEntityValidation(
  entityName: string,
  entity: EntityDefinition,
  filterFields: ReadonlySet<string> = new Set(),
): string {
  const names = entityNames(entityName);
  const primary = primaryField(entity);
  const primaryName = primary?.[0] ?? "id";
  const mutableFields = Object.entries(entity.fields)
    .filter(([fieldName, field]) => fieldName !== primaryName && field.generated === undefined)
    .map(([fieldName]) => fieldName);
  const mutableFieldUnion = mutableFields.length > 0 ? mutableFields.map(json).join(" | ") : "never";
  const assignments = Object.entries(entity.fields)
    .filter(([, field]) => field.generated === undefined && field.default === undefined)
    .map(([fieldName, field]) => {
      const parsed = fieldParser(field, `input[${json(fieldName)}]`, `${entityName}.${fieldName}`);
      if (field.required) {
        return `  result.${fieldName} = ${parsed};`;
      }
      return `  if (hasOwn(input, ${json(fieldName)})) result.${fieldName} = ${parsed};`;
    })
    .join("\n");

  const updateAssignments = Object.entries(entity.fields)
    .filter(([fieldName, field]) => fieldName !== primaryName && field.generated === undefined)
    .map(([fieldName, field]) => {
      const parsed = fieldParser(field, `input[${json(fieldName)}]`, `${entityName}.${fieldName}`);
      return `  if (hasOwn(input, ${json(fieldName)})) result.${fieldName} = ${parsed};`;
    })
    .join("\n");

  const idField = primary?.[1];
  const idValue = idField?.type === "integer" ? "Number(value)" : "value";
  const idParser = idField
    ? fieldParser(idField, idValue, `${entityName}.${primaryName}`)
    : `assertString(value, ${json(`${entityName}.${primaryName}`)})`;
  const filterParsers = [...filterFields].sort().map((fieldName) => {
    const field = entity.fields[fieldName];
    if (!field) return "";
    const value = field.type === "integer" || field.type === "number"
      ? "Number(value)"
      : field.type === "boolean"
        ? '(value === "true" ? true : value === "false" ? false : value)'
        : "value";
    return `export function parse${names.pascal}${pascalCase(fieldName)}Filter(value: string): ${names.pascal}[${json(fieldName)}] {
  return ${fieldParser(field, value, `${entityName}.${fieldName}`)} as ${names.pascal}[${json(fieldName)}];
}`;
  }).filter(Boolean).join("\n\n");

  return `import type { ${names.pascal}, New${names.pascal} } from "@/db/schema";
import {
  InputValidationError,
  asRecord,
  assertBoolean,
  assertDate,
  assertDateTime,
  assertJson,
  assertNumber,
  assertString,
  assertUuid,
  hasOwn,
} from "./input";

export type ${names.pascal}UpdateInput = Partial<Pick<New${names.pascal}, ${mutableFieldUnion}>>;

export function parse${names.pascal}Create(value: unknown): New${names.pascal} {
  const input = asRecord(value, ${json(entityName)});
  const result: Record<string, unknown> = {};
${assignments}
  return result as New${names.pascal};
}

export function parse${names.pascal}Update(value: unknown): ${names.pascal}UpdateInput {
  const input = asRecord(value, ${json(entityName)});
  const result: Record<string, unknown> = {};
${updateAssignments}
  if (Object.keys(result).length === 0) {
    throw new InputValidationError(${json(`${entityName} update must contain at least one mutable field.`)});
  }
  return result as ${names.pascal}UpdateInput;
}

export function parse${names.pascal}Id(value: string): ${names.pascal}[${json(primaryName)}] {
  return ${idParser} as ${names.pascal}[${json(primaryName)}];
}

${filterParsers}`;
}

function renderInputHelpers(): string {
  return `export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

type StringOptions = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly allowed?: readonly unknown[];
};

type NumberOptions = {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer?: boolean;
  readonly allowed?: readonly unknown[];
};

function assertAllowed(value: unknown, label: string, allowed?: readonly unknown[]): void {
  if (allowed && !allowed.includes(value)) {
    throw new InputValidationError(\`${"${label}"} must be one of: ${"${allowed.join(\", \")}"}.\`);
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError(\`${"${label}"} must be a JSON object.\`);
  }
  return value as Record<string, unknown>;
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new InputValidationError(\`${"${label}"} contains unknown field(s): ${"${unexpected.join(\", \")}"}.\`);
  }
}

export function assertString(value: unknown, label: string, options: StringOptions = {}): string {
  if (typeof value !== "string") throw new InputValidationError(\`${"${label}"} must be a string.\`);
  if (options.minLength !== undefined && value.length < options.minLength) {
    throw new InputValidationError(\`${"${label}"} must contain at least ${"${options.minLength}"} characters.\`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new InputValidationError(\`${"${label}"} must contain at most ${"${options.maxLength}"} characters.\`);
  }
  if (options.pattern !== undefined && !new RegExp(options.pattern).test(value)) {
    throw new InputValidationError(\`${"${label}"} has an invalid format.\`);
  }
  assertAllowed(value, label, options.allowed);
  return value;
}

export function assertNumber(value: unknown, label: string, options: NumberOptions = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputValidationError(\`${"${label}"} must be a finite number.\`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new InputValidationError(\`${"${label}"} must be an integer.\`);
  }
  if (options.minimum !== undefined && value < options.minimum) {
    throw new InputValidationError(\`${"${label}"} must be at least ${"${options.minimum}"}.\`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw new InputValidationError(\`${"${label}"} must be at most ${"${options.maximum}"}.\`);
  }
  assertAllowed(value, label, options.allowed);
  return value;
}

export function assertBoolean(value: unknown, label: string, options: { readonly allowed?: readonly unknown[] } = {}): boolean {
  if (typeof value !== "boolean") throw new InputValidationError(\`${"${label}"} must be a boolean.\`);
  assertAllowed(value, label, options.allowed);
  return value;
}

export function assertUuid(value: unknown, label: string, options: StringOptions = {}): string {
  const result = assertString(value, label, options);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new InputValidationError(\`${"${label}"} must be a UUID.\`);
  }
  return result;
}

export function assertDate(value: unknown, label: string, options: StringOptions = {}): string {
  const result = assertString(value, label, options);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(result) || Number.isNaN(Date.parse(\`${"${result}"}T00:00:00Z\`))) {
    throw new InputValidationError(\`${"${label}"} must be an ISO date.\`);
  }
  return result;
}

export function assertDateTime(value: unknown, label: string, options: StringOptions = {}): string {
  const result = assertString(value, label, options);
  if (Number.isNaN(Date.parse(result))) throw new InputValidationError(\`${"${label}"} must be an ISO date-time.\`);
  return result;
}

export function assertJson(value: unknown, label: string): unknown {
  if (value === undefined) throw new InputValidationError(\`${"${label}"} is required.\`);
  try {
    JSON.stringify(value);
  } catch {
    throw new InputValidationError(\`${"${label}"} must be JSON-serializable.\`);
  }
  return value;
}`;
}

function typescriptType(field: ContractFieldDefinition): string {
  const primitive = {
    string: "string",
    integer: "number",
    number: "number",
    boolean: "boolean",
    uuid: "string",
    date: "string",
    datetime: "string",
    json: "unknown",
  }[field.type];
  return field.nullable ? `${primitive} | null` : primitive;
}

function renderContracts(contracts: Readonly<Record<string, ContractDefinition>>): string {
  const blocks = Object.entries(contracts).map(([contractName, contract]) => {
    const typeName = pascalCase(contractName);
    const properties = Object.entries(contract.fields)
      .map(([fieldName, field]) => `  readonly ${fieldName}${field.required ? "" : "?"}: ${typescriptType(field)};`)
      .join("\n");
    const assignments = Object.entries(contract.fields)
      .map(([fieldName, field]) => {
        const parsed = fieldParser(field, `input[${json(fieldName)}]`, `${contractName}.${fieldName}`);
        return field.required
          ? `  result.${fieldName} = ${parsed};`
          : `  if (hasOwn(input, ${json(fieldName)})) result.${fieldName} = ${parsed};`;
      })
      .join("\n");
    const allowed = JSON.stringify(Object.keys(contract.fields));
    return `export interface ${typeName} {
${properties}
}

export function parse${typeName}(value: unknown): ${typeName} {
  const input = asRecord(value, ${json(contractName)});
  assertOnlyKeys(input, ${allowed}, ${json(contractName)});
  const result: Record<string, unknown> = {};
${assignments}
  return result as unknown as ${typeName};
}`;
  });

  return `import {
  asRecord,
  assertBoolean,
  assertDate,
  assertDateTime,
  assertJson,
  assertNumber,
  assertOnlyKeys,
  assertString,
  assertUuid,
  hasOwn,
} from "./input";

${blocks.join("\n\n")}`;
}

function renderDomainErrors(): string {
  return `export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function hasDatabaseErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}`;
}

function renderPrincipalAuthentication(air: AirDocument): string {
  const principals = Object.entries(air.spec.principals ?? {});
  const imports = principals
    .flatMap(([principalName]) => [
      `parse${pascalCase(principalName)}`,
      `type ${pascalCase(principalName)}`,
    ])
    .join(", ");
  const readers = principals
    .map(([principalName, principal]) => {
      const typeName = pascalCase(principalName);
      const claimNames = JSON.stringify(Object.keys(principal.fields));
      return `export async function authenticate${typeName}(request: Request): Promise<${typeName} | undefined> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const secret = process.env.AIR_AUTH_SECRET;
  if (!secret) throw new Error("AIR_AUTH_SECRET is required for authenticated AIR commands.");
  try {
    const { payload } = await jwtVerify(authorization.slice(7), new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
    });
    if (typeof payload.exp !== "number") return undefined;
    const claims = Object.fromEntries(
      ${claimNames}.filter((name) => payload[name] !== undefined).map((name) => [name, payload[name]]),
    );
    return parse${typeName}(claims);
  } catch {
    return undefined;
  }
}`;
    })
    .join("\n\n");

  return `import { jwtVerify } from "jose";
import { ${imports} } from "../domain/contracts";

${readers}`;
}

function commandReference(reference: CommandValueReference): string {
  return "input" in reference ? `input.${reference.input}` : json(reference.literal);
}

function commandAssignment(
  table: string,
  fieldName: string,
  assignment: CommandAssignment,
): string {
  if ("increment" in assignment || "decrement" in assignment) {
    const change = "increment" in assignment ? assignment.increment : assignment.decrement;
    const amount = typeof change === "number" ? String(change) : `\${input.${change.input}}`;
    const operator = "increment" in assignment ? "+" : "-";
    return `sql\`\${${table}.${fieldName}} ${operator} ${amount}\``;
  }
  return commandReference(assignment);
}

function renderedDomainError(commandName: string, command: CommandDefinition, code: string): string {
  const declared = command.errors?.[code];
  if (!declared) throw new Error(`Command ${commandName} has an undeclared error ${code}.`);
  return `new DomainError(${json(code)}, ${json(declared.message)}, ${declared.status}, ${declared.retryable ?? false})`;
}

function namedRecordVariable(effectName: string): string {
  return `record${pascalCase(effectName)}`;
}

function renderInvariantOperand(operand: InvariantOperand): string {
  if ("input" in operand) return `input.${operand.input}`;
  if ("record" in operand) {
    return typeof operand.record === "string"
      ? `current.${operand.record}`
      : `${namedRecordVariable(operand.record.effect)}.${operand.record.field}`;
  }
  if ("principal" in operand) return `principal.${operand.principal}`;
  return json(operand.literal);
}

function renderInvariantExpression(expression: InvariantExpression): string {
  if ("all" in expression) {
    return `(${expression.all.map(renderInvariantExpression).join(" && ")})`;
  }
  if ("any" in expression) {
    return `(${expression.any.map(renderInvariantExpression).join(" || ")})`;
  }
  if ("not" in expression) return `!(${renderInvariantExpression(expression.not)})`;
  const operator = {
    equals: "===",
    "not-equals": "!==",
    "greater-than": ">",
    "greater-than-or-equal": ">=",
    "less-than": "<",
    "less-than-or-equal": "<=",
  }[expression.operator];
  return `(${renderInvariantOperand(expression.left)} ${operator} ${renderInvariantOperand(expression.right)})`;
}

function renderMultiCommand(commandName: string, command: CommandDefinition): string {
  const namedEffects = Object.entries(command.effects ?? {});
  if (namedEffects.length === 0) throw new Error(`Command ${commandName} has no named effects.`);
  if (command.effect.kind !== "create") {
    throw new Error(`Next.js named effects currently require command ${commandName} to use a primary create effect.`);
  }
  const functionName = camelCase(commandName);
  const outputType = `${pascalCase(commandName)}Output`;
  const inputType = pascalCase(command.input);
  const principalType = command.authorization
    ? pascalCase(command.authorization.principal)
    : undefined;
  const outputEntity = entityNames(command.output.entity);
  const primaryEntity = entityNames(command.effect.entity);
  const guardTables = (command.guards ?? []).map((guard) => entityNames(guard.entity).pluralCamel);
  const namedTables = namedEffects.map(([, effect]) => entityNames(effect.entity).pluralCamel);
  const idempotencyTable = command.idempotency
    ? entityNames(command.idempotency.entity).pluralCamel
    : undefined;
  const schemaImports = [
    ...new Set([
      primaryEntity.pluralCamel,
      ...namedTables,
      ...guardTables,
      ...(idempotencyTable ? [idempotencyTable] : []),
    ]),
  ].sort();
  const outputFields = command.output.fields.map(json).join(" | ");
  const inputAuthorization = (command.authorization?.rules ?? [])
    .flatMap((rule) => rule.kind === "input-equals-principal"
      ? [`      if (input.${rule.input} !== principal.${rule.principalField}) {
        throw ${renderedDomainError(commandName, command, rule.error)};
      }`]
      : rule.kind === "principal-field-in"
        ? [`      if (!${json(rule.values)}.includes(principal.${rule.principalField})) {
        throw ${renderedDomainError(commandName, command, rule.error)};
      }`]
        : [])
    .join("\n");
  const replay = command.idempotency
    ? `      const [replayed] = await tx
        .select({
${command.output.fields.map((field) => `          ${field}: ${idempotencyTable}.${field},`).join("\n")}
        })
        .from(${idempotencyTable})
        .where(and(
          eq(${idempotencyTable}.${command.idempotency.field}, input.${command.idempotency.input}),
          eq(${idempotencyTable}.${command.idempotency.scopeField}, principal.${command.idempotency.scopePrincipalField}),
        ))
        .limit(1);
      if (replayed) return replayed;`
    : "";
  const guards = (command.guards ?? [])
    .map((guard, index) => {
      const table = entityNames(guard.entity).pluralCamel;
      return `      const [guard${index}] = await tx
        .select({ value: ${table}.${guard.field} })
        .from(${table})
        .where(eq(${table}.${guard.field}, input.${guard.value.input}))
        .limit(1);
      if (!guard${index}) throw ${renderedDomainError(commandName, command, guard.error)};`;
    })
    .join("\n");
  const selections = namedEffects
    .map(([effectName, effect]) => {
      const record = namedRecordVariable(effectName);
      const table = entityNames(effect.entity).pluralCamel;
      return `      const [${record}] = await tx
        .select()
        .from(${table})
        .where(eq(${table}.${effect.identify.field}, ${commandReference(effect.identify.value)}))
        .limit(1)
        .for("update");
      if (!${record}) throw ${renderedDomainError(commandName, command, effect.identify.error)};`;
    })
    .join("\n");
  const recordAuthorization = (command.authorization?.rules ?? [])
    .flatMap((rule) =>
      rule.kind === "record-field-equals-principal" && rule.effect
        ? [`      if (${namedRecordVariable(rule.effect)}.${rule.field} !== principal.${rule.principalField}) {
        throw ${renderedDomainError(commandName, command, rule.error)};
      }`]
        : [],
    )
    .join("\n");
  const invariantChecks = (command.invariants ?? [])
    .map(
      (invariant) => `      if (!(${renderInvariantExpression(invariant.condition)})) {
        throw ${renderedDomainError(commandName, command, invariant.error)};
      }`,
    )
    .join("\n");
  const preconditionChecks = namedEffects
    .flatMap(([effectName, effect]) =>
      (effect.preconditions ?? []).map(
        (precondition) => `      if (${namedRecordVariable(effectName)}.${precondition.field} !== ${commandReference(precondition.equals)}) {
        throw ${renderedDomainError(commandName, command, precondition.error)};
      }`,
      ),
    )
    .join("\n");
  const conflictError = command.transaction?.conflictError;
  if (!conflictError) throw new Error(`Multi-effect command ${commandName} has no conflict error.`);
  const mutations = namedEffects
    .map(([effectName, effect]) => {
      const table = entityNames(effect.entity).pluralCamel;
      const values = Object.entries(effect.values)
        .map(
          ([field, assignment]) =>
            `          ${field}: ${commandAssignment(table, field, assignment)},`,
        )
        .join("\n");
      const predicates = [
        `eq(${table}.${effect.identify.field}, ${commandReference(effect.identify.value)})`,
        ...(effect.preconditions ?? []).map(
          (precondition) =>
            `eq(${table}.${precondition.field}, ${commandReference(precondition.equals)})`,
        ),
      ];
      return `      const [updated${pascalCase(effectName)}] = await tx
        .update(${table})
        .set({
${values}
        })
        .where(and(${predicates.join(", ")}))
        .returning({ changed: ${table}.${effect.identify.field} });
      if (!updated${pascalCase(effectName)}) throw ${renderedDomainError(commandName, command, conflictError)};`;
    })
    .join("\n");
  const primaryValues = Object.entries(command.effect.values)
    .map(
      ([field, assignment]) =>
        `          ${field}: ${commandAssignment(primaryEntity.pluralCamel, field, assignment)},`,
    )
    .join("\n");
  const returning = command.output.fields
    .map((field) => `          ${field}: ${primaryEntity.pluralCamel}.${field},`)
    .join("\n");
  const primaryMutation = `      const [created] = await tx
        .insert(${primaryEntity.pluralCamel})
        .values({
${primaryValues}
        })
        .returning({
${returning}
        });
      if (!created) throw new Error(${json(`PostgreSQL did not return the result of command ${commandName}.`)});
      await enqueueMessages(tx, ${json(commandName)}, input, created, ${principalType ? "principal" : "{ }"});
      return created;`;
  const isolationLevel = command.transaction?.isolation.replaceAll("-", " ") ?? "read committed";
  const retryAttempts = command.transaction?.retry?.maxAttempts ?? 1;
  const retryableCheck = [
    `hasDatabaseErrorCode(error, "40001")`,
    `hasDatabaseErrorCode(error, "40P01")`,
    ...(command.idempotency ? [`hasDatabaseErrorCode(error, "23505")`] : []),
  ].join(" || ");
  const blocks = [
    inputAuthorization,
    replay,
    guards,
    selections,
    recordAuthorization,
    invariantChecks,
    preconditionChecks,
    mutations,
    primaryMutation,
  ].filter(Boolean).join("\n");

  return `import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ${schemaImports.join(", ")}, type ${outputEntity.pascal} } from "@/db/schema";
import { DomainError, hasDatabaseErrorCode } from "@/domain/errors";
import { enqueueMessages } from "@/air/runtime";
import type { ${[inputType, principalType].filter(Boolean).join(", ")} } from "@/domain/contracts";

export type ${outputType} = Pick<${outputEntity.pascal}, ${outputFields}>;

export async function ${functionName}(input: ${inputType}${principalType ? `, principal: ${principalType}` : ""}): Promise<${outputType}> {
  const maxAttempts = ${retryAttempts};
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await getDb().transaction(async (tx) => {
${blocks}
      }, { isolationLevel: ${json(isolationLevel)} });
    } catch (error) {
      const retryable = ${retryableCheck};
      if (retryable && attempt < maxAttempts) continue;
      if (retryable) throw ${renderedDomainError(commandName, command, conflictError)};
      throw error;
    }
  }
  throw ${renderedDomainError(commandName, command, conflictError)};
}`;
}

function renderCommand(
  commandName: string,
  command: CommandDefinition,
): string {
  if (Object.keys(command.effects ?? {}).length > 0) return renderMultiCommand(commandName, command);
  const functionName = camelCase(commandName);
  const outputType = `${pascalCase(commandName)}Output`;
  const inputType = pascalCase(command.input);
  const principalType = command.authorization
    ? pascalCase(command.authorization.principal)
    : undefined;
  const outputEntity = entityNames(command.output.entity);
  const effectEntity = entityNames(command.effect.entity);
  const guardTables = (command.guards ?? []).map((guard) => entityNames(guard.entity).pluralCamel);
  const schemaImports = [...new Set([effectEntity.pluralCamel, ...guardTables])].sort();
  const outputFields = command.output.fields.map(json).join(" | ");
  const inputAuthorization = (command.authorization?.rules ?? [])
    .flatMap((rule) => rule.kind === "input-equals-principal"
      ? [`    if (input.${rule.input} !== principal.${rule.principalField}) {
      throw ${renderedDomainError(commandName, command, rule.error)};
    }`]
      : rule.kind === "principal-field-in"
        ? [`    if (!${json(rule.values)}.includes(principal.${rule.principalField})) {
      throw ${renderedDomainError(commandName, command, rule.error)};
    }`]
        : [])
    .join("\n");
  const recordAuthorization = (command.authorization?.rules ?? [])
    .filter((rule) => rule.kind === "record-field-equals-principal")
    .map(
      (rule) => `    if (current.${rule.field} !== principal.${rule.principalField}) {
      throw ${renderedDomainError(commandName, command, rule.error)};
    }`,
    )
    .join("\n");
  const invariantChecks = (command.invariants ?? [])
    .map(
      (invariant) => `    if (!(${renderInvariantExpression(invariant.condition)})) {
      throw ${renderedDomainError(commandName, command, invariant.error)};
    }`,
    )
    .join("\n");
  const guards = (command.guards ?? [])
    .map((guard, index) => {
      const guardTable = entityNames(guard.entity).pluralCamel;
      return `    const [guard${index}] = await tx
      .select({ value: ${guardTable}.${guard.field} })
      .from(${guardTable})
      .where(eq(${guardTable}.${guard.field}, input.${guard.value.input}))
      .limit(1);
    if (!guard${index}) {
      throw ${renderedDomainError(commandName, command, guard.error)};
    }`;
    })
    .join("\n\n");
  const returning = command.output.fields
    .map((fieldName) => `        ${fieldName}: ${effectEntity.pluralCamel}.${fieldName},`)
    .join("\n");
  const values = Object.entries(command.effect.kind === "delete" ? {} : command.effect.values)
    .map(
      ([targetField, assignment]) =>
        `        ${targetField}: ${commandAssignment(effectEntity.pluralCamel, targetField, assignment)},`,
    )
    .join("\n");
  let effect: string;
  if (command.effect.kind === "create") {
    effect = `    const [created] = await tx
      .insert(${effectEntity.pluralCamel})
      .values({
${values}
      })
      .returning({
${returning}
      });
    if (!created) throw new Error(${json(`PostgreSQL did not return the result of command ${commandName}.`)});
    await enqueueMessages(tx, ${json(commandName)}, input, created, ${principalType ? "principal" : "{ }"});
    return created;`;
  } else {
    const identify = command.effect.identify;
    const identifyValue = commandReference(identify.value);
    const preconditionChecks = (command.effect.preconditions ?? [])
      .map(
        (precondition) => `    if (current.${precondition.field} !== ${commandReference(precondition.equals)}) {
      throw ${renderedDomainError(commandName, command, precondition.error)};
    }`,
      )
      .join("\n");
    const predicates = [
      `eq(${effectEntity.pluralCamel}.${identify.field}, ${identifyValue})`,
      ...(command.effect.preconditions ?? []).map(
        (precondition) =>
          `eq(${effectEntity.pluralCamel}.${precondition.field}, ${commandReference(precondition.equals)})`,
      ),
    ];
    const conflictError = command.transaction?.conflictError;
    if (!conflictError) throw new Error(`Update command ${commandName} has no conflict error.`);
    const mutation = command.effect.kind === "update"
      ? `    const [updated] = await tx
      .update(${effectEntity.pluralCamel})
      .set({
${values}
      })
      .where(and(${predicates.join(", ")}))
      .returning({
${returning}
      });
    if (!updated) {
      throw ${renderedDomainError(commandName, command, conflictError)};
    }
    await enqueueMessages(tx, ${json(commandName)}, input, updated, ${principalType ? "principal" : "{ }"});
    return updated;`
      : `    const [deleted] = await tx
      .delete(${effectEntity.pluralCamel})
      .where(and(${predicates.join(", ")}))
      .returning({
${returning}
      });
    if (!deleted) {
      throw ${renderedDomainError(commandName, command, conflictError)};
    }
    await enqueueMessages(tx, ${json(commandName)}, input, deleted, ${principalType ? "principal" : "{ }"});
    return deleted;`;
    effect = `    const [current] = await tx
      .select()
      .from(${effectEntity.pluralCamel})
      .where(eq(${effectEntity.pluralCamel}.${identify.field}, ${identifyValue}))
      .limit(1);
    if (!current) {
      throw ${renderedDomainError(commandName, command, identify.error)};
    }
${recordAuthorization}
${invariantChecks}
${preconditionChecks}
${mutation}`;
  }

  const isolationLevel = command.transaction?.isolation.replaceAll("-", " ");
  const transactionOptions = isolationLevel
    ? `, { isolationLevel: ${json(isolationLevel)} }`
    : "";
  const transactionCall = `getDb().transaction(async (tx) => {
${inputAuthorization}${inputAuthorization ? "\n" : ""}${command.effect.kind === "create" ? invariantChecks : ""}${command.effect.kind === "create" && invariantChecks ? "\n" : ""}${guards}${guards ? "\n" : ""}${effect}
  }${transactionOptions})`;
  const conflictError = command.transaction?.conflictError;
  const execution = conflictError
    ? `  try {
    return await ${transactionCall};
  } catch (error) {
    if (hasDatabaseErrorCode(error, "40001")) {
      throw ${renderedDomainError(commandName, command, conflictError)};
    }
    throw error;
  }`
    : `  return ${transactionCall};`;

  return `import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ${schemaImports.join(", ")}, type ${outputEntity.pascal} } from "@/db/schema";
import { DomainError, hasDatabaseErrorCode } from "@/domain/errors";
import { enqueueMessages } from "@/air/runtime";
import type { ${[inputType, principalType].filter(Boolean).join(", ")} } from "@/domain/contracts";

export type ${outputType} = Pick<${outputEntity.pascal}, ${outputFields}>;

export async function ${functionName}(input: ${inputType}${principalType ? `, principal: ${principalType}` : ""}): Promise<${outputType}> {
${execution}
}`;
}

function renderRepository(
  entityName: string,
  entity: EntityDefinition,
  operations: readonly CrudHttpOperation[],
): string {
  const names = entityNames(entityName);
  const primaryName = primaryField(entity)?.[0] ?? "id";
  const blocks: string[] = [];
  const pluralPascal = upperFirst(names.pluralCamel);
  const actions = new Set(operations.map((operation) => operation.action));
  const listOperation = operations.find((operation) => operation.action === "list");
  const collection = listOperation?.collection;
  const drizzleImports = new Set<string>(["eq"]);

  if (actions.has("list")) {
    const filters = collection?.filters ?? [];
    if (filters.length > 0) drizzleImports.add("and");
    for (const order of collection?.orderBy ?? []) drizzleImports.add(order.direction);
    const queryFields = [
      ...(collection?.pagination ? ["  readonly limit: number;", "  readonly offset: number;"] : []),
      ...filters.map((filter) => `  readonly ${filter.parameter}?: ${names.pascal}[${json(filter.field)}];`),
    ];
    const queryType = collection ? `export interface ${names.pascal}ListQuery {\n${queryFields.join("\n")}\n}\n\n` : "";
    const where = filters.length > 0
      ? `.where(and(${filters.map((filter) => `query.${filter.parameter} === undefined ? undefined : eq(${names.pluralCamel}.${filter.field}, query.${filter.parameter})`).join(", ")}))`
      : "";
    const ordering = (collection?.orderBy?.length ?? 0) > 0
      ? `.orderBy(${collection!.orderBy!.map((order) => `${order.direction}(${names.pluralCamel}.${order.field})`).join(", ")})`
      : "";
    const pagination = collection?.pagination ? ".limit(query.limit).offset(query.offset)" : "";
    blocks.push(`${queryType}export async function list${pluralPascal}(${collection ? `query: ${names.pascal}ListQuery` : ""}): Promise<${names.pascal}[]> {
  return getDb().select().from(${names.pluralCamel})${where}${ordering}${pagination};
}`);
  }
  if (actions.has("read")) {
    blocks.push(`export async function get${names.pascal}(id: ${names.pascal}[${json(primaryName)}]): Promise<${names.pascal} | undefined> {
  const [row] = await getDb().select().from(${names.pluralCamel}).where(eq(${names.pluralCamel}.${primaryName}, id)).limit(1);
  return row;
}`);
  }
  if (actions.has("create")) {
    blocks.push(`export async function create${names.pascal}(data: New${names.pascal}): Promise<${names.pascal}> {
  const [row] = await getDb().insert(${names.pluralCamel}).values(data).returning();
  if (!row) throw new Error(${json(`PostgreSQL did not return the created ${entityName}.`)});
  return row;
}`);
  }
  if (actions.has("update")) {
    blocks.push(`export async function update${names.pascal}(id: ${names.pascal}[${json(primaryName)}], data: ${names.pascal}UpdateInput): Promise<${names.pascal} | undefined> {
  const [row] = await getDb().update(${names.pluralCamel}).set(data).where(eq(${names.pluralCamel}.${primaryName}, id)).returning();
  return row;
}`);
  }
  if (actions.has("delete")) {
    blocks.push(`export async function delete${names.pascal}(id: ${names.pascal}[${json(primaryName)}]): Promise<boolean> {
  const rows = await getDb().delete(${names.pluralCamel}).where(eq(${names.pluralCamel}.${primaryName}, id)).returning({ id: ${names.pluralCamel}.${primaryName} });
  return rows.length > 0;
}`);
  }

  return `import { ${[...drizzleImports].sort().join(", ")} } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ${names.pluralCamel}, type ${names.pascal}, type New${names.pascal} } from "@/db/schema";
import type { ${names.pascal}UpdateInput } from "@/domain/${names.kebab}";

${blocks.join("\n\n")}`;
}

function renderHttpHelpers(): string {
  return `import { DomainError } from "@/domain/errors";
import { InputValidationError } from "@/domain/input";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InputValidationError("Request body must be valid JSON.");
  }
}

export function notFoundResponse(resource: string): Response {
  return Response.json(
    { error: { code: "NOT_FOUND", message: \`${"${resource}"} not found.\`, retryable: false } },
    { status: 404 },
  );
}

export function errorResponse(error: unknown): Response {
  if (error instanceof InputValidationError) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: error.message, retryable: false } },
      { status: 400 },
    );
  }
  if (error instanceof DomainError) {
    return Response.json(
      { error: { code: error.code, message: error.message, retryable: error.retryable } },
      { status: error.status },
    );
  }
  console.error(JSON.stringify({
    level: "error",
    event: "air.http.unhandled_error",
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { value: String(error) },
    timestamp: new Date().toISOString(),
  }));
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error.", retryable: false } },
    { status: 500 },
  );
}`;
}

function renderNodeDockerfile(options: ResolvedNextjsOptions): string {
  const install = {
    npm: "npm install",
    pnpm: "corepack enable && pnpm install --no-frozen-lockfile",
    yarn: "corepack enable && yarn install",
    bun: "npm install --global bun && bun install",
  }[options.packageManager];
  const build = `${options.packageManager} run build`;
  return `FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN ${install}
COPY . .
RUN ${build}

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/air-runtime/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]`;
}

function repositoryFunction(operation: CrudHttpOperation): string {
  const names = entityNames(operation.entity);
  switch (operation.action) {
    case "list":
      return `list${upperFirst(names.pluralCamel)}`;
    case "read":
      return `get${names.pascal}`;
    case "create":
      return `create${names.pascal}`;
    case "update":
      return `update${names.pascal}`;
    case "delete":
      return `delete${names.pascal}`;
  }
}

function renderCrudAuthorization(operation: CrudHttpOperation): string {
  const authorization = operation.authorization;
  if (!authorization) return "";
  const principalType = pascalCase(authorization.principal);
  const checks = authorization.rules.map((rule) => `    if (!${json(rule.values)}.includes(principal.${rule.principalField})) {
      throw new DomainError("FORBIDDEN", "The authenticated principal cannot perform this operation.", 403, false);
    }`).join("\n");
  return `    const principal = await authenticate${principalType}(request);
    if (!principal) {
      throw new DomainError("UNAUTHENTICATED", "Authentication is required.", 401, false);
    }
${checks}
`;
}

function renderCollectionQuery(operation: CrudHttpOperation): string {
  const collection = operation.collection;
  if (!collection) return "";
  const lines = ["    const searchParams = new URL(request.url).searchParams;"];
  if (collection.pagination) {
    lines.push(
      '    const rawLimit = searchParams.get("limit");',
      '    const rawOffset = searchParams.get("offset");',
      `    const limit = rawLimit === null ? ${collection.pagination.defaultLimit} : Number(rawLimit);`,
      "    const offset = rawOffset === null ? 0 : Number(rawOffset);",
      `    if (!Number.isInteger(limit) || limit < 1 || limit > ${collection.pagination.maxLimit}) {`,
      `      throw new InputValidationError(${json(`limit must be an integer from 1 through ${collection.pagination.maxLimit}.`)});`,
      "    }",
      "    if (!Number.isInteger(offset) || offset < 0) {",
      '      throw new InputValidationError("offset must be a non-negative integer.");',
      "    }",
    );
  }
  for (const filter of collection.filters ?? []) {
    lines.push(`    const raw${pascalCase(filter.parameter)} = searchParams.get(${json(filter.parameter)});`);
  }
  const properties = [
    ...(collection.pagination ? ["limit", "offset"] : []),
    ...(collection.filters ?? []).map((filter) => {
      const raw = `raw${pascalCase(filter.parameter)}`;
      return `${filter.parameter}: ${raw} === null ? undefined : parse${pascalCase(operation.entity)}${pascalCase(filter.field)}Filter(${raw})`;
    }),
  ];
  lines.push(`    const query = { ${properties.join(", ")} };`);
  return `${lines.join("\n")}\n`;
}

function renderHandler(operation: CrudHttpOperation): string {
  const names = entityNames(operation.entity);
  const repository = repositoryFunction(operation);
  const authorization = renderCrudAuthorization(operation);
  switch (operation.action) {
    case "list":
      return `export async function ${operation.method}(request: Request): Promise<Response> {
  try {
${authorization}${renderCollectionQuery(operation)}    return Response.json(await ${repository}(${operation.collection ? "query" : ""}));
  } catch (error) {
    return errorResponse(error);
  }
}`;
    case "create":
      return `export async function ${operation.method}(request: Request): Promise<Response> {
  try {
${authorization}    const input = parse${names.pascal}Create(await readJson(request));
    return Response.json(await ${repository}(input), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}`;
    case "read":
      return `export async function ${operation.method}(request: Request, { params }: RouteContext): Promise<Response> {
  try {
${authorization}    const { id } = await params;
    const row = await ${repository}(parse${names.pascal}Id(id));
    return row ? Response.json(row) : notFoundResponse(${json(operation.entity)});
  } catch (error) {
    return errorResponse(error);
  }
}`;
    case "update":
      return `export async function ${operation.method}(request: Request, { params }: RouteContext): Promise<Response> {
  try {
${authorization}    const { id } = await params;
    const input = parse${names.pascal}Update(await readJson(request));
    const row = await ${repository}(parse${names.pascal}Id(id), input);
    return row ? Response.json(row) : notFoundResponse(${json(operation.entity)});
  } catch (error) {
    return errorResponse(error);
  }
}`;
    case "delete":
      return `export async function ${operation.method}(request: Request, { params }: RouteContext): Promise<Response> {
  try {
${authorization}    const { id } = await params;
    const deleted = await ${repository}(parse${names.pascal}Id(id));
    return deleted ? new Response(null, { status: 204 }) : notFoundResponse(${json(operation.entity)});
  } catch (error) {
    return errorResponse(error);
  }
}`;
  }
}

function renderCrudRoute(operations: readonly CrudHttpOperation[]): string {
  const entityName = operations[0]?.entity;
  if (!entityName) throw new Error("Cannot render an empty route.");
  const names = entityNames(entityName);
  const repositories = [...new Set(operations.map(repositoryFunction))].sort();
  const needsCreate = operations.some((operation) => operation.action === "create");
  const needsUpdate = operations.some((operation) => operation.action === "update");
  const needsId = operations.some((operation) => ["read", "update", "delete"].includes(operation.action));
  const validationImports = [
    ...(needsCreate ? [`parse${names.pascal}Create`] : []),
    ...(needsUpdate ? [`parse${names.pascal}Update`] : []),
    ...(needsId ? [`parse${names.pascal}Id`] : []),
    ...operations.flatMap((operation) => (operation.collection?.filters ?? []).map(
      (filter) => `parse${names.pascal}${pascalCase(filter.field)}Filter`,
    )),
  ];
  const httpImports = [
    "errorResponse",
    ...(operations.some((operation) => operation.action === "create" || operation.action === "update")
      ? ["readJson"]
      : []),
    ...(needsId ? ["notFoundResponse"] : []),
  ].sort();
  const authorized = operations.filter((operation) => operation.authorization);
  const authenticationImports = [...new Set(authorized.map(
    (operation) => `authenticate${pascalCase(operation.authorization!.principal)}`,
  ))].sort();
  const needsInputValidationError = operations.some((operation) => operation.collection?.pagination);

  return `import { ${repositories.join(", ")} } from "@/repositories/${names.kebab}";
${validationImports.length > 0 ? `import { ${[...new Set(validationImports)].sort().join(", ")} } from "@/domain/${names.kebab}";` : ""}
import { ${httpImports.join(", ")} } from "@/http/responses";
${authenticationImports.length > 0 ? `import { ${authenticationImports.join(", ")} } from "@/auth/principals";\nimport { DomainError } from "@/domain/errors";` : ""}
${needsInputValidationError ? `import { InputValidationError } from "@/domain/input";` : ""}
${needsId ? `\ntype RouteContext = { readonly params: Promise<{ readonly id: string }> };` : ""}

${operations.map(renderHandler).join("\n\n")}`;
}

function renderCommandRoute(operation: HttpOperation, air: AirDocument): string {
  if (isCrudOperation(operation)) throw new Error("Expected a command HTTP operation.");
  const command = air.spec.commands?.[operation.command];
  if (!command) throw new Error(`Unknown command ${operation.command}.`);
  const functionName = camelCase(operation.command);
  const commandFile = kebabCase(operation.command);
  const inputType = pascalCase(command.input);
  const authorization = command.authorization;
  const principalType = authorization ? pascalCase(authorization.principal) : undefined;
  const authImports = authorization
    ? `import { authenticate${principalType} } from "@/auth/principals";\nimport { DomainError } from "@/domain/errors";\n`
    : "";
  const authPrelude = authorization
    ? `    const principal = await authenticate${principalType}(request);
    if (!principal) {
      throw ${renderedDomainError(operation.command, command, authorization.unauthenticatedError)};
    }
`
    : "";
  const commandArguments = authorization ? "input, principal" : "input";

  return `import { ${functionName} } from "@/commands/${commandFile}";
${authImports}import { parse${inputType} } from "@/domain/contracts";
import { errorResponse, readJson } from "@/http/responses";

export async function ${operation.method}(request: Request): Promise<Response> {
  try {
${authPrelude}    const input = parse${inputType}(await readJson(request));
    return Response.json(await ${functionName}(${commandArguments}), { status: ${command.effect.kind === "create" ? 201 : 200} });
  } catch (error) {
    return errorResponse(error);
  }
}`;
}

function exampleValue(fieldName: string, field: FieldDefinition | ContractFieldDefinition): unknown {
  if (field.validation?.enum?.[0] !== undefined) return field.validation.enum[0];
  switch (field.type) {
    case "string":
      return fieldName;
    case "integer":
      return Math.max(1, Math.ceil(field.validation?.minimum ?? 1));
    case "number":
      return Math.max(1, field.validation?.minimum ?? 1);
    case "boolean":
      return false;
    case "uuid":
      return "00000000-0000-4000-8000-000000000001";
    case "date":
      return "2026-01-01";
    case "datetime":
      return "2026-01-01T00:00:00.000Z";
    case "json":
      return {};
  }
}

function renderPage(air: AirDocument): string {
  const resources = Object.entries(air.spec.entities).flatMap(([entityName, entity]) => {
    const operations =
      air.spec.http?.operations
        .filter(isCrudOperation)
        .filter((operation) => operation.entity === entityName) ?? [];
    const list = operations.find((operation) => operation.action === "list");
    const create = operations.find((operation) => operation.action === "create");
    if (!list) return [];
    const example = Object.fromEntries(
      Object.entries(entity.fields)
        .filter(([, field]) => field.required && field.generated === undefined && field.default === undefined)
        .map(([fieldName, field]) => [fieldName, exampleValue(fieldName, field)]),
    );
    return [
      {
        name: entityName,
        listPath: list.path,
        createPath: create?.path,
        example,
      },
    ];
  });

  return `"use client";

import { useCallback, useEffect, useState } from "react";

type Resource = {
  readonly name: string;
  readonly listPath: string;
  readonly createPath?: string;
  readonly example: Readonly<Record<string, unknown>>;
};

const resources: readonly Resource[] = ${JSON.stringify(resources, null, 2)};

function ResourcePanel({ resource }: { readonly resource: Resource }) {
  const [rows, setRows] = useState<unknown[]>([]);
  const [payload, setPayload] = useState(JSON.stringify(resource.example, null, 2));
  const [message, setMessage] = useState("Loading…");

  const load = useCallback(async () => {
    try {
      const response = await fetch(resource.listPath, { cache: "no-store" });
      if (!response.ok) throw new Error(\`Request failed with ${"${response.status}"}.\`);
      const value: unknown = await response.json();
      setRows(Array.isArray(value) ? value : []);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    }
  }, [resource.listPath]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!("createPath" in resource) || !resource.createPath) return;
    try {
      const response = await fetch(resource.createPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      const value: unknown = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        const detail =
          typeof value === "object" &&
          value !== null &&
          "error" in value &&
          typeof value.error === "object" &&
          value.error !== null &&
          "message" in value.error
            ? String(value.error.message)
            : "Create failed.";
        throw new Error(detail);
      }
      setMessage("Created.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Create failed.");
    }
  }

  return (
    <section className="panel">
      <div className="panelHeading">
        <div>
          <p className="eyebrow">Generated resource</p>
          <h2>{resource.name}</h2>
        </div>
        <button type="button" className="secondary" onClick={() => void load()}>Refresh</button>
      </div>
      {"createPath" in resource && resource.createPath ? (
        <div className="composer">
          <label htmlFor={\`payload-${"${resource.name}"}\`}>Create payload</label>
          <textarea id={\`payload-${"${resource.name}"}\`} value={payload} onChange={(event) => setPayload(event.target.value)} />
          <button type="button" onClick={() => void create()}>Create {resource.name}</button>
        </div>
      ) : null}
      {message ? <p className="message">{message}</p> : null}
      <div className="results">
        {rows.length === 0 && !message ? <p>No records yet.</p> : null}
        {rows.map((row, index) => <pre key={index}>{JSON.stringify(row, null, 2)}</pre>)}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Compiled from AIR</p>
        <h1>${air.metadata.displayName ?? air.metadata.name}</h1>
        <p>${air.metadata.description ?? "A generated Next.js application."}</p>
      </header>
      <div className="grid">
        {resources.map((resource) => <ResourcePanel key={resource.name} resource={resource} />)}
      </div>
    </main>
  );
}`;
}

function renderValidationTests(air: AirDocument): string {
  const entityImports = Object.keys(air.spec.entities)
    .map((entityName) => {
      const names = entityNames(entityName);
      return `import { parse${names.pascal}Create, parse${names.pascal}Update } from "./${names.kebab}";`;
    })
    .join("\n");
  const contractNames = [
    ...Object.keys(air.spec.contracts ?? {}),
    ...Object.keys(air.spec.principals ?? {}),
  ];
  const contractImports =
    contractNames.length > 0
      ? `import { ${contractNames.map((name) => `parse${pascalCase(name)}`).join(", ")} } from "./contracts";`
      : "";
  const entityCases = Object.keys(air.spec.entities)
    .map((entityName) => {
      const names = entityNames(entityName);
      return `  it(${json(`rejects non-object ${entityName} inputs`)}, () => {
    expect(() => parse${names.pascal}Create(null)).toThrow();
    expect(() => parse${names.pascal}Update([])).toThrow();
  });`;
    })
    .join("\n\n");
  const contractCases = contractNames
    .map(
      (contractName) => `  it(${json(`rejects non-object ${contractName} inputs`)}, () => {
    expect(() => parse${pascalCase(contractName)}(null)).toThrow();
    expect(() => parse${pascalCase(contractName)}({ unexpected: true })).toThrow(/unknown field/);
  });`,
    )
    .join("\n\n");
  return `import { describe, expect, it } from "vitest";
${entityImports}
${contractImports}

describe("generated AIR input validation", () => {
${entityCases}
${contractCases ? `\n\n${contractCases}` : ""}
});`;
}

function renderPrincipalAuthenticationTests(air: AirDocument): string {
  const principals = Object.entries(air.spec.principals ?? {});
  const imports = principals
    .map(([principalName]) => `authenticate${pascalCase(principalName)}`)
    .join(", ");
  const cases = principals
    .map(([principalName, principal]) => {
      const typeName = pascalCase(principalName);
      const claims = Object.fromEntries(
        Object.entries(principal.fields).map(([fieldName, field]) => [
          fieldName,
          exampleValue(fieldName, field),
        ]),
      );
      return `  it(${json(`authenticates a valid ${principalName} bearer token`)}, async () => {
    const claims = ${JSON.stringify(claims)};
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(TEST_SECRET));
    const request = new Request("http://localhost", {
      headers: { authorization: \`Bearer \${token}\` },
    });
    await expect(authenticate${typeName}(request)).resolves.toEqual(claims);
  });

  it(${json(`rejects an invalid ${principalName} bearer token`)}, async () => {
    const request = new Request("http://localhost", {
      headers: { authorization: "Bearer invalid" },
    });
    await expect(authenticate${typeName}(request)).resolves.toBeUndefined();
  });`;
    })
    .join("\n\n");

  return `import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { ${imports} } from "./principals";

const TEST_SECRET = "air-test-secret-at-least-32-characters";
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.AIR_AUTH_SECRET;
  process.env.AIR_AUTH_SECRET = TEST_SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.AIR_AUTH_SECRET;
  else process.env.AIR_AUTH_SECRET = previousSecret;
});

describe("generated AIR principal authentication", () => {
${cases}
});`;
}

export function renderNextjsFiles(
  air: AirDocument,
  options: ResolvedNextjsOptions,
): readonly PlannedNextjsFile[] {
  const dataContracts = {
    ...(air.spec.contracts ?? {}),
    ...(air.spec.principals ?? {}),
  };
  const hasPrincipals = Object.keys(air.spec.principals ?? {}).length > 0;
  const operations = air.spec.http?.operations ?? [];
  const operationGroups = new Map<string, HttpOperation[]>();
  for (const operation of operations) {
    const path = routePathToDirectory(operation.path);
    const group = operationGroups.get(path) ?? [];
    group.push(operation);
    operationGroups.set(path, group);
  }

  const files: PlannedNextjsFile[] = [
    planned("package.json", "configuration", ["/metadata"], renderPackageJson(air, options)),
    planned(
      "tsconfig.json",
      "configuration",
      ["/"],
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: false,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "react-jsx",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./src/*"] },
          },
          include: [
            "next-env.d.ts",
            ".next/types/**/*.ts",
            ".next/dev/types/**/*.ts",
            "**/*.ts",
            "**/*.tsx",
          ],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    ),
    planned(
      "next-env.d.ts",
      "configuration",
      ["/"],
      `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// This file is generated by Next.js tooling conventions.`,
    ),
    planned(
      "next.config.ts",
      "configuration",
      ["/"],
      `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = ${
        options.deployment === "node" ? `{ output: "standalone" }` : "{}"
      };\n\nexport default nextConfig;`,
    ),
    planned(
      "drizzle.config.ts",
      "configuration",
      ["/spec/entities"],
      `import { defineConfig } from "drizzle-kit";\n\nexport default defineConfig({\n  dialect: "postgresql",\n  schema: "./src/db/schema.ts",\n  out: "./drizzle",\n  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost/air" },\n});`,
    ),
    planned(
      ".env.example",
      "configuration",
      ["/"],
      `DATABASE_URL=postgres://postgres:postgres@localhost:5432/air${
        hasPrincipals ? "\nAIR_AUTH_SECRET=replace-with-at-least-32-random-characters" : ""
      }`,
    ),
    planned(
      ".gitignore",
      "configuration",
      ["/"],
      `.next/\nnode_modules/\n.env\n.env.local\ncoverage/\n*.tsbuildinfo`,
    ),
    planned(
      "src/db/client.ts",
      "source",
      ["/spec/entities"],
      `import { sql } from "drizzle-orm";\nimport { drizzle } from "drizzle-orm/postgres-js";\nimport postgres from "postgres";\nimport * as schema from "./schema";\n\nlet database: ReturnType<typeof createDatabase> | undefined;\n\nfunction createDatabase() {\n  const connectionString = process.env.DATABASE_URL;\n  if (!connectionString) throw new Error("DATABASE_URL is required before accessing PostgreSQL.");\n  const client = postgres(connectionString, { prepare: false });\n  return drizzle(client, { schema });\n}\n\nexport function getDb(): ReturnType<typeof createDatabase> {\n  database ??= createDatabase();\n  return database;\n}\n\nexport async function checkDatabaseReady(): Promise<void> {\n  await getDb().execute(sql\`select 1\`);\n}`,
    ),
    planned("src/db/schema.ts", "source", ["/spec/entities"], renderDatabaseSchema(air)),
    planned("drizzle/0000_air_async_runtime.sql", "source", ["/spec/events", "/spec/tasks", "/spec/consumers", "/spec/schedules", "/spec/realtime"], renderAsyncMigration()),
    planned("src/air/runtime.ts", "source", ["/spec/events", "/spec/tasks", "/spec/consumers", "/spec/schedules", "/spec/cachedReads", "/spec/realtime"], renderAsyncRuntime(air)),
    planned("src/domain/errors.ts", "source", ["/spec/commands"], renderDomainErrors()),
    planned("src/domain/input.ts", "source", ["/spec/entities"], renderInputHelpers()),
    planned("src/domain/validation.test.ts", "test", ["/spec/entities"], renderValidationTests(air)),
    planned("src/http/responses.ts", "source", ["/spec/http"], renderHttpHelpers()),
    planned(
      "src/app/air-runtime/health/route.ts",
      "source",
      ["/"],
      `export const runtime = "nodejs";\nexport const dynamic = "force-dynamic";\n\nexport function GET(): Response {\n  return Response.json({ status: "ok" });\n}`,
    ),
    planned(
      "src/app/air-runtime/ready/route.ts",
      "source",
      ["/spec/entities"],
      `import { checkDatabaseReady } from "@/db/client";\n\nexport const runtime = "nodejs";\nexport const dynamic = "force-dynamic";\n\nexport async function GET(): Promise<Response> {\n  try {\n    await checkDatabaseReady();\n    return Response.json({ status: "ready" });\n  } catch (error) {\n    console.error(JSON.stringify({\n      level: "error",\n      event: "air.readiness.failed",\n      error: error instanceof Error ? { name: error.name, message: error.message } : { value: String(error) },\n      timestamp: new Date().toISOString(),\n    }));\n    return Response.json(\n      { status: "not_ready", error: { code: "DATABASE_UNAVAILABLE", retryable: true } },\n      { status: 503 },\n    );\n  }\n}`,
    ),
    planned(
      "src/app/layout.tsx",
      "source",
      ["/metadata"],
      `import type { Metadata } from "next";\nimport type { ReactNode } from "react";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: ${json(air.metadata.displayName ?? air.metadata.name)},\n  description: ${json(air.metadata.description ?? "Generated from AIR.")},\n};\n\nexport default function RootLayout({ children }: { readonly children: ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}`,
    ),
    planned("src/app/page.tsx", "source", ["/metadata", "/spec/entities", "/spec/http"], renderPage(air)),
    planned(
      "src/app/globals.css",
      "source",
      ["/metadata"],
      `:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f5f7fb; color: #14213d; }\n* { box-sizing: border-box; }\nbody { margin: 0; }\nbutton, textarea { font: inherit; }\nmain { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0; }\n.hero { max-width: 720px; margin-bottom: 36px; }\nh1 { margin: 4px 0 12px; font-size: clamp(2.5rem, 7vw, 5rem); letter-spacing: -0.06em; }\nh2 { margin: 3px 0 0; }\n.eyebrow { margin: 0; color: #5268d9; font-size: .75rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }\n.grid { display: grid; gap: 24px; }\n.panel { padding: 24px; border: 1px solid #dce2f0; border-radius: 20px; background: #fff; box-shadow: 0 18px 50px rgba(20,33,61,.08); }\n.panelHeading { display: flex; justify-content: space-between; gap: 16px; align-items: start; }\n.composer { display: grid; gap: 10px; margin: 24px 0; }\ntextarea { width: 100%; min-height: 150px; padding: 14px; border: 1px solid #cbd4e7; border-radius: 12px; font-family: ui-monospace, monospace; }\nbutton { width: fit-content; border: 0; border-radius: 999px; padding: 10px 16px; background: #5268d9; color: #fff; cursor: pointer; font-weight: 700; }\nbutton.secondary { background: #edf0fb; color: #33448e; }\n.message { color: #5268d9; }\n.results { display: grid; gap: 12px; }\npre { overflow: auto; margin: 0; padding: 16px; border-radius: 12px; background: #11182c; color: #dce5ff; }`,
    ),
    planned(
      "README.md",
      "documentation",
      ["/"],
      `# ${air.metadata.displayName ?? air.metadata.name}\n\nGenerated from AIR ${air.apiVersion} by the Next.js target.\n\n## Run\n\n1. Copy \`.env.example\` to \`.env.local\` and set \`DATABASE_URL\`${hasPrincipals ? " and `AIR_AUTH_SECRET`" : ""}.\n2. Run \`${options.packageManager} install\`.\n3. Run \`${options.packageManager} run db:generate\` and apply the migration.\n4. Run \`${options.packageManager} run dev\`.\n\nGenerated files are compiler-owned in managed mode. Change the AIR source and regenerate instead of editing them directly.`,
    ),
  ];

  if (options.deployment === "node") {
    files.push(planned("Dockerfile", "configuration", ["/metadata"], renderNodeDockerfile(options)));
  }

  if (Object.keys(dataContracts).length > 0) {
    files.push(
      planned(
        "src/domain/contracts.ts",
        "source",
        ["/spec/contracts", "/spec/principals"],
        renderContracts(dataContracts),
      ),
    );
  }

  if (hasPrincipals) {
    files.push(
      planned(
        "src/auth/principals.ts",
        "source",
        ["/spec/principals"],
        renderPrincipalAuthentication(air),
      ),
      planned(
        "src/auth/principals.test.ts",
        "test",
        ["/spec/principals"],
        renderPrincipalAuthenticationTests(air),
      ),
    );
  }

  for (const [commandName, command] of Object.entries(air.spec.commands ?? {})) {
    files.push(
      planned(
        `src/commands/${kebabCase(commandName)}.ts`,
        "source",
        [`/spec/commands/${commandName}`],
        renderCommand(commandName, command),
      ),
    );
  }

  if (options.packageManager === "pnpm") {
    files.push(
      planned(
        "pnpm-workspace.yaml",
        "configuration",
        ["/"],
        `allowBuilds:\n  esbuild: true`,
      ),
    );
  }

  for (const [entityName, entity] of Object.entries(air.spec.entities)) {
    const names = entityNames(entityName);
    const entityOperations = operations
      .filter(isCrudOperation)
      .filter((operation) => operation.entity === entityName);
    const filterFields = new Set(entityOperations.flatMap(
      (operation) => (operation.collection?.filters ?? []).map((filter) => filter.field),
    ));
    files.push(
      planned(
        `src/domain/${names.kebab}.ts`,
        "source",
        [`/spec/entities/${entityName}`],
        renderEntityValidation(entityName, entity, filterFields),
      ),
      planned(
        `src/repositories/${names.kebab}.ts`,
        "source",
        [`/spec/entities/${entityName}`],
        renderRepository(entityName, entity, entityOperations),
      ),
    );
  }

  for (const [path, pathOperations] of operationGroups) {
    const first = pathOperations[0];
    if (!first) continue;
    files.push(
      planned(
        path,
        "source",
        pathOperations.map((operation) => `/spec/http/operations/${operation.id}`),
        isCrudOperation(first)
          ? renderCrudRoute(pathOperations.filter(isCrudOperation))
          : renderCommandRoute(first, air),
      ),
    );
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

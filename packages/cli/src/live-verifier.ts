import { createHmac } from "node:crypto";
import postgres from "postgres";
import type { AirDocument, EntityDefinition } from "@air/schema";
import type {
  LiveCommandOperation,
  LiveInvocationResult,
  LiveVerificationAdapter,
  VerificationRecord,
  VerificationScenario,
  VerificationState,
} from "@air/verifier";

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_").toLowerCase();
}

function pluralize(value: string): string {
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
}

function tableName(entityName: string): string {
  return snakeCase(pluralize(entityName));
}

function camelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function databaseValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Date(value);
  }
  return value;
}

function databaseRecord(record: VerificationRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([field, value]) => [snakeCase(field), databaseValue(value)]));
}

function verificationValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function verificationRecord(record: Record<string, unknown>, entity: EntityDefinition): VerificationRecord {
  return Object.fromEntries(Object.entries(record).map(([field, value]) => {
    const airField = camelCase(field);
    const definition = entity.fields[airField];
    const normalized = definition && (definition.type === "integer" || definition.type === "number") && typeof value === "string"
      ? Number(value)
      : verificationValue(value);
    return [airField, normalized];
  }));
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(principal: VerificationRecord, secret: string): string {
  const header = base64Url({ alg: "HS256", typ: "JWT" });
  const payload = base64Url({ ...principal, exp: Math.floor(Date.now() / 1000) + 300 });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: "INVALID_JSON_RESPONSE", message: text } };
  }
}

export interface PostgresHttpLiveAdapter {
  readonly adapter: LiveVerificationAdapter;
  close(): Promise<void>;
}

export function createPostgresHttpLiveAdapter(
  air: AirDocument,
  options: { readonly baseUrl: string; readonly databaseUrl: string; readonly authSecret: string },
): PostgresHttpLiveAdapter {
  const sql = postgres(options.databaseUrl, { max: 1 });
  const entities = Object.entries(air.spec.entities);
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  const adapter: LiveVerificationAdapter = {
    async reset(scenario: VerificationScenario): Promise<void> {
      await sql.begin(async (transaction) => {
        for (const [entityName] of [...entities].reverse()) {
          await transaction`DELETE FROM ${transaction(tableName(entityName))}`;
        }
        for (const [entityName, records] of Object.entries(scenario.given.state ?? {})) {
          for (const record of records) {
            const row = databaseRecord(record);
            const columns = Object.keys(row);
            await transaction`INSERT INTO ${transaction(tableName(entityName))} ${transaction(row, ...columns)}`;
          }
        }
      });
    },

    async invoke(scenario: VerificationScenario, operation: LiveCommandOperation): Promise<LiveInvocationResult> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (scenario.given.principal) headers.authorization = `Bearer ${jwt(scenario.given.principal, options.authSecret)}`;
      const response = await fetch(`${baseUrl}${operation.path}`, {
        method: operation.method,
        headers,
        body: JSON.stringify(scenario.given.input),
      });
      return { status: response.status, body: await responseBody(response) };
    },

    async readState(entityNames: readonly string[]): Promise<VerificationState> {
      const state: Record<string, VerificationRecord[]> = {};
      for (const entityName of entityNames) {
        const entity = air.spec.entities[entityName];
        if (!entity) throw new Error(`Live verification references unknown entity ${entityName}.`);
        const primaryField = Object.entries(entity.fields).find(([, field]) => field.primaryKey)?.[0];
        const rows = primaryField
          ? await sql`SELECT * FROM ${sql(tableName(entityName))} ORDER BY ${sql(snakeCase(primaryField))}`
          : await sql`SELECT * FROM ${sql(tableName(entityName))}`;
        state[entityName] = rows.map((row) => verificationRecord(row, entity));
      }
      return state;
    },
  };

  return { adapter, close: async () => sql.end({ timeout: 1 }) };
}

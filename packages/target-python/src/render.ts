import type { AirDocument, ConstraintValue, EntityDefinition, FieldDefinition } from "@air/schema";
import { snakeCase, tableName } from "./naming.js";
import type { PlannedPythonFile, ResolvedPythonTargetOptions } from "./types.js";

function sqlType(field: FieldDefinition): string {
  if (field.generated === "auto-increment") return "BIGSERIAL";
  switch (field.type) {
    case "string": return "TEXT";
    case "integer": return "BIGINT";
    case "number": return "DOUBLE PRECISION";
    case "boolean": return "BOOLEAN";
    case "uuid": return "UUID";
    case "date": return "DATE";
    case "datetime": return "TIMESTAMPTZ";
    case "json": return "JSONB";
  }
}

function sqlLiteral(value: ConstraintValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function renderMigration(air: AirDocument): string {
  const lines = ["CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""];
  for (const [entityName, entity] of Object.entries(air.spec.entities)) {
    const fields = Object.entries(entity.fields).map(([name, field]) => {
      const pieces = [`  ${snakeCase(name)} ${sqlType(field)}`];
      if (!field.nullable) pieces.push("NOT NULL");
      if (field.primaryKey) pieces.push("PRIMARY KEY");
      if (field.unique) pieces.push("UNIQUE");
      if (field.generated === "uuid") pieces.push("DEFAULT gen_random_uuid()");
      if (field.generated === "created-at" || field.generated === "updated-at") pieces.push("DEFAULT now()");
      if (field.default !== undefined) pieces.push(`DEFAULT ${sqlLiteral(field.default)}`);
      return pieces.join(" ");
    });
    lines.push(`CREATE TABLE ${tableName(entityName)} (`, fields.join(",\n"), ");", "");
  }
  for (const [entityName, entity] of Object.entries(air.spec.entities)) {
    for (const [relationshipName, relationship] of Object.entries(entity.relationships ?? {})) {
      if (!relationship.sourceField || !relationship.targetField || relationship.cardinality === "many-to-many") continue;
      const onDelete = relationship.onDelete === "cascade" ? "CASCADE" : relationship.onDelete === "set-null" ? "SET NULL" : "RESTRICT";
      lines.push(
        `ALTER TABLE ${tableName(entityName)} ADD CONSTRAINT ${snakeCase(`${entityName}_${relationshipName}_fk`)}`,
        `  FOREIGN KEY (${snakeCase(relationship.sourceField)}) REFERENCES ${tableName(relationship.target)} (${snakeCase(relationship.targetField)}) ON DELETE ${onDelete};`,
        "",
      );
    }
  }
  lines.push(`CREATE TABLE IF NOT EXISTS air_outbox (id UUID PRIMARY KEY, message_type TEXT NOT NULL, schema_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, producer TEXT NOT NULL, correlation_id UUID NOT NULL, causation_id UUID, ordering_key TEXT, payload JSONB NOT NULL, destination TEXT NOT NULL, message_kind TEXT NOT NULL CHECK (message_kind IN ('event','task')), attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ);`,
    `CREATE INDEX IF NOT EXISTS air_outbox_pending ON air_outbox (available_at) WHERE published_at IS NULL;`,
    `CREATE TABLE IF NOT EXISTS air_inbox (consumer TEXT NOT NULL, message_id UUID NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id));`,
    `CREATE TABLE IF NOT EXISTS air_dead_letters (id UUID PRIMARY KEY, consumer TEXT NOT NULL, envelope JSONB NOT NULL, attempts INTEGER NOT NULL, reason TEXT NOT NULL, failed_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    `CREATE TABLE IF NOT EXISTS air_saga_instances (id UUID PRIMARY KEY, saga_type TEXT NOT NULL, correlation_id TEXT NOT NULL, state JSONB NOT NULL, status TEXT NOT NULL, current_step TEXT, version BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (saga_type, correlation_id));`,
    `CREATE TABLE IF NOT EXISTS air_saga_timers (id UUID PRIMARY KEY, saga_id UUID NOT NULL REFERENCES air_saga_instances(id) ON DELETE CASCADE, step_id TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL, claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ);`,
    `CREATE TABLE IF NOT EXISTS air_realtime_journal (cursor BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL, envelope JSONB NOT NULL, ordering_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    `CREATE INDEX IF NOT EXISTS air_realtime_channel_cursor ON air_realtime_journal (channel, cursor);`);
  return `${lines.join("\n").trimEnd()}\n`;
}

function entityMetadata(air: AirDocument): Record<string, { table: string; fields: Record<string, string>; primary?: string }> {
  return Object.fromEntries(Object.entries(air.spec.entities).map(([name, entity]) => {
    const primary = Object.entries(entity.fields).find(([, field]) => field.primaryKey)?.[0] ?? (entity.fields.id ? "id" : undefined);
    return [name, {
      table: tableName(name),
      fields: Object.fromEntries(Object.keys(entity.fields).map((field) => [field, snakeCase(field)])),
      ...(primary ? { primary } : {}),
    }];
  }));
}

function renderAsyncRuntime(air: AirDocument): string {
  const encoded = JSON.stringify(JSON.stringify({ application: air.metadata.name, events: air.spec.events ?? {}, tasks: air.spec.tasks ?? {}, consumers: air.spec.consumers ?? {}, schedules: air.spec.schedules ?? {}, cachedReads: air.spec.cachedReads ?? {}, realtime: air.spec.realtime ?? {} }));
  return `from __future__ import annotations
import asyncio, json, logging, os, sys
from datetime import datetime, timezone
import psycopg
from psycopg.rows import dict_row
from opentelemetry import metrics, trace

AIR_ASYNC = json.loads(${encoded})
LOGGER = logging.getLogger("air.async")
TRACER = trace.get_tracer("air.runtime")
METER = metrics.get_meter("air.runtime")
DELIVERIES = METER.create_counter("air.consumer.deliveries")
RETRIES = METER.create_counter("air.consumer.retries")

def database_url():
    value = os.getenv("DATABASE_URL")
    if not value: raise RuntimeError("DATABASE_URL is required")
    return value

async def publish(destination, envelope):
    provider = os.getenv("AIR_BROKER_PROVIDER", "postgres")
    if provider == "postgres":
        with psycopg.connect(database_url(), autocommit=True) as connection:
            connection.execute("SELECT pg_notify(%s, %s)", (destination, json.dumps(envelope, default=str)))
        return
    raise RuntimeError(f"Provider {provider} must be attached through its explicitly configured AIR provider adapter")

async def worker():
    while True:
        with psycopg.connect(database_url(), autocommit=True, row_factory=dict_row) as connection:
            rows = connection.execute("SELECT * FROM air_outbox WHERE published_at IS NULL AND available_at <= now() ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 100").fetchall()
            for row in rows:
                envelope = {"id": str(row["id"]), "type": row["message_type"], "schemaVersion": row["schema_version"], "occurredAt": row["occurred_at"].isoformat(), "producer": row["producer"], "correlationId": str(row["correlation_id"]), "causationId": str(row["causation_id"]) if row["causation_id"] else None, "orderingKey": row["ordering_key"], "payload": row["payload"]}
                try:
                    await publish(row["destination"], envelope)
                    connection.execute("UPDATE air_outbox SET published_at=now() WHERE id=%s", (row["id"],))
                    DELIVERIES.add(1, {"destination": row["destination"]})
                except Exception:
                    LOGGER.exception("air.outbox.publish_failed")
                    connection.execute("UPDATE air_outbox SET attempts=attempts+1, available_at=now()+make_interval(secs => least(300, power(2, attempts)::int)) WHERE id=%s", (row["id"],))
                    RETRIES.add(1, {"destination": row["destination"]})
        await asyncio.sleep(0.01 if rows else 0.25)

async def scheduler():
    while True:
        LOGGER.info(json.dumps({"event": "air.scheduler.tick", "schedules": list(AIR_ASYNC["schedules"]), "timestamp": datetime.now(timezone.utc).isoformat()}))
        await asyncio.sleep(1)

async def orchestrator():
    while True:
        with psycopg.connect(database_url(), autocommit=True) as connection:
            connection.execute("UPDATE air_saga_timers SET claimed_at=now() WHERE id IN (SELECT id FROM air_saga_timers WHERE completed_at IS NULL AND claimed_at IS NULL AND due_at <= now() FOR UPDATE SKIP LOCKED LIMIT 100)")
        await asyncio.sleep(.25)

async def main():
    role = sys.argv[1] if len(sys.argv) > 1 else os.getenv("AIR_COMPONENT_ROLE", "worker")
    if role == "worker": await worker()
    elif role == "scheduler": await scheduler()
    elif role == "orchestrator": await orchestrator()
    elif role == "realtime":
        import uvicorn
        from app import app
        config = uvicorn.Config(app, host="0.0.0.0", port=int(os.getenv("AIR_PORT", "3000")))
        await uvicorn.Server(config).serve()
    else: raise RuntimeError(f"Unknown AIR runtime role {role}")

if __name__ == "__main__": asyncio.run(main())
`;
}

function renderApplication(air: AirDocument): string {
  const encodedAir = JSON.stringify(JSON.stringify(air));
  const encodedEntities = JSON.stringify(JSON.stringify(entityMetadata(air)));
  return `# Generated by AIR. Changes are overwritten in managed mode.
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import jwt
import psycopg
from fastapi import Body, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response, StreamingResponse
from psycopg.errors import DeadlockDetected, DuplicateObject, DuplicateTable, SerializationFailure, UniqueViolation
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import ConfigDict, Field, ValidationError, create_model

AIR: dict[str, Any] = json.loads(${encodedAir})
ENTITIES: dict[str, Any] = json.loads(${encodedEntities})
LOGGER = logging.getLogger("air.runtime")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format='{"level":"%(levelname)s","event":"%(message)s"}')
POOL: Any = None


class DomainError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False):
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)


def database_url() -> str:
    value = os.getenv("DATABASE_URL")
    if not value:
        raise RuntimeError("DATABASE_URL is required.")
    return value


def connect():
    if POOL is None:
        raise RuntimeError("Database pool is not initialized.")
    return POOL.connection()


def python_type(field: dict[str, Any]):
    value = {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
        "uuid": UUID,
        "date": date,
        "datetime": datetime,
        "json": Any,
    }[field["type"]]
    return value | None if field.get("nullable", False) else value


def model_field(field: dict[str, Any], required: bool):
    validation = field.get("validation", {})
    constraints: dict[str, Any] = {}
    if "minimum" in validation:
        constraints["ge"] = validation["minimum"]
    if "maximum" in validation:
        constraints["le"] = validation["maximum"]
    if "minLength" in validation:
        constraints["min_length"] = validation["minLength"]
    if "maxLength" in validation:
        constraints["max_length"] = validation["maxLength"]
    if "pattern" in validation:
        constraints["pattern"] = validation["pattern"]
    default = ... if required else field.get("default", None)
    return python_type(field), Field(default, **constraints)


def build_models() -> dict[str, Any]:
    models: dict[str, Any] = {}
    configuration = ConfigDict(extra="forbid")
    for name, contract in AIR["spec"].get("contracts", {}).items():
        definitions = {field_name: model_field(field, not field.get("nullable", False) and "default" not in field) for field_name, field in contract["fields"].items()}
        models[f"contract:{name}"] = create_model(name, __config__=configuration, **cast(Any, definitions))
    for name, entity in AIR["spec"]["entities"].items():
        create_definitions = {
            field_name: model_field(field, not field.get("nullable", False) and "default" not in field)
            for field_name, field in entity["fields"].items()
            if not field.get("generated")
        }
        update_definitions = {
            field_name: (python_type({**field, "nullable": True}), Field(None))
            for field_name, field in entity["fields"].items()
            if not field.get("generated") and not field.get("primaryKey")
        }
        models[f"create:{name}"] = create_model(f"Create{name}Input", __config__=configuration, **cast(Any, create_definitions))
        models[f"update:{name}"] = create_model(f"Update{name}Input", __config__=configuration, **cast(Any, update_definitions))
    return models


MODELS = build_models()


def validate_payload(model_name: str, payload: dict[str, Any], partial: bool = False) -> dict[str, Any]:
    model = MODELS[model_name].model_validate(payload)
    return model.model_dump(mode="json", exclude_unset=partial)


def error_for(command: dict[str, Any], code: str) -> DomainError:
    definition = command["errors"][code]
    return DomainError(definition["status"], code, definition["message"], definition.get("retryable", False))


def authenticate(request: Request, error: DomainError) -> dict[str, Any]:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise error
    secret = os.getenv("AIR_AUTH_SECRET")
    if not secret:
        raise RuntimeError("AIR_AUTH_SECRET is required.")
    try:
        return jwt.decode(header[7:], secret, algorithms=["HS256"], options={"require": ["exp"]})
    except jwt.PyJWTError as exception:
        raise error from exception


def entity_row(entity_name: str, row: dict[str, Any]) -> dict[str, Any]:
    return {name: jsonable_encoder(row[column]) for name, column in ENTITIES[entity_name]["fields"].items() if column in row}


def columns(entity_name: str, selected: list[str] | None = None) -> str:
    fields = selected or list(ENTITIES[entity_name]["fields"])
    return ", ".join(ENTITIES[entity_name]["fields"][field] for field in fields)


def reference(value: dict[str, Any], payload: dict[str, Any]) -> Any:
    if "input" in value:
        return payload[value["input"]]
    return value.get("literal")


def message_reference(value: dict[str, Any], payload: dict[str, Any], record: dict[str, Any], principal: dict[str, Any]) -> Any:
    if "input" in value: return payload.get(value["input"])
    if "literal" in value: return value["literal"]
    if "principal" in value: return principal.get(value["principal"])
    target = value["record"]
    return record.get(target if isinstance(target, str) else target["field"])


def operand(value: dict[str, Any], payload: dict[str, Any], records: dict[str, dict[str, Any]]) -> Any:
    if "input" in value:
        return payload[value["input"]]
    if "literal" in value:
        return value["literal"]
    record = value["record"]
    return records[record["effect"]][record["field"]]


def condition_holds(condition: dict[str, Any], payload: dict[str, Any], records: dict[str, dict[str, Any]]) -> bool:
    left = operand(condition["left"], payload, records)
    right = operand(condition["right"], payload, records)
    return {
        "equals": left == right,
        "not-equals": left != right,
        "greater-than": left > right,
        "greater-than-or-equal": left >= right,
        "less-than": left < right,
        "less-than-or-equal": left <= right,
    }[condition["operator"]]


def assignments(values: dict[str, Any], payload: dict[str, Any]) -> tuple[list[tuple[str, str]], list[Any]]:
    sql: list[tuple[str, str]] = []
    parameters: list[Any] = []
    for field, assignment in values.items():
        column = None
        if "increment" in assignment or "decrement" in assignment:
            key = "increment" if "increment" in assignment else "decrement"
            operator = "+" if key == "increment" else "-"
            change = assignment[key]
            column = f"{operator} %s"
            parameters.append(change if isinstance(change, (int, float)) else payload[change["input"]])
        else:
            column = "%s"
            parameters.append(reference(assignment, payload))
        sql.append((field, column))
    return sql, parameters


def authorization(command: dict[str, Any], payload: dict[str, Any], principal: dict[str, Any], records: dict[str, dict[str, Any]], phase: str) -> None:
    for rule in command.get("authorization", {}).get("rules", []):
        kind = rule["kind"]
        if phase == "input" and kind == "input-equals-principal" and payload[rule["input"]] != principal[rule["principalField"]]:
            raise error_for(command, rule["error"])
        if phase == "input" and kind == "principal-field-in" and principal.get(rule["principalField"]) not in rule["values"]:
            raise error_for(command, rule["error"])
        if phase == "record" and kind == "record-field-equals-principal":
            record_name = rule.get("effect", "primary")
            if records[record_name][rule["field"]] != principal[rule["principalField"]]:
                raise error_for(command, rule["error"])


def execute_command_once(command_name: str, payload: dict[str, Any], principal: dict[str, Any]) -> dict[str, Any]:
    command = AIR["spec"]["commands"][command_name]
    records: dict[str, dict[str, Any]] = {}
    with connect() as connection:
        with connection.transaction():
            isolation = command.get("transaction", {}).get("isolation")
            if isolation:
                connection.execute("SET TRANSACTION ISOLATION LEVEL " + isolation.replace("-", " ").upper())
            authorization(command, payload, principal, records, "input")

            idem = command.get("idempotency")
            if idem:
                metadata = ENTITIES[idem["entity"]]
                row = connection.execute(
                    f"SELECT {columns(idem['entity'], command['output']['fields'])} FROM {metadata['table']} WHERE {metadata['fields'][idem['field']]} = %s AND {metadata['fields'][idem['scopeField']]} = %s",
                    (payload[idem["input"]], principal[idem["scopePrincipalField"]]),
                ).fetchone()
                if row is not None:
                    return entity_row(idem["entity"], row)

            for guard in command.get("guards", []):
                metadata = ENTITIES[guard["entity"]]
                found = connection.execute(
                    f"SELECT EXISTS(SELECT 1 FROM {metadata['table']} WHERE {metadata['fields'][guard['field']]} = %s) AS found",
                    (payload[guard["value"]["input"]],),
                ).fetchone()["found"]
                if not found:
                    raise error_for(command, guard["error"])

            effects = dict(command.get("effects", {}))
            if command["effect"]["kind"] in ("update", "delete"):
                effects["primary"] = command["effect"]
            for effect_name, effect in effects.items():
                metadata = ENTITIES[effect["entity"]]
                row = connection.execute(
                    f"SELECT {columns(effect['entity'])} FROM {metadata['table']} WHERE {metadata['fields'][effect['identify']['field']]} = %s FOR UPDATE",
                    (reference(effect["identify"]["value"], payload),),
                ).fetchone()
                if row is None:
                    raise error_for(command, effect["identify"]["error"])
                records[effect_name] = entity_row(effect["entity"], row)
                for precondition in effect.get("preconditions", []):
                    if records[effect_name][precondition["field"]] != reference(precondition["equals"], payload):
                        raise error_for(command, precondition["error"])

            authorization(command, payload, principal, records, "record")
            for invariant in command.get("invariants", []):
                if not condition_holds(invariant["condition"], payload, records):
                    raise error_for(command, invariant["error"])

            for effect_name, effect in command.get("effects", {}).items():
                metadata = ENTITIES[effect["entity"]]
                sql_assignments, parameters = assignments(effect["values"], payload)
                rendered = [f"{metadata['fields'][field]} = {metadata['fields'][field]} {expression}" if expression.startswith(("+", "-")) else f"{metadata['fields'][field]} = {expression}" for field, expression in sql_assignments]
                parameters.append(reference(effect["identify"]["value"], payload))
                connection.execute(
                    f"UPDATE {metadata['table']} SET {', '.join(rendered)} WHERE {metadata['fields'][effect['identify']['field']]} = %s",
                    parameters,
                )

            primary = command["effect"]
            metadata = ENTITIES[primary["entity"]]
            selected = command["output"]["fields"]
            if primary["kind"] == "create":
                fields = list(primary["values"])
                values = [reference(primary["values"][field], payload) for field in fields]
                row = connection.execute(
                    f"INSERT INTO {metadata['table']} ({', '.join(metadata['fields'][field] for field in fields)}) VALUES ({', '.join(['%s'] * len(fields))}) RETURNING {columns(primary['entity'], selected)}",
                    values,
                ).fetchone()
            elif primary["kind"] == "update":
                sql_assignments, parameters = assignments(primary["values"], payload)
                rendered = [f"{metadata['fields'][field]} = {metadata['fields'][field]} {expression}" if expression.startswith(("+", "-")) else f"{metadata['fields'][field]} = {expression}" for field, expression in sql_assignments]
                parameters.append(reference(primary["identify"]["value"], payload))
                row = connection.execute(
                    f"UPDATE {metadata['table']} SET {', '.join(rendered)} WHERE {metadata['fields'][primary['identify']['field']]} = %s RETURNING {columns(primary['entity'], selected)}",
                    parameters,
                ).fetchone()
            else:
                row = connection.execute(
                    f"DELETE FROM {metadata['table']} WHERE {metadata['fields'][primary['identify']['field']]} = %s RETURNING {columns(primary['entity'], selected)}",
                    (reference(primary["identify"]["value"], payload),),
                ).fetchone()
            if row is None:
                raise RuntimeError(f"Command {command_name} did not return its output row.")
            output = entity_row(primary["entity"], row)
            for kind, messages in (("event", command.get("emits", [])), ("task", command.get("enqueues", []))):
                for message in messages:
                    message_name = message[kind]
                    definition = AIR["spec"]["events" if kind == "event" else "tasks"][message_name]
                    message_id, correlation_id = uuid4(), uuid4()
                    body = {name: message_reference(value, payload, output, principal) for name, value in message["payload"].items()}
                    ordering_key = str(message_reference(message["key"], payload, output, principal)) if message.get("key") else None
                    envelope = {"id": str(message_id), "type": message_name, "schemaVersion": definition.get("version", "1"), "occurredAt": datetime.now(timezone.utc).isoformat(), "producer": AIR["metadata"]["name"], "correlationId": str(correlation_id), "orderingKey": ordering_key, "payload": body}
                    connection.execute("INSERT INTO air_outbox (id,message_type,schema_version,occurred_at,producer,correlation_id,ordering_key,payload,destination,message_kind) VALUES (%s,%s,%s,now(),%s,%s,%s,%s,%s,%s)", (message_id, message_name, definition.get("version", "1"), AIR["metadata"]["name"], correlation_id, ordering_key, json.dumps(body), message_name, kind))
                    if kind == "event":
                        for channel_name, channel in AIR["spec"].get("realtime", {}).items():
                            if any(subscription["event"] == message_name for subscription in channel["subscriptions"]):
                                connection.execute("INSERT INTO air_realtime_journal (channel,envelope,ordering_key) VALUES (%s,%s,%s)", (channel_name, json.dumps(envelope), ordering_key))
            return output


def execute_command(command_name: str, payload: dict[str, Any], principal: dict[str, Any]) -> dict[str, Any]:
    command = AIR["spec"]["commands"][command_name]
    maximum = command.get("transaction", {}).get("retry", {}).get("maxAttempts", 1)
    for attempt in range(maximum):
        try:
            return execute_command_once(command_name, payload, principal)
        except (SerializationFailure, DeadlockDetected, UniqueViolation):
            if attempt + 1 == maximum:
                conflict = command.get("transaction", {}).get("conflictError")
                if conflict:
                    raise error_for(command, conflict)
                raise
            time.sleep(0.005 * (attempt + 1))
    raise RuntimeError("unreachable")


def authorize_crud(operation: dict[str, Any], request: Request) -> None:
    policy = operation.get("authorization")
    if not policy:
        return
    principal = authenticate(request, DomainError(401, "UNAUTHENTICATED", "Authentication is required."))
    for rule in policy.get("rules", []):
        if rule["kind"] == "principal-field-in" and principal.get(rule["principalField"]) not in rule["values"]:
            raise DomainError(403, "FORBIDDEN", "The authenticated principal cannot perform this operation.")


def list_entity(operation: dict[str, Any], request: Request) -> list[dict[str, Any]]:
    authorize_crud(operation, request)
    entity_name = operation["entity"]
    metadata = ENTITIES[entity_name]
    collection = operation.get("collection", {})
    predicates: list[str] = []
    parameters: list[Any] = []
    for item in collection.get("filters", []):
        if item["parameter"] in request.query_params:
            predicates.append(f"{metadata['fields'][item['field']]} = %s")
            parameters.append(request.query_params[item["parameter"]])
    sql = f"SELECT {columns(entity_name)} FROM {metadata['table']}"
    if predicates:
        sql += " WHERE " + " AND ".join(predicates)
    if collection.get("orderBy"):
        sql += " ORDER BY " + ", ".join(f"{metadata['fields'][item['field']]} {item['direction'].upper()}" for item in collection["orderBy"])
    pagination = collection.get("pagination")
    if pagination:
        limit = int(request.query_params.get("limit", pagination["defaultLimit"]))
        offset = int(request.query_params.get("offset", 0))
        if limit < 1 or limit > pagination["maxLimit"] or offset < 0:
            raise DomainError(400, "INVALID_INPUT", "Invalid collection pagination.")
        sql += " LIMIT %s OFFSET %s"
        parameters.extend([limit, offset])
    with connect() as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [entity_row(entity_name, row) for row in rows]


def mutate_or_read_entity(operation: dict[str, Any], request: Request, payload: dict[str, Any] | None) -> Any:
    authorize_crud(operation, request)
    entity_name = operation["entity"]
    entity = AIR["spec"]["entities"][entity_name]
    metadata = ENTITIES[entity_name]
    action = operation["action"]
    primary = metadata.get("primary")
    with connect() as connection:
        if action == "create":
            supplied = [field for field in entity["fields"] if field in (payload or {}) and not entity["fields"][field].get("generated")]
            if supplied:
                row = connection.execute(
                    f"INSERT INTO {metadata['table']} ({', '.join(metadata['fields'][field] for field in supplied)}) VALUES ({', '.join(['%s'] * len(supplied))}) RETURNING {columns(entity_name)}",
                    [(payload or {})[field] for field in supplied],
                ).fetchone()
            else:
                row = connection.execute(f"INSERT INTO {metadata['table']} DEFAULT VALUES RETURNING {columns(entity_name)}").fetchone()
            if row is None:
                raise RuntimeError(f"Create for {entity_name} did not return a row.")
            return entity_row(entity_name, row)
        if primary is None:
            raise RuntimeError(f"Entity {entity_name} has no primary key.")
        identity = request.path_params.get(primary)
        if identity is None:
            identity = next(iter(request.path_params.values()), None)
        if action == "read":
            row = connection.execute(
                f"SELECT {columns(entity_name)} FROM {metadata['table']} WHERE {metadata['fields'][primary]} = %s",
                (identity,),
            ).fetchone()
        elif action == "update":
            supplied = [field for field in entity["fields"] if field in (payload or {}) and field != primary and not entity["fields"][field].get("generated")]
            if not supplied:
                raise DomainError(400, "INVALID_INPUT", "At least one updatable field is required.")
            parameters = [(payload or {})[field] for field in supplied] + [identity]
            row = connection.execute(
                f"UPDATE {metadata['table']} SET {', '.join(metadata['fields'][field] + ' = %s' for field in supplied)} WHERE {metadata['fields'][primary]} = %s RETURNING {columns(entity_name)}",
                parameters,
            ).fetchone()
        else:
            row = connection.execute(
                f"DELETE FROM {metadata['table']} WHERE {metadata['fields'][primary]} = %s RETURNING {columns(entity_name)}",
                (identity,),
            ).fetchone()
        if row is None:
            raise DomainError(404, "NOT_FOUND", f"{entity_name} was not found.")
        return entity_row(entity_name, row)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global POOL
    migration = (Path(__file__).parent / "migrations" / "0001_air.sql").read_text()
    with cast(Any, psycopg.connect)(database_url(), autocommit=True, row_factory=dict_row) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS air_schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        applied = connection.execute("SELECT 1 FROM air_schema_migrations WHERE version = %s", ("0001_air",)).fetchone()
        if applied is None:
            for statement in migration.split(";"):
                if statement.strip():
                    try:
                        connection.execute(statement)
                    except (DuplicateObject, DuplicateTable):
                        pass
            connection.execute("INSERT INTO air_schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING", ("0001_air",))
    pool = cast(Any, ConnectionPool)(database_url(), min_size=1, max_size=int(os.getenv("AIR_DATABASE_POOL_SIZE", "20")), kwargs={"row_factory": dict_row})
    pool.wait()
    POOL = pool
    LOGGER.info("air.server.started")
    yield
    pool.close()
    POOL = None
    LOGGER.info("air.shutdown.completed")


app = FastAPI(title=AIR["metadata"].get("displayName", AIR["metadata"]["name"]), lifespan=lifespan)


@app.exception_handler(DomainError)
async def domain_error_handler(_: Request, error: DomainError):
    return JSONResponse(status_code=error.status, content={"error": {"code": error.code, "message": error.message, "retryable": error.retryable}})


@app.exception_handler(ValidationError)
async def validation_error_handler(_: Request, error: ValidationError):
    return JSONResponse(status_code=422, content={"error": {"code": "INVALID_INPUT", "message": "Request validation failed.", "retryable": False, "issues": error.errors(include_url=False)}})


@app.get("/air-runtime/health")
def health():
    return {"status": "ok"}


@app.get("/air-runtime/ready")
def ready():
    try:
        with connect() as connection:
            connection.execute("SELECT 1").fetchone()
        return {"status": "ready"}
    except Exception:
        LOGGER.exception("air.readiness.failed")
        return JSONResponse(status_code=503, content={"status": "not_ready", "error": {"code": "DATABASE_UNAVAILABLE", "retryable": True}})


def command_endpoint(operation: dict[str, Any]):
    def endpoint(request: Request, payload: dict[str, Any] = Body(...)):
        command = AIR["spec"]["commands"][operation["command"]]
        payload = validate_payload(f"contract:{command['input']}", payload)
        principal: dict[str, Any] = {}
        if command.get("authorization"):
            principal = authenticate(request, error_for(command, command["authorization"]["unauthenticatedError"]))
        output = execute_command(operation["command"], payload, principal)
        status = 201 if command["effect"]["kind"] == "create" else 200
        return JSONResponse(status_code=status, content=jsonable_encoder(output))
    return endpoint


def list_endpoint(operation: dict[str, Any]):
    def endpoint(request: Request):
        return list_entity(operation, request)
    return endpoint


def crud_endpoint(operation: dict[str, Any]):
    if operation["action"] in ("create", "update"):
        def create_update_endpoint(request: Request, payload: dict[str, Any] = Body(...)):
            payload = validate_payload(f"{operation['action']}:{operation['entity']}", payload, operation["action"] == "update")
            output = mutate_or_read_entity(operation, request, payload)
            return JSONResponse(status_code=201 if operation["action"] == "create" else 200, content=jsonable_encoder(output))
        return create_update_endpoint
    else:
        def read_delete_endpoint(request: Request):
            output = mutate_or_read_entity(operation, request, None)
            if operation["action"] == "delete":
                return Response(status_code=204)
            return output
        return read_delete_endpoint


for operation in AIR["spec"].get("http", {}).get("operations", []):
    if "command" in operation:
        app.add_api_route(operation["path"], command_endpoint(operation), methods=[operation["method"]], name=operation["id"])
    elif operation["action"] == "list":
        app.add_api_route(operation["path"], list_endpoint(operation), methods=[operation["method"]], name=operation["id"])
    else:
        app.add_api_route(operation["path"], crud_endpoint(operation), methods=[operation["method"]], name=operation["id"])


@app.websocket("/air-runtime/realtime/{channel_name}")
async def realtime_socket(websocket: WebSocket, channel_name: str):
    channel = AIR["spec"].get("realtime", {}).get(channel_name)
    if channel is None or "websocket" not in channel["transports"]:
        await websocket.close(code=4404)
        return
    if channel.get("principal"):
        token = websocket.query_params.get("token")
        secret = os.getenv("AIR_AUTH_SECRET")
        if not token or not secret:
            await websocket.close(code=4401)
            return
        try: jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["exp"]})
        except jwt.PyJWTError:
            await websocket.close(code=4401)
            return
    await websocket.accept()
    cursor = int(websocket.query_params.get("cursor", "0"))
    try:
        while True:
            with connect() as connection:
                frames = connection.execute("SELECT cursor,envelope FROM air_realtime_journal WHERE channel=%s AND cursor>%s ORDER BY cursor LIMIT %s", (channel_name, cursor, channel["buffer"]["maxMessages"])).fetchall()
            for frame in frames:
                await websocket.send_json({"cursor": frame["cursor"], "envelope": frame["envelope"]})
                cursor = frame["cursor"]
            try:
                request = await asyncio.wait_for(websocket.receive_json(), timeout=.1)
                mapping = next((item for item in channel.get("commands", []) if item["type"] == request.get("type")), None)
                if mapping: await websocket.send_json({"type": "reply", "requestId": request.get("id"), "accepted": True})
            except asyncio.TimeoutError: pass
    except WebSocketDisconnect: pass


@app.get("/air-runtime/events/{channel_name}")
async def realtime_sse(channel_name: str, cursor: int = 0):
    channel = AIR["spec"].get("realtime", {}).get(channel_name)
    if channel is None or "sse" not in channel["transports"]:
        return JSONResponse(status_code=404, content={"error": {"code": "CHANNEL_NOT_FOUND"}})
    async def stream():
        current = cursor
        while True:
            with connect() as connection:
                frames = connection.execute("SELECT cursor,envelope FROM air_realtime_journal WHERE channel=%s AND cursor>%s ORDER BY cursor LIMIT %s", (channel_name, current, channel["buffer"]["maxMessages"])).fetchall()
            for frame in frames:
                current = frame["cursor"]
                yield f"id: {current}\\ndata: {json.dumps(frame['envelope'], default=str)}\\n\\n"
            await asyncio.sleep(.25)
    return StreamingResponse(stream(), media_type="text/event-stream")
`;
}

export function renderPythonFiles(air: AirDocument, options: ResolvedPythonTargetOptions): readonly PlannedPythonFile[] {
  const files: PlannedPythonFile[] = [
    {
      path: "pyproject.toml", kind: "configuration", airNodes: ["/metadata"],
      content: `[project]\nname = ${JSON.stringify(snakeCase(air.metadata.name).replaceAll("_", "-"))}\nversion = "0.1.0"\nrequires-python = ">=${options.pythonVersion}"\ndependencies = [\n  "fastapi==0.115.12",\n  "psycopg[binary]==3.2.9",\n  "psycopg-pool==3.2.6",\n  "PyJWT==2.10.1",\n  "opentelemetry-api==1.38.0",\n  "uvicorn[standard]==0.34.3",\n]\n\n[dependency-groups]\ndev = ["pyright==1.1.408", "ruff==0.14.2"]\n\n[tool.pyright]\npythonVersion = "${options.pythonVersion.split(".").slice(0, 2).join(".")}"\ntypeCheckingMode = "basic"\nvenvPath = "."\nvenv = ".venv"\n\n[tool.ruff]\nline-length = 120\ntarget-version = "py${options.pythonVersion.split(".").slice(0, 2).join("")}"\n\n[tool.uvicorn]\nfactory = false\n`,
    },
    { path: "requirements.txt", kind: "configuration", airNodes: ["/metadata"], content: "fastapi==0.115.12\npsycopg[binary]==3.2.9\npsycopg-pool==3.2.6\nPyJWT==2.10.1\nopentelemetry-api==1.38.0\nuvicorn[standard]==0.34.3\n" },
    { path: "requirements-dev.txt", kind: "configuration", airNodes: ["/metadata"], content: "-r requirements.txt\npyright==1.1.408\nruff==0.14.2\n" },
    { path: ".env.example", kind: "configuration", airNodes: ["/"], content: "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app\nAIR_AUTH_SECRET=replace-with-at-least-32-random-characters\nAIR_PORT=3000\n" },
    { path: "migrations/0001_air.sql", kind: "source", airNodes: ["/spec/entities"], content: renderMigration(air) },
    { path: "app.py", kind: "source", airNodes: ["/spec"], content: renderApplication(air) },
    { path: "air_runtime.py", kind: "source", airNodes: ["/spec/events", "/spec/tasks", "/spec/consumers", "/spec/schedules", "/spec/cachedReads", "/spec/realtime"], content: renderAsyncRuntime(air) },
    {
      path: "Dockerfile", kind: "configuration", airNodes: ["/metadata"],
      content: `FROM python:${options.pythonVersion}-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('AIR_PORT','3000')+'/air-runtime/health')"]\nCMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port \${AIR_PORT:-3000}"]\n`,
    },
    {
      path: "README.md", kind: "documentation", airNodes: ["/"],
      content: `# ${air.metadata.displayName ?? air.metadata.name}\n\nGenerated by AIR for Python, FastAPI, psycopg, and PostgreSQL.\n\n\`\`\`bash\npython -m venv .venv\n. .venv/bin/activate\npip install -r requirements.txt\nuvicorn app:app --port 3000\n\`\`\`\n`,
    },
  ];
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

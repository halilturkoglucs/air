import { spawnSync } from "node:child_process";
import type {
  AirDocument,
  CommandAssignment,
  CommandDefinition,
  CommandUpdateEffect,
  ConstraintValue,
  CrudHttpOperation,
  EntityDefinition,
  FieldDefinition,
  HttpOperation,
  InvariantExpression,
  InvariantOperand,
} from "@air/schema";
import { pascalCase, rustIdentifier, snakeCase, tableName } from "./naming.js";
import type { PlannedRustFile, ResolvedRustTargetOptions } from "./types.js";

function rustBaseType(field: Pick<FieldDefinition, "type">): string {
  switch (field.type) {
    case "string": return "String";
    case "integer": return "i64";
    case "number": return "f64";
    case "boolean": return "bool";
    case "uuid": return "Uuid";
    case "date": return "NaiveDate";
    case "datetime": return "DateTime<Utc>";
    case "json": return "serde_json::Value";
  }
}

function rustType(field: Pick<FieldDefinition, "type" | "nullable">): string {
  const base = rustBaseType(field);
  return field.nullable ? `Option<${base}>` : base;
}

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

function rustLiteral(value: ConstraintValue): string {
  if (value === null) return "serde_json::Value::Null";
  if (typeof value === "string") return `${JSON.stringify(value)}.to_string()`;
  return String(value);
}

function primaryField(entity: EntityDefinition): [string, FieldDefinition] | undefined {
  return Object.entries(entity.fields).find(([, field]) => field.primaryKey === true) ??
    (entity.fields.id ? ["id", entity.fields.id] : undefined);
}

function columnList(entity: EntityDefinition): string {
  return Object.keys(entity.fields).map(snakeCase).join(", ");
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

function renderStruct(name: string, fields: Readonly<Record<string, Pick<FieldDefinition, "type" | "nullable">>>, derives: string): string {
  const body = Object.entries(fields).map(([fieldName, field]) => `    pub ${rustIdentifier(fieldName)}: ${rustType(field)},`).join("\n");
  return `#[derive(${derives})]\n#[serde(rename_all = "camelCase")]\npub struct ${pascalCase(name)} {\n${body}\n}`;
}

function createInputFields(entity: EntityDefinition): Record<string, FieldDefinition> {
  return Object.fromEntries(Object.entries(entity.fields).filter(([, field]) => !field.generated && field.default === undefined));
}

function updateInputFields(entity: EntityDefinition): Record<string, FieldDefinition> {
  return Object.fromEntries(Object.entries(entity.fields).filter(([, field]) => !field.primaryKey && !field.generated).map(([name, field]) => [name, { ...field, nullable: true }]));
}

function bindExpression(reference: { readonly input: string } | { readonly literal: ConstraintValue }, input = "input"): string {
  return "input" in reference ? `&${input}.${rustIdentifier(reference.input)}` : `&${rustLiteral(reference.literal)}`;
}

function renderEntityCrud(entityName: string, entity: EntityDefinition, operations: readonly HttpOperation[]): string {
  const rustName = pascalCase(entityName);
  const table = tableName(entityName);
  const columns = columnList(entity);
  const primary = primaryField(entity);
  const createFields = createInputFields(entity);
  const updateFields = updateInputFields(entity);
  const entityOperations = operations.filter(
    (item): item is CrudHttpOperation => "entity" in item && item.entity === entityName,
  );
  const authorization = (operation: CrudHttpOperation): { parameter: string; prelude: string } => {
    if (!operation.authorization) return { parameter: "", prelude: "" };
    const principalName = pascalCase(operation.authorization.principal);
    const checks = operation.authorization.rules.map((rule) =>
      `    if !${JSON.stringify(rule.values)}.contains(&principal.${rustIdentifier(rule.principalField)}.as_str()) { return Err(AppError::domain(403, "FORBIDDEN", "The authenticated principal cannot perform this operation.", false)); }`,
    ).join("\n");
    return {
      parameter: ", headers: HeaderMap",
      prelude: `    let principal = authenticate::<${principalName}, _>(&headers, || AppError::domain(401, "UNAUTHENTICATED", "Authentication is required.", false))?;\n${checks}\n`,
    };
  };
  const chunks = [renderStruct(entityName, entity.fields, "Debug, Clone, Serialize, Deserialize, FromRow")];
  if (entityOperations.some((operation) => operation.action === "create") && Object.keys(createFields).length > 0) {
    chunks.push(renderStruct(`Create${rustName}Input`, createFields, "Debug, Deserialize"));
  }
  if (entityOperations.some((operation) => operation.action === "update") && Object.keys(updateFields).length > 0) {
    chunks.push(renderStruct(`Update${rustName}Input`, updateFields, "Debug, Deserialize"));
  }

  for (const operation of entityOperations) {
    const functionName = rustIdentifier(operation.id);
    const auth = authorization(operation);
    if (operation.action === "list") {
      const collection = operation.collection;
      if (!collection) {
        chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${auth.parameter}) -> Result<Json<Vec<${rustName}>>, AppError> {\n${auth.prelude}    let rows = sqlx::query_as::<_, ${rustName}>("SELECT ${columns} FROM ${table}")\n        .fetch_all(&state.pool).await?;\n    Ok(Json(rows))\n}`);
      } else {
        const queryName = `${pascalCase(operation.id)}Query`;
        const queryFields = [
          ...(collection.pagination ? ["    pub limit: Option<i64>,", "    pub offset: Option<i64>,"] : []),
          ...(collection.filters ?? []).map((filter) => `    pub ${rustIdentifier(filter.parameter)}: Option<${rustBaseType(entity.fields[filter.field]!)}>,`),
        ];
        chunks.push(`#[derive(Debug, Deserialize)]\npub struct ${queryName} {\n${queryFields.join("\n")}\n}`);
        const filters = collection.filters ?? [];
        let position = 1;
        const predicates = filters.map((filter) => {
          const current = position++;
          return `($${current}::${sqlType(entity.fields[filter.field]!)} IS NULL OR ${snakeCase(filter.field)} = $${current})`;
        });
        const order = (collection.orderBy ?? []).map((item) => `${snakeCase(item.field)} ${item.direction.toUpperCase()}`).join(", ");
        const limitPosition = collection.pagination ? position++ : undefined;
        const offsetPosition = collection.pagination ? position++ : undefined;
        const sql = `SELECT ${columns} FROM ${table}${predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : ""}${order ? ` ORDER BY ${order}` : ""}${limitPosition ? ` LIMIT $${limitPosition} OFFSET $${offsetPosition}` : ""}`;
        const binds = [
          ...filters.map((filter) => `        .bind(&query.${rustIdentifier(filter.parameter)})`),
          ...(collection.pagination ? ["        .bind(limit)", "        .bind(offset)"] : []),
        ].join("\n");
        const pagination = collection.pagination
          ? `    let limit = query.limit.unwrap_or(${collection.pagination.defaultLimit});\n    let offset = query.offset.unwrap_or(0);\n    if !(1..=${collection.pagination.maxLimit}).contains(&limit) || offset < 0 {\n        return Err(AppError::domain(400, "INVALID_INPUT", "Invalid collection pagination.", false));\n    }\n`
          : "";
        chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${auth.parameter}, Query(query): Query<${queryName}>) -> Result<Json<Vec<${rustName}>>, AppError> {\n${auth.prelude}${pagination}    let rows = sqlx::query_as::<_, ${rustName}>(${JSON.stringify(sql)})\n${binds}\n        .fetch_all(&state.pool).await?;\n    Ok(Json(rows))\n}`);
      }
    } else if (operation.action === "read" && primary) {
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${auth.parameter}, Path(id): Path<${rustBaseType(primary[1])}>) -> Result<Json<${rustName}>, AppError> {\n${auth.prelude}    let row = sqlx::query_as::<_, ${rustName}>("SELECT ${columns} FROM ${table} WHERE ${snakeCase(primary[0])} = $1")\n        .bind(id).fetch_optional(&state.pool).await?\n        .ok_or_else(|| AppError::domain(404, "NOT_FOUND", "${rustName} not found.", false))?;\n    Ok(Json(row))\n}`);
    } else if (operation.action === "create") {
      const names = Object.keys(createFields);
      const placeholders = names.map((_, index) => `$${index + 1}`).join(", ");
      const binds = names.map((name) => `        .bind(&input.${rustIdentifier(name)})`).join("\n");
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${auth.parameter}, Json(input): Json<Create${rustName}Input>) -> Result<(StatusCode, Json<${rustName}>), AppError> {\n${auth.prelude}    let row = sqlx::query_as::<_, ${rustName}>("INSERT INTO ${table} (${names.map(snakeCase).join(", ")}) VALUES (${placeholders}) RETURNING ${columns}")\n${binds}\n        .fetch_one(&state.pool).await?;\n    Ok((StatusCode::CREATED, Json(row)))\n}`);
    } else if (operation.action === "update" && primary) {
      const names = Object.keys(updateFields);
      const assignments = names.map((name, index) => `${snakeCase(name)} = COALESCE($${index + 1}, ${snakeCase(name)})`).join(", ");
      const binds = names.map((name) => `        .bind(&input.${rustIdentifier(name)})`).join("\n");
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${auth.parameter}, Path(id): Path<${rustBaseType(primary[1])}>, Json(input): Json<Update${rustName}Input>) -> Result<Json<${rustName}>, AppError> {\n${auth.prelude}    let row = sqlx::query_as::<_, ${rustName}>("UPDATE ${table} SET ${assignments} WHERE ${snakeCase(primary[0])} = $${names.length + 1} RETURNING ${columns}")\n${binds}\n        .bind(id).fetch_optional(&state.pool).await?\n        .ok_or_else(|| AppError::domain(404, "NOT_FOUND", "${rustName} not found.", false))?;\n    Ok(Json(row))\n}`);
    } else if (operation.action === "delete" && primary) {
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${auth.parameter}, Path(id): Path<${rustBaseType(primary[1])}>) -> Result<StatusCode, AppError> {\n${auth.prelude}    let result = sqlx::query("DELETE FROM ${table} WHERE ${snakeCase(primary[0])} = $1").bind(id).execute(&state.pool).await?;\n    if result.rows_affected() == 0 { return Err(AppError::domain(404, "NOT_FOUND", "${rustName} not found.", false)); }\n    Ok(StatusCode::NO_CONTENT)\n}`);
    }
  }
  return chunks.join("\n\n");
}

function operand(expression: InvariantOperand, named: ReadonlySet<string>): string {
  if ("input" in expression) return `input.${rustIdentifier(expression.input)}`;
  if ("principal" in expression) return `principal.${rustIdentifier(expression.principal)}`;
  if ("record" in expression) {
    if (typeof expression.record === "string") return `record.${rustIdentifier(expression.record)}`;
    const recordName = named.has(expression.record.effect) ? `record_${rustIdentifier(expression.record.effect)}` : "record";
    return `${recordName}.${rustIdentifier(expression.record.field)}`;
  }
  return rustLiteral(expression.literal);
}

function invariant(expression: InvariantExpression, named: ReadonlySet<string>): string {
  if ("all" in expression) return `(${expression.all.map((child) => invariant(child, named)).join(" && ")})`;
  if ("any" in expression) return `(${expression.any.map((child) => invariant(child, named)).join(" || ")})`;
  if ("not" in expression) return `!(${invariant(expression.not, named)})`;
  const operator = {
    equals: "==", "not-equals": "!=", "greater-than": ">", "greater-than-or-equal": ">=",
    "less-than": "<", "less-than-or-equal": "<=",
  }[expression.operator];
  return `(${operand(expression.left, named)} ${operator} ${operand(expression.right, named)})`;
}

function invariantFailure(expression: InvariantExpression, named: ReadonlySet<string>): string {
  if ("all" in expression) return `(${expression.all.map((child) => invariantFailure(child, named)).join(" || ")})`;
  if ("any" in expression) return `(${expression.any.map((child) => invariantFailure(child, named)).join(" && ")})`;
  if ("not" in expression) return invariant(expression.not, named);
  const operator = {
    equals: "!=", "not-equals": "==", "greater-than": "<=", "greater-than-or-equal": "<",
    "less-than": ">=", "less-than-or-equal": ">",
  }[expression.operator];
  return `(${operand(expression.left, named)} ${operator} ${operand(expression.right, named)})`;
}

function condition(expression: string): string {
  return expression.startsWith("(") && expression.endsWith(")") ? expression.slice(1, -1) : expression;
}

function errorExpression(command: CommandDefinition, code: string): string {
  const error = command.errors?.[code];
  return `AppError::domain(${error?.status ?? 500}, ${JSON.stringify(code)}, ${JSON.stringify(error?.message ?? code)}, ${error?.retryable === true})`;
}

function assignmentSql(field: string, assignment: CommandAssignment, position: number): { sql: string; bind?: string } {
  const column = snakeCase(field);
  if ("increment" in assignment || "decrement" in assignment) {
    const change = "increment" in assignment ? assignment.increment : assignment.decrement;
    const operator = "increment" in assignment ? "+" : "-";
    if (typeof change === "number") return { sql: `${column} = ${column} ${operator} ${change}` };
    return { sql: `${column} = ${column} ${operator} $${position}`, bind: `&input.${rustIdentifier(change.input)}` };
  }
  return { sql: `${column} = $${position}`, bind: bindExpression(assignment) };
}

function renderUpdateEffect(
  command: CommandDefinition,
  effectName: string,
  effect: CommandUpdateEffect,
  air: AirDocument,
): string {
  const entity = air.spec.entities[effect.entity]!;
  const rustName = pascalCase(effect.entity);
  const record = `record_${rustIdentifier(effectName)}`;
  const selection = bindExpression(effect.identify.value);
  const lines = [
    `    let ${record} = sqlx::query_as::<_, ${rustName}>("SELECT ${columnList(entity)} FROM ${tableName(effect.entity)} WHERE ${snakeCase(effect.identify.field)} = $1 FOR UPDATE")`,
    `        .bind(${selection}).fetch_optional(&mut *tx).await?`,
    `        .ok_or_else(|| ${errorExpression(command, effect.identify.error)})?;`,
  ];
  for (const precondition of effect.preconditions ?? []) {
    const expected = "input" in precondition.equals ? `input.${rustIdentifier(precondition.equals.input)}` : rustLiteral(precondition.equals.literal);
    lines.push(`    if ${record}.${rustIdentifier(precondition.field)} != ${expected} { return Err(${errorExpression(command, precondition.error)}); }`);
  }
  return lines.join("\n");
}

function renderEffectMutation(effectName: string, effect: CommandUpdateEffect): string {
  let position = 1;
  const assignments = Object.entries(effect.values).map(([field, assignment]) => {
    const rendered = assignmentSql(field, assignment, position);
    if (rendered.bind) position += 1;
    return rendered;
  });
  const identifyPosition = position;
  const binds = assignments.flatMap((assignment) => assignment.bind ? [`        .bind(${assignment.bind})`] : []);
  binds.push(`        .bind(${bindExpression(effect.identify.value)})`);
  return `    sqlx::query("UPDATE ${tableName(effect.entity)} SET ${assignments.map((item) => item.sql).join(", ")} WHERE ${snakeCase(effect.identify.field)} = $${identifyPosition}")\n${binds.join("\n")}\n        .execute(&mut *tx).await?; // named effect: ${effectName}`;
}

function messageValue(reference: import("@air/schema").MessageValueReference): string {
  if ("input" in reference) return `input.${rustIdentifier(reference.input)}`;
  if ("literal" in reference) return rustLiteral(reference.literal);
  if ("principal" in reference) return `principal.${rustIdentifier(reference.principal)}`;
  return typeof reference.record === "string"
    ? `output.${rustIdentifier(reference.record)}`
    : `record_${rustIdentifier(reference.record.effect)}.${rustIdentifier(reference.record.field)}`;
}

function renderOutbox(command: CommandDefinition, air: AirDocument): string {
  const messages = [
    ...(command.emits ?? []).map((message) => ({ kind: "event" as const, name: message.event, version: air.spec.events?.[message.event]?.version ?? "1", payload: message.payload, key: message.key })),
    ...(command.enqueues ?? []).map((message) => ({ kind: "task" as const, name: message.task, version: "1", payload: message.payload, key: message.key })),
  ];
  return messages.map((message, index) => {
    const payload = Object.entries(message.payload).map(([name, reference]) => `${JSON.stringify(name)}: ${messageValue(reference)}`).join(", ");
    const key = message.key ? `Some(${messageValue(message.key)}.to_string())` : "None::<String>";
    const journal = message.kind === "event"
      ? Object.entries(air.spec.realtime ?? {}).filter(([, channel]) => channel.subscriptions.some((subscription) => subscription.event === message.name)).map(([channelName]) => `    sqlx::query("INSERT INTO air_realtime_journal (channel,envelope,ordering_key) VALUES ($1,$2,$3)").bind(${JSON.stringify(channelName)}).bind(&envelope_${index}).bind(&ordering_key_${index}).execute(&mut *tx).await?;`).join("\n")
      : "";
    return `    let message_id_${index} = Uuid::new_v4();
    let correlation_id_${index} = Uuid::new_v4();
    let ordering_key_${index} = ${key};
    let payload_${index} = json!({ ${payload} });
    let envelope_${index} = json!({ "id": message_id_${index}, "type": ${JSON.stringify(message.name)}, "schemaVersion": ${JSON.stringify(message.version)}, "occurredAt": Utc::now(), "producer": ${JSON.stringify(air.metadata.name)}, "correlationId": correlation_id_${index}, "orderingKey": ordering_key_${index}, "payload": payload_${index} });
    let _ = &envelope_${index};
    sqlx::query("INSERT INTO air_outbox (id,message_type,schema_version,occurred_at,producer,correlation_id,ordering_key,payload,destination,message_kind) VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9)")
        .bind(message_id_${index}).bind(${JSON.stringify(message.name)}).bind(${JSON.stringify(message.version)}).bind(${JSON.stringify(air.metadata.name)}).bind(correlation_id_${index}).bind(&ordering_key_${index}).bind(&payload_${index}).bind(${JSON.stringify(message.name)}).bind(${JSON.stringify(message.kind)}).execute(&mut *tx).await?;
${journal}`;
  }).join("\n");
}

function renderCommand(name: string, command: CommandDefinition, air: AirDocument): string {
  const inputName = pascalCase(command.input);
  const principalName = command.authorization ? pascalCase(command.authorization.principal) : undefined;
  const outputName = `${pascalCase(name)}Output`;
  const outputEntity = air.spec.entities[command.output.entity]!;
  const outputFields = Object.fromEntries(command.output.fields.map((field) => [field, outputEntity.fields[field]!]));
  const named = new Set(Object.keys(command.effects ?? {}));
  const routeOperation = (air.spec.http?.operations ?? []).find((operation) => "command" in operation && operation.command === name);
  const functionName = rustIdentifier(name);
  const attemptName = `${functionName}_once`;
  const parameters = principalName ? `input: &${inputName}, principal: &${principalName}` : `input: &${inputName}`;
  const callParameters = principalName ? "&input, &principal" : "&input";
  const lines: string[] = [renderStruct(outputName, outputFields, "Debug, Clone, Serialize, FromRow")];

  if (routeOperation) {
    const auth = principalName
      ? `    let principal = authenticate::<${principalName}, _>(&headers, || ${errorExpression(command, command.authorization!.unauthenticatedError)})?;\n`
      : "";
    const headers = principalName ? ", headers: HeaderMap" : "";
    const successStatus = command.effect.kind === "create" ? "CREATED" : "OK";
    lines.push(`pub async fn ${rustIdentifier(routeOperation.id)}_route(State(state): State<AppState>${headers}, Json(input): Json<${inputName}>) -> Result<(StatusCode, Json<${outputName}>), AppError> {\n${auth}    let output = ${functionName}(&state.pool, ${callParameters}).await?;\n    Ok((StatusCode::${successStatus}, Json(output)))\n}`);
  }

  const maxAttempts = command.transaction?.retry?.maxAttempts ?? 1;
  const conflict = command.transaction?.conflictError;
  lines.push(`pub async fn ${functionName}(pool: &PgPool, ${parameters}) -> Result<${outputName}, AppError> {\n    for attempt in 1..=${maxAttempts} {\n        match ${attemptName}(pool, ${principalName ? "input, principal" : "input"}).await {\n            Ok(value) => return Ok(value),\n            Err(error) if attempt < ${maxAttempts} && error.is_retryable_database() => continue,\n            Err(error) if error.is_retryable_database() => return Err(${conflict ? errorExpression(command, conflict) : "error"}),\n            Err(error) => return Err(error),\n        }\n    }\n    unreachable!()\n}`);

  const isolation = command.transaction?.isolation === "serializable"
    ? `    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE").execute(&mut *tx).await?;\n`
    : command.transaction?.isolation === "repeatable-read"
      ? `    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").execute(&mut *tx).await?;\n`
      : "";
  const body: string[] = [`async fn ${attemptName}(pool: &PgPool, ${parameters}) -> Result<${outputName}, AppError> {`, "    let mut tx = pool.begin().await?;", isolation.trimEnd()];
  if (command.authorization && principalName) {
    for (const rule of command.authorization.rules) {
      if (rule.kind === "input-equals-principal") {
        body.push(`    if input.${rustIdentifier(rule.input)} != principal.${rustIdentifier(rule.principalField)} { return Err(${errorExpression(command, rule.error)}); }`);
      } else if (rule.kind === "principal-field-in") {
        body.push(`    if !${JSON.stringify(rule.values)}.contains(&principal.${rustIdentifier(rule.principalField)}.as_str()) { return Err(${errorExpression(command, rule.error)}); }`);
      }
    }
  }
  if (command.idempotency) {
    const idem = command.idempotency;
    const entity = air.spec.entities[idem.entity]!;
    body.push(`    if let Some(replayed) = sqlx::query_as::<_, ${outputName}>("SELECT ${command.output.fields.map(snakeCase).join(", ")} FROM ${tableName(idem.entity)} WHERE ${snakeCase(idem.field)} = $1 AND ${snakeCase(idem.scopeField)} = $2")\n        .bind(&input.${rustIdentifier(idem.input)}).bind(&principal.${rustIdentifier(idem.scopePrincipalField)})\n        .fetch_optional(&mut *tx).await? { tx.commit().await?; return Ok(replayed); }`);
  }
  for (const guard of command.guards ?? []) {
    body.push(`    let guard_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ${tableName(guard.entity)} WHERE ${snakeCase(guard.field)} = $1)")\n        .bind(&input.${rustIdentifier(guard.value.input)}).fetch_one(&mut *tx).await?;\n    if !guard_exists { return Err(${errorExpression(command, guard.error)}); }`);
  }
  for (const [effectName, effect] of Object.entries(command.effects ?? {})) body.push(renderUpdateEffect(command, effectName, effect, air));
  if (command.effect.kind === "update" || command.effect.kind === "delete") {
    const effect = command.effect;
    const entity = air.spec.entities[effect.entity]!;
    body.push(`    let record = sqlx::query_as::<_, ${pascalCase(effect.entity)}>("SELECT ${columnList(entity)} FROM ${tableName(effect.entity)} WHERE ${snakeCase(effect.identify.field)} = $1 FOR UPDATE")\n        .bind(${bindExpression(effect.identify.value)}).fetch_optional(&mut *tx).await?\n        .ok_or_else(|| ${errorExpression(command, effect.identify.error)})?;\n    let _ = &record;`);
  }
  for (const rule of command.authorization?.rules ?? []) {
    if (rule.kind === "record-field-equals-principal") {
      const recordName = rule.effect ? `record_${rustIdentifier(rule.effect)}` : "record";
      body.push(`    if ${recordName}.${rustIdentifier(rule.field)} != principal.${rustIdentifier(rule.principalField)} { return Err(${errorExpression(command, rule.error)}); }`);
    }
  }
  for (const rule of command.invariants ?? []) body.push(`    if ${condition(invariantFailure(rule.condition, named))} { return Err(${errorExpression(command, rule.error)}); }`);
  if (command.effect.kind === "update" || command.effect.kind === "delete") {
    for (const precondition of command.effect.preconditions ?? []) {
      const expected = "input" in precondition.equals ? `input.${rustIdentifier(precondition.equals.input)}` : rustLiteral(precondition.equals.literal);
      body.push(`    if record.${rustIdentifier(precondition.field)} != ${expected} { return Err(${errorExpression(command, precondition.error)}); }`);
    }
  }
  for (const [effectName, effect] of Object.entries(command.effects ?? {})) body.push(renderEffectMutation(effectName, effect));

  if (command.effect.kind === "create") {
    const entries = Object.entries(command.effect.values);
    const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");
    const binds = entries.map(([, value]) => `        .bind(${bindExpression(value)})`).join("\n");
    body.push(`    let output = sqlx::query_as::<_, ${outputName}>("INSERT INTO ${tableName(command.effect.entity)} (${entries.map(([field]) => snakeCase(field)).join(", ")}) VALUES (${placeholders}) RETURNING ${command.output.fields.map(snakeCase).join(", ")}")\n${binds}\n        .fetch_one(&mut *tx).await?;`);
  } else if (command.effect.kind === "update") {
    const effect = command.effect;
    let position = 1;
    const assignments = Object.entries(effect.values).map(([field, assignment]) => {
      const rendered = assignmentSql(field, assignment, position);
      if (rendered.bind) position += 1;
      return rendered;
    });
    const binds = assignments.flatMap((assignment) => assignment.bind ? [`        .bind(${assignment.bind})`] : []);
    binds.push(`        .bind(${bindExpression(effect.identify.value)})`);
    body.push(`    let output = sqlx::query_as::<_, ${outputName}>("UPDATE ${tableName(effect.entity)} SET ${assignments.map((item) => item.sql).join(", ")} WHERE ${snakeCase(effect.identify.field)} = $${position} RETURNING ${command.output.fields.map(snakeCase).join(", ")}")\n${binds.join("\n")}\n        .fetch_one(&mut *tx).await?;`);
  } else {
    const effect = command.effect;
    body.push(`    let output = sqlx::query_as::<_, ${outputName}>("DELETE FROM ${tableName(effect.entity)} WHERE ${snakeCase(effect.identify.field)} = $1 RETURNING ${command.output.fields.map(snakeCase).join(", ")}")
        .bind(${bindExpression(effect.identify.value)}).fetch_one(&mut *tx).await?;`);
  }
  const outbox = renderOutbox(command, air);
  if (outbox) body.push(outbox);
  body.push("    tx.commit().await?;", "    Ok(output)", "}");
  lines.push(body.filter(Boolean).join("\n"));
  return lines.join("\n\n");
}

function renderRouter(air: AirDocument): string {
  const groups = new Map<string, string[]>();
  for (const operation of air.spec.http?.operations ?? []) {
    const path = operation.path.replace(/\{([^}]+)\}/g, "{$1}");
    const handlers = groups.get(path) ?? [];
    const layer = operation.method === "GET" ? "get" : operation.method === "POST" ? "post" : operation.method === "DELETE" ? "delete" : "patch";
    const handler = "command" in operation ? `${rustIdentifier(operation.id)}_route` : rustIdentifier(operation.id);
    handlers.push(`${layer}(${handler})`);
    groups.set(path, handlers);
  }
  const routes = [...groups.entries()].map(([path, handlers]) => `        .route(${JSON.stringify(path)}, ${handlers.join(".")})`).join("\n");
  return `pub async fn air_health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

pub async fn air_ready(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.pool).await {
        Ok(_) => Json(json!({ "status": "ready" })).into_response(),
        Err(error) => {
            tracing::error!(event = "air.readiness.failed", error = %error);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "not_ready", "error": { "code": "DATABASE_UNAVAILABLE", "retryable": true } })),
            ).into_response()
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/air-runtime/health", get(air_health))
        .route("/air-runtime/ready", get(air_ready))
${routes}
        .with_state(state)
}`;
}

function renderGenerated(air: AirDocument): string {
  const operations = air.spec.http?.operations ?? [];
  const contracts = Object.entries(air.spec.contracts ?? {}).map(([name, contract]) => renderStruct(name, contract.fields, "Debug, Clone, Deserialize"));
  const principals = Object.entries(air.spec.principals ?? {}).map(([name, principal]) => renderStruct(name, principal.fields, "Debug, Clone, Deserialize"));
  const entities = Object.entries(air.spec.entities).map(([name, entity]) => renderEntityCrud(name, entity, operations));
  const commands = Object.entries(air.spec.commands ?? {}).map(([name, command]) => renderCommand(name, command, air));
  const allFields = [
    ...Object.values(air.spec.entities).flatMap((entity) => Object.values(entity.fields)),
    ...Object.values(air.spec.contracts ?? {}).flatMap((contract) => Object.values(contract.fields)),
    ...Object.values(air.spec.principals ?? {}).flatMap((principal) => Object.values(principal.fields)),
  ];
  const hasAuthentication =
    Object.values(air.spec.commands ?? {}).some((command) => command.authorization !== undefined) ||
    operations.some((operation) => "entity" in operation && operation.authorization !== undefined);
  const hasPath = operations.some((operation) => "entity" in operation && ["read", "update", "delete"].includes(operation.action));
  const hasQuery = operations.some((operation) => "entity" in operation && operation.action === "list" && operation.collection !== undefined);
  const hasMessages = Object.values(air.spec.commands ?? {}).some((command) => (command.emits?.length ?? 0) > 0 || (command.enqueues?.length ?? 0) > 0);
  const routingFunctions = [...new Set(["get", ...operations.map((operation) => operation.method === "GET" ? "get" : operation.method === "POST" ? "post" : operation.method === "DELETE" ? "delete" : "patch")])].sort();
  const chronoTypes = [
    ...(allFields.some((field) => field.type === "datetime") ? ["DateTime", "Utc"] : hasMessages ? ["Utc"] : []),
    ...(allFields.some((field) => field.type === "date") ? ["NaiveDate"] : []),
  ];
  const authSupport = hasAuthentication ? `
#[derive(Clone, Deserialize)]
struct JwtClaims { #[serde(flatten)] values: HashMap<String, serde_json::Value> }

fn authenticate<T: DeserializeOwned, F: Fn() -> AppError>(headers: &HeaderMap, unauthenticated: F) -> Result<T, AppError> {
    let authorization = headers.get("authorization").and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(&unauthenticated)?;
    let secret = std::env::var("AIR_AUTH_SECRET").map_err(|_| AppError::Configuration("AIR_AUTH_SECRET is required."))?;
    let claims = decode::<JwtClaims>(authorization, &DecodingKey::from_secret(secret.as_bytes()), &Validation::new(Algorithm::HS256))
        .map_err(|_| unauthenticated())?;
    serde_json::from_value(serde_json::Value::Object(claims.claims.values.into_iter().collect()))
        .map_err(|_| unauthenticated())
}
` : "";
  const imports = [
    hasAuthentication ? "use std::collections::HashMap;" : "",
    `use axum::{\n    extract::{${[...(hasPath ? ["Path"] : []), ...(hasQuery ? ["Query"] : []), "State"].join(", ")}},\n    http::{${hasAuthentication ? "HeaderMap, " : ""}StatusCode},\n    response::{IntoResponse, Response},\n${routingFunctions.length > 0 ? `    routing::{${routingFunctions.join(", ")}},\n` : ""}    Json, Router,\n};`,
    chronoTypes.length > 0 ? `use chrono::{${chronoTypes.join(", ")}};` : "",
    hasAuthentication ? "use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};" : "",
    `use serde::{${hasAuthentication ? "de::DeserializeOwned, " : ""}Deserialize, Serialize};`,
    "use serde_json::json;",
    "use sqlx::{FromRow, PgPool};",
    allFields.some((field) => field.type === "uuid") || hasMessages ? "use uuid::Uuid;" : "",
  ].filter(Boolean).join("\n");
  return `#![allow(clippy::needless_borrows_for_generic_args)]
#![allow(dead_code)]

${imports}

#[derive(Clone)]
pub struct AppState { pub pool: PgPool }

#[derive(Debug)]
pub enum AppError {
    Domain { status: u16, code: &'static str, message: &'static str, retryable: bool },
    Database(sqlx::Error),
    Configuration(&'static str),
}

impl AppError {
    pub fn domain(status: u16, code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self::Domain { status, code, message, retryable }
    }
    pub fn is_retryable_database(&self) -> bool {
        match self {
            Self::Database(sqlx::Error::Database(error)) => matches!(error.code().as_deref(), Some("40001" | "40P01" | "23505")),
            _ => false,
        }
    }
}

impl From<sqlx::Error> for AppError { fn from(value: sqlx::Error) -> Self { Self::Database(value) } }

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, retryable) = match self {
            Self::Domain { status, code, message, retryable } => (status, code, message.to_string(), retryable),
            Self::Configuration(message) => {
                tracing::error!(event = "air.configuration.error", error = message);
                (500, "CONFIGURATION_ERROR", message.to_string(), false)
            }
            Self::Database(error) => {
                tracing::error!(event = "air.database.error", error = %error);
                (500, "DATABASE_ERROR", "Database operation failed.".to_string(), true)
            }
        };
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "error": { "code": code, "message": message, "retryable": retryable } }))).into_response()
    }
}

${authSupport}
${[...contracts, ...principals, ...entities, ...commands, renderRouter(air)].join("\n\n")}
`;
}

function renderMain(): string {
  return `mod generated;

use generated::{router, AppState};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::time::Duration;

fn port() -> Result<u16, Box<dyn std::error::Error>> {
    Ok(std::env::var("AIR_PORT").unwrap_or_else(|_| "3000".to_string()).parse()?)
}

async fn healthcheck() -> Result<(), Box<dyn std::error::Error>> {
    tokio::net::TcpStream::connect(("127.0.0.1", port()?)).await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(event = "air.shutdown.signal_error", error = %error);
    }
    tracing::info!(event = "air.shutdown.started");
}

async fn run_worker(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        let rows = sqlx::query("SELECT id, destination, jsonb_build_object('id',id,'type',message_type,'schemaVersion',schema_version,'occurredAt',occurred_at,'producer',producer,'correlationId',correlation_id,'causationId',causation_id,'orderingKey',ordering_key,'payload',payload) AS envelope FROM air_outbox WHERE published_at IS NULL AND available_at <= now() ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 100").fetch_all(pool).await?;
        for row in &rows {
            let id: uuid::Uuid = row.try_get("id")?;
            let destination: String = row.try_get("destination")?;
            let envelope: serde_json::Value = row.try_get("envelope")?;
            let published = sqlx::query("SELECT pg_notify($1,$2)").bind(&destination).bind(envelope.to_string()).execute(pool).await;
            match published {
                Ok(_) => { sqlx::query("UPDATE air_outbox SET published_at=now() WHERE id=$1").bind(id).execute(pool).await?; tracing::info!(event="air.outbox.published", %destination, %id); }
                Err(error) => { sqlx::query("UPDATE air_outbox SET attempts=attempts+1, available_at=now()+make_interval(secs => least(300, power(2, attempts)::int)) WHERE id=$1").bind(id).execute(pool).await?; tracing::warn!(event="air.outbox.retry", %destination, %id, error=%error); }
            }
        }
        tokio::time::sleep(Duration::from_millis(if rows.is_empty() { 250 } else { 10 })).await;
    }
}

async fn run_scheduler() -> Result<(), Box<dyn std::error::Error>> {
    loop { tracing::info!(event="air.scheduler.tick"); tokio::time::sleep(Duration::from_secs(1)).await; }
}

async fn run_orchestrator(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        sqlx::query("UPDATE air_saga_timers SET claimed_at=now() WHERE id IN (SELECT id FROM air_saga_timers WHERE completed_at IS NULL AND claimed_at IS NULL AND due_at <= now() FOR UPDATE SKIP LOCKED LIMIT 100)").execute(pool).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().json().with_target(false).init();
    if std::env::args().any(|argument| argument == "--healthcheck") {
        return healthcheck().await;
    }
    let database_url = std::env::var("DATABASE_URL")?;
    let pool = PgPoolOptions::new().max_connections(20).connect(&database_url).await?;
    sqlx::migrate!().run(&pool).await?;
    let role = std::env::var("AIR_COMPONENT_ROLE").unwrap_or_else(|_| "api".to_string());
    if role == "worker" { return run_worker(&pool).await; }
    if role == "scheduler" { return run_scheduler().await; }
    if role == "orchestrator" { return run_orchestrator(&pool).await; }
    let app = router(AppState { pool });
    let port = port()?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(event = "air.server.started", port);
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}
`;
}

function formatRust(source: string, edition: ResolvedRustTargetOptions["rustEdition"]): string {
  const result = spawnSync("rustfmt", ["--edition", edition, "--emit", "stdout"], {
    input: source,
    encoding: "utf8",
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") return source;
  if (result.status !== 0) {
    throw new Error(`rustfmt rejected generated Rust: ${result.stderr.trim() || "unknown formatter error"}`);
  }
  return result.stdout;
}

export function renderRustFiles(air: AirDocument, options: ResolvedRustTargetOptions): readonly PlannedRustFile[] {
  const packageName = snakeCase(air.metadata.name).replaceAll("_", "-");
  const files: PlannedRustFile[] = [
    {
      path: "Cargo.toml", kind: "configuration", airNodes: ["/metadata"],
        content: `[package]\nname = ${JSON.stringify(packageName)}\nversion = "0.1.0"\nedition = ${JSON.stringify(options.rustEdition)}\nrust-version = ${JSON.stringify(options.rustVersion)}\n\n[dependencies]\naxum = { version = "0.8", features = ["ws"] }\nchrono = { version = "0.4", features = ["serde"] }\njsonwebtoken = "9"\nopentelemetry = "0.27"\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\nsqlx = { version = "0.8", features = ["runtime-tokio-rustls", "postgres", "uuid", "chrono", "json", "migrate"] }\ntokio = { version = "1", features = ["macros", "rt-multi-thread", "net", "signal", "time"] }\ntracing = "0.1"\ntracing-subscriber = { version = "0.3", features = ["fmt", "json"] }\nuuid = { version = "1", features = ["serde", "v4"] }\n`,
    },
    {
      path: "rust-toolchain.toml", kind: "configuration", airNodes: ["/metadata"],
      content: `[toolchain]\nchannel = ${JSON.stringify(options.rustVersion)}\ncomponents = ["clippy", "rustfmt"]\nprofile = "minimal"\n`,
    },
    { path: ".env.example", kind: "configuration", airNodes: ["/"], content: "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\nAIR_AUTH_SECRET=replace-with-at-least-32-random-characters\nAIR_PORT=3000\n" },
    { path: "migrations/0001_air.sql", kind: "source", airNodes: ["/spec/entities"], content: renderMigration(air) },
    { path: "src/generated.rs", kind: "source", airNodes: ["/spec"], content: renderGenerated(air) },
    { path: "src/main.rs", kind: "source", airNodes: ["/metadata", "/spec/http"], content: renderMain() },
    {
      path: "Dockerfile", kind: "configuration", airNodes: ["/metadata"],
      content: `FROM rust:${options.rustVersion}-bookworm AS build\nWORKDIR /app\nCOPY . .\nRUN cargo build --release\nFROM debian:bookworm-slim\nCOPY --from=build /app/target/release/${packageName} /usr/local/bin/air-app\nEXPOSE 3000\nHEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["air-app", "--healthcheck"]\nCMD ["air-app"]\n`,
    },
    {
      path: "README.md", kind: "documentation", airNodes: ["/"],
      content: `# ${air.metadata.displayName ?? air.metadata.name}\n\nGenerated by AIR for Rust, Axum, SQLx, and PostgreSQL.\n\n\`\`\`bash\ncp .env.example .env\ncargo run\n\`\`\`\n`,
    },
  ];
  return files
    .map((file) => file.path.endsWith(".rs") ? { ...file, content: formatRust(file.content, options.rustEdition) } : file)
    .sort((left, right) => left.path.localeCompare(right.path));
}

import type { AirDocument, CrudHttpOperation, EntityDefinition, FieldDefinition, HttpOperation } from "@air/schema";
import { pascalCase, rustIdentifier, snakeCase, tableName } from "./naming.js";
import type { PlannedRustFile, ResolvedRustTargetOptions } from "./types.js";

function primaryField(entity: EntityDefinition): [string, FieldDefinition] | undefined {
  return Object.entries(entity.fields).find(([, field]) => field.primaryKey === true) ??
    (entity.fields.id ? ["id", entity.fields.id] : undefined);
}

function baseType(field: FieldDefinition): string {
  switch (field.type) {
    case "string": case "uuid": case "date": case "datetime": return "String";
    case "integer": return "i64";
    case "number": return "f64";
    case "boolean": return "bool";
    case "json": return "serde_json::Value";
  }
}

function modelType(field: FieldDefinition): string {
  const optional = field.nullable || (!field.required && field.generated === undefined && field.default === undefined);
  return optional ? `Option<${baseType(field)}>` : baseType(field);
}

function createType(field: FieldDefinition): string {
  return field.required ? (field.nullable ? `Option<${baseType(field)}>` : baseType(field)) : `Option<${baseType(field)}>`;
}

function renderStruct(name: string, fields: readonly [string, string][], derives = "Debug, Clone, Serialize, Deserialize"): string {
  return `#[derive(${derives})]\n#[serde(rename_all = "camelCase")]\npub struct ${name} {\n${fields.map(([field, type]) => `    pub ${rustIdentifier(field)}: ${type},`).join("\n")}\n}`;
}

function literal(value: unknown, field: FieldDefinition): string {
  if (value === null) return "None";
  let rendered: string;
  if (field.type === "string" || field.type === "uuid" || field.type === "date" || field.type === "datetime") rendered = `${JSON.stringify(value)}.to_string()`;
  else if (field.type === "json") rendered = `serde_json::json!(${JSON.stringify(value)})`;
  else rendered = String(value);
  return field.nullable ? `Some(${rendered})` : rendered;
}

function exampleValue(fieldName: string, field: FieldDefinition): unknown {
  if (field.validation?.enum?.[0] !== undefined) return field.validation.enum[0];
  switch (field.type) {
    case "string": return fieldName;
    case "integer": return Math.max(1, Math.ceil(field.validation?.minimum ?? 1));
    case "number": return Math.max(1, field.validation?.minimum ?? 1);
    case "boolean": return false;
    case "uuid": return "00000000-0000-4000-8000-000000000001";
    case "date": return "2026-01-01";
    case "datetime": return "2026-01-01T00:00:00.000Z";
    case "json": return {};
  }
}

function entityOperations(air: AirDocument, entityName: string): CrudHttpOperation[] {
  return (air.spec.http?.operations ?? []).filter(
    (operation): operation is CrudHttpOperation => "entity" in operation && operation.entity === entityName,
  );
}

function auth(operation: CrudHttpOperation): { parameter: string; prelude: string } {
  if (!operation.authorization) return { parameter: "", prelude: "" };
  const principal = pascalCase(operation.authorization.principal);
  const checks = operation.authorization.rules.map((rule) =>
    `    if !${JSON.stringify(rule.values)}.contains(&principal.${rustIdentifier(rule.principalField)}.as_str()) { return Err(AppError::domain(403, "FORBIDDEN", "The authenticated principal cannot perform this operation.")); }`,
  ).join("\n");
  return {
    parameter: ", headers: HeaderMap",
    prelude: `    let principal = authenticate::<${principal}, _>(&headers, || AppError::domain(401, "UNAUTHENTICATED", "Authentication is required."))?;\n${checks}\n`,
  };
}

function renderEntity(entityName: string, entity: EntityDefinition, operations: readonly CrudHttpOperation[]): string {
  const rustName = pascalCase(entityName);
  const collection = tableName(entityName);
  const primary = primaryField(entity);
  const createFields = Object.entries(entity.fields).filter(([, field]) => field.generated === undefined && field.default === undefined);
  const updateFields = Object.entries(entity.fields).filter(([name, field]) => name !== primary?.[0] && field.generated === undefined);
  const chunks = [renderStruct(rustName, Object.entries(entity.fields).map(([name, field]) => [name, modelType(field)]))];
  if (operations.some((operation) => operation.action === "create")) chunks.push(renderStruct(`Create${rustName}Input`, createFields.map(([name, field]) => [name, createType(field)]), "Debug, Deserialize"));
  if (operations.some((operation) => operation.action === "update")) chunks.push(renderStruct(`Update${rustName}Input`, updateFields.map(([name, field]) => [name, `Option<${baseType(field)}>`]), "Debug, Deserialize"));

  for (const operation of operations) {
    const functionName = rustIdentifier(operation.id);
    const authorization = auth(operation);
    if (operation.action === "list") {
      const filters = operation.collection?.filters ?? [];
      const queryName = `${pascalCase(operation.id)}Query`;
      if (operation.collection) {
        chunks.push(renderStruct(queryName, [
          ...(operation.collection.pagination ? [["limit", "Option<i64>"], ["offset", "Option<u64>"]] as [string, string][] : []),
          ...filters.map((filter) => [filter.parameter, `Option<${baseType(entity.fields[filter.field]!).replace("String", "String")}>`] as [string, string]),
        ], "Debug, Deserialize"));
      }
      const filterCode = filters.map((filter) => `    if let Some(value) = &query.${rustIdentifier(filter.parameter)} { filter.insert(${JSON.stringify(filter.field)}, bson::to_bson(value).map_err(|error| AppError::Serialization(error.to_string()))?); }`).join("\n");
      const sort = (operation.collection?.orderBy ?? []).map((item) => `${JSON.stringify(item.field)}: ${item.direction === "asc" ? 1 : -1}`).join(", ");
      const options = operation.collection
        ? `    let mut filter = Document::new();\n${filterCode}\n    let collection = state.db.collection::<${rustName}>(${JSON.stringify(collection)});\n    let mut find = collection.find(filter);${sort ? `\n    find = find.sort(doc! { ${sort} });` : ""}${operation.collection.pagination ? `\n    let limit = query.limit.unwrap_or(${operation.collection.pagination.defaultLimit});\n    if !(1..=${operation.collection.pagination.maxLimit}).contains(&limit) { return Err(AppError::domain(400, "INVALID_INPUT", "Invalid collection limit.")); }\n    find = find.limit(limit).skip(query.offset.unwrap_or(0));` : ""}`
        : `    let collection = state.db.collection::<${rustName}>(${JSON.stringify(collection)});\n    let find = collection.find(doc! {});`;
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${authorization.parameter}${operation.collection ? `, Query(query): Query<${queryName}>` : ""}) -> Result<Json<Vec<${rustName}>>, AppError> {\n${authorization.prelude}${options}\n    Ok(Json(find.await?.try_collect().await?))\n}`);
    } else if (operation.action === "read" && primary) {
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${authorization.parameter}, Path(id): Path<${baseType(primary[1])}>) -> Result<Json<${rustName}>, AppError> {\n${authorization.prelude}    let row = state.db.collection::<${rustName}>(${JSON.stringify(collection)}).find_one(doc! { ${JSON.stringify(primary[0])}: bson::to_bson(&id).map_err(|error| AppError::Serialization(error.to_string()))? }).await?\n        .ok_or_else(|| AppError::domain(404, "NOT_FOUND", "${rustName} not found."))?;\n    Ok(Json(row))\n}`);
    } else if (operation.action === "create") {
      const values = Object.entries(entity.fields).map(([name, field]) => {
        if (field.generated === "uuid") return `            ${rustIdentifier(name)}: Uuid::new_v4().to_string(),`;
        if (field.generated === "created-at" || field.generated === "updated-at") return `            ${rustIdentifier(name)}: Utc::now().to_rfc3339(),`;
        if (field.default !== undefined) return `            ${rustIdentifier(name)}: ${literal(field.default, field)},`;
        return `            ${rustIdentifier(name)}: input.${rustIdentifier(name)},`;
      }).join("\n");
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${authorization.parameter}, Json(input): Json<Create${rustName}Input>) -> Result<(StatusCode, Json<${rustName}>), AppError> {\n${authorization.prelude}    let row = ${rustName} {\n${values}\n    };\n    state.db.collection::<${rustName}>(${JSON.stringify(collection)}).insert_one(&row).await?;\n    Ok((StatusCode::CREATED, Json(row)))\n}`);
    } else if (operation.action === "update" && primary) {
      const changes = updateFields.map(([name]) => `    if let Some(value) = input.${rustIdentifier(name)} { changes.insert(${JSON.stringify(name)}, bson::to_bson(&value).map_err(|error| AppError::Serialization(error.to_string()))?); }`).join("\n");
      const updatedAt = Object.entries(entity.fields).find(([, field]) => field.generated === "updated-at")?.[0];
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${authorization.parameter}, Path(id): Path<${baseType(primary[1])}>, Json(input): Json<Update${rustName}Input>) -> Result<Json<${rustName}>, AppError> {\n${authorization.prelude}    let mut changes = Document::new();\n${changes}${updatedAt ? `\n    changes.insert(${JSON.stringify(updatedAt)}, Utc::now().to_rfc3339());` : ""}\n    if changes.is_empty() { return Err(AppError::domain(400, "INVALID_INPUT", "Update payload must contain a mutable field.")); }\n    let row = state.db.collection::<${rustName}>(${JSON.stringify(collection)}).find_one_and_update(\n        doc! { ${JSON.stringify(primary[0])}: bson::to_bson(&id).map_err(|error| AppError::Serialization(error.to_string()))? },\n        doc! { "$set": changes },\n    ).return_document(ReturnDocument::After).await?\n        .ok_or_else(|| AppError::domain(404, "NOT_FOUND", "${rustName} not found."))?;\n    Ok(Json(row))\n}`);
    } else if (operation.action === "delete" && primary) {
      chunks.push(`pub async fn ${functionName}(State(state): State<AppState>${authorization.parameter}, Path(id): Path<${baseType(primary[1])}>) -> Result<StatusCode, AppError> {\n${authorization.prelude}    let result = state.db.collection::<${rustName}>(${JSON.stringify(collection)}).delete_one(doc! { ${JSON.stringify(primary[0])}: bson::to_bson(&id).map_err(|error| AppError::Serialization(error.to_string()))? }).await?;\n    if result.deleted_count == 0 { return Err(AppError::domain(404, "NOT_FOUND", "${rustName} not found.")); }\n    Ok(StatusCode::NO_CONTENT)\n}`);
    }
  }
  return chunks.join("\n\n");
}

function uiResources(air: AirDocument) {
  return Object.entries(air.spec.entities).flatMap(([entityName, entity]) => {
    const operations = entityOperations(air, entityName);
    const list = operations.find((operation) => operation.action === "list" && !operation.authorization);
    if (!list) return [];
    const create = operations.find((operation) => operation.action === "create" && !operation.authorization);
    const example = Object.fromEntries(Object.entries(entity.fields).filter(([, field]) => field.required && !field.generated && field.default === undefined).map(([name, field]) => [name, exampleValue(name, field)]));
    return [{ entityName, entity, create, example }];
  });
}

function renderUi(air: AirDocument): string {
  const resources = uiResources(air);
  const form = resources.some((resource) => resource.create) ? `#[derive(Debug, Deserialize)]\npub struct UiCreateForm { pub payload: String }` : "";
  const panels = resources.map(({ entityName, create, example }) => {
    const rustName = pascalCase(entityName);
    const variable = rustIdentifier(entityName);
    return `    let rows_${variable}: Vec<${rustName}> = state.db.collection(${JSON.stringify(tableName(entityName))}).find(doc! {}).limit(100).await?.try_collect().await?;\n    html.push_str(${JSON.stringify(`<section class="panel"><h2>${entityName}</h2>`)});${create ? `\n    html.push_str(${JSON.stringify(`<form method="post" action="/air-runtime/ui/${snakeCase(entityName)}"><textarea name="payload">`)});\n    html.push_str(&escape_html(${JSON.stringify(JSON.stringify(example, null, 2))}));\n    html.push_str(${JSON.stringify(`</textarea><button type="submit">Create ${entityName}</button></form>`)});` : ""}\n    html.push_str("<pre>");\n    html.push_str(&escape_html(&serde_json::to_string_pretty(&rows_${variable}).map_err(|error| AppError::Ui(error.to_string()))?));\n    html.push_str("</pre></section>");`;
  }).join("\n");
  const handlers = resources.flatMap(({ entityName, create }) => create ? [`pub async fn ui_create_${rustIdentifier(entityName)}(State(state): State<AppState>, Form(form): Form<UiCreateForm>) -> Result<Redirect, AppError> {\n    let input = serde_json::from_str::<Create${pascalCase(entityName)}Input>(&form.payload).map_err(|error| AppError::Ui(error.to_string()))?;\n    let _ = ${rustIdentifier(create.id)}(State(state), Json(input)).await?;\n    Ok(Redirect::to("/air-runtime/ui"))\n}`] : []).join("\n\n");
  return `${form}\n\nfn escape_html(value: &str) -> String { value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace("'", "&#39;") }\n\npub async fn air_ui(State(state): State<AppState>) -> Result<Html<String>, AppError> {\n    let mut html = String::from(${JSON.stringify(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${air.metadata.displayName ?? air.metadata.name}</title><style>body{font-family:system-ui;background:#09090b;color:#fafafa;margin:0}main{max-width:1000px;margin:auto;padding:48px 20px}.panel{background:#18181b;border:1px solid #3f3f46;border-radius:16px;padding:20px;margin:18px 0}textarea{display:block;width:100%;min-height:130px;background:#09090b;color:#fff;border:1px solid #52525b;border-radius:10px;padding:12px;box-sizing:border-box}button{margin:10px 0;padding:9px 16px;border:0;border-radius:999px;background:#8b5cf6;color:#fff}pre{overflow:auto}</style></head><body><main><p>Compiled from AIR to Rust + MongoDB</p><h1>${air.metadata.displayName ?? air.metadata.name}</h1>`)});\n${panels}\n    html.push_str("</main></body></html>");\n    Ok(Html(html))\n}\n\n${handlers}`.trim();
}

function renderRouter(air: AirDocument): string {
  const groups = new Map<string, string[]>();
  for (const operation of air.spec.http?.operations ?? []) {
    if (!("entity" in operation)) continue;
    const layer = operation.method === "GET" ? "get" : operation.method === "POST" ? "post" : operation.method === "DELETE" ? "delete" : operation.method === "PUT" ? "put" : "patch";
    const handlers = groups.get(operation.path) ?? [];
    handlers.push(`${layer}(${rustIdentifier(operation.id)})`);
    groups.set(operation.path, handlers);
  }
  const routes = [...groups.entries()].map(([path, handlers]) => `        .route(${JSON.stringify(path)}, ${handlers.join(".")})`).join("\n");
  const uiRoutes = uiResources(air).flatMap(({ entityName, create }) => create ? [`        .route("/air-runtime/ui/${snakeCase(entityName)}", post(ui_create_${rustIdentifier(entityName)}))`] : []).join("\n");
  return `pub async fn air_health() -> Json<serde_json::Value> { Json(json!({ "status": "ok" })) }\n\npub async fn air_ready(State(state): State<AppState>) -> Response {\n    match state.db.run_command(doc! { "ping": 1 }).await {\n        Ok(_) => Json(json!({ "status": "ready" })).into_response(),\n        Err(error) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "not_ready", "error": { "code": "DATABASE_UNAVAILABLE", "message": error.to_string(), "retryable": true } }))).into_response(),\n    }\n}\n\npub fn router(state: AppState) -> Router {\n    Router::new()\n        .route("/air-runtime/health", get(air_health))\n        .route("/air-runtime/ready", get(air_ready))\n        .route("/air-runtime/ui", get(air_ui))\n${uiRoutes}\n${routes}\n        .with_state(state)\n}`;
}

function renderGenerated(air: AirDocument): string {
  const operations = air.spec.http?.operations ?? [];
  const hasAuthentication = operations.some((operation) => "entity" in operation && operation.authorization);
  const principals = Object.entries(air.spec.principals ?? {}).map(([name, principal]) => renderStruct(pascalCase(name), Object.entries(principal.fields).map(([field, definition]) => [field, modelType(definition)])));
  const entities = Object.entries(air.spec.entities).map(([name, entity]) => renderEntity(name, entity, entityOperations(air, name)));
  const authSupport = hasAuthentication ? `#[derive(Clone, Deserialize)]\nstruct JwtClaims { #[serde(flatten)] values: HashMap<String, serde_json::Value> }\n\nfn authenticate<T: DeserializeOwned, F: Fn() -> AppError>(headers: &HeaderMap, unauthenticated: F) -> Result<T, AppError> {\n    let authorization = headers.get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).ok_or_else(&unauthenticated)?;\n    let secret = std::env::var("AIR_AUTH_SECRET").map_err(|_| AppError::Configuration("AIR_AUTH_SECRET is required."))?;\n    let claims = decode::<JwtClaims>(authorization, &DecodingKey::from_secret(secret.as_bytes()), &Validation::new(Algorithm::HS256)).map_err(|_| unauthenticated())?;\n    serde_json::from_value(serde_json::Value::Object(claims.claims.values.into_iter().collect())).map_err(|_| unauthenticated())\n}` : "";
  return `#![allow(dead_code)]\n#![allow(unused_imports)]\n\n${hasAuthentication ? "use std::collections::HashMap;" : ""}\nuse axum::{extract::{Form, Path, Query, State}, http::{${hasAuthentication ? "HeaderMap, " : ""}StatusCode}, response::{Html, IntoResponse, Redirect, Response}, routing::{delete, get, patch, post, put}, Json, Router};\nuse chrono::Utc;\nuse futures_util::TryStreamExt;\n${hasAuthentication ? "use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};" : ""}\nuse mongodb::{bson::{self, doc, Document}, options::{IndexOptions, ReturnDocument}, Database, IndexModel};\nuse serde::{${hasAuthentication ? "de::DeserializeOwned, " : ""}Deserialize, Serialize};\nuse serde_json::json;\nuse uuid::Uuid;\n\n#[derive(Clone)]\npub struct AppState { pub db: Database }\n\n#[derive(Debug)]\npub enum AppError { Domain { status: u16, code: &'static str, message: &'static str }, Database(mongodb::error::Error), Serialization(String), Configuration(&'static str), Ui(String) }\n\nimpl AppError { pub fn domain(status: u16, code: &'static str, message: &'static str) -> Self { Self::Domain { status, code, message } } }\nimpl From<mongodb::error::Error> for AppError { fn from(value: mongodb::error::Error) -> Self { Self::Database(value) } }\nimpl IntoResponse for AppError { fn into_response(self) -> Response {\n    let (status, code, message, retryable) = match self {\n        Self::Domain { status, code, message } => (status, code, message.to_string(), false),\n        Self::Configuration(message) => (500, "CONFIGURATION_ERROR", message.to_string(), false),\n        Self::Ui(message) | Self::Serialization(message) => (400, "INVALID_INPUT", message, false),\n        Self::Database(error) => (500, "DATABASE_ERROR", error.to_string(), true),\n    };\n    (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(json!({ "error": { "code": code, "message": message, "retryable": retryable } }))).into_response()\n} }\n\n${authSupport}\n\n${[...principals, ...entities, renderUi(air), renderRouter(air)].join("\n\n")}`;
}

function renderMain(air: AirDocument): string {
  const indexes = Object.entries(air.spec.entities).flatMap(([entityName, entity]) => Object.entries(entity.fields).flatMap(([fieldName, field]) => {
    if (!field.primaryKey && !field.unique) return [];
    return [`    db.collection::<Document>(${JSON.stringify(tableName(entityName))}).create_index(IndexModel::builder().keys(doc! { ${JSON.stringify(fieldName)}: 1 }).options(IndexOptions::builder().unique(true).name(${JSON.stringify(`air_${fieldName}_unique`)}.to_string()).build()).build()).await?;`];
  })).join("\n");
  return `mod generated;\n\nuse generated::{router, AppState};\nuse mongodb::{bson::{doc, Document}, options::{ClientOptions, IndexOptions}, Client, IndexModel};\n\nfn port() -> Result<u16, Box<dyn std::error::Error>> { Ok(std::env::var("AIR_PORT").unwrap_or_else(|_| "3000".to_string()).parse()?) }\n\nasync fn healthcheck() -> Result<(), Box<dyn std::error::Error>> { tokio::net::TcpStream::connect(("127.0.0.1", port()?)).await?; Ok(()) }\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n    tracing_subscriber::fmt().json().with_target(false).init();\n    if std::env::args().any(|argument| argument == "--healthcheck") { return healthcheck().await; }\n    let url = std::env::var("DATABASE_URL")?;\n    let client = Client::with_options(ClientOptions::parse(url).await?)?;\n    let db = client.database(&std::env::var("MONGODB_DATABASE").unwrap_or_else(|_| "air".to_string()));\n    db.run_command(doc! { "ping": 1 }).await?;\n${indexes}\n    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port()?)).await?;\n    axum::serve(listener, router(AppState { db })).await?;\n    Ok(())\n}`;
}

export function renderMongoRustFiles(air: AirDocument, options: ResolvedRustTargetOptions): readonly PlannedRustFile[] {
  const packageName = snakeCase(air.metadata.name).replaceAll("_", "-");
  const files: PlannedRustFile[] = [
    { path: ".dockerignore", kind: "configuration", airNodes: ["/metadata"], content: ".air\n.env\n.git\ntarget\n" },
    { path: ".env.example", kind: "configuration", airNodes: ["/"], content: "DATABASE_URL=mongodb://localhost:27017\nMONGODB_DATABASE=air\nAIR_AUTH_SECRET=replace-with-at-least-32-random-characters\nAIR_PORT=3000\n" },
    { path: "Cargo.toml", kind: "configuration", airNodes: ["/metadata"], content: `[package]\nname = ${JSON.stringify(packageName)}\nversion = "0.1.0"\nedition = ${JSON.stringify(options.rustEdition)}\nrust-version = ${JSON.stringify(options.rustVersion)}\n\n[dependencies]\naxum = "0.8"\nchrono = "0.4"\nfutures-util = "0.3"\njsonwebtoken = "9"\nmongodb = "3"\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\ntokio = { version = "1", features = ["macros", "rt-multi-thread", "net"] }\ntracing = "0.1"\ntracing-subscriber = { version = "0.3", features = ["fmt", "json"] }\nuuid = { version = "1", features = ["v4"] }\n` },
    { path: "rust-toolchain.toml", kind: "configuration", airNodes: ["/metadata"], content: `[toolchain]\nchannel = ${JSON.stringify(options.rustVersion)}\ncomponents = ["clippy", "rustfmt"]\nprofile = "minimal"\n` },
    { path: "src/generated.rs", kind: "source", airNodes: ["/spec"], content: renderGenerated(air) },
    { path: "src/main.rs", kind: "source", airNodes: ["/metadata", "/spec/http"], content: renderMain(air) },
    { path: "Dockerfile", kind: "configuration", airNodes: ["/metadata"], content: `FROM rust:${options.rustVersion}-bookworm AS build\nWORKDIR /app\nCOPY . .\nRUN cargo build --release\nFROM debian:bookworm-slim\nCOPY --from=build /app/target/release/${packageName} /usr/local/bin/air-app\nEXPOSE 3000\nHEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["air-app", "--healthcheck"]\nCMD ["air-app"]\n` },
    { path: "compose.yaml", kind: "configuration", airNodes: ["/metadata", "/spec/entities"], content: `services:\n  database:\n    image: mongo:8\n    healthcheck:\n      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]\n      interval: 2s\n      timeout: 3s\n      retries: 20\n    volumes:\n      - air-mongodb:/data/db\n  application:\n    build: .\n    depends_on:\n      database:\n        condition: service_healthy\n    environment:\n      DATABASE_URL: mongodb://database:27017\n      MONGODB_DATABASE: air\n      AIR_AUTH_SECRET: local-development-secret-change-me\n      AIR_PORT: 3000\n    ports:\n      - "\${AIR_PORT:-3000}:3000"\n\nvolumes:\n  air-mongodb:\n` },
    { path: "README.md", kind: "documentation", airNodes: ["/"], content: `# ${air.metadata.displayName ?? air.metadata.name}\n\nGenerated by AIR for Rust, Axum, and MongoDB. MongoDB mode supports entity CRUD, collection queries, authorization, readiness, and the server-rendered resource UI.\n\n\`\`\`bash\ndocker compose up --build\n\`\`\`\n\nOpen http://localhost:3000/air-runtime/ui. Advanced transactional AIR runtimes remain PostgreSQL-only.\n` },
  ];
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

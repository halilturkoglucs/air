import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Kafka, type Consumer } from "kafkajs";
import postgres, { type Sql } from "postgres";
import { loadEvidenceCaptureProfile, normalizeHttpRoute, type EvidenceCaptureProfile, type EvidenceCaptureSource } from "@air/discovery";

interface CaptureRecord {
  readonly name: string;
  readonly kind: "database-change" | "message" | "outbound-call" | "test";
  readonly observedAt: string;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

interface RabbitMessage { readonly content: Buffer; readonly fields: { readonly routingKey: string } }
interface RabbitChannel {
  checkQueue(queue: string): Promise<unknown>;
  consume(queue: string, listener: (message: RabbitMessage | null) => void, options: { noAck: boolean }): Promise<{ consumerTag: string }>;
  cancel(tag: string): Promise<unknown>;
  nack(message: RabbitMessage, allUpTo: boolean, requeue: boolean): void;
  close(): Promise<unknown>;
}
interface RabbitConnection { createChannel(): Promise<RabbitChannel>; close(): Promise<unknown> }
interface RabbitModule { connect(url: string): Promise<RabbitConnection> }

const require = createRequire(import.meta.url);
const amqp = require("amqplib") as RabbitModule;

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function templatePattern(path: string): RegExp {
  const escaped = normalizeHttpRoute(path).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\\\{[^/]+\\\}/gu, "[^/]+");
  return new RegExp(`^${escaped}/?$`, "u");
}

async function startOutboundStub(source: Extract<EvidenceCaptureSource, { kind: "outbound-http" }>, records: CaptureRecord[]): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = normalizeHttpRoute(request.url ?? "/");
    const stub = source.stubs.find((candidate) => candidate.method === method && templatePattern(candidate.path).test(path));
    let bytes = 0;
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) request.destroy(new Error("Evidence stub request exceeded 1 MiB.")); });
    request.on("end", () => {
      const status = stub?.status ?? 404;
      records.push({ name: `${source.id} ${method} ${stub?.path ?? path}`, kind: "outbound-call", observedAt: new Date().toISOString(), attributes: {
        "air.identity": `outbound:${source.id}:${method}:${normalizeHttpRoute(stub?.path ?? path)}`,
        "air.capture.source": source.id,
        "http.request.method": method,
        "http.route": normalizeHttpRoute(stub?.path ?? path),
        "http.response.status_code": status,
        "http.request.body.size": bytes,
        "air.invocation.order": records.length + 1,
      } });
      response.writeHead(status, stub?.headers ?? {});
      response.end(stub?.body ?? "");
    });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(source.listen.port, source.listen.host, () => done()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(`Could not determine listen address for outbound source ${source.id}.`);
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return { server, url: `http://${host}:${address.port}` };
}

async function snapshotPostgres(source: Extract<EvidenceCaptureSource, { kind: "postgres" }>, environment: NodeJS.ProcessEnv): Promise<{ readonly sql: Sql; readonly hashes: ReadonlyMap<string, string> }> {
  const connection = environment[source.connectionEnv];
  if (!connection) throw new Error(`Evidence capture requires environment variable ${source.connectionEnv}; its value is never persisted.`);
  const sql = postgres(connection, { max: 1, prepare: false, onnotice: () => undefined });
  const hashes = new Map<string, string>();
  try {
    for (const table of source.tables) {
      const rows = await sql.unsafe(`SELECT * FROM ${quoteIdentifier(source.schema)}.${quoteIdentifier(table)}`);
      const rowHashes = rows.map((row) => sha256(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value))).sort();
      hashes.set(table, sha256(JSON.stringify(rowHashes)));
    }
    return { sql, hashes };
  } catch (error) { await sql.end({ timeout: 1 }); throw error; }
}

async function finishPostgres(source: Extract<EvidenceCaptureSource, { kind: "postgres" }>, state: { readonly sql: Sql; readonly hashes: ReadonlyMap<string, string> }, records: CaptureRecord[]): Promise<void> {
  try {
    for (const table of source.tables) {
      const rows = await state.sql.unsafe(`SELECT * FROM ${quoteIdentifier(source.schema)}.${quoteIdentifier(table)}`);
      const rowHashes = rows.map((row) => sha256(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value))).sort();
      const after = sha256(JSON.stringify(rowHashes));
      records.push({ name: `${source.id} ${source.schema}.${table}`, kind: "database-change", observedAt: new Date().toISOString(), attributes: {
        "air.identity": `db:postgresql:${source.schema}:${table}:*`,
        "air.capture.source": source.id,
        "db.system": "postgresql",
        "db.namespace": source.schema,
        "db.sql.table": table,
        "db.operation.name": "*",
        "db.rows.count": rows.length,
        "air.before.sha256": state.hashes.get(table) ?? sha256("[]"),
        "air.after.sha256": after,
        "air.changed": after !== state.hashes.get(table),
      } });
    }
  } finally { await state.sql.end({ timeout: 1 }); }
}

async function startKafka(source: Extract<EvidenceCaptureSource, { kind: "kafka" }>, environment: NodeJS.ProcessEnv, records: CaptureRecord[]): Promise<Consumer> {
  const configured = environment[source.brokersEnv];
  if (!configured) throw new Error(`Evidence capture requires environment variable ${source.brokersEnv}; its value is never persisted.`);
  const consumer = new Kafka({ clientId: `air-evidence-${source.id}`, brokers: configured.split(",").map((item) => item.trim()).filter(Boolean) }).consumer({ groupId: source.groupId ?? `air-evidence-${source.id}-${process.pid}` });
  await consumer.connect();
  for (const topic of source.topics) await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({ eachMessage: async ({ topic, partition, message }) => {
    records.push({ name: `${source.id} ${topic}`, kind: "message", observedAt: new Date().toISOString(), attributes: {
      "air.identity": `message:kafka:${topic}:publish:*`,
      "air.capture.source": source.id,
      "messaging.system": "kafka",
      "messaging.destination.name": topic,
      "messaging.operation.type": "publish",
      "messaging.kafka.partition": partition,
      "messaging.message.body.size": message.value?.length ?? 0,
      "air.observation.sha256": sha256(message.value ?? Buffer.alloc(0)),
    } });
  } });
  return consumer;
}

async function startRabbit(source: Extract<EvidenceCaptureSource, { kind: "rabbitmq" }>, environment: NodeJS.ProcessEnv, records: CaptureRecord[]): Promise<{ readonly connection: RabbitConnection; readonly channel: RabbitChannel; readonly consumers: readonly { readonly tag: string; readonly messages: RabbitMessage[] }[] }> {
  const url = environment[source.urlEnv];
  if (!url) throw new Error(`Evidence capture requires environment variable ${source.urlEnv}; its value is never persisted.`);
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  const consumers: { tag: string; messages: RabbitMessage[] }[] = [];
  for (const queue of source.queues) {
    await channel.checkQueue(queue);
    const messages: RabbitMessage[] = [];
    const consumer = await channel.consume(queue, (message) => {
      if (!message) return;
      messages.push(message);
      records.push({ name: `${source.id} ${queue}`, kind: "message", observedAt: new Date().toISOString(), attributes: {
        "air.identity": `message:rabbitmq:${queue}:publish:*`,
        "air.capture.source": source.id,
        "messaging.system": "rabbitmq",
        "messaging.destination.name": queue,
        "messaging.operation.type": "publish",
        "messaging.rabbitmq.routing_key": message.fields.routingKey,
        "messaging.message.body.size": message.content.length,
        "air.observation.sha256": sha256(message.content),
      } });
    }, { noAck: false });
    consumers.push({ tag: consumer.consumerTag, messages });
  }
  return { connection, channel, consumers };
}

async function runCommand(command: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<number> {
  if (!command[0]) throw new Error("Evidence capture requires a command after --.");
  const child = spawn(command[0], command.slice(1), { env: environment, stdio: "inherit", shell: false });
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    return await new Promise<number>((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => signal ? reject(new Error(`Evidence command terminated by ${signal}.`)) : done(code ?? 1));
    });
  } finally { clearTimeout(timeout); }
}

export interface EvidenceCaptureResult { readonly profile: EvidenceCaptureProfile; readonly output: string; readonly records: number; readonly exitCode: number }

export async function captureEvidence(profilePath: string, outputPath: string, command: readonly string[], baseEnvironment: NodeJS.ProcessEnv = process.env): Promise<EvidenceCaptureResult> {
  const profile = await loadEvidenceCaptureProfile(profilePath);
  const output = resolve(outputPath);
  try { await access(output); throw new Error(`Evidence output ${output} already exists; refusing to run a side-effecting command before an overwrite failure.`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const records: CaptureRecord[] = [];
  const environment = { ...baseEnvironment };
  const servers: Server[] = [];
  const postgresStates: { source: Extract<EvidenceCaptureSource, { kind: "postgres" }>; state: Awaited<ReturnType<typeof snapshotPostgres>> }[] = [];
  const kafkaConsumers: Consumer[] = [];
  const rabbitStates: Awaited<ReturnType<typeof startRabbit>>[] = [];
  let exitCode = 1;
  try {
    for (const source of profile.spec.sources) {
      if (source.kind === "outbound-http") {
        const running = await startOutboundStub(source, records); servers.push(running.server); environment[source.environment] = running.url;
      } else if (source.kind === "postgres") postgresStates.push({ source, state: await snapshotPostgres(source, environment) });
      else if (source.kind === "kafka") kafkaConsumers.push(await startKafka(source, environment, records));
      else rabbitStates.push(await startRabbit(source, environment, records));
    }
    exitCode = await runCommand(command, environment, profile.spec.timeoutMs ?? 300_000);
    for (const item of postgresStates) await finishPostgres(item.source, item.state, records);
    postgresStates.length = 0;
  } finally {
    for (const state of postgresStates) await state.state.sql.end({ timeout: 1 }).catch(() => undefined);
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
    for (const consumer of kafkaConsumers) await consumer.disconnect().catch(() => undefined);
    for (const state of rabbitStates) {
      for (const consumer of state.consumers) { await state.channel.cancel(consumer.tag).catch(() => undefined); for (const message of consumer.messages) state.channel.nack(message, false, true); }
      await state.channel.close().catch(() => undefined); await state.connection.close().catch(() => undefined);
    }
  }
  records.push({ name: profile.metadata.name, kind: "test", observedAt: new Date().toISOString(), attributes: { "air.capture.command.exit_code": exitCode, "air.capture.profile": profile.metadata.name } });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return { profile, output, records: records.length, exitCode };
}

import {
  AIR_PLUGIN_API_VERSION,
  type AirProviderPlugin,
  type PluginArtifact,
  type PluginDiagnostic,
  type ProviderResourcePlan,
  type ProviderConformanceAdapter,
} from "@halilturkoglucs/air-plugin-sdk";
import { Kafka } from "kafkajs";
import amqp from "amqplib";
import postgres from "postgres";
import { createClient } from "redis";

function url(configuration: Readonly<Record<string, string>>): string {
  const value = configuration.URL;
  if (!value) throw new Error("Provider configuration URL is required.");
  return value;
}

async function kafkaAdapter(configuration: Readonly<Record<string, string>>): Promise<ProviderConformanceAdapter> {
  const broker = url(configuration).replace(/^kafka:\/\//, "");
  const kafka = new Kafka({ clientId: "air-provider-check", brokers: broker.split(",") });
  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId: `air-provider-check-${Date.now()}` });
  await Promise.all([producer.connect(), consumer.connect()]);
  const buffers = new Map<string, Readonly<Record<string, unknown>>[]>();
  const subscribed = new Set<string>();
  let running = false;
  return {
    async publish(channel, envelope) { const key = typeof envelope.orderingKey === "string" ? envelope.orderingKey : undefined; await producer.send({ topic: channel, messages: [{ ...(key ? { key } : {}), value: JSON.stringify(envelope) }] }); },
    async receive(channel, options) { if (!subscribed.has(channel)) { if (running) throw new Error("Kafka conformance channels must be subscribed before the first receive loop starts."); const admin = kafka.admin(); await admin.connect(); try { await admin.createTopics({ waitForLeaders: true, topics: [{ topic: channel, numPartitions: 1, replicationFactor: 1 }] }); } finally { await admin.disconnect(); } await consumer.subscribe({ topic: channel, fromBeginning: true }); subscribed.add(channel); } if (!running) { running = true; void consumer.run({ eachMessage: async ({ topic, message }) => { const value = message.value ? JSON.parse(message.value.toString()) as Readonly<Record<string, unknown>> : {}; const queue = buffers.get(topic) ?? []; queue.push(value); buffers.set(topic, queue); } }); } const deadline = Date.now() + (options?.timeoutMs ?? 1000); while (Date.now() < deadline) { const value = buffers.get(channel)?.shift(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); } return undefined; },
    async health() { try { const admin = kafka.admin(); await admin.connect(); await admin.fetchTopicMetadata(); await admin.disconnect(); return { ready: true, diagnostics: [] }; } catch (error) { return { ready: false, diagnostics: [{ severity: "error", code: "KAFKA_HEALTH", message: error instanceof Error ? error.message : String(error) }] }; } },
    async close() { await Promise.all([producer.disconnect(), consumer.disconnect()]); },
  };
}

async function rabbitAdapter(configuration: Readonly<Record<string, string>>): Promise<ProviderConformanceAdapter> {
  const connection = await amqp.connect(url(configuration));
  const channel = await connection.createChannel();
  return {
    async publish(destination, envelope) { await channel.assertQueue(destination, { durable: true }); channel.sendToQueue(destination, Buffer.from(JSON.stringify(envelope)), { persistent: true, messageId: String(envelope.id ?? "") }); },
    async receive(destination, options) { await channel.assertQueue(destination, { durable: true }); const deadline = Date.now() + (options?.timeoutMs ?? 1000); while (Date.now() < deadline) { const message = await channel.get(destination, { noAck: false }); if (message) { channel.ack(message); return JSON.parse(message.content.toString()) as Readonly<Record<string, unknown>>; } await new Promise((resolve) => setTimeout(resolve, 10)); } return undefined; },
    async health() { return { ready: true, diagnostics: [] }; },
    async close() { await channel.close(); await connection.close(); },
  };
}

async function postgresAdapter(configuration: Readonly<Record<string, string>>): Promise<ProviderConformanceAdapter> {
  const sql = postgres(url(configuration), { prepare: false });
  await sql`create table if not exists air_provider_conformance (sequence bigserial primary key, channel text not null, envelope jsonb not null, consumed_at timestamptz)`;
  return {
    async publish(channel, envelope) { await sql`insert into air_provider_conformance (channel,envelope) values (${channel},${sql.json(JSON.parse(JSON.stringify(envelope)) as never)})`; },
    async receive(channel, options) { const deadline = Date.now() + (options?.timeoutMs ?? 1000); while (Date.now() < deadline) { const rows = await sql.begin(async (tx) => { const found = await tx`select sequence,envelope from air_provider_conformance where channel=${channel} and consumed_at is null order by sequence for update skip locked limit 1`; if (found[0]) await tx`update air_provider_conformance set consumed_at=now() where sequence=${found[0].sequence}`; return found; }); if (rows[0]) return rows[0].envelope as Readonly<Record<string, unknown>>; await new Promise((resolve) => setTimeout(resolve, 10)); } return undefined; },
    async health() { try { await sql`select 1`; return { ready: true, diagnostics: [] }; } catch (error) { return { ready: false, diagnostics: [{ severity: "error", code: "POSTGRES_HEALTH", message: error instanceof Error ? error.message : String(error) }] }; } },
    async close() { await sql.end(); },
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireKind(plan: ProviderResourcePlan, kind: ProviderResourcePlan["kind"]): PluginDiagnostic[] {
  return plan.kind === kind ? [] : [{ severity: "error", code: "PROVIDER_RESOURCE_KIND", message: `${plan.provider} requires a ${kind} resource.`, path: `/resources/${plan.logicalName}/kind` }];
}

function requireUrl(plan: ProviderResourcePlan): PluginDiagnostic[] {
  return plan.environment.URL ? [] : [{ severity: "error", code: "PROVIDER_URL_ENVIRONMENT", message: `${plan.provider} requires an environment mapping named URL.`, path: `/resources/${plan.logicalName}/environment/URL` }];
}

function brokerArtifacts(provider: string, plan: ProviderResourcePlan): PluginArtifact[] {
  const channels = [...plan.channels].sort((left, right) => left.name.localeCompare(right.name));
  return [{
    path: `.air/providers/${plan.logicalName}.${provider}.json`,
    kind: "configuration",
    content: stableJson({ provider, delivery: "at-least-once", channels }),
  }];
}

export const kafkaProvider: AirProviderPlugin = {
  apiVersion: AIR_PLUGIN_API_VERSION,
  id: "air.kafka",
  displayName: "Kafka-compatible",
  version: "0.1.0",
  providers: ["kafka"],
  capabilities: ["messaging.publish", "messaging.consume", "messaging.tasks", "messaging.ordering-key", "messaging.dead-letter", "observability.otel"],
  analyze(plan) { return [...requireKind(plan, "broker"), ...requireUrl(plan)]; },
  render(plan) { return brokerArtifacts("kafka", plan); },
  createConformanceAdapter: kafkaAdapter,
  async health(configuration) { const adapter = await kafkaAdapter(configuration); try { return await adapter.health(); } finally { await adapter.close(); } },
};

export const rabbitmqProvider: AirProviderPlugin = {
  apiVersion: AIR_PLUGIN_API_VERSION,
  id: "air.rabbitmq",
  displayName: "RabbitMQ",
  version: "0.1.0",
  providers: ["rabbitmq"],
  capabilities: ["messaging.publish", "messaging.consume", "messaging.tasks", "messaging.ordering-key", "messaging.dead-letter", "observability.otel"],
  analyze(plan) { return [...requireKind(plan, "broker"), ...requireUrl(plan)]; },
  render(plan) { return brokerArtifacts("rabbitmq", plan); },
  createConformanceAdapter: rabbitAdapter,
  async health(configuration) { const adapter = await rabbitAdapter(configuration); try { return await adapter.health(); } finally { await adapter.close(); } },
};

const outboxSql = `CREATE TABLE IF NOT EXISTS air_outbox (
  id uuid PRIMARY KEY,
  channel text NOT NULL,
  ordering_key text,
  envelope jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS air_outbox_pending ON air_outbox (available_at, occurred_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS air_inbox (
  consumer text NOT NULL,
  message_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (consumer, message_id)
);
CREATE TABLE IF NOT EXISTS air_dead_letter (
  id uuid PRIMARY KEY,
  channel text NOT NULL,
  envelope jsonb NOT NULL,
  error jsonb NOT NULL,
  failed_at timestamptz NOT NULL
);
`;

export const postgresOutboxProvider: AirProviderPlugin = {
  apiVersion: AIR_PLUGIN_API_VERSION,
  id: "air.postgres-outbox",
  displayName: "PostgreSQL outbox/inbox",
  version: "0.1.0",
  providers: ["postgres"],
  capabilities: ["messaging.publish", "messaging.consume", "messaging.tasks", "messaging.ordering-key", "messaging.dead-letter", "messaging.transactional-outbox", "observability.otel"],
  analyze(plan) { return [...requireKind(plan, "broker"), ...requireUrl(plan)]; },
  render(plan) {
    return [
      { path: `.air/providers/${plan.logicalName}.postgres.json`, kind: "configuration", content: stableJson({ provider: "postgres", delivery: "at-least-once", poller: { locking: "skip-locked" }, channels: [...plan.channels].sort((a, b) => a.name.localeCompare(b.name)) }) },
      { path: `.air/providers/${plan.logicalName}.sql`, kind: "source", content: outboxSql },
    ];
  },
  createConformanceAdapter: postgresAdapter,
  async health(configuration) { const adapter = await postgresAdapter(configuration); try { return await adapter.health(); } finally { await adapter.close(); } },
};

export const postgresDatabaseProvider: AirProviderPlugin = {
  apiVersion: AIR_PLUGIN_API_VERSION,
  id: "air.postgres-database",
  displayName: "PostgreSQL database",
  version: "0.1.0",
  providers: ["postgres"],
  capabilities: ["persistence.relational", "orchestration.saga-store", "realtime.journal", "observability.otel"],
  analyze(plan) { return [...requireKind(plan, "database"), ...requireUrl(plan)]; },
  render(plan) { return [{ path: `.air/providers/${plan.logicalName}.postgres-database.json`, kind: "configuration", content: stableJson({ provider: "postgres", authoritative: true, sagaStore: true, realtimeJournal: true }) }]; },
  async health(configuration) { const adapter = await postgresAdapter(configuration); try { return await adapter.health(); } finally { await adapter.close(); } },
};

export const redisCacheProvider: AirProviderPlugin = {
  apiVersion: AIR_PLUGIN_API_VERSION,
  id: "air.redis-cache",
  displayName: "Redis derived cache",
  version: "0.1.0",
  providers: ["redis"],
  capabilities: ["cache.derived", "cache.fallback", "cache.invalidation", "observability.otel"],
  analyze(plan) { return [...requireKind(plan, "cache"), ...requireUrl(plan)]; },
  render(plan) {
    return [{ path: `.air/providers/${plan.logicalName}.redis.json`, kind: "configuration", content: stableJson({ provider: "redis", authoritative: false, failureMode: "canonical-source-fallback" }) }];
  },
  async health(configuration) { const client = createClient({ url: url(configuration) }); try { await client.connect(); return { ready: await client.ping() === "PONG", diagnostics: [] }; } catch (error) { return { ready: false, diagnostics: [{ severity: "error", code: "REDIS_HEALTH", message: error instanceof Error ? error.message : String(error) }] }; } finally { if (client.isOpen) await client.quit(); } },
};

export const builtinProviders = [kafkaProvider, rabbitmqProvider, postgresOutboxProvider, postgresDatabaseProvider, redisCacheProvider] as const;

export function providerFor(provider: string, kind?: ProviderResourcePlan["kind"]): AirProviderPlugin | undefined {
  return builtinProviders.find((candidate) => candidate.providers.includes(provider) && (!kind || candidate.analyze({ logicalName: "probe", kind, provider, environment: { URL: "URL" }, channels: [] }).every((item) => item.code !== "PROVIDER_RESOURCE_KIND")));
}

export function analyzeProviderPlan(plan: ProviderResourcePlan): readonly PluginDiagnostic[] {
  const provider = providerFor(plan.provider, plan.kind);
  return provider
    ? [...(!plan.plugin || plan.plugin.id !== provider.id || plan.plugin.version !== provider.version ? [{ severity: "error" as const, code: "PROVIDER_PLUGIN_LOCK", message: `Resource ${plan.logicalName} must lock ${provider.id}@${provider.version}.`, path: `/resources/${plan.logicalName}` }] : []), ...provider.analyze(plan)]
    : [{ severity: "error", code: "PROVIDER_UNAVAILABLE", message: `No explicit AIR provider plugin is registered for ${plan.provider}.`, path: `/resources/${plan.logicalName}/provider` }];
}

export function renderProviderPlan(plan: ProviderResourcePlan): readonly PluginArtifact[] {
  const provider = providerFor(plan.provider, plan.kind);
  if (!provider) throw new Error(`No AIR provider plugin is registered for ${plan.provider}.`);
  return provider.render(plan);
}

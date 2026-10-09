import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import verificationSystemSchema from "../schema/verification-0.2.schema.json" with { type: "json" };
import type { AirDocument, AirSystemDocument, MessageEnvelope, MessageValueReference } from "@air/schema";
import { executeVerificationScenario, VerificationParseError, type VerificationRecord, type VerificationState } from "./index.js";

export const SYSTEM_VERIFICATION_API_VERSION = "air.dev/verification/v0.2" as const;
export const SYSTEM_VERIFICATION_KIND = "SystemVerificationSuite" as const;

export type SystemVerificationStep =
  | { readonly invoke: { readonly application: string; readonly command: string; readonly input: VerificationRecord; readonly principal?: VerificationRecord } }
  | { readonly publish: { readonly application: string; readonly event: string; readonly payload: VerificationRecord; readonly correlationId?: string; readonly orderingKey?: string } }
  | { readonly advance: { readonly seconds: number } }
  | { readonly connect: { readonly client: string; readonly application: string; readonly channel: string; readonly principal?: VerificationRecord; readonly cursor?: number } }
  | { readonly disconnect: { readonly client: string } }
  | { readonly clientCommand: { readonly client: string; readonly type: string; readonly payload: VerificationRecord } }
  | { readonly readCache: { readonly application: string; readonly cache: string; readonly key: string } }
  | { readonly duplicate: { readonly messageId: string } }
  | { readonly reorder: { readonly messageIds: readonly string[] } }
  | { readonly fail: { readonly dependency: string } }
  | { readonly recover: { readonly dependency: string } }
  | { readonly assert: { readonly emitted?: readonly string[]; readonly deadLetters?: number; readonly consumerDeliveries?: number; readonly saga?: { readonly name: string; readonly status: SagaStatus }; readonly frames?: Readonly<Record<string, number>>; readonly state?: VerificationState; readonly cache?: Readonly<Record<string, "hit" | "miss" | "stale" | "fallback">> } };

export interface SystemVerificationScenario { readonly id: string; readonly description?: string; readonly steps: readonly SystemVerificationStep[] }
export interface SystemVerificationSuite { readonly apiVersion: typeof SYSTEM_VERIFICATION_API_VERSION; readonly kind: typeof SYSTEM_VERIFICATION_KIND; readonly scenarios: readonly SystemVerificationScenario[] }
export type SagaStatus = "running" | "completed" | "compensated" | "failed" | "timed-out";
export interface SystemScenarioResult { readonly id: string; readonly passed: boolean; readonly diagnostics: readonly string[]; readonly evidence: SystemEvidence }
export interface SystemEvidence {
  readonly virtualTime: string;
  readonly envelopes: readonly MessageEnvelope[];
  readonly deliveries: readonly { readonly consumer: string; readonly messageId: string; readonly duplicate: boolean; readonly outcome: "processed" | "deduplicated" | "dead-lettered" }[];
  readonly deadLetters: readonly { readonly consumer: string; readonly envelope: MessageEnvelope; readonly reason: string }[];
  readonly state: Readonly<Record<string, VerificationState>>;
  readonly sagas: Readonly<Record<string, SagaStatus>>;
  readonly frames: Readonly<Record<string, readonly VerificationRecord[]>>;
  readonly cache: Readonly<Record<string, "hit" | "miss" | "stale" | "fallback">>;
  readonly correlationIds: readonly string[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<SystemVerificationSuite>(verificationSystemSchema);
function issue(error: ErrorObject): string { return `${error.instancePath || "/"}: ${error.message ?? "invalid value"}`; }

export function parseSystemVerificationSuite(source: string): SystemVerificationSuite {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new VerificationParseError(document.errors.map((error) => error.message));
  const value: unknown = document.toJS();
  if (!validate(value)) throw new VerificationParseError((validate.errors ?? []).map(issue));
  const ids = new Set<string>();
  for (const scenario of value.scenarios) {
    if (ids.has(scenario.id)) throw new VerificationParseError([`Duplicate scenario id ${scenario.id}.`]);
    ids.add(scenario.id);
  }
  return value;
}

interface Session { readonly application: string; readonly channel: string; readonly principal?: VerificationRecord; connected: boolean; cursor: number; readonly frames: VerificationRecord[] }

class VirtualSystem {
  private sequence = 0;
  private nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  private readonly states: Record<string, VerificationState> = {};
  private readonly queue: MessageEnvelope[] = [];
  private readonly envelopeById = new Map<string, MessageEnvelope>();
  private readonly inbox = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private readonly journal: { readonly cursor: number; readonly application: string; readonly event: string; readonly envelope: MessageEnvelope }[] = [];
  private readonly sagaState: Record<string, SagaStatus> = {};
  private readonly cacheState: Record<string, "hit" | "miss" | "stale" | "fallback"> = {};
  private readonly cacheEntries = new Map<string, number>();
  readonly envelopes: MessageEnvelope[] = [];
  readonly deliveries: { consumer: string; messageId: string; duplicate: boolean; outcome: "processed" | "deduplicated" | "dead-lettered" }[] = [];
  readonly deadLetters: { consumer: string; envelope: MessageEnvelope; reason: string }[] = [];

  constructor(private readonly system: AirSystemDocument, private readonly applications: Readonly<Record<string, AirDocument>>) {
    for (const name of Object.keys(applications)) this.states[name] = {};
  }

  private id(): string { this.sequence += 1; return `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`; }
  private value(reference: MessageValueReference, input: VerificationRecord, record: VerificationRecord, principal?: VerificationRecord): unknown {
    if ("input" in reference) return input[reference.input];
    if ("literal" in reference) return reference.literal;
    if ("principal" in reference) return principal?.[reference.principal];
    const selected = typeof reference.record === "string" ? record : record;
    return selected[typeof reference.record === "string" ? reference.record : reference.record.field];
  }

  private makeEnvelope(application: string, type: string, version: string, payload: VerificationRecord, correlationId?: string, causationId?: string, orderingKey?: string): MessageEnvelope {
    const envelope: MessageEnvelope = { id: this.id(), type, schemaVersion: version, occurredAt: new Date(this.nowMs).toISOString(), producer: application, correlationId: correlationId ?? this.id(), ...(causationId ? { causationId } : {}), ...(orderingKey ? { orderingKey } : {}), payload };
    this.envelopes.push(envelope);
    this.envelopeById.set(envelope.id, envelope);
    return envelope;
  }

  private publish(application: string, event: string, payload: VerificationRecord, correlationId?: string, causationId?: string, orderingKey?: string): void {
    const definition = this.applications[application]?.spec.events?.[event];
    if (!definition) throw new Error(`Unknown event ${application}.${event}.`);
    const envelope = this.makeEnvelope(application, `${application}.${event}`, definition.version, payload, correlationId, causationId, orderingKey);
    this.queue.push(envelope);
    const cursor = this.journal.length + 1;
    this.journal.push({ cursor, application, event, envelope });
    for (const session of this.sessions.values()) this.deliverFrame(session, cursor, application, event, envelope);
    this.startSagas(application, event, envelope);
    for (const [cacheName, cache] of Object.entries(this.applications[application]?.spec.cachedReads ?? {})) {
      if (cache.invalidatedBy.includes(event)) for (const key of [...this.cacheEntries.keys()]) if (key.startsWith(`${application}.${cacheName}:`)) this.cacheEntries.delete(key);
    }
  }

  private deliverFrame(session: Session, cursor: number, application: string, event: string, envelope: MessageEnvelope): void {
    if (!session.connected || session.application !== application || cursor <= session.cursor) return;
    const channel = this.applications[application]?.spec.realtime?.[session.channel];
    const subscription = channel?.subscriptions.find((candidate) => candidate.event === event);
    if (!subscription) return;
    if ((subscription.filters ?? []).some((filter) => envelope.payload[filter.payloadField] !== session.principal?.[filter.principalField])) return;
    if (session.frames.length >= (channel?.buffer.maxMessages ?? 1)) { session.connected = false; return; }
    session.frames.push({ cursor, type: envelope.type, envelope });
    session.cursor = cursor;
  }

  private invoke(application: string, commandName: string, input: VerificationRecord, principal?: VerificationRecord, cause?: MessageEnvelope): boolean {
    const air = this.applications[application];
    const command = air?.spec.commands?.[commandName];
    if (!air || !command) throw new Error(`Unknown command ${application}.${commandName}.`);
    const result = executeVerificationScenario(air, { id: `system-${this.sequence}`, command: commandName, given: { input, ...(principal ? { principal } : {}), state: this.states[application]! }, expect: { output: {} } }, { now: new Date(this.nowMs).toISOString(), generateUuid: () => this.id() });
    if (result.status === "error") return false;
    this.states[application] = result.state;
    const emit = (definition: { event: string; payload: Readonly<Record<string, MessageValueReference>>; key?: MessageValueReference }): void => {
      const payload = Object.fromEntries(Object.entries(definition.payload).map(([name, reference]) => [name, this.value(reference, input, result.output, principal)]));
      const key = definition.key ? String(this.value(definition.key, input, result.output, principal)) : undefined;
      this.publish(application, definition.event, payload, cause?.correlationId, cause?.id, key);
    };
    for (const emission of command.emits ?? []) emit(emission);
    for (const task of command.enqueues ?? []) {
      const definition = air.spec.tasks?.[task.task];
      if (!definition) throw new Error(`Unknown task ${application}.${task.task}.`);
      const payload = Object.fromEntries(Object.entries(task.payload).map(([name, reference]) => [name, this.value(reference, input, result.output, principal)]));
      const key = task.key ? String(this.value(task.key, input, result.output, principal)) : undefined;
      this.queue.push(this.makeEnvelope(application, `${application}.${task.task}`, "1", payload, cause?.correlationId, cause?.id, key));
    }
    return true;
  }

  private consumersFor(envelope: MessageEnvelope): { application: string; name: string }[] {
    const [sourceApplication, sourceName] = envelope.type.split(".");
    const matches: { application: string; name: string }[] = [];
    const routedApplications = new Set(Object.values(this.system.spec.channels ?? {}).filter((channel) => channel.source === envelope.type).flatMap((channel) => channel.consumers.map((component) => this.system.spec.components[component]?.application).filter((name): name is string => Boolean(name))));
    for (const [application, air] of Object.entries(this.applications)) for (const [name, consumer] of Object.entries(air.spec.consumers ?? {})) {
      if (("event" in consumer.source && consumer.source.event === `${sourceApplication}.${sourceName}`) || ("event" in consumer.source && (sourceApplication === application || routedApplications.has(application)) && consumer.source.event === sourceName) || ("task" in consumer.source && consumer.source.task === `${sourceApplication}.${sourceName}`) || ("task" in consumer.source && (sourceApplication === application || routedApplications.has(application)) && consumer.source.task === sourceName)) matches.push({ application, name });
    }
    return matches;
  }

  drain(): void {
    let guard = 0;
    while (this.queue.length > 0) {
      if (guard++ > 10_000) throw new Error("Virtual broker exceeded its deterministic delivery limit.");
      const envelope = this.queue.shift()!;
      const consumers = this.consumersFor(envelope);
      const sourceApp = this.applications[envelope.producer];
      const sourceName = envelope.type.slice(envelope.type.indexOf(".") + 1);
      const isTask = Boolean(sourceApp?.spec.tasks?.[sourceName]);
      for (const target of isTask ? consumers.slice(0, 1) : consumers) {
        const key = `${target.application}.${target.name}:${envelope.id}`;
        if (this.inbox.has(key)) { this.deliveries.push({ consumer: `${target.application}.${target.name}`, messageId: envelope.id, duplicate: true, outcome: "deduplicated" }); continue; }
        const consumer = this.applications[target.application]!.spec.consumers![target.name]!;
        if (this.failed.has(target.application) || this.failed.has(target.name)) {
          this.deadLetters.push({ consumer: `${target.application}.${target.name}`, envelope, reason: "dependency unavailable after retry budget" });
          this.deliveries.push({ consumer: `${target.application}.${target.name}`, messageId: envelope.id, duplicate: false, outcome: "dead-lettered" });
          continue;
        }
        const input = Object.fromEntries(Object.entries(consumer.input).map(([name, reference]) => [name, "payload" in reference ? envelope.payload[reference.payload] : envelope[reference.envelope]]));
        const ok = this.invoke(target.application, consumer.command, input, undefined, envelope);
        if (ok) { this.inbox.add(key); this.deliveries.push({ consumer: `${target.application}.${target.name}`, messageId: envelope.id, duplicate: false, outcome: "processed" }); }
        else { this.deadLetters.push({ consumer: `${target.application}.${target.name}`, envelope, reason: "command rejected message" }); this.deliveries.push({ consumer: `${target.application}.${target.name}`, messageId: envelope.id, duplicate: false, outcome: "dead-lettered" }); }
      }
    }
  }

  private startSagas(application: string, event: string, envelope: MessageEnvelope): void {
    for (const [name, saga] of Object.entries(this.system.spec.sagas ?? {})) {
      if (saga.trigger.application !== application || saga.trigger.event !== event) continue;
      this.sagaState[name] = "running";
      const completed: { application: string; command: string }[] = [];
      for (const step of saga.steps) {
        if (step.kind === "delay" || step.kind === "wait") return;
        if (step.kind === "publish") this.publish(step.application, step.event, envelope.payload, envelope.correlationId, envelope.id);
        if (step.kind === "invoke") {
          const ok = this.invoke(step.application, step.command, envelope.payload, undefined, envelope);
          if (!ok) {
            let compensated = true;
            for (const prior of completed.reverse()) compensated = this.invoke(prior.application, prior.command, envelope.payload, undefined, envelope) && compensated;
            this.sagaState[name] = compensated ? "compensated" : "failed";
            return;
          }
          if (step.compensate) completed.push({ application: step.application, command: step.compensate });
        }
      }
      this.sagaState[name] = "completed";
    }
  }

  run(step: SystemVerificationStep, diagnostics: string[]): void {
    if ("invoke" in step) this.invoke(step.invoke.application, step.invoke.command, step.invoke.input, step.invoke.principal);
    else if ("publish" in step) this.publish(step.publish.application, step.publish.event, step.publish.payload, step.publish.correlationId, undefined, step.publish.orderingKey);
    else if ("advance" in step) {
      this.nowMs += step.advance.seconds * 1000;
      for (const [application, air] of Object.entries(this.applications)) for (const schedule of Object.values(air.spec.schedules ?? {})) this.invoke(application, schedule.command, schedule.input ?? {});
    } else if ("connect" in step) {
      const session: Session = { application: step.connect.application, channel: step.connect.channel, ...(step.connect.principal ? { principal: step.connect.principal } : {}), connected: true, cursor: step.connect.cursor ?? 0, frames: [] };
      this.sessions.set(step.connect.client, session);
      for (const item of this.journal) this.deliverFrame(session, item.cursor, item.application, item.event, item.envelope);
    } else if ("disconnect" in step) { const session = this.sessions.get(step.disconnect.client); if (session) session.connected = false; }
    else if ("clientCommand" in step) {
      const session = this.sessions.get(step.clientCommand.client);
      if (!session?.connected) throw new Error(`Realtime client ${step.clientCommand.client} is not connected.`);
      const channel = this.applications[session.application]?.spec.realtime?.[session.channel];
      const mapping = channel?.commands?.find((candidate) => candidate.type === step.clientCommand.type);
      if (!mapping) throw new Error(`Realtime command ${step.clientCommand.type} is not declared.`);
      const ok = this.invoke(session.application, mapping.command, step.clientCommand.payload, session.principal);
      session.frames.push({ type: "reply", command: step.clientCommand.type, ok });
    } else if ("readCache" in step) {
      const definition = this.applications[step.readCache.application]?.spec.cachedReads?.[step.readCache.cache];
      if (!definition) throw new Error(`Unknown cached read ${step.readCache.application}.${step.readCache.cache}.`);
      const observation = `${step.readCache.application}.${step.readCache.cache}`;
      const entry = `${observation}:${step.readCache.key}`;
      const createdAt = this.cacheEntries.get(entry);
      if (this.failed.has("cache") || this.failed.has(observation)) this.cacheState[observation] = "fallback";
      else if (createdAt === undefined) { this.cacheState[observation] = "miss"; this.cacheEntries.set(entry, this.nowMs); }
      else if ((this.nowMs - createdAt) / 1000 > definition.ttlSeconds + definition.maxStaleSeconds) { this.cacheState[observation] = "miss"; this.cacheEntries.set(entry, this.nowMs); }
      else if ((this.nowMs - createdAt) / 1000 > definition.ttlSeconds) this.cacheState[observation] = "stale";
      else this.cacheState[observation] = "hit";
    } else if ("duplicate" in step) { const envelope = this.envelopeById.get(step.duplicate.messageId); if (!envelope) throw new Error(`Unknown message ${step.duplicate.messageId}.`); this.queue.push(envelope); }
    else if ("reorder" in step) { const selected = step.reorder.messageIds.map((id) => this.envelopeById.get(id)).filter((item): item is MessageEnvelope => Boolean(item)); this.queue.unshift(...selected); }
    else if ("fail" in step) this.failed.add(step.fail.dependency);
    else if ("recover" in step) this.failed.delete(step.recover.dependency);
    else this.assert(step.assert, diagnostics);
    if (!("assert" in step) && !("fail" in step) && !("recover" in step) && !("connect" in step) && !("disconnect" in step)) this.drain();
  }

  private assert(expected: Extract<SystemVerificationStep, { assert: unknown }>["assert"], diagnostics: string[]): void {
    if (expected.emitted && !isDeepStrictEqual(this.envelopes.map((item) => item.type), expected.emitted)) diagnostics.push(`Emitted messages mismatch: expected ${JSON.stringify(expected.emitted)}, received ${JSON.stringify(this.envelopes.map((item) => item.type))}.`);
    if (expected.deadLetters !== undefined && this.deadLetters.length !== expected.deadLetters) diagnostics.push(`Expected ${expected.deadLetters} dead letters, received ${this.deadLetters.length}.`);
    if (expected.consumerDeliveries !== undefined && this.deliveries.length !== expected.consumerDeliveries) diagnostics.push(`Expected ${expected.consumerDeliveries} deliveries, received ${this.deliveries.length}.`);
    if (expected.saga && this.sagaState[expected.saga.name] !== expected.saga.status) diagnostics.push(`Expected saga ${expected.saga.name}=${expected.saga.status}, received ${this.sagaState[expected.saga.name] ?? "missing"}.`);
    if (expected.state && !isDeepStrictEqual(this.states, expected.state)) diagnostics.push(`Eventual state mismatch: expected ${JSON.stringify(expected.state)}, received ${JSON.stringify(this.states)}.`);
    for (const [client, count] of Object.entries(expected.frames ?? {})) if ((this.sessions.get(client)?.frames.length ?? 0) !== count) diagnostics.push(`Expected ${count} frames for ${client}, received ${this.sessions.get(client)?.frames.length ?? 0}.`);
    for (const [name, value] of Object.entries(expected.cache ?? {})) if (this.cacheState[name] !== value) diagnostics.push(`Expected cache ${name}=${value}, received ${this.cacheState[name] ?? "unobserved"}.`);
  }

  evidence(): SystemEvidence {
    return { virtualTime: new Date(this.nowMs).toISOString(), envelopes: this.envelopes, deliveries: this.deliveries, deadLetters: this.deadLetters, state: this.states, sagas: this.sagaState, frames: Object.fromEntries([...this.sessions].map(([name, session]) => [name, session.frames])), cache: this.cacheState, correlationIds: [...new Set(this.envelopes.map((item) => item.correlationId))] };
  }
}

export function verifySystemSuite(system: AirSystemDocument, applications: Readonly<Record<string, AirDocument>>, suite: SystemVerificationSuite): readonly SystemScenarioResult[] {
  return suite.scenarios.map((scenario) => {
    const runtime = new VirtualSystem(system, applications);
    const diagnostics: string[] = [];
    try { for (const step of scenario.steps) runtime.run(step, diagnostics); }
    catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
    return { id: scenario.id, passed: diagnostics.length === 0, diagnostics, evidence: runtime.evidence() };
  });
}

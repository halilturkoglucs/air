import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { AirDocument, ContractDefinition, EventDefinition, TaskDefinition } from "@air/schema";

export interface SpringImportDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly source: string;
  readonly line?: number;
}
export interface SpringDiscovery {
  readonly kind: "kafka-listener" | "rabbit-listener" | "event-listener" | "event-publisher" | "integration-flow" | "scheduled-handler" | "configuration";
  readonly source: string;
  readonly line: number;
  readonly destination?: string;
  readonly expression: string;
}
export interface SpringImportResult { readonly document: AirDocument; readonly discoveries: readonly SpringDiscovery[]; readonly diagnostics: readonly SpringImportDiagnostic[] }

async function sources(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", ".gradle", "build", "target", "node_modules"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if ([".java", ".kt", ".properties", ".yaml", ".yml"].includes(extname(entry.name))) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

function literal(annotation: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const named = annotation.match(new RegExp(`${name}\\s*=\\s*(?:\\{\\s*)?["']([^"']+)["']`));
    if (named?.[1]) return named[1];
  }
  return annotation.match(/\(\s*["']([^"']+)["']/)?.[1];
}

function identifier(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => next ? next.toUpperCase() : "").replace(/^[^A-Za-z]+/, "");
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "ImportedMessage";
}

export async function importSpring(inputDirectory: string, options: { readonly applicationName?: string } = {}): Promise<SpringImportResult> {
  const root = resolve(inputDirectory);
  const discoveries: SpringDiscovery[] = [];
  const diagnostics: SpringImportDiagnostic[] = [];
  for (const file of await sources(root)) {
    const sourceName = relative(root, file).replaceAll("\\", "/");
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      const line = index + 1;
      const annotations: readonly [RegExp, SpringDiscovery["kind"], readonly string[]][] = [
        [/@KafkaListener\s*\((.*)\)/, "kafka-listener", ["topics", "topicPattern"]],
        [/@RabbitListener\s*\((.*)\)/, "rabbit-listener", ["queues"]],
        [/@EventListener(?:\s*\((.*)\))?/, "event-listener", []],
        [/@Scheduled\s*\((.*)\)/, "scheduled-handler", ["cron"]],
      ];
      for (const [pattern, kind, names] of annotations) {
        const match = text.match(pattern);
        if (!match) continue;
        const expression = match[0];
        const destination = names.length > 0 ? literal(expression, names) : undefined;
        discoveries.push({ kind, source: sourceName, line, ...(destination ? { destination } : {}), expression: expression.trim() });
        if (names.length > 0 && !destination) diagnostics.push({ severity: "warning", code: "SPRING_RUNTIME_ROUTING_REVIEW", message: `${kind} uses a property, expression, pattern, or runtime destination and needs review.`, source: sourceName, line });
      }
      if (/\.publishEvent\s*\(/.test(text)) discoveries.push({ kind: "event-publisher", source: sourceName, line, expression: text.trim() });
      if (/IntegrationFlow\s*\.|IntegrationFlows\s*\./.test(text)) {
        discoveries.push({ kind: "integration-flow", source: sourceName, line, expression: text.trim() });
        diagnostics.push({ severity: "warning", code: "SPRING_INTEGRATION_FLOW_REVIEW", message: "Spring Integration flow topology requires review; AIR does not invent semantics for arbitrary DSL expressions.", source: sourceName, line });
      }
      if (/spring\.(kafka|rabbitmq|data\.redis)|bootstrap\.servers|RabbitTemplate|KafkaTemplate/.test(text)) discoveries.push({ kind: "configuration", source: sourceName, line, expression: text.trim() });
    }
  }

  const eventDestinations = [...new Set(discoveries.filter((item) => item.kind === "kafka-listener" || item.kind === "event-listener" || item.kind === "event-publisher").flatMap((item) => item.destination ? [item.destination] : []))];
  const taskDestinations = [...new Set(discoveries.filter((item) => item.kind === "rabbit-listener").flatMap((item) => item.destination ? [item.destination] : []))];
  for (const item of discoveries.filter((candidate) => candidate.kind === "event-publisher" || candidate.kind === "event-listener" || candidate.kind === "scheduled-handler")) diagnostics.push({ severity: "warning", code: "SPRING_HANDLER_SEMANTICS_REVIEW", message: `${item.kind} was discovered, but its payload/command mapping must be modeled explicitly.`, source: item.source, line: item.line });
  const contracts: Record<string, ContractDefinition> = Object.fromEntries([...eventDestinations, ...taskDestinations].map((destination) => [`${identifier(destination)}Payload`, { description: `Review-imported payload for ${destination}.`, fields: { value: { type: "json", required: true } } }]));
  const events: Record<string, EventDefinition> = Object.fromEntries(eventDestinations.map((destination) => [identifier(destination), { kind: "integration", version: "1.0.0", payload: `${identifier(destination)}Payload`, description: `Imported from ${destination}; review name, version, and schema.` }]));
  const tasks: Record<string, TaskDefinition> = Object.fromEntries(taskDestinations.map((destination) => [identifier(destination), { payload: `${identifier(destination)}Payload`, description: `Imported from ${destination}; review routing and schema.` }]));
  const document: AirDocument = {
    apiVersion: "air.dev/v0.9", kind: "Application",
    metadata: { name: options.applicationName ?? "imported-spring", displayName: "Imported Spring application", description: "Review-required forward AIR model derived conservatively from Spring messaging declarations." },
    spec: {
      entities: { ImportReview: { description: "Non-authoritative marker used to keep the imported model structurally valid until domain entities are reviewed.", fields: { id: { type: "uuid", primaryKey: true, generated: "uuid" } } } },
      ...(Object.keys(contracts).length > 0 ? { contracts } : {}),
      ...(eventDestinations.length > 0 ? { events } : {}),
      ...(taskDestinations.length > 0 ? { tasks } : {}),
    },
  };
  return { document, discoveries, diagnostics };
}

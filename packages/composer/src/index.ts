import { dirname, resolve } from "node:path";
import { loadAirFile, loadDeploymentFile, loadSystemFile } from "@air/parser";
import type { AirDeploymentDocument, AirDocument, AirSystemDocument } from "@air/schema";
import { analyzeProviderPlan, providerFor, renderProviderPlan } from "@air/providers";
import type { DeploymentPlan, PluginArtifact, PluginDiagnostic, ProviderResourcePlan } from "@halilturkoglucs/air-plugin-sdk";

export interface CompositionBundle {
  readonly systemPath: string;
  readonly deploymentPath: string;
  readonly system: AirSystemDocument;
  readonly deployment: AirDeploymentDocument;
  readonly applications: Readonly<Record<string, AirDocument>>;
}

export interface CompositionPlan {
  readonly bundle: CompositionBundle;
  readonly deploymentPlan: DeploymentPlan;
  readonly providerPlans: readonly ProviderResourcePlan[];
  readonly artifacts: readonly PluginArtifact[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function loadComposition(systemPath: string, deploymentPath: string): Promise<CompositionBundle> {
  const [system, deployment] = await Promise.all([loadSystemFile(systemPath), loadDeploymentFile(deploymentPath)]);
  const applicationEntries = await Promise.all(Object.entries(system.spec.applications).map(async ([name, reference]) => [
    name,
    await loadAirFile(resolve(dirname(systemPath), reference.source)),
  ] as const));
  return { systemPath, deploymentPath, system, deployment, applications: Object.fromEntries(applicationEntries) };
}

function compositionDiagnostics(bundle: CompositionBundle): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  const { system, deployment, applications } = bundle;
  for (const componentName of Object.keys(deployment.spec.components ?? {})) {
    if (!system.spec.components[componentName]) diagnostics.push({ severity: "error", code: "DEPLOYMENT_UNKNOWN_COMPONENT", message: `Deployment override references unknown component ${componentName}.`, path: `/spec/components/${componentName}` });
  }
  for (const [channelName, channel] of Object.entries(system.spec.channels ?? {})) {
    const [applicationName, messageName] = channel.source.split(".");
    const application = applications[applicationName ?? ""];
    const exists = channel.kind === "event" ? application?.spec.events?.[messageName ?? ""] : application?.spec.tasks?.[messageName ?? ""];
    if (!exists) diagnostics.push({ severity: "error", code: "SYSTEM_UNKNOWN_MESSAGE", message: `${channel.kind} source ${channel.source} is not declared by its application.`, path: `/spec/channels/${channelName}/source` });
    for (const consumerName of channel.consumers) {
      const consumer = system.spec.components[consumerName];
      if (consumer && consumer.role !== "worker" && consumer.role !== "orchestrator" && consumer.role !== "realtime") diagnostics.push({ severity: "error", code: "SYSTEM_CHANNEL_CONSUMER_ROLE", message: `Component ${consumerName} cannot consume ${channelName} with role ${consumer.role}.`, path: `/spec/channels/${channelName}/consumers` });
    }
    const resourceName = deployment.spec.bindings[channelName];
    const resource = resourceName ? deployment.spec.resources[resourceName] : undefined;
    if (!resourceName) diagnostics.push({ severity: "error", code: "DEPLOYMENT_CHANNEL_UNBOUND", message: `Channel ${channelName} has no deployment binding.`, path: `/spec/bindings/${channelName}` });
    else if (resource?.kind !== "broker") diagnostics.push({ severity: "error", code: "DEPLOYMENT_CHANNEL_NOT_BROKER", message: `Channel ${channelName} must bind to a broker resource.`, path: `/spec/bindings/${channelName}` });
  }
  for (const [applicationName, application] of Object.entries(applications)) {
    for (const cacheName of Object.keys(application.spec.cachedReads ?? {})) {
      const qualified = `${applicationName}.${cacheName}`;
      const resourceName = deployment.spec.bindings[qualified];
      const resource = resourceName ? deployment.spec.resources[resourceName] : undefined;
      if (!resourceName) diagnostics.push({ severity: "error", code: "DEPLOYMENT_CACHE_UNBOUND", message: `Cached read ${qualified} has no deployment binding.`, path: `/spec/bindings/${qualified}` });
      else if (resource?.kind !== "cache") diagnostics.push({ severity: "error", code: "DEPLOYMENT_CACHE_NOT_CACHE", message: `Cached read ${qualified} must bind to a cache resource.`, path: `/spec/bindings/${qualified}` });
    }
  }
  for (const [sagaName, saga] of Object.entries(system.spec.sagas ?? {})) {
    const triggerApplication = applications[saga.trigger.application];
    const triggerEvent = triggerApplication?.spec.events?.[saga.trigger.event];
    if (!triggerEvent) diagnostics.push({ severity: "error", code: "SAGA_UNKNOWN_TRIGGER", message: `Saga trigger ${saga.trigger.application}.${saga.trigger.event} is not declared.`, path: `/spec/sagas/${sagaName}/trigger` });
    else if (!triggerApplication.spec.contracts?.[triggerEvent.payload]?.fields[saga.correlation]) diagnostics.push({ severity: "error", code: "SAGA_UNKNOWN_CORRELATION", message: `Saga correlation field ${saga.correlation} is not present in ${triggerEvent.payload}.`, path: `/spec/sagas/${sagaName}/correlation` });
    for (const [index, step] of saga.steps.entries()) {
      const application = "application" in step ? applications[step.application] : undefined;
      if (step.kind === "invoke") {
        if (!application?.spec.commands?.[step.command]) diagnostics.push({ severity: "error", code: "SAGA_UNKNOWN_COMMAND", message: `Saga command ${step.application}.${step.command} is not declared.`, path: `/spec/sagas/${sagaName}/steps/${index}/command` });
        if (step.compensate && !application?.spec.commands?.[step.compensate]) diagnostics.push({ severity: "error", code: "SAGA_UNKNOWN_COMPENSATION", message: `Saga compensation ${step.application}.${step.compensate} is not declared.`, path: `/spec/sagas/${sagaName}/steps/${index}/compensate` });
      } else if ((step.kind === "publish" || step.kind === "wait") && !application?.spec.events?.[step.event]) diagnostics.push({ severity: "error", code: "SAGA_UNKNOWN_EVENT", message: `Saga event ${step.application}.${step.event} is not declared.`, path: `/spec/sagas/${sagaName}/steps/${index}/event` });
    }
  }
  return diagnostics;
}

function providerPlans(bundle: CompositionBundle): ProviderResourcePlan[] {
  const channels = bundle.system.spec.channels ?? {};
  return Object.entries(bundle.deployment.spec.resources).map(([logicalName, resource]): ProviderResourcePlan => {
    const plugin = providerFor(resource.provider, resource.kind);
    return ({
    logicalName,
    kind: resource.kind,
    provider: resource.provider,
    ...(plugin ? { plugin: { id: plugin.id, version: plugin.version } } : {}),
    environment: resource.environment ?? {},
    channels: Object.entries(channels)
      .filter(([name]) => bundle.deployment.spec.bindings[name] === logicalName)
      .map(([name, channel]) => ({ name, kind: channel.kind, ordered: channel.ordered === true }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }); }).sort((left, right) => left.logicalName.localeCompare(right.logicalName));
}

function componentCommand(target: string, role: string): string {
  if (target === "rust-axum") return `AIR_COMPONENT_ROLE=${role} cargo run`;
  if (target === "python-fastapi") return role === "api" ? "uvicorn app:app --host 0.0.0.0 --port ${AIR_PORT:-3000}" : `python air_runtime.py ${role}`;
  return role === "api" ? "pnpm run dev" : `pnpm run air:${role}`;
}

function processArtifact(plan: DeploymentPlan): PluginArtifact {
  return { path: "processes.json", kind: "configuration", content: `${JSON.stringify({ processes: plan.components.map((component) => ({ ...component, cwd: `components/${component.name}`, command: componentCommand(component.target, component.role) })) }, null, 2)}\n` };
}

function composeArtifact(plan: DeploymentPlan): PluginArtifact {
  const lines = ["services:"];
  for (const component of plan.components) {
    const database = plan.resources.find((resource) => resource.kind === "database");
    const broker = plan.resources.find((resource) => resource.kind === "broker");
    const cache = plan.resources.find((resource) => resource.kind === "cache");
    lines.push(`  ${component.name}:`, `    build: ./components/${component.name}`, `    environment:`, `      AIR_COMPONENT_ROLE: ${component.role}`, `      AIR_COMPONENT_NAME: ${component.name}`, `      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318`, ...(database ? [`      DATABASE_URL: postgres://postgres:postgres@${database.logicalName}:5432/air`] : []), ...(broker ? [`      AIR_BROKER_PROVIDER: ${broker.provider}`, `      AIR_BROKER_URL: ${broker.provider === "kafka" ? `${broker.logicalName}:9092` : broker.provider === "rabbitmq" ? `amqp://guest:guest@${broker.logicalName}:5672` : `postgres://postgres:postgres@${broker.logicalName}:5432/air`}`] : []), ...(cache ? [`      REDIS_URL: redis://${cache.logicalName}:6379`] : []), `    depends_on:`, `      - otel-collector`, ...plan.resources.map((resource) => `      - ${resource.logicalName}`));
  }
  for (const resource of plan.resources) {
    const image = resource.provider === "kafka" ? "redpandadata/redpanda:v24.1.21" : resource.provider === "rabbitmq" ? "rabbitmq:4-management" : resource.provider === "redis" ? "redis:7-alpine" : "postgres:16-alpine";
    lines.push(`  ${resource.logicalName}:`, `    image: ${image}`);
    if (resource.provider === "kafka") lines.push(`    command: [redpanda, start, --overprovisioned, --smp, '1', --memory, 512M, --reserve-memory, 0M, --node-id, '0', --check=false, --kafka-addr, 0.0.0.0:9092, --advertise-kafka-addr, ${resource.logicalName}:9092]`);
    if (resource.provider === "postgres") lines.push("    environment:", "      POSTGRES_PASSWORD: postgres", "      POSTGRES_DB: air", "    healthcheck: { test: [CMD-SHELL, pg_isready -U postgres -d air], interval: 2s, timeout: 2s, retries: 30 }");
    if (resource.provider === "rabbitmq") lines.push("    healthcheck: { test: [CMD, rabbitmq-diagnostics, -q, ping], interval: 5s, timeout: 3s, retries: 30 }");
    if (resource.provider === "redis") lines.push("    healthcheck: { test: [CMD, redis-cli, ping], interval: 2s, timeout: 2s, retries: 30 }");
  }
  lines.push("  otel-collector:", "    image: otel/opentelemetry-collector:0.114.0", "    volumes:", "      - ./otel-collector.yaml:/etc/otelcol/config.yaml:ro");
  return { path: "compose.yaml", kind: "configuration", content: `${lines.join("\n")}\n` };
}

function kubernetesArtifacts(plan: DeploymentPlan): PluginArtifact[] {
  const name = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
  const database = plan.resources.find((resource) => resource.kind === "database");
  const broker = plan.resources.find((resource) => resource.kind === "broker");
  const cache = plan.resources.find((resource) => resource.kind === "cache");
  const documents = plan.components.flatMap((component) => {
    const componentName = name(component.name);
    const probes = component.role === "api" ? `
          readinessProbe: { httpGet: { path: /air-runtime/ready, port: 3000 } }
          livenessProbe: { httpGet: { path: /air-runtime/health, port: 3000 } }` : "";
    const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${componentName}
spec:
  replicas: ${component.replicas}
  selector: { matchLabels: { app: ${componentName} } }
  template:
    metadata: { labels: { app: ${componentName} } }
    spec:
      containers:
        - name: ${componentName}
          image: ${componentName}:latest
          env:
            - { name: AIR_COMPONENT_ROLE, value: ${component.role} }
            - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: http://otel-collector:4318 }
${database ? `            - { name: DATABASE_URL, value: postgres://postgres:postgres@${name(database.logicalName)}:5432/air }\n` : ""}${broker ? `            - { name: AIR_BROKER_PROVIDER, value: ${broker.provider} }\n            - { name: AIR_BROKER_URL, value: ${broker.provider === "kafka" ? `${name(broker.logicalName)}:9092` : broker.provider === "rabbitmq" ? `amqp://guest:guest@${name(broker.logicalName)}:5672` : `postgres://postgres:postgres@${name(broker.logicalName)}:5432/air`} }\n` : ""}${cache ? `            - { name: REDIS_URL, value: redis://${name(cache.logicalName)}:6379 }\n` : ""}${probes}
`;
    const service = component.role === "api" ? `apiVersion: v1
kind: Service
metadata: { name: ${componentName} }
spec:
  selector: { app: ${componentName} }
  ports: [{ name: http, port: 3000, targetPort: 3000 }]
` : undefined;
    return service ? [deployment, service] : [deployment];
  });
  const providerDocuments = plan.resources.flatMap((resource) => {
    const resourceName = name(resource.logicalName);
    const image = resource.provider === "kafka" ? "redpandadata/redpanda:v24.1.21" : resource.provider === "rabbitmq" ? "rabbitmq:4-management" : resource.provider === "redis" ? "redis:7-alpine" : "postgres:16-alpine";
    const port = resource.provider === "kafka" ? 9092 : resource.provider === "rabbitmq" ? 5672 : resource.provider === "redis" ? 6379 : 5432;
    const environment = resource.provider === "postgres" ? "\n          env:\n            - { name: POSTGRES_PASSWORD, value: postgres }\n            - { name: POSTGRES_DB, value: air }" : "";
    const command = resource.provider === "kafka" ? `
          args: [redpanda, start, --overprovisioned, --smp, "1", --memory, 512M, --reserve-memory, 0M, --node-id, "0", --check=false, --kafka-addr, 0.0.0.0:9092, --advertise-kafka-addr, ${resourceName}:9092]` : "";
    return [`apiVersion: apps/v1
kind: Deployment
metadata: { name: ${resourceName} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${resourceName} } }
  template:
    metadata: { labels: { app: ${resourceName} } }
    spec:
      containers:
        - name: ${resourceName}
          image: ${image}
          ports: [{ containerPort: ${port} }]${environment}${command}
`, `apiVersion: v1
kind: Service
metadata: { name: ${resourceName} }
spec:
  selector: { app: ${resourceName} }
  ports: [{ port: ${port}, targetPort: ${port} }]
`];
  });
  const observabilityDocuments = [`apiVersion: v1
kind: ConfigMap
metadata: { name: otel-collector }
data:
  config.yaml: |
    receivers: { otlp: { protocols: { grpc: {}, http: {} } } }
    exporters: { debug: {} }
    service: { pipelines: { traces: { receivers: [otlp], exporters: [debug] }, metrics: { receivers: [otlp], exporters: [debug] }, logs: { receivers: [otlp], exporters: [debug] } } }
`, `apiVersion: apps/v1
kind: Deployment
metadata: { name: otel-collector }
spec:
  replicas: 1
  selector: { matchLabels: { app: otel-collector } }
  template:
    metadata: { labels: { app: otel-collector } }
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector:0.114.0
          args: [--config=/etc/otelcol/config.yaml]
          volumeMounts: [{ name: config, mountPath: /etc/otelcol }]
      volumes: [{ name: config, configMap: { name: otel-collector } }]
`, `apiVersion: v1
kind: Service
metadata: { name: otel-collector }
spec:
  selector: { app: otel-collector }
  ports: [{ name: otlp-grpc, port: 4317 }, { name: otlp-http, port: 4318 }]
`];
  const rendered = [...documents, ...providerDocuments, ...observabilityDocuments].join("---\n");
  const chart = `apiVersion: v2\nname: ${plan.name}\nversion: 0.1.0\ntype: application\n`;
  return [
    { path: "kubernetes/components.yaml", kind: "configuration", content: rendered },
    { path: "helm/Chart.yaml", kind: "configuration", content: chart },
    { path: "helm/templates/components.yaml", kind: "configuration", content: rendered },
  ];
}

function terraformArtifact(plan: DeploymentPlan): PluginArtifact {
  return { path: "terraform/main.tf", kind: "configuration", content: `terraform {
  required_providers { helm = { source = "hashicorp/helm", version = "~> 3.0" } }
}
provider "helm" { kubernetes = {} }
resource "helm_release" "air" {
  name = ${JSON.stringify(plan.name)}
  chart = "${"${path.module}"}/../helm"
}
` };
}

export function planComposition(bundle: CompositionBundle): CompositionPlan {
  const providers = providerPlans(bundle);
  const deploymentPlan: DeploymentPlan = {
    name: bundle.system.metadata.name,
    profile: bundle.deployment.spec.profile,
    components: Object.entries(bundle.system.spec.components).map(([name, component]) => ({
      name,
      role: component.role,
      target: component.target,
      replicas: bundle.deployment.spec.components?.[name]?.replicas ?? 1,
    })).sort((left, right) => left.name.localeCompare(right.name)),
    resources: providers,
  };
  const diagnostics = [...compositionDiagnostics(bundle), ...providers.flatMap((provider) => analyzeProviderPlan(provider))];
  const artifacts: PluginArtifact[] = [
    { path: ".air/composition.json", kind: "metadata", content: `${JSON.stringify({ format: "air.dev/composition/v0.1", system: bundle.system.metadata.name, deployment: bundle.deployment.metadata.name, profile: deploymentPlan.profile, components: deploymentPlan.components, resources: deploymentPlan.resources }, null, 2)}\n` },
    { path: "otel-collector.yaml", kind: "configuration", content: "receivers:\n  otlp:\n    protocols: { grpc: {}, http: {} }\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces: { receivers: [otlp], exporters: [debug] }\n    metrics: { receivers: [otlp], exporters: [debug] }\n    logs: { receivers: [otlp], exporters: [debug] }\n" },
    ...providers.flatMap((provider) => renderProviderPlan(provider)),
  ];
  if (deploymentPlan.profile === "process") artifacts.push(processArtifact(deploymentPlan));
  if (["docker", "compose"].includes(deploymentPlan.profile)) artifacts.push(composeArtifact(deploymentPlan));
  if (["kubernetes", "terraform-kubernetes"].includes(deploymentPlan.profile)) artifacts.push(...kubernetesArtifacts(deploymentPlan));
  if (deploymentPlan.profile === "terraform-kubernetes") artifacts.push(terraformArtifact(deploymentPlan));
  return { bundle, deploymentPlan, providerPlans: providers, artifacts, diagnostics };
}

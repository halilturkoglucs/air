export const AIR_PLUGIN_API_VERSION = "air.dev/plugin/v0.1" as const;

export type PluginDiagnosticSeverity = "info" | "warning" | "error";
export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly help?: string;
}

export interface PluginArtifact {
  readonly path: string;
  readonly kind: "source" | "configuration" | "documentation" | "metadata";
  readonly content: string;
}

export interface ProviderResourcePlan {
  readonly logicalName: string;
  readonly kind: "broker" | "cache" | "database";
  readonly provider: string;
  readonly plugin?: { readonly id: string; readonly version: string };
  readonly environment: Readonly<Record<string, string>>;
  readonly channels: readonly {
    readonly name: string;
    readonly kind: "event" | "task";
    readonly ordered: boolean;
  }[];
}

export interface ProviderHealthResult {
  readonly ready: boolean;
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly metrics?: Readonly<Record<string, number>>;
}

export interface ProviderConformanceAdapter {
  publish(channel: string, envelope: Readonly<Record<string, unknown>>): Promise<void>;
  receive(channel: string, options?: { readonly timeoutMs?: number }): Promise<Readonly<Record<string, unknown>> | undefined>;
  acknowledge?(messageId: string): Promise<void>;
  reject?(messageId: string, options: { readonly requeue: boolean }): Promise<void>;
  health(): Promise<ProviderHealthResult>;
  close(): Promise<void>;
}

export interface ProviderLocalRuntime {
  readonly id: string;
  readonly environment: Readonly<Record<string, string>>;
  health(): Promise<ProviderHealthResult>;
  stop(): Promise<void>;
}

export interface AirProviderPlugin {
  readonly apiVersion: typeof AIR_PLUGIN_API_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly providers: readonly string[];
  readonly capabilities: readonly string[];
  analyze(plan: ProviderResourcePlan): readonly PluginDiagnostic[];
  render(plan: ProviderResourcePlan): readonly PluginArtifact[];
  startLocal?(plan: ProviderResourcePlan): Promise<ProviderLocalRuntime>;
  health?(configuration: Readonly<Record<string, string>>): Promise<ProviderHealthResult>;
  createConformanceAdapter?(configuration: Readonly<Record<string, string>>): Promise<ProviderConformanceAdapter>;
}

export interface DeploymentPlan {
  readonly name: string;
  readonly profile: "process" | "docker" | "compose" | "kubernetes" | "terraform-kubernetes";
  readonly components: readonly {
    readonly name: string;
    readonly role: "api" | "worker" | "scheduler" | "orchestrator" | "realtime";
    readonly target: "nextjs" | "rust-axum" | "python-fastapi";
    readonly replicas: number;
  }[];
  readonly resources: readonly ProviderResourcePlan[];
}

export interface AirDeployerPlugin {
  readonly apiVersion: typeof AIR_PLUGIN_API_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly profiles: readonly DeploymentPlan["profile"][];
  analyze(plan: DeploymentPlan): readonly PluginDiagnostic[];
  render(plan: DeploymentPlan): readonly PluginArtifact[];
  startLocal?(plan: DeploymentPlan): Promise<{ readonly stop: () => Promise<void>; readonly health: () => Promise<ProviderHealthResult> }>;
}

export interface AirPluginModule {
  readonly provider?: AirProviderPlugin;
  readonly deployer?: AirDeployerPlugin;
}

export function assertPluginCompatibility(plugin: AirPluginModule): void {
  for (const candidate of [plugin.provider, plugin.deployer]) {
    if (candidate && candidate.apiVersion !== AIR_PLUGIN_API_VERSION) {
      throw new Error(`Unsupported AIR plugin API ${String(candidate.apiVersion)}; expected ${AIR_PLUGIN_API_VERSION}.`);
    }
  }
}

export function assertLockedPlugin(plan: ProviderResourcePlan, plugin: AirProviderPlugin): void {
  if (!plan.plugin) throw new Error(`Provider resource ${plan.logicalName} must explicitly lock plugin ${plugin.id}@${plugin.version}.`);
  if (plan.plugin.id !== plugin.id || plan.plugin.version !== plugin.version) throw new Error(`Provider resource ${plan.logicalName} locks ${plan.plugin.id}@${plan.plugin.version}, but ${plugin.id}@${plugin.version} was loaded.`);
}

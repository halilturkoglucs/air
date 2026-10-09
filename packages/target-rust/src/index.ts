import {
  CAPABILITY_MANIFEST_VERSION,
  type CapabilityManifest,
  type CompilationContext,
  type CompilationDiagnostic,
  type CompilationResult,
  type TargetAdapter,
} from "@air/compiler-core";
import { compileRust, planRust, validateRustTarget } from "./compiler.js";
import type { RustTargetOptions } from "./types.js";

export const rustCapabilityManifest = {
  apiVersion: CAPABILITY_MANIFEST_VERSION,
  target: { id: "rust-axum", displayName: "Rust Axum", version: "0.10.0" },
  capabilities: {
    "http.crud": { support: "supported", constraints: [{ kind: "air-version", minimum: "air.dev/v0.1", maximum: "air.dev/v0.9" }] },
    "http.collections": { support: "supported" },
    "domain.commands": {
      support: "conditional",
      conditions: ["AIR v0.9 create/update/delete effects, named atomic updates, authorization, invariants, idempotency, bounded retry, and transactional message effects are generated."],
      constraints: [{ kind: "primary-effect-in", values: ["create", "update", "delete"] }],
    },
    "authorization.ownership": { support: "supported" },
    "authorization.roles-scopes": { support: "supported" },
    "domain.invariants": { support: "supported" },
    "domain.multi_effect": { support: "conditional", constraints: [{ kind: "maximum-named-effects", value: 32 }] },
    "domain.idempotency": { support: "supported" },
    "domain.delete": { support: "supported" },
    "persistence.relational": { support: "conditional", conditions: ["PostgreSQL through SQLx is the only persistence provider."], constraints: [{ kind: "option-in", option: "database", values: ["postgres"] }] },
    "messaging.publish": { support: "supported" },
    "messaging.consume": { support: "supported" },
    "messaging.tasks": { support: "supported" },
    "messaging.ordering": { support: "supported" },
    "background.workers": { support: "supported" },
    "background.schedules": { support: "supported" },
    "background.long-running": { support: "supported" },
    "orchestration.sagas": { support: "supported" },
    "cache.derived": { support: "supported" },
    "realtime.websocket": { support: "supported" },
    "realtime.sse": { support: "supported" },
    "observability.opentelemetry": { support: "supported" },
    "deployment.container": { support: "supported" },
    "ui.web": { support: "unsupported" },
  },
} as const satisfies CapabilityManifest;

export class RustTargetAdapter implements TargetAdapter<RustTargetOptions> {
  readonly id = "rust-axum";
  readonly displayName = "Rust Axum";
  readonly version = "0.10.0";
  readonly manifest = rustCapabilityManifest;
  async analyze(context: CompilationContext<RustTargetOptions>): Promise<readonly CompilationDiagnostic[]> { return validateRustTarget(context); }
  async compile(context: CompilationContext<RustTargetOptions>): Promise<CompilationResult> { return compileRust(context); }
}

export { planRust };
export type { PlannedRustFile, ResolvedRustTargetOptions, RustTargetOptions } from "./types.js";

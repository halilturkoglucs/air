import {
  CAPABILITY_MANIFEST_VERSION,
  type CapabilityManifest,
  type CompilationContext,
  type CompilationDiagnostic,
  type CompilationResult,
  type TargetAdapter,
} from "@air/compiler-core";
import { compilePython, planPython, validatePythonTarget } from "./compiler.js";
import type { PythonTargetOptions } from "./types.js";

export const pythonCapabilityManifest = {
  apiVersion: CAPABILITY_MANIFEST_VERSION,
  target: { id: "python-fastapi", displayName: "Python FastAPI", version: "0.1.0" },
  capabilities: {
    "http.crud": { support: "supported", constraints: [{ kind: "air-version", minimum: "air.dev/v0.1", maximum: "air.dev/v0.8" }] },
    "http.collections": { support: "supported" },
    "domain.commands": {
      support: "conditional",
      conditions: ["AIR v0.8 create/update/delete effects, named atomic updates, authorization, invariants, idempotency, and bounded retry are generated."],
      constraints: [{ kind: "primary-effect-in", values: ["create", "update", "delete"] }],
    },
    "authorization.ownership": { support: "supported" },
    "authorization.roles-scopes": { support: "supported" },
    "domain.invariants": { support: "supported" },
    "domain.multi_effect": { support: "conditional", constraints: [{ kind: "maximum-named-effects", value: 32 }] },
    "domain.idempotency": { support: "supported" },
    "domain.delete": { support: "supported" },
    "persistence.relational": { support: "conditional", conditions: ["PostgreSQL through psycopg 3 is the only persistence provider."], constraints: [{ kind: "option-in", option: "database", values: ["postgres"] }] },
    "deployment.container": { support: "supported" },
    "ui.web": { support: "unsupported" },
  },
} as const satisfies CapabilityManifest;

export class PythonTargetAdapter implements TargetAdapter<PythonTargetOptions> {
  readonly id = "python-fastapi";
  readonly displayName = "Python FastAPI";
  readonly version = "0.1.0";
  readonly manifest = pythonCapabilityManifest;
  async analyze(context: CompilationContext<PythonTargetOptions>): Promise<readonly CompilationDiagnostic[]> { return validatePythonTarget(context); }
  async compile(context: CompilationContext<PythonTargetOptions>): Promise<CompilationResult> { return compilePython(context); }
}

export { planPython };
export type { PlannedPythonFile, PythonTargetOptions, ResolvedPythonTargetOptions } from "./types.js";

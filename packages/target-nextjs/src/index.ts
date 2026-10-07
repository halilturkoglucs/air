import {
  CAPABILITY_MANIFEST_VERSION,
  type CapabilityManifest,
  type CompilationContext,
  type CompilationDiagnostic,
  type CompilationResult,
  type TargetAdapter,
} from "@air/compiler-core";
import { compileNextjs, planNextjs, validateNextjsTarget } from "./compiler.js";

export interface NextjsTargetOptions {
  readonly frameworkVersion?: string;
  readonly packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  readonly deployment?: "vercel" | "node";
  readonly database?: "postgres";
}

export const nextjsCapabilityManifest = {
  apiVersion: CAPABILITY_MANIFEST_VERSION,
  target: {
    id: "nextjs",
    displayName: "Next.js",
    version: "0.9.0",
  },
  capabilities: {
    "http.crud": {
      support: "supported",
      notes: "Mapped to App Router route handlers using Node.js runtime.",
      constraints: [{ kind: "air-version", minimum: "air.dev/v0.1", maximum: "air.dev/v0.8" }],
    },
    "http.collections": { support: "supported" },
    "domain.commands": {
      support: "conditional",
      conditions: [
        "AIR v0.7 create/update effects, named atomic updates, guards, ownership authorization, invariant expressions, state preconditions, idempotency replay, and declared transaction isolation are supported.",
      ],
      constraints: [
        { kind: "air-version", minimum: "air.dev/v0.3", maximum: "air.dev/v0.8" },
        { kind: "primary-effect-in", values: ["create", "update", "delete"] },
      ],
      notes: "Commands lower to explicit App Router handlers and transactional domain functions with conflict errors.",
    },
    "authorization.ownership": {
      support: "conditional",
      conditions: [
        "Command authorization supports input-to-principal and persisted-record-to-principal equality rules.",
        "The generated Next.js boundary verifies HS256 bearer JWTs using AIR_AUTH_SECRET and same-named principal claims.",
      ],
      notes: "AIR remains identity-provider neutral and verifies same-named principal claims at the generated boundary.",
    },
    "authorization.roles-scopes": { support: "supported" },
    "domain.invariants": {
      support: "conditional",
      conditions: [
        "Typed scalar comparisons and nested all, any, and not expressions are supported.",
        "Record operands currently require a single-entity update effect; ordered comparisons require non-null numbers.",
      ],
      notes: "Invariant failures map to declared domain errors and run inside the command transaction.",
    },
    "domain.multi_effect": {
      support: "conditional",
      conditions: [
        "Named effects are update effects followed by one primary create effect.",
        "All records are selected with row locks and all mutations run in one PostgreSQL transaction.",
      ],
    },
    "domain.idempotency": {
      support: "conditional",
      conditions: [
        "Scoped replay uses a unique output-entity field plus one authenticated principal field.",
        "Serialization, deadlock, and idempotency races support one to ten declared attempts.",
      ],
    },
    "domain.delete": { support: "supported" },
    "persistence.relational": {
      support: "conditional",
      conditions: ["PostgreSQL is the only persistence provider in the current target."],
      constraints: [{ kind: "option-in", option: "database", values: ["postgres"] }],
    },
    "ui.web": {
      support: "supported",
      notes: "A basic generated CRUD console is emitted; custom AIR UI remains future work.",
    },
    "background.long-running": {
      support: "unsupported",
      notes: "A long-running worker requires a separate deployment target.",
    },
    "deployment.vercel": {
      support: "supported",
      notes: "Generated applications use the default Node.js runtime and external PostgreSQL.",
    },
  },
} as const satisfies CapabilityManifest;

export class NextjsTargetAdapter implements TargetAdapter<NextjsTargetOptions> {
  readonly id = "nextjs";
  readonly displayName = "Next.js";
  readonly version = "0.9.0";
  readonly manifest = nextjsCapabilityManifest;

  async analyze(
    context: CompilationContext<NextjsTargetOptions>,
  ): Promise<readonly CompilationDiagnostic[]> {
    return validateNextjsTarget(context);
  }

  async compile(
    context: CompilationContext<NextjsTargetOptions>,
  ): Promise<CompilationResult> {
    return compileNextjs(context);
  }
}

export { planNextjs };
export type { PlannedNextjsFile, ResolvedNextjsOptions } from "./types.js";

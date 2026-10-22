import { basename, dirname, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  AirMigrationError,
  AirParseError,
  AirValidationError,
  type AirSourceDocument,
  loadAirFile,
  parseAir,
  migrateAirDocument,
  diffAirDocuments,
  loadAirSourceFile,
  planAirEvolution,
  serializeAir,
} from "@air/parser";
import type { AirDeploymentDocument, AirDocument, AirSystemDocument, AirUiDocument } from "@air/schema";
import { loadComposition, planComposition } from "@air/composer";
import { providerFor } from "@air/providers";
import { importPostgres } from "@air/import-postgres";
import { importOpenApiSource } from "@air/import-openapi";
import { importNextjs } from "@air/import-nextjs";
import { importSpring } from "@air/import-spring";
import { CheckInfrastructureError, CheckInputError, adoptExtractedCapability, createCheckBaseline, discoverSpring, discoveryFromAirCandidate, extractCapability, ingestEvidence, initializeMigrationCheck, loadCheckBaseline, loadCheckPolicy, loadCheckTarget, loadMigrationCheck, mergeDiscoveryBundles, parseCheckResult, readDiscoveryBundle, runMigrationCheckDetailed, observeCheckTarget, approveBaselineScenarios, diffBaselines, checkFromExchanges, exchangesFromHar, recordHttpTraffic, writeRecordedCheck, traceMapFromOtlp, formatTraceMap, verifyHarness, createCheckBaselineDetailed, observationDigest, checkFromOpenApi, checkCoverage, formatCoverage, type CheckBaseline, sameDigest, buildAgentReport, formatAgentReport, differenceKey, AGENT_PROTOCOL, startWorkbench, validateMigrationCheck, verifyImportedCapability, writeCheckBaseline, writeCheckResult, writeDiscoveryBundle, writeDiscoveryReport, type CheckMismatch, type CheckDocument, type DiscoveryBundle, scanCodeSeams, formatCodeSeams } from "@air/discovery";
import { startLanguageServer } from "@air/language-server";
import { NextjsTargetAdapter, type NextjsTargetOptions } from "@air/target-nextjs";
import { RustTargetAdapter, type RustTargetOptions } from "@air/target-rust";
import { PythonTargetAdapter, type PythonTargetOptions } from "@air/target-python";
import { solveTargetCompatibility } from "@air/compiler-core";
import {
  benchmarkLiveScenario,
  benchmarkMutationScenario,
  benchmarkConflictScenario,
  parseVerificationSuite,
  parseSystemVerificationSuite,
  VerificationParseError,
  verifyDifferentialSuite,
  verifyLiveSuite,
  verifySuite,
  verifySystemSuite,
} from "@air/verifier";
import { createPostgresHttpLiveAdapter } from "./live-verifier.js";
import { captureEvidence } from "./evidence-capture.js";
import { AGENT_INSTRUCTIONS, serveMcp } from "./agent.js";
import packageJson from "../package.json" with { type: "json" };

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

export const VERSION = packageJson.version;

const HELP = `AIR verification and compiler toolkit ${VERSION}

Usage:
  air check init <discovery> --capability <id> --output <directory>
  air check profile --check <file> --baseline <dir> --legacy <file> --candidate <file> --output <dir> [--policy <file>]
  air check validate [<check.yaml>] [--policy <file>] [--json]
  air check baseline [<check.yaml>] [--target <file>] [--output <directory>] [--policy <file>] [--allow-dirty] [--json]
  air check run [<check.yaml>] [--baseline <dir>] [--target <file>] [--output <dir>] [--policy <file>] [--agent] [--reveal] [--max-lines <n>] [--json]
  air check explain <result.json> [--agent] [--json]
  air check status [--json]                   Check profile and last-run summary (runs nothing)
  air check record --to <url> --output <dir> [--from-har <file>]  Record HTTP traffic (proxy or HAR) into a check
  air check approve <scenario>... --reason <text>  Accept the candidate's behavior for chosen scenarios
  air check diff-baseline <before> <after>    Show behavioral differences between two baselines
  air check init --from-openapi <spec> --output <dir>  Scenario skeletons for every OpenAPI operation
  air check coverage [<check.yaml>] --openapi <spec> | --traces <otlp.json> [--fail-under <percent>]
  air protect [--url <url> -- <command>]      Record and baseline a running service once; afterwards check every change
  air agent install [--mcp]                   Add AIR's loop to AGENTS.md / CLAUDE.md (and register MCP)
  air harness task | new <name> | verify <name> --mutation <patch>  Lock events, caches, data, jobs via verified harnesses
  air agent instructions                      Print the agent repair loop for AGENTS.md / CLAUDE.md
  air mcp                                     Serve air_check_* tools over MCP stdio
  air validate <file>                         Parse and validate AIR YAML
  air inspect <file>                          Print a semantic summary
  air migrate <file> [options]                Migrate AIR to a newer schema
  air diff <before> <after> [--output <file>] Review semantic compatibility
  air plan-migration <before> <after> [options] Plan schema evolution safely
  air import-postgres [options]               Import a PostgreSQL schema into AIR
  air import-openapi [options]                Import OpenAPI 3.x into reviewable AIR
  air import-nextjs [options]                 Import Next.js App Router + Drizzle into AIR
  air discover spring <repository> [options] Build an evidence-backed discovery bundle
  air discover traces <otlp.json> [options]  Map endpoints to DB, outbound, and messaging from OpenTelemetry
  air discover code [<path>] [--symbol <name>] [--since <ref>]  Propose behavioral seams in any JS/TS, Python, or Go code
  air discovery report <bundle> [options] Export a deterministic discovery report
  air evidence ingest <trace> [options]      Ingest redacted runtime/test evidence
  air evidence capture <profile> [options]   Run a command with self-hosted evidence adapters
  air workbench <discovery> [options]        Start the local architecture workbench
  air extract <discovery> [options]          EXPERIMENTAL: extract one reviewed capability
  air verify-import <capability> [options]   EXPERIMENTAL: compare legacy and candidate behavior
  air verify <file> --scenarios <file> [--output <file>]
                                              Execute canonical verification scenarios
  air verify-live <file> [options]             Verify a running target over HTTP + PostgreSQL
  air verify-differential <file> [options]     Compare two or more running targets
  air benchmark-live <file> [options]          Benchmark a validated replay scenario
  air evidence-pack [options]                  Assemble immutable verification evidence
  air evidence-verify <directory>              Verify every evidence-pack checksum
  air ownership <directory> [--json]          Inspect generated/user ownership boundaries
  air adopt <directory> --user-owned <path>   EXPERIMENTAL for capability adoption
  air reconcile <directory> [--json]          Alias for ownership drift inspection
  air target-check <file> [options]           Solve target compatibility and preferences
  air lsp                                      Start the AIR language server over stdio
  air compile [file] --target <target> [options] Generate a target application
  air compose <system> --deployment <file> --output <dir>
                                              Generate a complete service topology
  air dev <system> --deployment <file> [--output <dir>]
                                              Compose and start a local topology
  air verify-system <system> --scenarios <file> [--output <file>]
                                              Verify asynchronous system behavior
  air provider-check <deployment> [--json] [--live]
                                               Validate provider bindings and health
  air import-spring [options]                Import Spring messaging into reviewable AIR
  air help                                    Show this help

Compile options:
  --output <directory>       Output directory (default: dist/nextjs)
  --package-manager <name>   pnpm, npm, yarn, or bun (default: pnpm)
  --deployment <name>        Target deployment: vercel/node, binary/container, or process/container
  --framework-version <ver>  Next.js version (default: 16.0.0)
  --rust-edition <edition>   Rust edition 2021 or 2024 (default: 2024)
  --rust-version <version>   Exact Rust toolchain version (default: 1.99.0)
  --python-version <version> Python 3 version (default: 3.12)
  --database <name>         postgres or mongodb (default: postgres)
  --detach                   Omit managed-mode ownership metadata

Migrate options:
  --to <version>             Target version (default: air.dev/v0.10)
  --output <file>            Output file (default: <file>.v0.10.yaml)

PostgreSQL import options:
  --url <postgres-url>       PostgreSQL connection URL (required)
  --output <file>            AIR output file (required)
  --name <name>              AIR application name (default: imported-app)
  --schema <schema>          PostgreSQL schema (default: public)
  --discovery <directory>   Merge review-required findings into discovery v0.1

OpenAPI import options:
  --input <file>             OpenAPI 3.x YAML or JSON document (required)
  --output <file>            AIR output file (required)
  --name <name>              AIR application name (default: imported-api)
  --discovery <directory>    Merge review-required findings into discovery v0.1

Next.js import options:
  --input <directory>        Next.js project directory (required)
  --schema <path>            Drizzle schema path relative to the project
  --output <file>            AIR output file (required)
  --report <file>            JSON provenance/diagnostic report (optional)
  --name <name>              AIR application name (default: project directory)
  --discovery <directory>    Merge review-required findings into discovery v0.1

Live verification options:
  --scenarios <file>         Canonical verification suite (required)
  --base-url <url>           Running target URL (required)
  --database-url <url>       PostgreSQL URL (or AIR_DATABASE_URL)
  --auth-secret <secret>     HS256 auth secret (or AIR_AUTH_SECRET)
  --allow-database-reset     Required acknowledgement; deletes target-table rows
  --output <file>            Optional JSON evidence output

Differential verification options:
  --scenarios <file>         Canonical verification suite (required)
  --target <name>=<url>      Running target; repeat at least twice
  --database-url <name>=<url> Dedicated PostgreSQL URL for each target
  --auth-secret <secret>     Shared HS256 secret (or AIR_AUTH_SECRET)
  --allow-database-reset     Required acknowledgement; deletes target-table rows
  --output <file>            Optional JSON evidence output

Live benchmark options:
  --scenarios <file>         Canonical verification suite (required)
  --scenario <id>            Idempotent replay scenario (required)
  --workload <name>          replay, mutation, or conflict (default: replay)
  --base-url <url>           Running target URL (required)
  --database-url <url>       Dedicated PostgreSQL URL (or AIR_DATABASE_URL)
  --auth-secret <secret>     HS256 secret (or AIR_AUTH_SECRET)
  --warmup <count>           Warmup requests (default: 20)
  --requests <count>         Measured requests (default: 200)
  --duration-seconds <n>     Measure replay traffic for a fixed duration
  --repetitions <count>      Repeat independently and compute confidence data
  --concurrency <count>      Concurrent request workers (default: 10)
  --client-retries <count>   Retries after retryable 409s (default: 20)
  --target-pid <pid>         Sample target RSS and CPU with ps
  --artifact-path <path>     Measure emitted artifact bytes
  --allow-database-reset     Required acknowledgement; deletes target-table rows
  --output <file>            Optional JSON evidence output

Evidence pack options:
  --artifact <name>=<file>   Evidence JSON artifact; repeat as needed
  --output <directory>       New evidence-pack directory (required)
`;

async function targetCheck(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  if (!file || file.startsWith("--")) {
    io.stderr("Usage: air target-check <file> [--require <capability>] [--prefer <capability>] [--json]\n");
    return 2;
  }
  const required: string[] = [];
  const preferred: string[] = [];
  let json = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--json") { json = true; continue; }
    const value = options[index + 1];
    if ((option !== "--require" && option !== "--prefer") || !value || value.startsWith("--")) {
      io.stderr(`Invalid target-check option: ${option ?? "<missing>"}.\n`);
      return 2;
    }
    index += 1;
    (option === "--require" ? required : preferred).push(value);
  }
  try {
    const air = await loadAirFile(resolve(file));
    const report = await solveTargetCompatibility({
      air,
      required,
      preferred,
      candidates: [
        { adapter: new NextjsTargetAdapter(), options: { frameworkVersion: "16.0.0", packageManager: "pnpm", deployment: "node", database: "postgres" } },
        { adapter: new RustTargetAdapter(), options: { rustEdition: "2024", rustVersion: "1.99.0", deployment: "binary", database: "postgres" } },
        { adapter: new PythonTargetAdapter(), options: { pythonVersion: "3.12", deployment: "process", database: "postgres" } },
      ],
    });
    if (json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else {
      io.stdout(`Target compatibility: ${resolve(file)}\n`);
      for (const result of report.results) {
        io.stdout(`  ${result.compatible ? "PASS" : "FAIL"} ${result.targetId} (preference score ${result.preferenceScore})\n`);
        for (const item of result.diagnostics) io.stdout(`    ${item.code}: ${item.message}\n`);
      }
    }
    return report.results.some((result) => result.compatible) ? 0 : 1;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

function formatError(error: unknown): string {
  if (error instanceof AirValidationError) {
    const issues = error.issues
      .map((issue) => `  - ${issue.path} [${issue.code}] ${issue.message}`)
      .join("\n");
    return `${error.message}\n${issues}\n`;
  }
  if (error instanceof AirParseError) return `${error.message}\n`;
  if (error instanceof AirMigrationError) {
    return `${error.message}\n${error.problems.map((problem) => `  - ${problem}`).join("\n")}\n`;
  }
  if (error instanceof VerificationParseError) {
    return `${error.message}\n${error.issues.map((issue) => `  - ${issue}`).join("\n")}\n`;
  }
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return `AIR file not found.\n`;
  }
  return `${error instanceof Error ? error.message : String(error)}\n`;
}

async function mergeIntoDiscovery(directory: string, candidate: DiscoveryBundle): Promise<void> {
  try {
    const existing = await readDiscoveryBundle(directory);
    await writeDiscoveryBundle(directory, mergeDiscoveryBundles(existing, [candidate]));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await writeDiscoveryBundle(directory, candidate);
  }
}

function inspect(document: AirDocument): string {
  const entities = Object.entries(document.spec.entities);
  const operations = document.spec.http?.operations ?? [];
  const lines = [
    `Application: ${document.metadata.displayName ?? document.metadata.name}`,
    `Name: ${document.metadata.name}`,
    `AIR version: ${document.apiVersion}`,
    `Entities (${entities.length}):`,
  ];

  for (const [name, entity] of entities) {
    const relationshipCount = Object.keys(entity.relationships ?? {}).length;
    lines.push(
      `  - ${name}: ${Object.keys(entity.fields).length} field(s), ${relationshipCount} relationship(s)`,
    );
  }

  lines.push(`HTTP operations (${operations.length}):`);
  for (const operation of operations) {
    const target =
      "command" in operation
        ? `command ${operation.command}`
        : `${operation.entity}.${operation.action}`;
    lines.push(`  - ${operation.method.padEnd(6)} ${operation.path} -> ${target} (${operation.id})`);
  }

  const contracts = Object.keys(document.spec.contracts ?? {});
  const commands = Object.keys(document.spec.commands ?? {});
  if (contracts.length > 0) lines.push(`Contracts (${contracts.length}): ${contracts.join(", ")}`);
  if (commands.length > 0) lines.push(`Commands (${commands.length}): ${commands.join(", ")}`);

  return `${lines.join("\n")}\n`;
}

function inspectSource(document: AirSourceDocument): string {
  if (document.kind === "Application") return inspect(document);
  if (document.kind === "System") {
    const system = document as AirSystemDocument;
    return [
      `System: ${system.metadata.displayName ?? system.metadata.name}`,
      `Name: ${system.metadata.name}`,
      `AIR version: ${system.apiVersion}`,
      `Applications (${Object.keys(system.spec.applications).length}): ${Object.keys(system.spec.applications).join(", ")}`,
      `Components (${Object.keys(system.spec.components).length}): ${Object.keys(system.spec.components).join(", ")}`,
      `Channels (${Object.keys(system.spec.channels ?? {}).length}): ${Object.keys(system.spec.channels ?? {}).join(", ")}`,
      `Sagas (${Object.keys(system.spec.sagas ?? {}).length}): ${Object.keys(system.spec.sagas ?? {}).join(", ")}`,
      "",
    ].join("\n");
  }
  if (document.kind === "UI") {
    const ui = document as AirUiDocument;
    return [
      `UI: ${ui.metadata.displayName ?? ui.metadata.name}`,
      `Name: ${ui.metadata.name}`,
      `AIR version: ${ui.apiVersion}`,
      `Rendering: ${ui.spec.implementation.rendering}`,
      `Technology: ${ui.spec.implementation.technology}`,
      `Screens (${Object.keys(ui.spec.screens).length}): ${Object.keys(ui.spec.screens).join(", ")}`,
      `Data sources (${Object.keys(ui.spec.dataSources ?? {}).length}): ${Object.keys(ui.spec.dataSources ?? {}).join(", ")}`,
      "",
    ].join("\n");
  }
  const deployment = document as AirDeploymentDocument;
  return [
    `Deployment: ${deployment.metadata.displayName ?? deployment.metadata.name}`,
    `Name: ${deployment.metadata.name}`,
    `AIR version: ${deployment.apiVersion}`,
    `System: ${deployment.spec.system}`,
    `Profile: ${deployment.spec.profile}`,
    `Resources (${Object.keys(deployment.spec.resources).length}): ${Object.keys(deployment.spec.resources).join(", ")}`,
    `Bindings (${Object.keys(deployment.spec.bindings).length})`,
    "",
  ].join("\n");
}

interface NextjsCompileArguments {
  readonly file: string;
  readonly target: "nextjs";
  readonly output: string;
  readonly mode: "managed" | "detached";
  readonly options: Required<NextjsTargetOptions>;
}

interface RustCompileArguments {
  readonly file: string;
  readonly target: "rust";
  readonly output: string;
  readonly mode: "managed" | "detached";
  readonly options: Required<RustTargetOptions>;
}

interface PythonCompileArguments {
  readonly file: string;
  readonly target: "python";
  readonly output: string;
  readonly mode: "managed" | "detached";
  readonly options: Required<PythonTargetOptions>;
}

type CompileArguments = NextjsCompileArguments | RustCompileArguments | PythonCompileArguments;

function parseCompileArguments(args: readonly string[]): CompileArguments | string {
  let file = "air.yaml";
  let positionalSeen = false;
  let target: string | undefined;
  let output: string | undefined;
  let packageManager = "pnpm";
  let deployment: string | undefined;
  let frameworkVersion = "16.0.0";
  let rustEdition = "2024";
  let rustVersion = "1.99.0";
  let pythonVersion = "3.12";
  let database = "postgres";
  let mode: "managed" | "detached" = "managed";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--detach") {
      mode = "detached";
      continue;
    }
    if (argument?.startsWith("--")) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `Missing value for ${argument}.`;
      index += 1;
      switch (argument) {
        case "--target":
          target = value;
          break;
        case "--output":
          output = value;
          break;
        case "--package-manager":
          packageManager = value;
          break;
        case "--deployment":
          deployment = value;
          break;
        case "--framework-version":
          frameworkVersion = value;
          break;
        case "--rust-edition":
          rustEdition = value;
          break;
        case "--rust-version":
          rustVersion = value;
          break;
        case "--python-version":
          pythonVersion = value;
          break;
        case "--database":
          database = value;
          break;
        default:
          return `Unknown compile option: ${argument}.`;
      }
      continue;
    }
    if (argument === undefined || positionalSeen) return "Compile accepts at most one AIR file.";
    file = argument;
    positionalSeen = true;
  }

  if (target !== "nextjs" && target !== "rust" && target !== "rust-axum" && target !== "python" && target !== "python-fastapi") return "Supported targets: nextjs, rust, python.";
  if (!["pnpm", "npm", "yarn", "bun"].includes(packageManager)) {
    return `Unsupported package manager: ${packageManager}.`;
  }
  if (database !== "postgres" && database !== "mongodb") return `Unsupported database: ${database}.`;
  if (target === "rust" || target === "rust-axum") {
    if (deployment !== undefined && deployment !== "binary" && deployment !== "container") return `Unsupported Rust deployment: ${deployment}.`;
    if (rustEdition !== "2021" && rustEdition !== "2024") return `Unsupported Rust edition: ${rustEdition}.`;
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(rustVersion)) return `Rust version must be exact: ${rustVersion}.`;
    return {
      file,
      target: "rust",
      output: output ?? "dist/rust",
      mode,
      options: {
        rustEdition,
        rustVersion,
        deployment: (deployment ?? "binary") as "binary" | "container",
        database,
      },
    };
  }

  if (target === "python" || target === "python-fastapi") {
    if (deployment !== undefined && deployment !== "process" && deployment !== "container") return `Unsupported Python deployment: ${deployment}.`;
    if (!/^3\.\d+(?:\.\d+)?$/.test(pythonVersion)) return `Python version must be an exact Python 3 version: ${pythonVersion}.`;
    return {
      file,
      target: "python",
      output: output ?? "dist/python",
      mode,
      options: {
        pythonVersion,
        deployment: (deployment ?? "process") as "process" | "container",
        database,
      },
    };
  }

  if (deployment !== undefined && deployment !== "vercel" && deployment !== "node") return `Unsupported Next.js deployment: ${deployment}.`;

  return {
    file,
    target,
    output: output ?? "dist/nextjs",
    mode,
    options: {
      frameworkVersion,
      packageManager: packageManager as Required<NextjsTargetOptions>["packageManager"],
      deployment: (deployment ?? "vercel") as "vercel" | "node",
      database,
    },
  };
}

async function compile(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCompileArguments(args);
  if (typeof parsed === "string") {
    io.stderr(`${parsed}\n\n${HELP}`);
    return 2;
  }

  const filePath = resolve(parsed.file);
  const outputDirectory = resolve(parsed.output);
  try {
    const air = await loadAirFile(filePath);
    const adapter = parsed.target === "nextjs" ? new NextjsTargetAdapter() : parsed.target === "rust" ? new RustTargetAdapter() : new PythonTargetAdapter();
    const result = parsed.target === "nextjs"
      ? await new NextjsTargetAdapter().compile({
          air,
          outputDirectory,
          mode: parsed.mode,
          options: parsed.options,
        })
      : parsed.target === "rust" ? await new RustTargetAdapter().compile({
          air,
          outputDirectory,
          mode: parsed.mode,
          options: parsed.options,
        }) : await new PythonTargetAdapter().compile({
          air,
          outputDirectory,
          mode: parsed.mode,
          options: parsed.options,
        });
    for (const item of result.diagnostics) {
      const location = item.airPath ? ` ${item.airPath}` : "";
      io.stderr(`${item.severity.toUpperCase()} ${item.code}${location}: ${item.message}\n`);
      if (item.help) io.stderr(`  ${item.help}\n`);
    }
    if (result.status === "failed") return 1;
    io.stdout(`Compiled ${filePath} to ${adapter.displayName} in ${outputDirectory}\n`);
    io.stdout(`  ${result.artifacts.length} generated artifact(s), mode: ${parsed.mode}\n`);
    return 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

interface CompositionArguments {
  readonly system: string;
  readonly deployment: string;
  readonly output: string;
}

function parseCompositionArguments(args: readonly string[], defaultOutput = "dist/system"): CompositionArguments | string {
  const [system, ...options] = args;
  if (!system || system.startsWith("--")) return "A System document is required.";
  let deployment: string | undefined;
  let output = defaultOutput;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if ((option !== "--deployment" && option !== "--output") || !value || value.startsWith("--")) return `Invalid composition option: ${option ?? "<missing>"}.`;
    index += 1;
    if (option === "--deployment") deployment = value;
    else output = value;
  }
  if (!deployment) return "--deployment <file> is required.";
  return { system: resolve(system), deployment: resolve(deployment), output: resolve(output) };
}

async function compileSystemComponent(
  componentName: string,
  component: Exclude<AirSystemDocument["spec"]["components"][string], { readonly kind: "foreign" }>,
  application: AirDocument,
  outputDirectory: string,
): Promise<{ readonly ok: boolean; readonly diagnostics: readonly string[] }> {
  const targetOutput = resolve(outputDirectory, "components", componentName);
  const result = component.target === "nextjs"
    ? await new NextjsTargetAdapter().compile({ air: application, outputDirectory: targetOutput, mode: "managed", options: { frameworkVersion: "16.0.0", packageManager: "pnpm", deployment: "node", database: "postgres" } })
    : component.target === "rust-axum"
      ? await new RustTargetAdapter().compile({ air: application, outputDirectory: targetOutput, mode: "managed", options: { rustEdition: "2024", rustVersion: "1.99.0", deployment: "binary", database: "postgres" } })
      : await new PythonTargetAdapter().compile({ air: application, outputDirectory: targetOutput, mode: "managed", options: { pythonVersion: "3.12", deployment: "process", database: "postgres" } });
  await writeFile(resolve(targetOutput, ".air/component.json"), `${JSON.stringify({ format: "air.dev/component/v0.1", name: componentName, role: component.role, target: component.target, application: component.application }, null, 2)}\n`, "utf8");
  return {
    ok: result.status === "success",
    diagnostics: result.diagnostics.map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`),
  };
}

async function composeSystem(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCompositionArguments(args);
  if (typeof parsed === "string") {
    io.stderr(`${parsed}\nUsage: air compose <system> --deployment <file> --output <dir>\n`);
    return 2;
  }
  try {
    const bundle = await loadComposition(parsed.system, parsed.deployment);
    const declaredSystem = resolve(dirname(parsed.deployment), bundle.deployment.spec.system);
    if (declaredSystem !== parsed.system) throw new Error(`Deployment references ${declaredSystem}, not ${parsed.system}.`);
    const plan = planComposition(bundle);
    for (const diagnostic of plan.diagnostics) io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}\n`);
    if (plan.diagnostics.some((item) => item.severity === "error")) return 1;
    await mkdir(parsed.output, { recursive: true });
    for (const artifact of plan.artifacts) {
      const artifactPath = resolve(parsed.output, artifact.path);
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, artifact.content, { encoding: "utf8", flag: "wx" });
    }
    let generated = 0;
    for (const [name, component] of Object.entries(bundle.system.spec.components)) {
      if ("kind" in component && component.kind === "foreign") continue;
      const result = await compileSystemComponent(name, component, bundle.applications[component.application]!, parsed.output);
      for (const diagnostic of result.diagnostics) io.stderr(`${name}: ${diagnostic}\n`);
      if (!result.ok) return 1;
      generated += 1;
    }
    io.stdout(`Composed ${bundle.system.metadata.name} in ${parsed.output}\n  ${generated} component(s), ${plan.providerPlans.length} resource(s), profile: ${bundle.deployment.spec.profile}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") io.stderr("Composition output contains compiler-owned files; refusing to overwrite them.\n");
    else io.stderr(formatError(error));
    return 1;
  }
}

async function devSystem(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCompositionArguments(args, ".air/dev");
  if (typeof parsed === "string") { io.stderr(`${parsed}\nUsage: air dev <system> --deployment <file> [--output <dir>]\n`); return 2; }
  const composed = await composeSystem([parsed.system, "--deployment", parsed.deployment, "--output", parsed.output], io);
  if (composed !== 0) return composed;
  try {
    const bundle = await loadComposition(parsed.system, parsed.deployment);
    if (["compose", "docker"].includes(bundle.deployment.spec.profile)) {
      return await new Promise<number>((complete) => {
        const child = spawn("docker", ["compose", "-f", resolve(parsed.output, "compose.yaml"), "up", "--build"], { cwd: parsed.output, stdio: "inherit" });
        child.once("error", (error) => { io.stderr(`${error.message}\n`); complete(1); });
        child.once("exit", (code) => complete(code ?? 1));
      });
    }
    if (bundle.deployment.spec.profile !== "process") {
      io.stderr(`air dev supports process, docker, and compose profiles; ${bundle.deployment.spec.profile} is rendered for deployment instead.\n`);
      return 1;
    }
    const manifest = JSON.parse(await readFile(resolve(parsed.output, "processes.json"), "utf8")) as { processes: readonly { name: string; cwd: string; command: string }[] };
    const children = manifest.processes.map((processDefinition) => {
      const child = spawn(processDefinition.command, { cwd: resolve(parsed.output, processDefinition.cwd), shell: true, stdio: "inherit", env: { ...process.env, AIR_COMPONENT_NAME: processDefinition.name } });
      child.once("error", (error) => io.stderr(`${processDefinition.name}: ${error.message}\n`));
      return child;
    });
    const stop = (): void => { for (const child of children) child.kill("SIGTERM"); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    return await new Promise<number>((complete) => {
      let remaining = children.length; let code = 0;
      for (const child of children) child.once("exit", (status) => { if (status) code = status; remaining -= 1; if (remaining === 0) complete(code); });
    });
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

async function providerCheck(args: readonly string[], io: CliIo): Promise<number> {
  const [deploymentArgument, ...options] = args;
  if (!deploymentArgument || options.some((value) => value !== "--json" && value !== "--live")) {
    io.stderr("Usage: air provider-check <deployment> [--json] [--live]\n");
    return 2;
  }
  try {
    const deployment = await loadAirSourceFile(resolve(deploymentArgument));
    if (deployment.kind !== "Deployment") throw new Error("provider-check requires a Deployment document.");
    const deploymentPath = resolve(deploymentArgument);
    const systemPath = resolve(dirname(deploymentPath), deployment.spec.system);
    const plan = planComposition(await loadComposition(systemPath, deploymentPath));
    const diagnostics = [...plan.diagnostics];
    const live: { resource: string; ready: boolean; roundTrip?: boolean }[] = [];
    if (options.includes("--live") && !diagnostics.some((item) => item.severity === "error")) for (const resource of plan.providerPlans) {
      const plugin = providerFor(resource.provider, resource.kind);
      const configuration = Object.fromEntries(Object.entries(resource.environment).map(([name, environmentName]) => [name, process.env[environmentName] ?? ""]));
      const missing = Object.entries(configuration).filter(([, value]) => !value).map(([name]) => name);
      if (missing.length > 0) { diagnostics.push({ severity: "error", code: "PROVIDER_ENVIRONMENT_MISSING", message: `${resource.logicalName} requires environment value(s): ${missing.join(", ")}.` }); live.push({ resource: resource.logicalName, ready: false }); continue; }
      if (!plugin) continue;
      if (resource.kind === "broker" && plugin.createConformanceAdapter) {
        const adapter = await plugin.createConformanceAdapter(configuration);
        try {
          const health = await adapter.health();
          const channel = `air-provider-check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const id = `air-provider-check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const pending = adapter.receive(channel, { timeoutMs: 5_000 });
          await adapter.publish(channel, { id, type: "air.provider.check", schemaVersion: "1.0.0", occurredAt: new Date().toISOString(), producer: "air", correlationId: id, payload: {} });
          const received = await pending;
          const roundTrip = received?.id === id;
          live.push({ resource: resource.logicalName, ready: health.ready, roundTrip });
          diagnostics.push(...health.diagnostics);
          if (!health.ready) diagnostics.push({ severity: "error", code: "PROVIDER_NOT_READY", message: `${resource.logicalName} did not pass its health check.` });
          if (!roundTrip) diagnostics.push({ severity: "error", code: "PROVIDER_ROUND_TRIP", message: `${resource.logicalName} did not complete the live publish/receive check.` });
        } finally { await adapter.close(); }
      } else if (plugin.health) {
        const health = await plugin.health(configuration); live.push({ resource: resource.logicalName, ready: health.ready }); diagnostics.push(...health.diagnostics);
        if (!health.ready) diagnostics.push({ severity: "error", code: "PROVIDER_NOT_READY", message: `${resource.logicalName} did not pass its health check.` });
      }
    }
    const report = { valid: !diagnostics.some((item) => item.severity === "error"), deployment: deployment.metadata.name, profile: deployment.spec.profile, providers: plan.providerPlans, live, diagnostics };
    if (options.includes("--json")) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else {
      io.stdout(`Provider check: ${report.valid ? "PASS" : "FAIL"} ${deployment.metadata.name}\n`);
      for (const provider of report.providers) io.stdout(`  ${provider.logicalName}: ${provider.provider} (${provider.kind})\n`);
      for (const diagnostic of report.diagnostics) io.stderr(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}\n`);
    }
    return report.valid ? 0 : 1;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

async function verifySystem(args: readonly string[], io: CliIo): Promise<number> {
  const [systemArgument, ...options] = args;
  if (!systemArgument) { io.stderr("Usage: air verify-system <system> --scenarios <file> [--output <file>]\n"); return 2; }
  let scenarioFile: string | undefined;
  let outputFile: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if ((option !== "--scenarios" && option !== "--output") || !value || value.startsWith("--")) { io.stderr("Usage: air verify-system <system> --scenarios <file> [--output <file>]\n"); return 2; }
    index += 1;
    if (option === "--scenarios") scenarioFile = value; else outputFile = value;
  }
  if (!scenarioFile) { io.stderr("Usage: air verify-system <system> --scenarios <file> [--output <file>]\n"); return 2; }
  try {
    const systemPath = resolve(systemArgument);
    const systemDocument = await loadAirSourceFile(systemPath);
    if (systemDocument.kind !== "System") throw new Error("verify-system requires a System document.");
    const applications = Object.fromEntries(await Promise.all(Object.entries(systemDocument.spec.applications).map(async ([name, reference]) => [name, await loadAirFile(resolve(dirname(systemPath), reference.source))] as const)));
    const [systemSource, suiteSource] = await Promise.all([
      readFile(systemPath, "utf8"),
      readFile(resolve(scenarioFile), "utf8"),
    ]);
    const suite = parseSystemVerificationSuite(suiteSource);
    const results = verifySystemSuite(systemDocument, applications, suite);
    const evidence = {
      format: "air.dev/system-evidence/v0.2",
      generatedAt: new Date().toISOString(),
      system: {
        name: systemDocument.metadata.name,
        apiVersion: systemDocument.apiVersion,
        sha256: createHash("sha256").update(systemSource).digest("hex"),
      },
      suite: {
        apiVersion: suite.apiVersion,
        sha256: createHash("sha256").update(suiteSource).digest("hex"),
      },
      topology: systemDocument.spec,
      scenarios: results,
    };
    if (outputFile) await writeFile(resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (const result of results) {
      io.stdout(`${result.passed ? "PASS" : "FAIL"} ${result.id}\n`);
      for (const diagnostic of result.diagnostics) io.stderr(`  ${diagnostic}\n`);
    }
    return results.every((result) => result.passed) ? 0 : 1;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

async function migrate(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  if (!file || file.startsWith("--")) {
    io.stderr("Usage: air migrate <file> [--to air.dev/v0.10] [--output <file>]\n");
    return 2;
  }
  let target = "air.dev/v0.10";
  let output = `${file}.v0.10.yaml`;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if ((option !== "--to" && option !== "--output") || !value || value.startsWith("--")) {
      io.stderr(`Invalid migrate option: ${option ?? "<missing>"}.\n`);
      return 2;
    }
    index += 1;
    if (option === "--to") target = value;
    else output = value;
  }
  if (
    target !== "air.dev/v0.2" &&
    target !== "air.dev/v0.3" &&
    target !== "air.dev/v0.4" &&
    target !== "air.dev/v0.5" &&
    target !== "air.dev/v0.6" &&
    target !== "air.dev/v0.7" &&
    target !== "air.dev/v0.8" &&
    target !== "air.dev/v0.9" &&
    target !== "air.dev/v0.10"
  ) {
    io.stderr(`Unsupported migration target: ${target}.\n`);
    return 2;
  }

  try {
    const document = await loadAirFile(resolve(file));
    const migrated = migrateAirDocument(document, target);
    const outputPath = resolve(output);
    await writeFile(outputPath, serializeAir(migrated), { encoding: "utf8", flag: "wx" });
    io.stdout(`Migrated ${resolve(file)} to ${target}\n  ${outputPath}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Migration output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

async function importPostgresCommand(args: readonly string[], io: CliIo): Promise<number> {
  let databaseUrl: string | undefined;
  let outputFile: string | undefined;
  let applicationName = "imported-app";
  let schema = "public";
  let discoveryDirectory: string | undefined;
  const usage = "Usage: air import-postgres --url <postgres-url> --output <file> [--name <name>] [--schema <schema>] [--discovery <directory>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--url", "--output", "--name", "--schema", "--discovery"].includes(option ?? "") || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--url") databaseUrl = value;
    else if (option === "--output") outputFile = value;
    else if (option === "--name") applicationName = value;
    else if (option === "--schema") schema = value;
    else discoveryDirectory = value;
  }
  if (!databaseUrl || !outputFile) {
    io.stderr(usage);
    return 2;
  }
  try {
    const result = await importPostgres(databaseUrl, { applicationName, schema });
    for (const diagnostic of result.diagnostics) {
      io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.databasePath}: ${diagnostic.message}\n`);
    }
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return 1;
    const outputPath = resolve(outputFile);
    const importedSource = serializeAir(result.air);
    await writeFile(outputPath, importedSource, { encoding: "utf8", flag: "wx" });
    if (discoveryDirectory) await mergeIntoDiscovery(resolve(discoveryDirectory), discoveryFromAirCandidate(result.air, { source: `postgres:${schema}`, analyzer: "postgres", sourceContent: importedSource }));
    io.stdout(`Imported PostgreSQL schema ${schema} into ${outputPath}\n`);
    io.stdout(`  ${Object.keys(result.air.spec.entities).length} entity/entities, ${result.diagnostics.length} diagnostic(s)\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Import output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

async function importOpenApiCommand(args: readonly string[], io: CliIo): Promise<number> {
  let inputFile: string | undefined;
  let outputFile: string | undefined;
  let applicationName = "imported-api";
  let discoveryDirectory: string | undefined;
  const usage = "Usage: air import-openapi --input <file> --output <file> [--name <name>] [--discovery <directory>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !["--input", "--output", "--name", "--discovery"].includes(option) || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--input") inputFile = value;
    else if (option === "--output") outputFile = value;
    else if (option === "--name") applicationName = value;
    else discoveryDirectory = value;
  }
  if (!inputFile || !outputFile) {
    io.stderr(usage);
    return 2;
  }
  try {
    const inputSource = await readFile(resolve(inputFile), "utf8");
    const result = importOpenApiSource(inputSource, { applicationName });
    for (const diagnostic of result.diagnostics) {
      io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.sourcePath}: ${diagnostic.message}\n`);
    }
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return 1;
    const outputPath = resolve(outputFile);
    await writeFile(outputPath, serializeAir(result.air), { encoding: "utf8", flag: "wx" });
    if (discoveryDirectory) await mergeIntoDiscovery(resolve(discoveryDirectory), discoveryFromAirCandidate(result.air, { source: resolve(inputFile), analyzer: "openapi", sourceContent: inputSource }));
    io.stdout(`Imported OpenAPI into ${outputPath}\n`);
    io.stdout(`  ${Object.keys(result.air.spec.entities).length} entity/entities, ${result.diagnostics.length} diagnostic(s)\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Import output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

async function importNextjsCommand(args: readonly string[], io: CliIo): Promise<number> {
  let inputDirectory: string | undefined;
  let outputFile: string | undefined;
  let reportFile: string | undefined;
  let applicationName: string | undefined;
  let schemaPath: string | undefined;
  let discoveryDirectory: string | undefined;
  const usage = "Usage: air import-nextjs --input <directory> --output <file> [--schema <path>] [--report <file>] [--name <name>] [--discovery <directory>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !["--input", "--output", "--schema", "--report", "--name", "--discovery"].includes(option) || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--input") inputDirectory = value;
    else if (option === "--output") outputFile = value;
    else if (option === "--schema") schemaPath = value;
    else if (option === "--report") reportFile = value;
    else if (option === "--name") applicationName = value;
    else discoveryDirectory = value;
  }
  if (!inputDirectory || !outputFile) {
    io.stderr(usage);
    return 2;
  }
  try {
    const result = await importNextjs(resolve(inputDirectory), { ...(applicationName ? { name: applicationName } : {}), ...(schemaPath ? { schemaPath } : {}) });
    for (const diagnostic of result.diagnostics) {
      io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.source ? ` ${diagnostic.source}` : ""}: ${diagnostic.message}\n`);
    }
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return 1;
    const source = serializeAir(result.document);
    parseAir(source, outputFile);
    const outputPath = resolve(outputFile);
    await writeFile(outputPath, source, { encoding: "utf8", flag: "wx" });
    if (discoveryDirectory) await mergeIntoDiscovery(resolve(discoveryDirectory), discoveryFromAirCandidate(result.document, { source: resolve(inputDirectory), analyzer: "nextjs", sourceContent: source }));
    if (reportFile) {
      await writeFile(resolve(reportFile), `${JSON.stringify({ format: "air.dev/nextjs-import-report/v0.1", input: resolve(inputDirectory), diagnostics: result.diagnostics, sources: result.sources }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    io.stdout(`Imported Next.js project into ${outputPath}\n`);
    io.stdout(`  ${Object.keys(result.document.spec.entities).length} entity/entities, ${result.document.spec.http?.operations.length ?? 0} operation(s), ${result.diagnostics.length} diagnostic(s)\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Import output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

async function importSpringCommand(args: readonly string[], io: CliIo): Promise<number> {
  let inputDirectory: string | undefined;
  let outputFile: string | undefined;
  let reportFile: string | undefined;
  let applicationName: string | undefined;
  const usage = "Usage: air import-spring --input <directory> --output <file> [--report <file>] [--name <name>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]; const value = args[index + 1];
    if (!option || !["--input", "--output", "--report", "--name"].includes(option) || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1;
    if (option === "--input") inputDirectory = value;
    else if (option === "--output") outputFile = value;
    else if (option === "--report") reportFile = value;
    else applicationName = value;
  }
  if (!inputDirectory || !outputFile) { io.stderr(usage); return 2; }
  try {
    io.stderr("WARNING AIR_IMPORT_REVIEW_REQUIRED: import-spring is a compatibility discovery prototype. Use `air discover spring` for enterprise discovery; no finding is authoritative AIR without review.\n");
    const result = await importSpring(resolve(inputDirectory), applicationName ? { applicationName } : {});
    const source = serializeAir(result.document);
    parseAir(source, outputFile);
    await writeFile(resolve(outputFile), source, { encoding: "utf8", flag: "wx" });
    if (reportFile) await writeFile(resolve(reportFile), `${JSON.stringify({ format: "air.dev/spring-import-report/v0.1", discoveries: result.discoveries, diagnostics: result.diagnostics }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (const diagnostic of result.diagnostics) io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.source}${diagnostic.line ? `:${diagnostic.line}` : ""}: ${diagnostic.message}\n`);
    io.stdout(`Imported Spring declarations into ${resolve(outputFile)}\n  ${result.discoveries.length} discovery item(s), ${result.diagnostics.length} review diagnostic(s)\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") io.stderr("Import output already exists; refusing to overwrite it.\n");
    else io.stderr(formatError(error));
    return 1;
  }
}

async function discoverTracesCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air discover traces <otlp.json> [--service <name>] [--output <file>] [--json]\n";
  const [input, ...options] = args; const values = new Map<string, string>(); let json = false;
  if (!input || input.startsWith("--")) { io.stderr(usage); return 2; }
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    if (option === "--json") { json = true; continue; }
    const value = options[index + 1];
    if (!["--service", "--output"].includes(option) || !value || value.startsWith("--") || values.has(option)) { io.stderr(usage); return 2; }
    values.set(option, value); index += 1;
  }
  try {
    const map = traceMapFromOtlp(JSON.parse(await readFile(resolve(input), "utf8")), values.has("--service") ? { service: values.get("--service")! } : {});
    if (values.has("--output")) await writeFile(resolve(values.get("--output")!), `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    io.stdout(json ? `${JSON.stringify(map)}\n` : formatTraceMap(map));
    return 0;
  } catch (error) { io.stderr(`${error instanceof Error ? error.message : String(error)}\n`); return 2; }
}

async function discoverCodeCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air discover code [<path>] [--symbol <name>] [--since <git-ref>] [--output <file>] [--json]\n";
  const parsed = parseFlags(args, ["--symbol", "--since", "--output"], ["--json"]);
  if (!parsed || parsed.positional.length > 1) { io.stderr(usage); return 2; }
  try {
    const root = projectRoot();
    const report = await scanCodeSeams({ root, path: parsed.positional[0] ? relative(root, resolve(parsed.positional[0])) || "." : relative(root, process.cwd()) || ".", ...(parsed.values.has("--symbol") ? { symbol: parsed.values.get("--symbol")! } : {}), ...(parsed.values.has("--since") ? { since: parsed.values.get("--since")! } : {}) });
    if (parsed.values.has("--output")) await writeFile(resolve(parsed.values.get("--output")!), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    io.stdout(parsed.flags.has("--json") ? `${JSON.stringify(report)}\n` : formatCodeSeams(report));
    return 0;
  } catch (error) { io.stderr(`${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`); return 2; }
}

async function discoverCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] === "traces") return discoverTracesCommand(args.slice(1), io);
  if (args[0] === "code") return discoverCodeCommand(args.slice(1), io);
  const [framework, repository, ...options] = args;
  const usage = "Usage: air discover spring <repository> --output <directory> [--name <name>] [--analyzer auto|source|openrewrite]\n";
  if (framework !== "spring" || !repository || repository.startsWith("--")) { io.stderr(usage); return 2; }
  let output: string | undefined; let name: string | undefined; let analyzer: "auto" | "source" | "openrewrite" = "auto";
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; const value = options[index + 1];
    if (!option || !["--output", "--name", "--analyzer"].includes(option) || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1;
    if (option === "--output") output = value;
    else if (option === "--name") name = value;
    else if (["auto", "source", "openrewrite"].includes(value)) analyzer = value as typeof analyzer;
    else { io.stderr(usage); return 2; }
  }
  if (!output) { io.stderr(usage); return 2; }
  try {
    const result = await discoverSpring(resolve(repository), { ...(name ? { name } : {}), analyzer });
    for (const diagnostic of result.diagnostics) io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.source ? ` ${diagnostic.source.path}:${diagnostic.source.startLine ?? 1}` : ""}: ${diagnostic.message}\n`);
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return 1;
    let discoveryBundle = result.bundle;
    try {
      const existing = await readDiscoveryBundle(resolve(output));
      const externalNodeIds = new Set(existing.nodes.filter((node) => typeof node.attributes.importer === "string").map((node) => node.id));
      const retainedNodeIds = new Set([...result.bundle.nodes.map((node) => node.id), ...externalNodeIds]);
      const retainedEvidence = existing.evidence.flatMap((item) => {
        const nodeIds = item.nodeIds.filter((nodeId) => retainedNodeIds.has(nodeId));
        return item.nodeIds.length === 0 || nodeIds.length > 0 ? [{ ...item, nodeIds }] : [];
      });
      const retainedEvidenceIds = new Set(retainedEvidence.map((item) => item.id));
      const previousNodes = new Map(existing.nodes.map((node) => [node.id, node]));
      const rescanned: DiscoveryBundle = { ...result.bundle, nodes: result.bundle.nodes.map((node) => {
        const previous = previousNodes.get(node.id);
        const evidenceIds = previous?.evidenceIds?.filter((id) => retainedEvidenceIds.has(id));
        return evidenceIds?.length ? { ...node, confidence: node.confidence === "inferred" ? "observed" as const : node.confidence, evidenceIds } : node;
      }), evidence: retainedEvidence };
      const external: DiscoveryBundle = { ...existing, manifest: { ...existing.manifest, metadata: { ...existing.manifest.metadata, repositoryHash: createHash("sha256").update([...externalNodeIds].sort().join(":")).digest("hex") } }, nodes: existing.nodes.filter((node) => externalNodeIds.has(node.id)), edges: existing.edges.filter((edge) => externalNodeIds.has(edge.from) && externalNodeIds.has(edge.to)), decisions: [], evidence: [] };
      discoveryBundle = mergeDiscoveryBundles(rescanned, [external]);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const written = await writeDiscoveryBundle(resolve(output), discoveryBundle);
    io.stdout(`Discovery bundle: ${resolve(output)}\n  ${written.nodes.length} node(s), ${written.edges.length} edge(s), ${Object.values(written.coverage).filter((item) => item.opaque > 0 || item.conflicting > 0).length} unresolved dimension(s)\n`);
    return 0;
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

async function evidenceCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [action, input, ...options] = args;
  const ingestUsage = "Usage: air evidence ingest <bundle-or-trace> --discovery <directory> [--allow-field <attribute> ...]\n";
  const captureUsage = "Usage: air evidence capture <profile> --output <evidence.jsonl> -- <test-command> [args ...]\n";
  if (!input || input.startsWith("--") || !["ingest", "capture"].includes(action ?? "")) { io.stderr(`${ingestUsage}${captureUsage}`); return 2; }
  if (action === "capture") {
    const separator = options.indexOf("--");
    const captureOptions = separator >= 0 ? options.slice(0, separator) : options;
    const command = separator >= 0 ? options.slice(separator + 1) : [];
    if (captureOptions.length !== 2 || captureOptions[0] !== "--output" || !captureOptions[1] || command.length === 0) { io.stderr(captureUsage); return 2; }
    try {
      const result = await captureEvidence(resolve(input), resolve(captureOptions[1]), command);
      io.stdout(`Evidence captured in ${result.output}\n  ${result.records} privacy-safe record(s); command exit code ${result.exitCode}\n`);
      return result.exitCode;
    } catch (error) { io.stderr(formatError(error)); return 1; }
  }
  const usage = ingestUsage;
  let discovery: string | undefined; const allowFields: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; const value = options[index + 1];
    if (!option || !["--discovery", "--allow-field"].includes(option) || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1;
    if (option === "--discovery") discovery = value; else allowFields.push(value);
  }
  if (!discovery) { io.stderr(usage); return 2; }
  try {
    const result = await ingestEvidence(resolve(input), resolve(discovery), { allowFields });
    io.stdout(`Evidence ingested into ${resolve(discovery)}\n  ${result.ingested} record(s), ${result.unmatched} unmatched, ${result.ambiguous} ambiguous; sensitive values redacted unless explicitly allowlisted\n`);
    return 0;
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

async function workbenchCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [directory, ...options] = args;
  const usage = "Usage: air workbench <discovery> --reviewer <id> [--host 127.0.0.1] [--port 4319]\n";
  if (!directory || directory.startsWith("--")) { io.stderr(usage); return 2; }
  let host = "127.0.0.1"; let port = 4319; let reviewer: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; const value = options[index + 1];
    if (!option || !["--host", "--port", "--reviewer"].includes(option) || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1;
    if (option === "--host") host = value; else if (option === "--port") port = Number(value); else reviewer = value.trim();
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !reviewer) { io.stderr(usage); return 2; }
  try {
    const workbench = await startWorkbench(resolve(directory), { host, port, reviewer });
    io.stdout(`AIR discovery workbench: ${workbench.url}\nPress Ctrl-C to stop.\n`);
    await new Promise<void>((resolvePromise) => {
      const stop = (): void => { workbench.server.close(() => resolvePromise()); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
    return 0;
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

async function discoveryCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [action, directory, ...options] = args;
  const usage = "Usage: air discovery report <bundle> --output <directory>\n";
  if (action !== "report" || !directory || directory.startsWith("--")) { io.stderr(usage); return 2; }
  let output: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; const value = options[index + 1];
    if (option !== "--output" || !value || value.startsWith("--") || output) { io.stderr(usage); return 2; }
    output = value; index += 1;
  }
  if (!output) { io.stderr(usage); return 2; }
  try {
    const result = await writeDiscoveryReport(resolve(directory), resolve(output));
    io.stdout(`Discovery report: ${result.json}\nHTML report: ${result.html}\n  ${result.report.summary.entryPoints} entry point(s), ${result.report.summary.unresolved} unresolved boundar${result.report.summary.unresolved === 1 ? "y" : "ies"}\n`);
    return 0;
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

async function extractCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [directory, ...options] = args;
  const usage = "Usage: air extract <discovery> --capability <id> --output <directory>\n";
  if (!directory || directory.startsWith("--")) { io.stderr(usage); return 2; }
  let capability: string | undefined; let output: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; const value = options[index + 1];
    if (!option || !["--capability", "--output"].includes(option) || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1; if (option === "--capability") capability = value; else output = value;
  }
  if (!capability || !output) { io.stderr(usage); return 2; }
  try {
    const result = await extractCapability(resolve(directory), capability, resolve(output));
    if (result.blockers.length > 0) { io.stderr(`Extraction blocked; observable behavior remains unresolved:\n${result.blockers.map((blocker) => `  - ${blocker}`).join("\n")}\n`); return 1; }
    io.stdout(`Extracted capability ${capability} into ${result.output}\n  ${result.nodes.length} evidence-linked node(s)\n`);
    return 0;
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

async function verifyImportCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [directory, ...options] = args;
  const usage = "Usage: air verify-import <capability> --legacy <url> --candidate <url> [--output <file>]\n";
  if (!directory || directory.startsWith("--")) { io.stderr(usage); return 2; }
  let legacy: string | undefined; let candidate: string | undefined; let output: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]; const value = options[index + 1];
    if (!option || !["--legacy", "--candidate", "--output"].includes(option) || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1; if (option === "--legacy") legacy = value; else if (option === "--candidate") candidate = value; else output = value;
  }
  if (!legacy || !candidate) { io.stderr(usage); return 2; }
  try {
    const result = await verifyImportedCapability(resolve(directory), legacy, candidate, output ? resolve(output) : undefined);
    io.stdout(`${result.passed ? "PASS" : "FAIL"} imported capability equivalence\nEvidence: ${result.output}\n`);
    return result.passed ? 0 : 1;
  } catch (error) { io.stderr(formatError(error)); return 1; }
}

function checkFailureCode(error: unknown): 2 | 3 {
  return error instanceof CheckInputError || (error instanceof Error && "code" in error && ["ENOENT", "EEXIST"].includes(String(error.code))) ? 2 : 3;
}

function gitRepositoryState(): { readonly root: string; readonly hash: string; readonly clean: boolean } {
  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", shell: false });
  const hashResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", shell: false });
  if (rootResult.status !== 0 || hashResult.status !== 0) throw new CheckInputError("air check baseline and run must execute inside a tracked Git repository.");
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: process.cwd(), encoding: "utf8", shell: false });
  if (status.status !== 0) throw new CheckInfrastructureError("Could not inspect the Git working tree.");
  return { root: rootResult.stdout.trim(), hash: createHash("sha256").update(hashResult.stdout.trim()).digest("hex"), clean: status.stdout.trim().length === 0 };
}

function explainMismatch(mismatch: CheckMismatch): string {
  const action = mismatch.repair === "candidate-code" ? "fix candidate code" : "repair the harness";
  return `${mismatch.classification} ${mismatch.scenario} ${mismatch.selector}: ${action}; provenance ${mismatch.provenance}`;
}

interface CheckProfile { readonly check: string; readonly policy?: string; readonly baseline: string; readonly legacy: string; readonly candidate: string; readonly output: string; readonly at?: string; readonly atSetup?: string }
interface LastRun { readonly v: string; readonly baselineId: string; readonly at: string; readonly passed: number; readonly total: number; readonly differences: number; readonly keys: readonly string[] }

function projectRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", shell: false });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

// .air/check.json remembers the check's paths so agents can run `air check run --agent` with no arguments.
async function readCheckProfile(root: string): Promise<CheckProfile | undefined> {
  try { return JSON.parse(await readFile(resolve(root, ".air/check.json"), "utf8")) as CheckProfile; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw new CheckInputError(`.air/check.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

// Per-developer run state; AIR_STATE_DIR relocates it (tests, CI) so it never lands in the repository.
// One last-run file per check (the HTTP check and each harness), keyed by the check's name.
const stateSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "check";
const lastRunPath = (root: string, check: string): string => resolve(process.env.AIR_STATE_DIR ?? resolve(root, ".air"), `last-run-${stateSlug(check)}.json`);

// Raw expected values recorded at baseline time, for local --reveal only. Never committed (gitignored by `air protect`).
const expectedCachePath = (root: string): string => resolve(process.env.AIR_STATE_DIR ?? resolve(root, ".air"), "expected.json");
async function readExpectedCache(root: string): Promise<Record<string, unknown>> {
  try { return (JSON.parse(await readFile(expectedCachePath(root), "utf8")) as { scenarios?: Record<string, unknown> }).scenarios ?? {}; } catch { return {}; }
}
// Cache keys are "<check name>::<scenario id>" so the HTTP check and harnesses never collide.
async function writeExpectedCache(root: string, check: string, observations: ReadonlyMap<string, unknown>): Promise<void> {
  const scenarios = { ...await readExpectedCache(root), ...Object.fromEntries([...observations].map(([id, value]) => [`${check}::${id}`, value])) };
  await mkdir(dirname(expectedCachePath(root)), { recursive: true });
  await writeFile(expectedCachePath(root), `${JSON.stringify({ v: 1, scenarios })}\n`, "utf8");
}

async function readLastRun(root: string, check: string): Promise<LastRun | undefined> {
  try { return JSON.parse(await readFile(lastRunPath(root, check), "utf8")) as LastRun; } catch { return undefined; }
}

async function checkCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [action, ...rest] = args;
  if (action === "record") return checkRecordCommand(rest, io);
  if (action === "approve") return checkApproveCommand(rest, io);
  if (action === "diff-baseline") return checkDiffBaselineCommand(rest, io);
  if (action === "coverage") return checkCoverageCommand(rest, io);
  if (action === "init" && rest.includes("--from-openapi")) return checkInitOpenApiCommand(rest, io);
  const usages = {
    init: "Usage: air check init <discovery> --capability <id> --output <directory>\n",
    profile: "Usage: air check profile --check <check.yaml> --baseline <directory> --legacy <target> --candidate <target> --output <directory> [--policy <file>] [--at <git-ref>] [--at-setup <command>]\n",
    status: "Usage: air check status [--json]\n",
    validate: "Usage: air check validate [<check.yaml>] [--policy <file>] [--json]\n",
    baseline: "Usage: air check baseline [<check.yaml>] [--target <file>] [--output <directory>] [--policy <file>] [--at <git-ref>] [--at-setup <command>] [--allow-dirty] [--json]\n",
    run: "Usage: air check run [<check.yaml>] [--baseline <directory>] [--target <file>] [--output <directory>] [--policy <file>] [--agent] [--reveal] [--legacy <file>] [--at <git-ref>] [--at-setup <command>] [--max-lines <n>] [--json]\n",
    explain: "Usage: air check explain <result.json> [--agent] [--max-lines <n>] [--json]\n",
  } as const;
  const input = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const options = input ? rest.slice(1) : rest;
  if (!action || !(action in usages) || (!input && (action === "init" || action === "explain")) || (input && (action === "profile" || action === "status"))) {
    io.stderr(Object.values(usages).join("")); return 2;
  }
  const usage = usages[action as keyof typeof usages];
  let json = false; let allowDirty = false; let agent = false; let reveal = false; const values = new Map<string, string>();
  const allowed = action === "init" ? new Set(["--capability", "--output"])
    : action === "profile" ? new Set(["--check", "--policy", "--baseline", "--legacy", "--candidate", "--output", "--at", "--at-setup"])
      : action === "validate" ? new Set(["--policy"])
        : action === "baseline" ? new Set(["--target", "--output", "--policy", "--at", "--at-setup"])
          : action === "run" ? new Set(["--baseline", "--target", "--output", "--policy", "--legacy", "--max-lines", "--at", "--at-setup"])
            : action === "explain" ? new Set(["--max-lines"])
              : new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--json") { json = true; continue; }
    if (option === "--allow-dirty" && action === "baseline") { allowDirty = true; continue; }
    if (option === "--agent" && (action === "run" || action === "explain")) { agent = true; continue; }
    if (option === "--reveal" && action === "run") { reveal = true; continue; }
    const value = options[index + 1];
    if (!option || !allowed.has(option) || !value || value.startsWith("--") || values.has(option)) { io.stderr(usage); return 2; }
    values.set(option, value); index += 1;
  }
  const maxLines = values.has("--max-lines") ? Number(values.get("--max-lines")) : undefined;
  if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 4)) { io.stderr(usage); return 2; }
  try {
    const root = projectRoot();
    if (action === "profile") {
      const required = ["--check", "--baseline", "--legacy", "--candidate", "--output"] as const;
      if (required.some((option) => !values.has(option))) { io.stderr(usage); return 2; }
      const relativePath = (option: string): string => relative(root, resolve(values.get(option)!));
      const profile: CheckProfile = { check: relativePath("--check"), ...(values.has("--policy") ? { policy: relativePath("--policy") } : {}), baseline: relativePath("--baseline"), legacy: relativePath("--legacy"), candidate: relativePath("--candidate"), output: relativePath("--output"), ...(values.has("--at") ? { at: values.get("--at")! } : {}), ...(values.has("--at-setup") ? { atSetup: values.get("--at-setup")! } : {}) };
      await mkdir(resolve(root, ".air"), { recursive: true });
      await writeFile(resolve(root, ".air/check.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
      io.stdout(json ? `${JSON.stringify({ ok: true, profile: resolve(root, ".air/check.json") })}\n` : `Check profile: ${resolve(root, ".air/check.json")}\n`);
      return 0;
    }
    const profile = action === "init" ? undefined : await readCheckProfile(root);
    const fromProfile = (key: keyof CheckProfile): string | undefined => profile?.[key] ? resolve(root, profile[key]!) : undefined;
    const option = (name: string, key?: keyof CheckProfile): string | undefined => values.has(name) ? resolve(values.get(name)!) : key ? fromProfile(key) : undefined;
    const checkPath = input ? resolve(input) : fromProfile("check");
    const policyPath = option("--policy", "policy");
    if (action === "status") {
      if (!profile) throw new CheckInputError("No check profile. Create one with `air check profile`.");
      const last = await readLastRun(root, (await loadMigrationCheck(resolve(root, profile.check))).metadata.name);
      if (json) io.stdout(`${JSON.stringify({ v: AGENT_PROTOCOL, profile, last: last ? { at: last.at, passed: last.passed, total: last.total, differences: last.differences } : null })}\n`);
      else io.stdout(`PROFILE check=${profile.check} candidate=${profile.candidate} baseline=${profile.baseline}\n${last ? `LAST ${last.differences === 0 ? "PASS" : "FAIL"} ${last.passed}/${last.total} scenarios · ${last.differences} differences · ${last.at}` : "LAST none"}\n`);
      return 0;
    }
    if (action === "init") {
      const capability = values.get("--capability"); const output = values.get("--output");
      if (!capability || !output) { io.stderr(usage); return 2; }
      const path = await initializeMigrationCheck(resolve(input!), capability, resolve(output));
      if (json) io.stdout(`${JSON.stringify({ ok: true, check: path, reviewRequired: true })}\n`);
      else io.stdout(`Check review candidate: ${path}\nReview and replace the generated scenario before creating a baseline.\n`);
      return 0;
    }
    if (action === "explain") {
      const result = parseCheckResult(await readFile(resolve(input!), "utf8"));
      if (agent) {
        const report = buildAgentReport({ result, maxLines });
        io.stdout(json ? `${JSON.stringify(report)}\n` : formatAgentReport(report));
        return result.passed ? 0 : 1;
      }
      const explanation = { passed: result.passed, baselineId: result.baselineId, differences: result.mismatches.map((mismatch) => ({ ...mismatch, action: mismatch.repair === "candidate-code" ? "fix-code" : "repair-harness" })) };
      if (json) io.stdout(`${JSON.stringify(explanation)}\n`);
      else if (result.mismatches.length === 0) io.stdout(`No differences. Candidate matches baseline ${result.baselineId} within the declared observation boundary.\n`);
      else for (const mismatch of result.mismatches) io.stdout(`${explainMismatch(mismatch)}\n`);
      return result.passed ? 0 : 1;
    }
    if (!checkPath) throw new CheckInputError("No check file. Pass <check.yaml> or create a profile with `air check profile`.");
    if (action === "validate") {
      const [check, policy] = await Promise.all([loadMigrationCheck(checkPath), loadCheckPolicy(policyPath)]);
      const violations = validateMigrationCheck(check, policy);
      if (json) io.stdout(`${JSON.stringify({ ok: violations.length === 0, check: checkPath, violations })}\n`);
      else if (violations.length === 0) io.stdout(`PASS ${checkPath}\n`); else for (const violation of violations) io.stderr(`POLICY ${violation}\n`);
      return violations.length === 0 ? 0 : 1;
    }
    if (action === "baseline") {
      const targetPath = option("--target", "legacy"); const output = option("--output", "baseline");
      if (!targetPath || !output) { io.stderr(usage); return 2; }
      const repository = gitRepositoryState();
      const [check, target, policy] = await Promise.all([loadMigrationCheck(checkPath), loadCheckTarget(targetPath), loadCheckPolicy(policyPath)]);
      const at = values.get("--at") ?? profile?.at;
      if (!at && !repository.clean && !allowDirty) throw new CheckInputError("Tracked working tree is dirty; commit/stash changes or pass --allow-dirty for a non-releasable baseline.");
      const baseline = at
        ? await withWorktreeAt({ ref: at, setup: values.get("--at-setup") ?? profile?.atSetup, root: repository.root, create: (worktree, hash) => createCheckBaseline({ check, target, policy, repositoryRoot: worktree, repositoryHash: hash, clean: true }) })
        : await createCheckBaseline({ check, target, policy, repositoryRoot: repository.root, repositoryHash: repository.hash, clean: repository.clean, allowDirty });
      const path = await writeCheckBaseline(output, baseline);
      const response = { ok: true, baselineId: baseline.baselineId, releasable: baseline.releasable, path };
      if (json) io.stdout(`${JSON.stringify(response)}\n`); else io.stdout(`Baseline ${baseline.baselineId}: ${path}\n${baseline.releasable ? "Releasable clean-tree baseline." : "NON-RELEASABLE dirty-tree baseline."}\n`);
      return 0;
    }
    const baselinePath = option("--baseline", "baseline"); const targetPath = option("--target", "candidate");
    const output = values.has("--output") ? resolve(values.get("--output")!) : profile ? resolve(root, profile.output, new Date().toISOString().replace(/[:.]/gu, "-")) : undefined;
    if (!baselinePath || !targetPath || !output) { io.stderr(usage); return 2; }
    const repository = gitRepositoryState();
    const [check, baseline, target, policy] = await Promise.all([loadMigrationCheck(checkPath), loadCheckBaseline(baselinePath), loadCheckTarget(targetPath), loadCheckPolicy(policyPath)]);
    let legacyTarget: Awaited<ReturnType<typeof loadCheckTarget>> | undefined;
    if (reveal) {
      if (policy.spec.reveal === "deny") throw new CheckInputError("The check policy denies --reveal (reveal: deny).");
      const legacyPath = option("--legacy", "legacy");
      // Without --at, a legacy target that is the same file as the candidate is the running service itself: it now
      // runs the changed code, so values can only come from the local expected-value cache written at baseline time.
      if (legacyPath && (legacyPath !== targetPath || values.has("--at") || profile?.at)) {
        legacyTarget = await loadCheckTarget(legacyPath);
        if (legacyTarget.spec.evidenceCaptureProfile && policy.spec.reveal !== "allow") throw new CheckInputError("The legacy target uses evidence capture; set `reveal: allow` in the check policy to show its values locally.");
      }
    }
    const { result, observations } = await runMigrationCheckDetailed({ check, baseline, target, policy, repositoryRoot: repository.root, repositoryHash: repository.hash, keepObservations: reveal });
    const path = await writeCheckResult(output, result);
    if (agent) {
      const revealed = new Map<string, { expected: unknown; actual: unknown }>(); const notes: string[] = [];
      if (reveal && !result.passed) {
        const cache = await readExpectedCache(root);
        const pending: string[] = [];
        for (const id of result.scenarios.filter((scenario) => !scenario.passed).map((scenario) => scenario.id)) {
          const approved = baseline.scenarios.find((scenario) => scenario.id === id)?.observation; const key = `${check.metadata.name}::${id}`;
          if (Object.hasOwn(cache, key) && sameDigest(observationDigest(cache[key]), approved)) revealed.set(id, { expected: cache[key], actual: observations.get(id) });
          else pending.push(id);
        }
        if (pending.length > 0 && !legacyTarget) notes.push(`expected values for ${pending.join(", ")} are unavailable: no matching local cache and no separate legacy target. Differences are still exact; only the values are hidden.`);
      }
      if (legacyTarget && !result.passed && reveal) {
        const failing = result.scenarios.filter((scenario) => !scenario.passed && !revealed.has(scenario.id)).map((scenario) => scenario.id);
        const at = values.get("--at") ?? profile?.at; const target = legacyTarget;
        const observe = (repositoryRoot: string) => observeCheckTarget({ check, target, repositoryRoot, scenarioIds: failing });
        const legacy = at ? await withWorktreeAt({ ref: at, setup: values.get("--at-setup") ?? profile?.atSetup, root: repository.root, create: (worktree) => observe(worktree) }) : await observe(repository.root);
        for (const id of failing) {
          const approved = baseline.scenarios.find((scenario) => scenario.id === id)?.observation; const observed = legacy.get(id);
          if (observed && sameDigest(observed.digest, approved)) revealed.set(id, { expected: observed.raw, actual: observations.get(id) });
          else notes.push(`legacy output for ${id} no longer matches the baseline; values hidden. Re-baseline if legacy changed on purpose.`);
        }
      }
      const last = await readLastRun(root, check.metadata.name);
      const report = buildAgentReport({ result, values: revealed, previousKeys: last?.baselineId === result.baselineId ? last.keys : undefined, maxLines, notes });
      const lastRun: LastRun = { v: AGENT_PROTOCOL, baselineId: result.baselineId, at: result.generatedAt, passed: report.passed, total: report.total, differences: report.differences, keys: result.mismatches.map(differenceKey) };
      await mkdir(dirname(lastRunPath(root, check.metadata.name)), { recursive: true });
      await writeFile(lastRunPath(root, check.metadata.name), `${JSON.stringify(lastRun)}\n`, "utf8");
      io.stdout(json ? `${JSON.stringify({ ...report, result: path })}\n` : formatAgentReport(report));
      return result.passed ? 0 : 1;
    }
    if (json) io.stdout(`${JSON.stringify({ ...result, path })}\n`);
    else {
      io.stdout(`${result.passed ? "PASS" : "FAIL"} migration check against baseline ${result.baselineId}\nResult: ${path}\n`);
      for (const mismatch of result.mismatches) io.stderr(`  ${explainMismatch(mismatch)}\n`);
    }
    return result.passed ? 0 : 1;
  } catch (error) {
    const code = checkFailureCode(error); const message = error instanceof Error && "code" in error && error.code === "EEXIST" ? "Output already exists; AIR will not overwrite an approved check artifact." : error instanceof Error ? error.message : String(error);
    // Agents get the first lines only; a full stack trace costs tokens and rarely changes the next action.
    const lines = message.split("\n"); const cause = lines.slice(1).find((line) => /\b\w*Error\b|error:/u.test(line));
    const shown = agent ? [lines[0], cause?.trim()].filter(Boolean).join(" | ").slice(0, 400) : message;
    if (json) io.stderr(`${JSON.stringify({ ok: false, category: code === 2 ? "invalid-input" : "infrastructure-error", message: shown })}\n`);
    else io.stderr(agent ? `${code === 2 ? "INPUT" : "INFRA"} ${shown}\nNEXT fix the target or environment, not the candidate's behavior; exit ${code}.\n` : `${message}\n`);
    return code;
  }
}

// Runs work (legacy baseline or reveal) from a clean Git worktree at `ref`, so refactors in place need no second running copy.
async function withWorktreeAt<T>(input: { readonly ref: string; readonly setup: string | undefined; readonly root: string; readonly create: (worktree: string, repositoryHash: string) => Promise<T> }): Promise<T> {
  const resolved = spawnSync("git", ["rev-parse", "--verify", `${input.ref}^{commit}`], { cwd: input.root, encoding: "utf8", shell: false });
  if (resolved.status !== 0) throw new CheckInputError(`Git ref ${input.ref} does not name a commit.`);
  const commit = resolved.stdout.trim();
  const worktree = await mkdtemp(resolve(tmpdir(), "air-baseline-"));
  const added = spawnSync("git", ["worktree", "add", "--detach", "--force", worktree, commit], { cwd: input.root, encoding: "utf8", shell: false });
  if (added.status !== 0) throw new CheckInfrastructureError(`Could not create a worktree at ${input.ref}: ${added.stderr.trim()}`);
  try {
    if (input.setup) {
      const [program, ...args] = input.setup.split(/\s+/u).filter(Boolean);
      if (!program) throw new CheckInputError("--at-setup must name a command.");
      const setup = spawnSync(program, args, { cwd: worktree, encoding: "utf8", shell: false });
      if (setup.status !== 0) throw new CheckInfrastructureError(`--at-setup failed in the ${input.ref} worktree with exit ${setup.status}: ${setup.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    return await input.create(worktree, createHash("sha256").update(commit).digest("hex"));
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: input.root, shell: false });
  }
}

async function checkRecordCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air check record --to <url> --output <directory> [--from-har <file>] [--listen <port>] [--max <n>] [--name <name>] [--keep-header <name>]... [--include-static]\n";
  const values = new Map<string, string>(); const keepHeaders: string[] = []; let includeStatic = false;
  const allowed = new Set(["--to", "--output", "--from-har", "--listen", "--max", "--name", "--keep-header"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--include-static") { includeStatic = true; continue; }
    const value = args[index + 1];
    if (!allowed.has(option) || !value || value.startsWith("--") || (option !== "--keep-header" && values.has(option))) { io.stderr(usage); return 2; }
    if (option === "--keep-header") keepHeaders.push(value); else values.set(option, value);
    index += 1;
  }
  const to = values.get("--to"); const output = values.get("--output");
  const numberOption = (name: string): number | undefined => values.has(name) ? Number(values.get(name)) : undefined;
  const port = numberOption("--listen"); const max = numberOption("--max");
  if (!to || !output || (port !== undefined && !Number.isInteger(port)) || (max !== undefined && (!Number.isInteger(max) || max < 1))) { io.stderr(usage); return 2; }
  try {
    const upstream = new URL(to).toString();
    let exchanges;
    if (values.has("--from-har")) exchanges = exchangesFromHar(JSON.parse(await readFile(resolve(values.get("--from-har")!), "utf8")), upstream);
    else {
      const controller = new AbortController(); const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      try {
        exchanges = await recordHttpTraffic({ upstream, signal: controller.signal, ...(port === undefined ? {} : { port }), ...(max === undefined ? {} : { maxRequests: max }),
          onListening: (url) => io.stderr(`Recording: send traffic to ${url} (forwarded to ${upstream}). Press Ctrl-C to stop.\n`),
          onExchange: (exchange) => io.stderr(`  ${exchange.method} ${exchange.path} -> ${exchange.status}\n`) });
      } finally { process.off("SIGINT", stop); }
    }
    const name = values.get("--name") ?? `${new URL(upstream).hostname.replace(/[^a-z0-9]+/giu, "-")}-recorded`;
    const { check, skipped } = checkFromExchanges(exchanges, { name, keepHeaders, includeStatic });
    const paths = await writeRecordedCheck(resolve(output), check, upstream);
    io.stdout(`Recorded ${check.spec.scenarios.length} scenario(s)${skipped > 0 ? `; skipped ${skipped} non-JSON or static exchange(s)` : ""}.\nCheck: ${paths.check}\nLegacy target: ${paths.target}\nNext: review the scenarios (stateful services need a lifecycle.reset), then run \`air check baseline\` against the legacy service.\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error && "code" in error && error.code === "EEXIST" ? "Output already contains a recorded check; AIR will not overwrite it." : error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function checkApproveCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air check approve <scenario>... --reason <text> [--output <directory>] [--allow-dirty] [--json]\n";
  const scenarioIds: string[] = []; const values = new Map<string, string>(); let json = false; let allowDirty = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!option.startsWith("--")) { scenarioIds.push(option); continue; }
    if (option === "--json") { json = true; continue; }
    if (option === "--allow-dirty") { allowDirty = true; continue; }
    const value = args[index + 1];
    if (!["--reason", "--output"].includes(option) || !value || value.startsWith("--") || values.has(option)) { io.stderr(usage); return 2; }
    values.set(option, value); index += 1;
  }
  if (scenarioIds.length === 0 || !values.get("--reason")) { io.stderr(usage); return 2; }
  try {
    const root = projectRoot(); const profile = await readCheckProfile(root);
    if (!profile) throw new CheckInputError("air check approve uses the check profile; create one with `air check profile`.");
    const repository = gitRepositoryState();
    if (!repository.clean && !allowDirty) throw new CheckInputError("Commit the intended change before approving it, or pass --allow-dirty for a non-releasable baseline.");
    const [check, baseline, target] = await Promise.all([loadMigrationCheck(resolve(root, profile.check)), loadCheckBaseline(resolve(root, profile.baseline)), loadCheckTarget(resolve(root, profile.candidate))]);
    const approved = await approveBaselineScenarios({ check, baseline, target, repositoryRoot: repository.root, clean: repository.clean, scenarioIds, reason: values.get("--reason")! });
    const output = values.has("--output") ? resolve(values.get("--output")!) : resolve(root, `${profile.baseline}-approved-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
    const path = await writeCheckBaseline(output, approved);
    await writeFile(resolve(root, ".air/check.json"), `${JSON.stringify({ ...profile, baseline: relative(root, output) }, null, 2)}\n`, "utf8");
    const changed = diffBaselines(baseline, approved).length;
    if (json) io.stdout(`${JSON.stringify({ ok: true, baselineId: approved.baselineId, previousBaselineId: baseline.baselineId, approved: scenarioIds, changedSelectors: changed, path })}\n`);
    else io.stdout(`Approved ${scenarioIds.join(", ")} (${changed} changed selector(s)). New baseline ${approved.baselineId}: ${path}\nThe check profile now points to it; the previous baseline is kept for review.\n`);
    return 0;
  } catch (error) {
    const code = checkFailureCode(error);
    io.stderr(`${error instanceof Error && "code" in error && error.code === "EEXIST" ? "Output already exists; AIR will not overwrite an approved baseline." : error instanceof Error ? error.message : String(error)}\n`);
    return code;
  }
}

async function checkDiffBaselineCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air check diff-baseline <before> <after> [--json]\n";
  const json = args.includes("--json"); const paths = args.filter((arg) => arg !== "--json");
  if (paths.length !== 2 || paths.some((path) => path.startsWith("--"))) { io.stderr(usage); return 2; }
  try {
    const [before, after] = await Promise.all(paths.map((path) => loadCheckBaseline(resolve(path))));
    const differences = diffBaselines(before!, after!);
    const approvals = (after!.approvals ?? []).filter((approval) => !(before!.approvals ?? []).some((item) => item.approvedAt === approval.approvedAt && item.scenario === approval.scenario));
    if (json) io.stdout(`${JSON.stringify({ changed: differences.map(({ scenario, selector }) => ({ scenario, selector })), approvals })}\n`);
    else {
      for (const item of differences) io.stdout(`CHANGED ${item.scenario} ${item.selector}\n`);
      for (const approval of approvals) io.stdout(`APPROVED ${approval.scenario} by target ${approval.target}: ${approval.reason}\n`);
      if (differences.length === 0) io.stdout("No behavioral differences between the baselines.\n");
    }
    return differences.length === 0 ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return checkFailureCode(error);
  }
}

const readSpec = async (path: string): Promise<unknown> => parseYaml(await readFile(resolve(path), "utf8")) as unknown;

function parseFlags(args: readonly string[], allowed: readonly string[], booleans: readonly string[]): { readonly values: Map<string, string>; readonly flags: Set<string>; readonly positional: string[] } | undefined {
  const values = new Map<string, string>(); const flags = new Set<string>(); const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!option.startsWith("--")) { positional.push(option); continue; }
    if (booleans.includes(option)) { flags.add(option); continue; }
    const value = args[index + 1];
    if (!allowed.includes(option) || !value || value.startsWith("--") || values.has(option)) return undefined;
    values.set(option, value); index += 1;
  }
  return { values, flags, positional };
}

async function checkInitOpenApiCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air check init --from-openapi <spec> --output <directory> [--name <name>] [--base-url <url>]\n";
  const parsed = parseFlags(args, ["--from-openapi", "--output", "--name", "--base-url"], []);
  if (!parsed || parsed.positional.length > 0 || !parsed.values.get("--from-openapi") || !parsed.values.get("--output")) { io.stderr(usage); return 2; }
  try {
    const name = parsed.values.get("--name") ?? "openapi-check";
    const { check, baseUrl } = checkFromOpenApi(await readSpec(parsed.values.get("--from-openapi")!), { name });
    const upstream = parsed.values.get("--base-url") ?? baseUrl;
    if (!upstream) throw new CheckInputError("The spec has no absolute servers[0].url; pass --base-url for the legacy service.");
    const paths = await writeRecordedCheck(resolve(parsed.values.get("--output")!), check, new URL(upstream).toString());
    io.stdout(`Created ${check.spec.scenarios.length} scenario skeleton(s) from OpenAPI.\nCheck: ${paths.check}\nLegacy target: ${paths.target}\nNext: replace example values marked "TODO review" with realistic inputs, then run \`air check baseline\`.\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error && "code" in error && error.code === "EEXIST" ? "Output already contains a check; AIR will not overwrite it." : error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function checkCoverageCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air check coverage [<check.yaml>] [--openapi <spec>] [--traces <otlp.json>] [--fail-under <percent>] [--json]\n";
  const parsed = parseFlags(args, ["--openapi", "--traces", "--fail-under"], ["--json"]);
  const failUnder = parsed?.values.has("--fail-under") ? Number(parsed.values.get("--fail-under")) : undefined;
  if (!parsed || parsed.positional.length > 1 || (!parsed.values.has("--openapi") && !parsed.values.has("--traces")) || (failUnder !== undefined && !(failUnder >= 0 && failUnder <= 100))) { io.stderr(usage); return 2; }
  try {
    const root = projectRoot(); const profile = await readCheckProfile(root);
    const checkPath = parsed.positional[0] ? resolve(parsed.positional[0]) : profile ? resolve(root, profile.check) : undefined;
    if (!checkPath) throw new CheckInputError("No check file. Pass <check.yaml> or create a profile with `air check profile`.");
    const report = checkCoverage(await loadMigrationCheck(checkPath), {
      ...(parsed.values.has("--openapi") ? { openapi: await readSpec(parsed.values.get("--openapi")!) } : {}),
      ...(parsed.values.has("--traces") ? { traces: traceMapFromOtlp(JSON.parse(await readFile(resolve(parsed.values.get("--traces")!), "utf8"))) } : {}),
    });
    io.stdout(parsed.flags.has("--json") ? `${JSON.stringify(report)}\n` : formatCoverage(report));
    const percent = report.total === 0 ? 100 : (report.covered / report.total) * 100;
    return failUnder !== undefined && percent < failUnder ? 1 : 0;
  } catch (error) { io.stderr(`${error instanceof Error ? error.message : String(error)}\n`); return checkFailureCode(error); }
}

const AIR_GITIGNORE = [".air/runs/", ".air/last-run*.json", ".air/expected.json"];
const OPENAPI_CANDIDATES = ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json", "docs/openapi.yaml", "docs/openapi.json", "api/openapi.yaml"];
const SAFE_METHODS = new Set(["GET", "HEAD"]);

// Proxy-free scenario source: read-only operations from an OpenAPI file, else parameter-free GET routes from the code.
async function scenariosWithoutProxy(root: string, name: string): Promise<{ readonly check?: CheckDocument; readonly skipped: number }> {
  for (const candidate of OPENAPI_CANDIDATES) {
    let spec: unknown;
    try { spec = await readSpec(resolve(root, candidate)); } catch { continue; }
    const { check } = checkFromOpenApi(spec, { name });
    const safe = check.spec.scenarios.filter((scenario) => scenario.request.kind === "http" && SAFE_METHODS.has(scenario.request.method));
    const skipped = check.spec.scenarios.length - safe.length;
    return safe.length > 0 ? { check: { ...check, spec: { ...check.spec, scenarios: safe.map((scenario) => ({ ...scenario, description: scenario.description?.replace("TODO review: ", "From OpenAPI: ") ?? "From OpenAPI" })) } }, skipped } : { skipped };
  }
  const seams = (await scanCodeSeams({ root })).seams.filter((seam) => seam.kind === "http" && seam.route);
  const safe = seams.filter((seam) => (seam.method === "GET" || seam.method === "ANY") && !/[:{<[*]/u.test(seam.route!));
  const routes = [...new Set(safe.map((seam) => seam.route!))].sort();
  if (routes.length === 0) return { skipped: seams.length };
  const ids = new Map<string, number>();
  const scenarios = routes.map((route) => {
    const base = `get-${route.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "root"}`; const count = (ids.get(base) ?? 0) + 1; ids.set(base, count);
    return { id: count === 1 ? base : `${base}-${count}`, description: `From code: GET ${route}`, request: { kind: "http" as const, method: "GET", path: route } };
  });
  return { check: { apiVersion: "air.dev/check/v0.1", kind: "Check", metadata: { name }, spec: { capability: { id: name }, observations: ["http"], scenarios } }, skipped: seams.length - safe.length };
}

async function ensureGitignore(root: string): Promise<boolean> {
  const path = resolve(root, ".gitignore"); let current = "";
  try { current = await readFile(path, "utf8"); } catch { /* created below */ }
  const missing = AIR_GITIGNORE.filter((line) => !current.split("\n").includes(line));
  if (missing.length === 0) return false;
  await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}# AIR local state (values stay on this machine)\n${missing.join("\n")}\n`, "utf8");
  return true;
}

// One entry point for people and agents: first run records and baselines a running service, later runs check it.
async function protectCommand(args: readonly string[], io: CliIo): Promise<number> {
  const usage = "Usage: air protect [--url <base-url> [--from-har <file> | -- <command that sends requests to $AIR_PROXY_URL>] [--output <dir>]] [--max-lines <n>] [--json]\n";
  const separator = args.indexOf("--"); const command = separator >= 0 ? args.slice(separator + 1) : [];
  const parsed = parseFlags(separator >= 0 ? args.slice(0, separator) : args, ["--url", "--from-har", "--output", "--max-lines"], ["--json"]);
  if (!parsed || parsed.positional.length > 0) { io.stderr(usage); return 2; }
  const passThrough = [...(parsed.values.has("--max-lines") ? ["--max-lines", parsed.values.get("--max-lines")!] : []), ...(parsed.flags.has("--json") ? ["--json"] : [])];
  try {
    const root = projectRoot(); let profile = await readCheckProfile(root);
    if (!profile) {
      const url = parsed.values.get("--url");
      if (!url) {
        io.stdout("QUESTION AIR is not set up here yet. Which running service should it protect?\nNEXT start the service, then run: air protect --url http://localhost:<port>\n");
        return 2;
      }
      const upstream = new URL(url).toString();
      const name = `${new URL(upstream).hostname.replace(/[^a-z0-9]+/giu, "-")}-${new URL(upstream).port || "80"}`;
      let check: CheckDocument | undefined; let note = "";
      if (command.length === 0 && !parsed.values.has("--from-har")) {
        // No proxy needed: build read-only scenarios from an OpenAPI file or from routes found in the code.
        const built = await scenariosWithoutProxy(root, name);
        if (!built.check) {
          io.stdout(`QUESTION AIR found no OpenAPI file and no parameter-free GET routes to call safely${built.skipped > 0 ? ` (${built.skipped} route(s) need inputs or change data)` : ""}. What sends this service realistic requests?\nNEXT run: air protect --url ${url} -- <command that calls $AIR_PROXY_URL> (for example: sh -c 'BASE_URL=$AIR_PROXY_URL npm test'), or air protect --url ${url} --from-har <file>.\n`);
          return 2;
        }
        check = built.check;
        if (built.skipped > 0) note = `NOTE ${built.skipped} route(s) that need inputs or change data were not called. Add them later with a recorded run (air protect --url ${url} -- <command>) or by editing the check file.\n`;
      }
      let exchanges: Parameters<typeof checkFromExchanges>[0] = [];
      if (check) { /* built above */ }
      else if (parsed.values.has("--from-har")) exchanges = exchangesFromHar(JSON.parse(await readFile(resolve(parsed.values.get("--from-har")!), "utf8")), upstream);
      else {
        const controller = new AbortController(); let commandExit = 0; let commandTail = "";
        const recording = recordHttpTraffic({ upstream, signal: controller.signal, onListening: (proxy) => {
          const [program, ...programArgs] = command;
          const child = spawn(program!, programArgs, { cwd: process.cwd(), env: { ...process.env, AIR_PROXY_URL: proxy }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
          const keep = (chunk: Buffer): void => { commandTail = `${commandTail}${chunk.toString()}`.slice(-2000); };
          child.stdout.on("data", keep); child.stderr.on("data", keep);
          child.once("error", (error) => { commandExit = 127; commandTail = error.message; controller.abort(); });
          child.once("close", (code) => { commandExit = code ?? 1; controller.abort(); });
        } });
        exchanges = await recording;
        if (commandExit !== 0) io.stderr(`NOTE the traffic command exited ${commandExit}; recorded what it sent. Last output: ${commandTail.trim().split("\n").slice(-2).join(" | ")}\n`);
        if (exchanges.length === 0) throw new CheckInputError("The command sent no requests through $AIR_PROXY_URL. Point its base URL at AIR_PROXY_URL, e.g. sh -c 'BASE_URL=$AIR_PROXY_URL npm test'.");
      }
      const output = resolve(parsed.values.get("--output") ?? "air-checks");
      let skipped = 0;
      if (!check) ({ check, skipped } = checkFromExchanges(exchanges, { name }));
      const paths = await writeRecordedCheck(output, check, upstream);
      if (note) io.stderr(note);
      const policyPath = resolve(output, "policy.yaml");
      await writeFile(policyPath, "apiVersion: air.dev/check-policy/v0.1\nkind: CheckPolicy\nmetadata: { name: air-protect }\nspec:\n  allowedNormalizations: [ignore, typed-token, unordered-array, rename, internal-boundary]\n  # The baseline comes from the running service, not from a committed tree.\n  requireCleanBaseline: false\n", { encoding: "utf8", flag: "wx" });
      profile = { check: relative(root, paths.check), policy: relative(root, policyPath), baseline: relative(root, resolve(output, "baseline")), legacy: relative(root, paths.target), candidate: relative(root, paths.target), output: ".air/runs" };
      await mkdir(resolve(root, ".air"), { recursive: true });
      await writeFile(resolve(root, ".air/check.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
      if (await ensureGitignore(root)) io.stderr("NOTE added AIR's local state (.air/runs, last-run, expected values) to .gitignore.\n");
      io.stderr(`Recorded ${check.spec.scenarios.length} scenario(s)${skipped > 0 ? ` (skipped ${skipped} non-JSON or static)` : ""}.\n`);
    }
    let baselineExists = true;
    try { await stat(resolve(root, profile.baseline, "baseline.json")); } catch { baselineExists = false; }
    if (!baselineExists) {
      const repository = gitRepositoryState();
      const [check, target, policy] = await Promise.all([loadMigrationCheck(resolve(root, profile.check)), loadCheckTarget(resolve(root, profile.legacy)), loadCheckPolicy(profile.policy ? resolve(root, profile.policy) : undefined)]);
      const { baseline, observations } = await createCheckBaselineDetailed({ check, target, policy, repositoryRoot: repository.root, repositoryHash: repository.hash, clean: repository.clean, allowDirty: true, keepObservations: true });
      await writeCheckBaseline(resolve(root, profile.baseline), baseline);
      await writeExpectedCache(root, check.metadata.name, observations);
      io.stdout(`PROTECTED ${baseline.scenarios.length} scenario(s) (baseline ${baseline.baselineId.slice(0, 12)}). Commit ${dirname(profile.check)}/ and .air/check.json.\nNEXT change the code, restart the service, then run \`air protect\`.\n`);
      return Math.max(0, await protectHarnesses(root, profile, passThrough, io));
    }
    const primary = await checkCommand(["run", "--agent", "--reveal", ...passThrough], io);
    return Math.max(primary, await protectHarnesses(root, profile, passThrough, io));
  } catch (error) {
    io.stderr(`${error instanceof Error && "code" in error && error.code === "EEXIST" ? "AIR files already exist in the output directory; remove them or pass --output." : error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
    return checkFailureCode(error);
  }
}

const AGENT_BLOCK_START = "<!-- AIR:START (managed by `air agent install`; edits inside are replaced) -->";
const AGENT_BLOCK_END = "<!-- AIR:END -->";

async function agentInstallCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseFlags(args, [], ["--mcp"]);
  if (!parsed || parsed.positional.length > 0) { io.stderr("Usage: air agent install [--mcp]\n"); return 2; }
  const root = projectRoot();
  const block = `${AGENT_BLOCK_START}\n${AGENT_INSTRUCTIONS.trimEnd()}\n${AGENT_BLOCK_END}\n`;
  const write = async (name: string): Promise<string> => {
    const path = resolve(root, name); let current = "";
    try { current = await readFile(path, "utf8"); } catch { /* new file */ }
    const pattern = /<!-- AIR:START[^\n]*-->[\s\S]*?<!-- AIR:END -->\n?/u;
    const next = pattern.test(current) ? current.replace(pattern, block) : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${block}`;
    if (next === current) return `${name}: already up to date`;
    await writeFile(path, next, "utf8"); return `${name}: ${current ? "updated" : "created"}`;
  };
  const results = [await write("AGENTS.md")];
  let claude = ""; try { claude = await readFile(resolve(root, "CLAUDE.md"), "utf8"); } catch { /* none */ }
  // A CLAUDE.md that already imports AGENTS.md gets the block through the import.
  results.push(claude.includes("@AGENTS.md") ? "CLAUDE.md: imports AGENTS.md" : await write("CLAUDE.md"));
  const registrations: string[] = [];
  for (const [cli, argv] of [["claude", ["mcp", "add", "air", "--", "air", "mcp"]], ["codex", ["mcp", "add", "air", "--", "air", "mcp"]]] as const) {
    const available = spawnSync(cli, ["--version"], { encoding: "utf8", shell: false }).status === 0;
    if (!available) continue;
    if (parsed.flags.has("--mcp")) {
      const run = spawnSync(cli, argv, { cwd: root, encoding: "utf8", shell: false });
      registrations.push(`${cli}: ${run.status === 0 ? "MCP server registered" : `registration failed (${(run.stderr || run.stdout).trim().split("\n")[0]})`}`);
    } else registrations.push(`${cli}: run \`${cli} ${argv.join(" ")}\` or rerun with --mcp`);
  }
  io.stdout(`${[...results, ...registrations].join("\n")}\nNEXT ask your coding agent for a change; it will run \`air protect\` before and after.\n`);
  return 0;
}

const harnessesRoot = (root: string, profile: CheckProfile | undefined): string => resolve(root, profile ? dirname(profile.check) : "air-checks", "harnesses");

async function harnessFingerprint(directory: string): Promise<string> {
  const material: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "baseline") await walk(child); }
      else if (entry.name !== "verified.json") material.push(`${relative(directory, child)}\0${createHash("sha256").update(await readFile(child)).digest("hex")}`);
    }
  };
  await walk(directory);
  return createHash("sha256").update(material.join("\n")).digest("hex");
}

async function harnessNames(root: string, profile: CheckProfile | undefined): Promise<string[]> {
  try { return (await readdir(harnessesRoot(root, profile), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return []; }
}

// Runs every verified harness next to the HTTP check: baselines new ones, checks existing ones, and asks for verification otherwise.
async function protectHarnesses(root: string, profile: CheckProfile, passThrough: readonly string[], io: CliIo): Promise<number> {
  const names = await harnessNames(root, profile); let code = 0;
  if (names.length === 0) {
    const report = await scanCodeSeams({ root }).catch(() => undefined);
    const hidden = report ? [...new Set([...report.seams.filter((seam) => seam.kind === "job" || seam.kind === "consumer").map((seam) => `${seam.kind} ${seam.name ?? seam.file}`), ...report.effects.filter((effect) => effect.kind !== "outbound").map((effect) => `${effect.kind === "message" ? "event" : "data"} ${effect.name}`)])].sort() : [];
    if (hidden.length > 0) io.stdout(`TASK the code also has behavior HTTP checks cannot see (${hidden.slice(0, 6).join(", ")}${hidden.length > 6 ? `, +${hidden.length - 6} more` : ""}). Run \`air harness task\` and follow it to lock it.\n`);
    return 0;
  }
  for (const name of names) {
    const directory = resolve(harnessesRoot(root, profile), name);
    io.stdout(`== harness ${name}\n`);
    let verified: { fingerprint?: string } = {};
    try { verified = JSON.parse(await readFile(resolve(directory, "verified.json"), "utf8")) as typeof verified; } catch { /* unverified */ }
    if (verified.fingerprint !== await harnessFingerprint(directory)) {
      io.stdout(`TASK harness ${name} is new or changed and not verified. Run: air harness verify ${name} --mutation <patch that deliberately breaks this behavior>\n`);
      code = Math.max(code, 2); continue;
    }
    const checkPath = resolve(directory, "check.yaml"); const targetPath = resolve(directory, "target.yaml"); const baselinePath = resolve(directory, "baseline");
    let hasBaseline = true; try { await stat(resolve(baselinePath, "baseline.json")); } catch { hasBaseline = false; }
    if (!hasBaseline) {
      const repository = gitRepositoryState();
      const [check, target, policy] = await Promise.all([loadMigrationCheck(checkPath), loadCheckTarget(targetPath), loadCheckPolicy(profile.policy ? resolve(root, profile.policy) : undefined)]);
      const { baseline, observations } = await createCheckBaselineDetailed({ check, target, policy, repositoryRoot: repository.root, repositoryHash: repository.hash, clean: repository.clean, allowDirty: true, keepObservations: true });
      await writeCheckBaseline(baselinePath, baseline);
      await writeExpectedCache(root, check.metadata.name, observations);
      io.stdout(`PROTECTED harness ${name}: ${baseline.scenarios.length} scenario(s) (baseline ${baseline.baselineId.slice(0, 12)}).\n`);
      continue;
    }
    const output = resolve(root, profile.output, `${name}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
    code = Math.max(code, await checkCommand(["run", checkPath, "--baseline", baselinePath, "--target", targetPath, "--legacy", targetPath, ...(profile.policy ? ["--policy", resolve(root, profile.policy)] : []), "--output", output, "--agent", "--reveal", ...passThrough], io));
  }
  return code;
}

const harnessTemplate = (name: string, categories: readonly string[]): string => `// AIR harness "${name}": owned by your team (or written by your coding agent).
// Contract: read one JSON request from stdin, trigger the behavior, then print ONE JSON object to stdout whose keys
// are exactly the declared observation categories: ${categories.join(", ")}. Exit non-zero only if the harness itself breaks.
// Use what the project already has: import its modules, call the running service, use test doubles or an in-memory
// broker or cache, then report what happened (events published, cache entries, rows written, files, emails, ...).
// Report values, not timings. AIR verifies this file before trusting it: \`air harness verify ${name} --mutation <patch>\`.
// Any language works: change the argv in target.yaml.
let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

// TODO: replace this placeholder with real calls into the code under test, driven by \`input\`.
const observation = { ${categories.map((category) => `${JSON.stringify(category)}: null`).join(", ")} };
console.log(JSON.stringify(observation));
`;

async function harnessCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [action, ...rest] = args;
  const usage = "Usage:\n  air harness task\n  air harness new <name> [--observe <category,...>]\n  air harness verify <name> [--mutation <patch>] [--runs <n>] [--setup <command>] [--json]\n";
  const parsed = parseFlags(rest, ["--observe", "--mutation", "--runs", "--setup"], ["--json"]);
  if (!parsed || !action) { io.stderr(usage); return 2; }
  try {
    const root = projectRoot(); const profile = await readCheckProfile(root);
    if (action === "task" && parsed.positional.length === 0) {
      const report = await scanCodeSeams({ root });
      const lines = [...report.seams.filter((seam) => seam.kind === "job" || seam.kind === "consumer").map((seam) => `  ${seam.kind} ${seam.name ?? ""} (${seam.file}:${seam.line})`), ...report.effects.filter((effect) => effect.kind !== "outbound").map((effect) => `  ${effect.kind === "message" ? "event" : "data"} ${effect.name} (${effect.file}:${effect.line})`)];
      const base = relative(root, harnessesRoot(root, profile));
      io.stdout(`TASK lock behavior that HTTP checks cannot see (events, caches, data, jobs, files, emails, ...).
${lines.length > 0 ? `Found in the code:\n${[...new Set(lines)].join("\n")}\n` : "Nothing was found automatically; use what you know about this code.\n"}For each behavior worth protecting (ask the developer if unsure what matters):
1. air harness new <name> --observe <categories, e.g. events,cache>
2. Edit ${base}/<name>/harness.mjs to trigger the behavior and print what happened, and set realistic inputs in ${base}/<name>/check.yaml (at least two different scenarios).
3. Make a small change that deliberately breaks that behavior in the code, save it as a patch (git diff > /tmp/break.patch), then revert it.
4. air harness verify <name> --mutation /tmp/break.patch   (stable, input-sensitive, and catches the break)
5. air protect   (baselines verified harnesses, then checks them on every run)
Never weaken a harness or its check to make a run pass.
`);
      return 0;
    }
    const name = parsed.positional[0];
    if (!name || parsed.positional.length !== 1 || !/^[a-z][a-z0-9-]{0,39}$/u.test(name)) { io.stderr(`${usage}Harness names use lowercase letters, digits, and dashes.\n`); return 2; }
    const directory = resolve(harnessesRoot(root, profile), name);
    if (action === "new") {
      const categories = (parsed.values.get("--observe") ?? "events").split(",").map((item) => item.trim()).filter(Boolean);
      if (categories.length === 0 || categories.some((category) => !/^[a-z][a-z0-9-]{0,39}$/u.test(category))) throw new CheckInputError("--observe takes lowercase category names, e.g. events,cache.");
      await mkdir(directory, { recursive: true });
      const workingDirectory = relative(root, directory).split("\\").join("/");
      await writeFile(resolve(directory, "harness.mjs"), harnessTemplate(name, categories), { encoding: "utf8", flag: "wx" });
      await writeFile(resolve(directory, "check.yaml"), `apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: harness-${name} }\nspec:\n  capability: { id: ${name} }\n  observations: [${categories.join(", ")}]\n  scenarios:\n    # TODO: realistic inputs; at least two that should behave differently.\n    - { id: first, request: { kind: command, input: { case: first } } }\n    - { id: second, request: { kind: command, input: { case: second } } }\n`, { encoding: "utf8", flag: "wx" });
      await writeFile(resolve(directory, "target.yaml"), `apiVersion: air.dev/check-target/v0.1\nkind: CheckTarget\nmetadata: { name: harness-${name} }\nspec:\n  type: command\n  fixtureIsolation: process\n  workingDirectory: ${workingDirectory}\n  command: { argv: [node, harness.mjs] }\n`, { encoding: "utf8", flag: "wx" });
      io.stdout(`Created ${relative(root, directory)}/ (harness.mjs, check.yaml, target.yaml).\nNEXT implement harness.mjs and the scenario inputs, then run: air harness verify ${name} --mutation <patch>\n`);
      return 0;
    }
    if (action !== "verify") { io.stderr(usage); return 2; }
    const runs = parsed.values.has("--runs") ? Number(parsed.values.get("--runs")) : 3;
    if (!Number.isInteger(runs) || runs < 2 || runs > 20) { io.stderr(usage); return 2; }
    const [check, target] = await Promise.all([loadMigrationCheck(resolve(directory, "check.yaml")), loadCheckTarget(resolve(directory, "target.yaml"))]);
    const repository = gitRepositoryState();
    const mutation = parsed.values.get("--mutation");
    const verdict = mutation
      ? await withMutatedCopy({ root: repository.root, patch: resolve(mutation), setup: parsed.values.get("--setup"), run: (mutatedRoot) => verifyHarness({ check, target, repositoryRoot: repository.root, runs, mutatedRoot }) })
      : await verifyHarness({ check, target, repositoryRoot: repository.root, runs });
    const problems = [...verdict.problems];
    if (!mutation) problems.push("no --mutation patch: AIR cannot confirm that the harness notices a broken behavior");
    if (verdict.proposedNormalization.length > 0) problems.push(`generated values change between runs; add to check.yaml normalization: ${verdict.proposedNormalization.map((rule) => `{ kind: typed-token, pointer: ${rule.pointer}, format: ${rule.kind === "typed-token" ? rule.format : ""} }`).join(", ")}`);
    const accepted = problems.length === 0;
    if (accepted) await writeFile(resolve(directory, "verified.json"), `${JSON.stringify({ v: 1, fingerprint: await harnessFingerprint(directory), runs, mutationDetected: verdict.mutationDetected === true }, null, 2)}\n`, "utf8");
    if (parsed.flags.has("--json")) io.stdout(`${JSON.stringify({ ...verdict, accepted, problems })}\n`);
    else io.stdout(`${accepted ? `HARNESS ACCEPTED ${name}: stable over ${runs} runs, input-sensitive, and caught the planted change.` : `HARNESS REJECTED ${name}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`}\nNEXT ${accepted ? "run `air protect` to baseline it; it is checked on every run from now on." : "fix the harness or its scenarios (never weaken them to pass), then verify again."}\n`);
    return accepted ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error && "code" in error && error.code === "EEXIST" ? "That harness already exists." : error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
    return checkFailureCode(error);
  }
}

// A throwaway copy of the current working tree (HEAD + uncommitted + untracked files) with a patch applied.
async function withMutatedCopy<T>(input: { readonly root: string; readonly patch: string; readonly setup: string | undefined; readonly run: (mutatedRoot: string) => Promise<T> }): Promise<T> {
  const copy = await mkdtemp(resolve(tmpdir(), "air-mutation-"));
  const git = (args: readonly string[], cwd: string, stdin?: string) => spawnSync("git", args, { cwd, encoding: "utf8", shell: false, ...(stdin === undefined ? {} : { input: stdin }) });
  const added = git(["worktree", "add", "--detach", "--force", copy, "HEAD"], input.root);
  if (added.status !== 0) throw new CheckInfrastructureError(`Could not create a working copy: ${added.stderr.trim()}`);
  try {
    const pending = git(["diff", "HEAD", "--binary"], input.root).stdout;
    if (pending.trim()) { const applied = git(["apply", "--binary", "-"], copy, pending); if (applied.status !== 0) throw new CheckInfrastructureError(`Could not copy uncommitted changes: ${applied.stderr.trim()}`); }
    for (const file of git(["ls-files", "--others", "--exclude-standard"], input.root).stdout.split("\n").filter(Boolean)) {
      await mkdir(dirname(resolve(copy, file)), { recursive: true }); await copyFile(resolve(input.root, file), resolve(copy, file));
    }
    for (const dependencies of ["node_modules", ".venv", "venv"]) {
      try { await stat(resolve(input.root, dependencies)); await symlink(resolve(input.root, dependencies), resolve(copy, dependencies)); } catch { /* not present */ }
    }
    const applied = git(["apply", input.patch], copy);
    if (applied.status !== 0) throw new CheckInputError(`The --mutation patch does not apply to the current code: ${applied.stderr.trim().split("\n")[0]}`);
    if (input.setup) {
      const [program, ...args] = input.setup.split(/\s+/u).filter(Boolean);
      const setup = spawnSync(program!, args, { cwd: copy, encoding: "utf8", shell: false });
      if (setup.status !== 0) throw new CheckInfrastructureError(`--setup failed with exit ${setup.status}: ${setup.stderr.trim().split("\n").slice(-2).join(" ")}`);
    }
    return await input.run(copy);
  } finally { git(["worktree", "remove", "--force", copy], input.root); }
}

async function verify(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  let scenarioFile: string | undefined;
  let outputFile: string | undefined;
  if (!file || file.startsWith("--")) {
    io.stderr("Usage: air verify <file> --scenarios <file> [--output <file>]\n");
    return 2;
  }
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if ((option !== "--scenarios" && option !== "--output") || !value || value.startsWith("--")) {
      io.stderr("Usage: air verify <file> --scenarios <file> [--output <file>]\n");
      return 2;
    }
    index += 1;
    if (option === "--scenarios") scenarioFile = value;
    else outputFile = value;
  }
  if (!scenarioFile) {
    io.stderr("Usage: air verify <file> --scenarios <file> [--output <file>]\n");
    return 2;
  }
  try {
    const airPath = resolve(file);
    const scenarioPath = resolve(scenarioFile);
    const [air, airSource, scenarioSource] = await Promise.all([
      loadAirFile(airPath),
      readFile(airPath, "utf8"),
      readFile(scenarioPath, "utf8"),
    ]);
    const suite = parseVerificationSuite(scenarioSource);
    const results = verifySuite(air, suite);
    for (const result of results) {
      io.stdout(`${result.passed ? "PASS" : "FAIL"} ${result.id}\n`);
      for (const diagnostic of result.diagnostics) io.stderr(`  - ${diagnostic}\n`);
    }
    const passed = results.filter((result) => result.passed).length;
    io.stdout(`Verified ${passed}/${results.length} scenario(s).\n`);
    if (outputFile) {
      const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
      const evidence = {
        format: "air.dev/verification-evidence/v0.1",
        runnerVersion: "0.1.0",
        air: { apiVersion: air.apiVersion, sha256: sha256(airSource) },
        suite: { apiVersion: suite.apiVersion, sha256: sha256(scenarioSource) },
        summary: { passed, failed: results.length - passed, total: results.length },
        results,
      };
      const outputPath = resolve(outputFile);
      await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      io.stdout(`Evidence: ${outputPath}\n`);
    }
    return passed === results.length ? 0 : 1;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Verification evidence output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

async function verifyLive(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  let scenarioFile: string | undefined;
  let baseUrl: string | undefined;
  let databaseUrl = process.env.AIR_DATABASE_URL;
  let authSecret = process.env.AIR_AUTH_SECRET;
  let outputFile: string | undefined;
  let allowDatabaseReset = false;
  const usage = "Usage: air verify-live <file> --scenarios <file> --base-url <url> [--database-url <url>] [--auth-secret <secret>] --allow-database-reset [--output <file>]\n";
  if (!file || file.startsWith("--")) {
    io.stderr(usage);
    return 2;
  }
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--allow-database-reset") {
      allowDatabaseReset = true;
      continue;
    }
    const value = options[index + 1];
    if (!option || !["--scenarios", "--base-url", "--database-url", "--auth-secret", "--output"].includes(option) || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--scenarios") scenarioFile = value;
    else if (option === "--base-url") baseUrl = value;
    else if (option === "--database-url") databaseUrl = value;
    else if (option === "--auth-secret") authSecret = value;
    else outputFile = value;
  }
  if (!scenarioFile || !baseUrl || !databaseUrl || !authSecret || !allowDatabaseReset) {
    io.stderr(usage);
    return 2;
  }

  let connection: ReturnType<typeof createPostgresHttpLiveAdapter> | undefined;
  try {
    const airPath = resolve(file);
    const scenarioPath = resolve(scenarioFile);
    const [air, airSource, scenarioSource] = await Promise.all([
      loadAirFile(airPath),
      readFile(airPath, "utf8"),
      readFile(scenarioPath, "utf8"),
    ]);
    const suite = parseVerificationSuite(scenarioSource);
    connection = createPostgresHttpLiveAdapter(air, { baseUrl, databaseUrl, authSecret });
    const results = await verifyLiveSuite(air, suite, connection.adapter);
    for (const result of results) {
      io.stdout(`${result.passed ? "PASS" : "FAIL"} ${result.id} (HTTP ${result.httpStatus})\n`);
      for (const diagnostic of result.diagnostics) io.stderr(`  - ${diagnostic}\n`);
    }
    const passed = results.filter((result) => result.passed).length;
    io.stdout(`Live verified ${passed}/${results.length} scenario(s).\n`);
    if (outputFile) {
      const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
      const evidence = {
        format: "air.dev/live-verification-evidence/v0.1",
        runnerVersion: "0.1.0",
        target: { baseUrl },
        air: { apiVersion: air.apiVersion, sha256: sha256(airSource) },
        suite: { apiVersion: suite.apiVersion, sha256: sha256(scenarioSource) },
        summary: { passed, failed: results.length - passed, total: results.length },
        results,
      };
      const outputPath = resolve(outputFile);
      await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      io.stdout(`Evidence: ${outputPath}\n`);
    }
    return passed === results.length ? 0 : 1;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Live verification evidence output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  } finally {
    await connection?.close();
  }
}

function namedOption(value: string, option: string): readonly [string, string] {
  const separator = value.indexOf("=");
  const name = value.slice(0, separator);
  const resolved = value.slice(separator + 1);
  if (separator < 1 || !/^[a-z][a-z0-9-]*$/i.test(name) || !resolved) {
    throw new Error(`${option} must use <name>=<value>.`);
  }
  return [name, resolved];
}

async function verifyDifferential(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  let scenarioFile: string | undefined;
  let authSecret = process.env.AIR_AUTH_SECRET;
  let outputFile: string | undefined;
  let allowDatabaseReset = false;
  const targetUrls = new Map<string, string>();
  const databaseUrls = new Map<string, string>();
  const usage = "Usage: air verify-differential <file> --scenarios <file> --target <name>=<url> --database-url <name>=<url> [repeat targets] [--auth-secret <secret>] --allow-database-reset [--output <file>]\n";
  if (!file || file.startsWith("--")) {
    io.stderr(usage);
    return 2;
  }
  try {
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--allow-database-reset") {
        allowDatabaseReset = true;
        continue;
      }
      const value = options[index + 1];
      if (!option || !["--scenarios", "--target", "--database-url", "--auth-secret", "--output"].includes(option) || !value || value.startsWith("--")) {
        io.stderr(usage);
        return 2;
      }
      index += 1;
      if (option === "--scenarios") scenarioFile = value;
      else if (option === "--auth-secret") authSecret = value;
      else if (option === "--output") outputFile = value;
      else {
        const [name, resolved] = namedOption(value, option);
        const collection = option === "--target" ? targetUrls : databaseUrls;
        if (collection.has(name)) throw new Error(`Duplicate ${option} name ${name}.`);
        collection.set(name, resolved);
      }
    }
    if (!scenarioFile || !authSecret || !allowDatabaseReset || targetUrls.size < 2) {
      io.stderr(usage);
      return 2;
    }
    if ([...targetUrls.keys()].some((name) => !databaseUrls.has(name)) || databaseUrls.size !== targetUrls.size) {
      throw new Error("Every differential target must have exactly one same-named --database-url.");
    }
    if (new Set(databaseUrls.values()).size !== databaseUrls.size) {
      throw new Error("Differential targets must use distinct isolated databases.");
    }
    const resolvedAuthSecret = authSecret;

    const airPath = resolve(file);
    const scenarioPath = resolve(scenarioFile);
    const [air, airSource, scenarioSource] = await Promise.all([
      loadAirFile(airPath),
      readFile(airPath, "utf8"),
      readFile(scenarioPath, "utf8"),
    ]);
    const suite = parseVerificationSuite(scenarioSource);
    const connections = [...targetUrls].map(([name, baseUrl]) => ({
      name,
      baseUrl,
      connection: createPostgresHttpLiveAdapter(air, {
        baseUrl,
        databaseUrl: databaseUrls.get(name)!,
        authSecret: resolvedAuthSecret,
      }),
    }));
    try {
      const results = await verifyDifferentialSuite(
        air,
        suite,
        connections.map(({ name, connection }) => ({ name, adapter: connection.adapter })),
      );
      for (const result of results) {
        io.stdout(`${result.passed ? "PASS" : "FAIL"} ${result.id}\n`);
        for (const [name, target] of Object.entries(result.targets)) io.stdout(`  ${name}: HTTP ${target.httpStatus}\n`);
        for (const diagnostic of result.diagnostics) io.stderr(`  - ${diagnostic}\n`);
      }
      const passed = results.filter((result) => result.passed).length;
      io.stdout(`Differentially verified ${passed}/${results.length} scenario(s) across ${connections.length} targets.\n`);
      if (outputFile) {
        const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
        const evidence = {
          format: "air.dev/differential-verification-evidence/v0.1",
          runnerVersion: "0.1.0",
          targets: connections.map(({ name, baseUrl }) => ({ name, baseUrl })),
          air: { apiVersion: air.apiVersion, sha256: sha256(airSource) },
          suite: { apiVersion: suite.apiVersion, sha256: sha256(scenarioSource) },
          summary: { passed, failed: results.length - passed, total: results.length },
          results,
        };
        const outputPath = resolve(outputFile);
        await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        io.stdout(`Evidence: ${outputPath}\n`);
      }
      return passed === results.length ? 0 : 1;
    } finally {
      await Promise.all(connections.map(({ connection }) => connection.close()));
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Differential verification evidence output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

function integerOption(value: string, option: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${option} must be an integer greater than or equal to ${minimum}.`);
  return parsed;
}

function numberOption(value: string, option: string, minimumExclusive: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= minimumExclusive) throw new Error(`${option} must be greater than ${minimumExclusive}.`);
  return parsed;
}

async function artifactBytes(path: string): Promise<number> {
  const information = await stat(path);
  if (information.isFile()) return information.size;
  if (!information.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path)) total += await artifactBytes(resolve(path, entry));
  return total;
}

function targetProcessSample(pid: number): { rssBytes: number; cpuPercent: number } | undefined {
  const result = spawnSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], { encoding: "utf8" });
  const [rss, cpu] = result.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(rss) || !Number.isFinite(cpu)) return undefined;
  return { rssBytes: rss! * 1024, cpuPercent: cpu! };
}

async function benchmarkLive(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  let scenarioFile: string | undefined;
  let scenarioId: string | undefined;
  let workload: "replay" | "mutation" | "conflict" = "replay";
  let baseUrl: string | undefined;
  let databaseUrl = process.env.AIR_DATABASE_URL;
  let authSecret = process.env.AIR_AUTH_SECRET;
  let warmupRequests = 20;
  let measuredRequests = 200;
  let durationMs: number | undefined;
  let repetitions = 1;
  let concurrency = 10;
  let clientRetryLimit = 20;
  let outputFile: string | undefined;
  let targetPid: number | undefined;
  let measuredArtifactPath: string | undefined;
  let allowDatabaseReset = false;
  const usage = "Usage: air benchmark-live <file> --scenarios <file> --scenario <id> --base-url <url> [--workload <replay|mutation|conflict>] [--database-url <url>] [--auth-secret <secret>] [--warmup <n>] [--requests <n>] [--concurrency <n>] [--client-retries <n>] --allow-database-reset [--output <file>]\n";
  if (!file || file.startsWith("--")) {
    io.stderr(usage);
    return 2;
  }
  try {
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--allow-database-reset") {
        allowDatabaseReset = true;
        continue;
      }
      const value = options[index + 1];
      if (!option || !["--scenarios", "--scenario", "--workload", "--base-url", "--database-url", "--auth-secret", "--warmup", "--requests", "--duration-seconds", "--repetitions", "--concurrency", "--client-retries", "--target-pid", "--artifact-path", "--output"].includes(option) || !value || value.startsWith("--")) {
        io.stderr(usage);
        return 2;
      }
      index += 1;
      if (option === "--scenarios") scenarioFile = value;
      else if (option === "--scenario") scenarioId = value;
      else if (option === "--workload") {
        if (value !== "replay" && value !== "mutation" && value !== "conflict") throw new Error(`Unsupported benchmark workload ${value}.`);
        workload = value;
      }
      else if (option === "--base-url") baseUrl = value;
      else if (option === "--database-url") databaseUrl = value;
      else if (option === "--auth-secret") authSecret = value;
      else if (option === "--warmup") warmupRequests = integerOption(value, option, 0);
      else if (option === "--requests") measuredRequests = integerOption(value, option, 1);
      else if (option === "--duration-seconds") durationMs = numberOption(value, option, 0) * 1000;
      else if (option === "--repetitions") repetitions = integerOption(value, option, 1);
      else if (option === "--concurrency") concurrency = integerOption(value, option, 1);
      else if (option === "--client-retries") clientRetryLimit = integerOption(value, option, 0);
      else if (option === "--target-pid") targetPid = integerOption(value, option, 1);
      else if (option === "--artifact-path") measuredArtifactPath = value;
      else outputFile = value;
    }
    if (!scenarioFile || !scenarioId || !baseUrl || !databaseUrl || !authSecret || !allowDatabaseReset) {
      io.stderr(usage);
      return 2;
    }
    const airPath = resolve(file);
    const scenarioPath = resolve(scenarioFile);
    const [air, airSource, scenarioSource] = await Promise.all([
      loadAirFile(airPath),
      readFile(airPath, "utf8"),
      readFile(scenarioPath, "utf8"),
    ]);
    const suite = parseVerificationSuite(scenarioSource);
    const scenario = suite.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw new Error(`Verification suite has no scenario ${scenarioId}.`);
    if (durationMs !== undefined && workload !== "replay") throw new Error("--duration-seconds currently requires the replay workload.");
    const connection = createPostgresHttpLiveAdapter(air, { baseUrl, databaseUrl, authSecret });
    try {
      const benchmarkOptions = { warmupRequests, measuredRequests, concurrency, clientRetryLimit, ...(durationMs !== undefined ? { durationMs } : {}) };
      const samples: { rssBytes: number; cpuPercent: number }[] = [];
      if (targetPid) { const sample = targetProcessSample(targetPid); if (sample) samples.push(sample); }
      const timer = targetPid ? setInterval(() => { const sample = targetProcessSample(targetPid!); if (sample) samples.push(sample); }, 100) : undefined;
      const runs = [];
      try {
        for (let repetition = 0; repetition < repetitions; repetition += 1) {
          runs.push(workload === "mutation"
            ? await benchmarkMutationScenario(air, scenario, connection.adapter, benchmarkOptions)
            : workload === "conflict"
              ? await benchmarkConflictScenario(air, scenario, connection.adapter, benchmarkOptions)
              : await benchmarkLiveScenario(air, scenario, connection.adapter, benchmarkOptions));
        }
      } finally {
        if (timer) clearInterval(timer);
        if (targetPid) { const sample = targetProcessSample(targetPid); if (sample) samples.push(sample); }
      }
      const result = runs.at(-1)!;
      const throughputs = runs.map((run) => run.metrics.throughputPerSecond);
      const throughputMean = throughputs.reduce((sum, value) => sum + value, 0) / throughputs.length;
      const variance = throughputs.length > 1 ? throughputs.reduce((sum, value) => sum + (value - throughputMean) ** 2, 0) / (throughputs.length - 1) : 0;
      const margin95 = throughputs.length > 1 ? 1.96 * Math.sqrt(variance / throughputs.length) : 0;
      const aggregate = {
        repetitions,
        throughputPerSecond: { mean: throughputMean, confidence95: [Math.max(0, throughputMean - margin95), throughputMean + margin95] },
        targetResources: targetPid ? {
          pid: targetPid,
          samples: samples.length,
          peakRssBytes: Math.max(0, ...samples.map((sample) => sample.rssBytes)),
          meanCpuPercent: samples.length > 0 ? samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / samples.length : 0,
        } : null,
        artifactBytes: measuredArtifactPath ? await artifactBytes(resolve(measuredArtifactPath)) : null,
      };
      const latency = result.metrics.latencyMs;
      io.stdout(`${result.passed ? "PASS" : "FAIL"} benchmark ${result.scenarioId} (${result.workload})\n`);
      io.stdout(`  ${result.metrics.requests} requests, concurrency ${concurrency}, ${result.metrics.throughputPerSecond.toFixed(2)} req/s\n`);
      io.stdout(`  ${result.metrics.attempts} HTTP attempts, ${result.metrics.retryableConflicts} retryable conflict(s)\n`);
      io.stdout(`  latency ms: min ${latency.min.toFixed(2)}, mean ${latency.mean.toFixed(2)}, p50 ${latency.p50.toFixed(2)}, p95 ${latency.p95.toFixed(2)}, p99 ${latency.p99.toFixed(2)}, max ${latency.max.toFixed(2)}\n`);
      if (repetitions > 1) io.stdout(`  repetitions ${repetitions}, throughput mean ${throughputMean.toFixed(2)} req/s, 95% CI ${aggregate.throughputPerSecond.confidence95.map((value) => value.toFixed(2)).join("–")}\n`);
      for (const diagnostic of result.diagnostics) io.stderr(`  - ${diagnostic}\n`);
      if (outputFile) {
        const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
        const evidence = {
          format: "air.dev/live-benchmark-evidence/v0.1",
          runnerVersion: "0.1.0",
          generatedAt: new Date().toISOString(),
          target: { baseUrl },
          environment: { node: process.version, platform: process.platform, arch: process.arch },
          air: { apiVersion: air.apiVersion, sha256: sha256(airSource) },
          suite: { apiVersion: suite.apiVersion, sha256: sha256(scenarioSource) },
          result,
          runs,
          aggregate,
        };
        const outputPath = resolve(outputFile);
        await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        io.stdout(`Evidence: ${outputPath}\n`);
      }
      return runs.every((run) => run.passed) ? 0 : 1;
    } finally {
      await connection.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Benchmark evidence output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

const EVIDENCE_FORMATS = new Set([
  "air.dev/verification-evidence/v0.1",
  "air.dev/system-evidence/v0.2",
  "air.dev/live-verification-evidence/v0.1",
  "air.dev/differential-verification-evidence/v0.1",
  "air.dev/live-benchmark-evidence/v0.1",
  "air.dev/target-compatibility/v0.1",
]);

async function evidencePack(args: readonly string[], io: CliIo): Promise<number> {
  let outputDirectory: string | undefined;
  const inputs = new Map<string, string>();
  const usage = "Usage: air evidence-pack --artifact <name>=<file> [--artifact <name>=<file> ...] --output <directory>\n";
  try {
    for (let index = 0; index < args.length; index += 1) {
      const option = args[index];
      const value = args[index + 1];
      if (!option || (option !== "--artifact" && option !== "--output") || !value || value.startsWith("--")) {
        io.stderr(usage);
        return 2;
      }
      index += 1;
      if (option === "--output") outputDirectory = value;
      else {
        const [name, file] = namedOption(value, option);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          throw new Error(`Evidence artifact name ${name} must contain only letters, digits, dots, underscores, or hyphens.`);
        }
        if (inputs.has(name)) throw new Error(`Duplicate evidence artifact name ${name}.`);
        inputs.set(name, file);
      }
    }
    if (!outputDirectory || inputs.size === 0) {
      io.stderr(usage);
      return 2;
    }
    const loaded = await Promise.all([...inputs].map(async ([name, file]) => {
      const sourcePath = resolve(file);
      const source = await readFile(sourcePath, "utf8");
      const parsed = JSON.parse(source) as Record<string, unknown>;
      if (typeof parsed.format !== "string" || !EVIDENCE_FORMATS.has(parsed.format)) {
        throw new Error(`Artifact ${name} has unsupported evidence format ${String(parsed.format)}.`);
      }
      const air = (parsed.air ?? parsed.system) as { sha256?: unknown } | undefined;
      const suite = parsed.suite as { sha256?: unknown } | undefined;
      return {
        name,
        sourcePath,
        source,
        format: parsed.format,
        airSha256: typeof air?.sha256 === "string" ? air.sha256 : undefined,
        suiteSha256: typeof suite?.sha256 === "string" ? suite.sha256 : undefined,
        summary: parsed.summary ?? (parsed.result as { passed?: unknown } | undefined)?.passed,
      };
    }));
    const airHashes = new Set(loaded.map((item) => item.airSha256).filter(Boolean));
    const suiteHashes = new Set(loaded.map((item) => item.suiteSha256).filter(Boolean));
    if (airHashes.size > 1) throw new Error("Evidence artifacts reference different AIR source hashes.");
    if (suiteHashes.size > 1) throw new Error("Evidence artifacts reference different verification-suite hashes.");

    const destination = resolve(outputDirectory);
    await mkdir(destination);
    const artifacts = [];
    for (const item of loaded) {
      const file = `${item.name}-${basename(item.sourcePath)}`;
      await copyFile(item.sourcePath, resolve(destination, file));
      artifacts.push({
        name: item.name,
        file,
        format: item.format,
        sha256: createHash("sha256").update(item.source).digest("hex"),
        summary: item.summary,
      });
    }
    const manifest = {
      format: "air.dev/evidence-pack/v0.1",
      createdAt: new Date().toISOString(),
      airSha256: [...airHashes][0] ?? null,
      suiteSha256: [...suiteHashes][0] ?? null,
      artifacts,
    };
    await writeFile(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    io.stdout(`Evidence pack: ${destination}\n`);
    io.stdout(`  ${artifacts.length} artifact(s), AIR ${manifest.airSha256 ?? "unavailable"}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Evidence-pack output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

async function evidenceVerify(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length !== 1 || !args[0]) {
    io.stderr("Usage: air evidence-verify <directory>\n");
    return 2;
  }
  try {
    const directory = resolve(args[0]);
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as {
      format?: unknown;
      airSha256?: unknown;
      suiteSha256?: unknown;
      artifacts?: unknown;
    };
    if (manifest.format !== "air.dev/evidence-pack/v0.1" || !Array.isArray(manifest.artifacts)) {
      throw new Error("Invalid AIR evidence-pack manifest.");
    }
    const names = new Set<string>();
    const files = new Set<string>();
    for (const value of manifest.artifacts) {
      if (!value || typeof value !== "object") throw new Error("Invalid evidence artifact entry.");
      const artifact = value as Record<string, unknown>;
      if (typeof artifact.name !== "string" || typeof artifact.file !== "string" ||
          typeof artifact.format !== "string" || typeof artifact.sha256 !== "string") {
        throw new Error("Evidence artifact entries require name, file, format, and sha256 strings.");
      }
      if (basename(artifact.file) !== artifact.file) {
        throw new Error(`Evidence artifact ${artifact.name} contains an unsafe file path.`);
      }
      if (names.has(artifact.name) || files.has(artifact.file)) {
        throw new Error(`Evidence artifact ${artifact.name} is duplicated in the manifest.`);
      }
      names.add(artifact.name);
      files.add(artifact.file);
      const source = await readFile(resolve(directory, artifact.file), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      if (checksum !== artifact.sha256) throw new Error(`Checksum mismatch for evidence artifact ${artifact.name}.`);
      const evidence = JSON.parse(source) as Record<string, unknown>;
      if (evidence.format !== artifact.format || !EVIDENCE_FORMATS.has(artifact.format)) {
        throw new Error(`Evidence format mismatch for artifact ${artifact.name}.`);
      }
      const airHash = ((evidence.air ?? evidence.system) as { sha256?: unknown } | undefined)?.sha256;
      const suiteHash = (evidence.suite as { sha256?: unknown } | undefined)?.sha256;
      if (typeof manifest.airSha256 === "string" && typeof airHash === "string" && airHash !== manifest.airSha256) {
        throw new Error(`AIR source hash mismatch for evidence artifact ${artifact.name}.`);
      }
      if (typeof manifest.suiteSha256 === "string" && typeof suiteHash === "string" && suiteHash !== manifest.suiteSha256) {
        throw new Error(`Verification-suite hash mismatch for evidence artifact ${artifact.name}.`);
      }
    }
    if (names.size === 0) throw new Error("Evidence pack contains no artifacts.");
    io.stdout(`Verified evidence pack: ${directory}\n  ${names.size} artifact(s), all checksums valid\n`);
    return 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

async function ownershipCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [directoryArgument, option] = args;
  if (!directoryArgument || args.length > 2 || (option !== undefined && option !== "--json")) {
    io.stderr("Usage: air ownership <directory> [--json]\n");
    return 2;
  }
  try {
    const directory = resolve(directoryArgument);
    const manifest = JSON.parse(await readFile(resolve(directory, ".air/manifest.json"), "utf8")) as {
      format?: unknown;
      targetId?: unknown;
      artifacts?: unknown;
    };
    if (manifest.format !== "air.dev/generated-manifest/v0.1" || typeof manifest.targetId !== "string" || !Array.isArray(manifest.artifacts)) {
      throw new Error("Invalid AIR generated-output manifest.");
    }
    const generated = new Map<string, string>();
    for (const value of manifest.artifacts) {
      if (!value || typeof value !== "object") throw new Error("Invalid generated artifact entry.");
      const item = value as Record<string, unknown>;
      if (typeof item.path !== "string" || typeof item.checksum !== "string") throw new Error("Generated artifacts require path and checksum.");
      generated.set(item.path, item.checksum);
    }
    try {
      const adoption = JSON.parse(await readFile(resolve(directory, ".air/adoption.json"), "utf8")) as { format?: unknown; targetId?: unknown; userOwned?: unknown };
      if (adoption.format === "air.dev/adoption-boundary/v0.1" && adoption.targetId === manifest.targetId && Array.isArray(adoption.userOwned)) {
        for (const path of adoption.userOwned) if (typeof path === "string") generated.delete(path);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const ignored = new Set([".git", ".next", "__pycache__", ".venv", "dist", "node_modules", "target"]);
    const files: string[] = [];
    const visit = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.isDirectory() && ignored.has(entry.name)) continue;
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) files.push(relative(directory, path));
      }
    };
    await visit(directory);
    const modified: string[] = [];
    for (const [path, checksum] of generated) {
      try {
        const source = await readFile(resolve(directory, path), "utf8");
        if (createHash("sha256").update(source).digest("hex") !== checksum) modified.push(path);
      } catch { modified.push(path); }
    }
    const user = files.filter((path) => !path.startsWith(".air/") && !generated.has(path)).sort();
    const report = { format: "air.dev/ownership-report/v0.1", targetId: manifest.targetId, generated: [...generated.keys()].sort(), modified: modified.sort(), user };
    if (option === "--json") io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else {
      io.stdout(`Ownership report: ${directory}\n`);
      io.stdout(`  target: ${report.targetId}\n  generated: ${report.generated.length}\n  user-owned: ${report.user.length}\n  modified generated: ${report.modified.length}\n`);
      for (const path of report.modified) io.stdout(`  ! ${path}\n`);
      for (const path of report.user) io.stdout(`  + ${path}\n`);
    }
    return modified.length > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

async function adoptCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [directoryArgument, ...options] = args;
  const usage = "Usage: air adopt <directory> --user-owned <path> [--user-owned <path> ...]\n";
  if (!directoryArgument || directoryArgument.startsWith("--")) { io.stderr(usage); return 2; }
  if (options.length === 0) {
    try {
      const adoptionPath = await adoptExtractedCapability(resolve(directoryArgument));
      io.stdout(`Capability adopted with evidence record: ${adoptionPath}\n`);
      return 0;
    } catch (error) { io.stderr(formatError(error)); return 1; }
  }
  const requested: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if (option !== "--user-owned" || !value || value.startsWith("--")) { io.stderr(usage); return 2; }
    index += 1;
    if (value.startsWith("/") || value.split(/[\\/]/).includes("..") || value.startsWith(".air/")) {
      io.stderr(`Unsafe adoption path: ${value}.\n`);
      return 2;
    }
    requested.push(value.replaceAll("\\", "/"));
  }
  if (requested.length === 0) { io.stderr(usage); return 2; }
  try {
    const directory = resolve(directoryArgument);
    const manifest = JSON.parse(await readFile(resolve(directory, ".air/manifest.json"), "utf8")) as { format?: unknown; targetId?: unknown; artifacts?: unknown };
    if (manifest.format !== "air.dev/generated-manifest/v0.1" || typeof manifest.targetId !== "string" || !Array.isArray(manifest.artifacts)) throw new Error("Invalid AIR generated-output manifest.");
    const artifactPaths = new Set(manifest.artifacts.flatMap((value) => value && typeof value === "object" && typeof (value as Record<string, unknown>).path === "string" ? [(value as { path: string }).path] : []));
    for (const path of requested) {
      if (!artifactPaths.has(path)) throw new Error(`Cannot adopt ${path}; it is not a compiler-owned artifact.`);
      await readFile(resolve(directory, path), "utf8");
    }
    const adoptionPath = resolve(directory, ".air/adoption.json");
    let existing: string[] = [];
    try {
      const adoption = JSON.parse(await readFile(adoptionPath, "utf8")) as { targetId?: unknown; userOwned?: unknown };
      if (adoption.targetId !== manifest.targetId) throw new Error("Adoption boundary belongs to another target.");
      if (Array.isArray(adoption.userOwned)) existing = adoption.userOwned.filter((item): item is string => typeof item === "string");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const boundary = { format: "air.dev/adoption-boundary/v0.1", targetId: manifest.targetId, userOwned: [...new Set([...existing, ...requested])].sort() };
    await writeFile(adoptionPath, `${JSON.stringify(boundary, null, 2)}\n`, "utf8");
    io.stdout(`Adoption boundary: ${adoptionPath}\n  ${boundary.userOwned.length} user-owned artifact(s)\n`);
    return 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

async function evolutionCommand(
  command: "diff" | "plan-migration",
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const usage = `Usage: air ${command} <before> <after> [--output <file>]\n`;
  if (args.length !== 2 && args.length !== 4) {
    io.stderr(usage);
    return 2;
  }
  const [beforeFile, afterFile, option, outputFile] = args;
  if (!beforeFile || !afterFile || (args.length === 4 && (option !== "--output" || !outputFile))) {
    io.stderr(usage);
    return 2;
  }
  try {
    const [before, after] = await Promise.all([loadAirFile(resolve(beforeFile)), loadAirFile(resolve(afterFile))]);
    const artifact = command === "diff" ? diffAirDocuments(before, after) : planAirEvolution(before, after);
    const source = `${JSON.stringify(artifact, null, 2)}\n`;
    if (outputFile) {
      const outputPath = resolve(outputFile);
      await writeFile(outputPath, source, { encoding: "utf8", flag: "wx" });
      io.stdout(`${command === "diff" ? "Semantic diff" : "Migration plan"}: ${outputPath}\n`);
    } else {
      io.stdout(source);
    }
    return artifact.summary.breaking > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr("Evolution output already exists; refusing to overwrite it.\n");
      return 1;
    }
    io.stderr(formatError(error));
    return 1;
  }
}

export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const [command, file, ...extra] = args;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  if (command === "check") return checkCommand(args.slice(1), io);
  if (command === "mcp" && args.length === 1) return serveMcp(runCli, VERSION);
  if (command === "agent" && args[1] === "instructions" && args.length === 2) { io.stdout(AGENT_INSTRUCTIONS); return 0; }
  if (command === "agent" && args[1] === "install") return agentInstallCommand(args.slice(2), io);
  if (command === "protect") return protectCommand(args.slice(1), io);
  if (command === "harness") return harnessCommand(args.slice(1), io);
  if (command === "compile") return compile(args.slice(1), io);
  if (command === "compose") return composeSystem(args.slice(1), io);
  if (command === "dev") return devSystem(args.slice(1), io);
  if (command === "provider-check") return providerCheck(args.slice(1), io);
  if (command === "verify-system") return verifySystem(args.slice(1), io);
  if (command === "import-postgres") return importPostgresCommand(args.slice(1), io);
  if (command === "import-openapi") return importOpenApiCommand(args.slice(1), io);
  if (command === "import-nextjs") return importNextjsCommand(args.slice(1), io);
  if (command === "import-spring") return importSpringCommand(args.slice(1), io);
  if (command === "discover") return discoverCommand(args.slice(1), io);
  if (command === "discovery") return discoveryCommand(args.slice(1), io);
  if (command === "evidence") return evidenceCommand(args.slice(1), io);
  if (command === "workbench") return workbenchCommand(args.slice(1), io);
  if (command === "extract") return extractCommand(args.slice(1), io);
  if (command === "verify-import") return verifyImportCommand(args.slice(1), io);
  if (command === "migrate") return migrate(args.slice(1), io);
  if (command === "verify") return verify(args.slice(1), io);
  if (command === "verify-live") return verifyLive(args.slice(1), io);
  if (command === "verify-differential") return verifyDifferential(args.slice(1), io);
  if (command === "benchmark-live") return benchmarkLive(args.slice(1), io);
  if (command === "evidence-pack") return evidencePack(args.slice(1), io);
  if (command === "evidence-verify") return evidenceVerify(args.slice(1), io);
  if (command === "ownership") return ownershipCommand(args.slice(1), io);
  if (command === "reconcile") return ownershipCommand(args.slice(1), io);
  if (command === "adopt") return adoptCommand(args.slice(1), io);
  if (command === "target-check") return targetCheck(args.slice(1), io);
  if (command === "diff") return evolutionCommand("diff", args.slice(1), io);
  if (command === "plan-migration") return evolutionCommand("plan-migration", args.slice(1), io);
  if (command === "lsp") {
    if (args.length !== 1) {
      io.stderr("Usage: air lsp\n");
      return 2;
    }
    startLanguageServer();
    return 0;
  }

  if (command !== "validate" && command !== "inspect") {
    io.stderr(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  if (file === undefined || extra.length > 0) {
    io.stderr(`Usage: air ${command} <file>\n`);
    return 2;
  }

  const filePath = resolve(file);
  try {
    const document = await loadAirSourceFile(filePath);
    if (command === "validate") {
      if (document.kind === "Application") io.stdout(`Valid AIR document: ${filePath}\n  ${Object.keys(document.spec.entities).length} entity/entities, ${document.spec.http?.operations.length ?? 0} HTTP operation(s)\n`);
      else if (document.kind === "System") io.stdout(`Valid AIR System document: ${filePath}\n  ${Object.keys(document.spec.components).length} component(s), ${Object.keys(document.spec.channels ?? {}).length} channel(s)\n`);
      else if (document.kind === "UI") io.stdout(`Valid AIR UI document: ${filePath}\n  ${Object.keys(document.spec.screens).length} screen(s), ${document.spec.implementation.rendering} ${document.spec.implementation.technology}\n`);
      else io.stdout(`Valid AIR Deployment document: ${filePath}\n  ${Object.keys(document.spec.resources).length} resource(s), profile: ${document.spec.profile}\n`);
    } else {
      io.stdout(inspectSource(document));
    }
    return 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

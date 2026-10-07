import { basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import {
  AirMigrationError,
  AirParseError,
  AirValidationError,
  loadAirFile,
  parseAir,
  migrateAirDocument,
  diffAirDocuments,
  planAirEvolution,
  serializeAir,
} from "@air/parser";
import type { AirDocument } from "@air/schema";
import { importPostgres } from "@air/import-postgres";
import { importOpenApiSource } from "@air/import-openapi";
import { importNextjs } from "@air/import-nextjs";
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
  VerificationParseError,
  verifyDifferentialSuite,
  verifyLiveSuite,
  verifySuite,
} from "@air/verifier";
import { createPostgresHttpLiveAdapter } from "./live-verifier.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

const HELP = `AIR compiler toolkit 0.9.0

Usage:
  air validate <file>                         Parse and validate AIR YAML
  air inspect <file>                          Print a semantic summary
  air migrate <file> [options]                Migrate AIR to a newer schema
  air diff <before> <after> [--output <file>] Review semantic compatibility
  air plan-migration <before> <after> [options] Plan schema evolution safely
  air import-postgres [options]               Import a PostgreSQL schema into AIR
  air import-openapi [options]                Import OpenAPI 3.x into reviewable AIR
  air import-nextjs [options]                 Import Next.js App Router + Drizzle into AIR
  air verify <file> --scenarios <file> [--output <file>]
                                              Execute canonical verification scenarios
  air verify-live <file> [options]             Verify a running target over HTTP + PostgreSQL
  air verify-differential <file> [options]     Compare two or more running targets
  air benchmark-live <file> [options]          Benchmark a validated replay scenario
  air evidence-pack [options]                  Assemble immutable verification evidence
  air evidence-verify <directory>              Verify every evidence-pack checksum
  air ownership <directory> [--json]          Inspect generated/user ownership boundaries
  air adopt <directory> --user-owned <path>   Release selected artifacts to user ownership
  air reconcile <directory> [--json]          Alias for ownership drift inspection
  air target-check <file> [options]           Solve target compatibility and preferences
  air lsp                                      Start the AIR language server over stdio
  air compile [file] --target <target> [options] Generate a target application
  air help                                    Show this help

Compile options:
  --output <directory>       Output directory (default: dist/nextjs)
  --package-manager <name>   pnpm, npm, yarn, or bun (default: pnpm)
  --deployment <name>        Target deployment: vercel/node, binary/container, or process/container
  --framework-version <ver>  Next.js version (default: 16.0.0)
  --rust-edition <edition>   Rust edition 2021 or 2024 (default: 2024)
  --rust-version <version>   Exact Rust toolchain version (default: 1.99.0)
  --python-version <version> Python 3 version (default: 3.12)
  --detach                   Omit managed-mode ownership metadata

Migrate options:
  --to <version>             Target version (default: air.dev/v0.8)
  --output <file>            Output file (default: <file>.v0.8.yaml)

PostgreSQL import options:
  --url <postgres-url>       PostgreSQL connection URL (required)
  --output <file>            AIR output file (required)
  --name <name>              AIR application name (default: imported-app)
  --schema <schema>          PostgreSQL schema (default: public)

OpenAPI import options:
  --input <file>             OpenAPI 3.x YAML or JSON document (required)
  --output <file>            AIR output file (required)
  --name <name>              AIR application name (default: imported-api)

Next.js import options:
  --input <directory>        Next.js project directory (required)
  --schema <path>            Drizzle schema path relative to the project
  --output <file>            AIR output file (required)
  --report <file>            JSON provenance/diagnostic report (optional)
  --name <name>              AIR application name (default: project directory)

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
        database: "postgres",
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
        database: "postgres",
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
      database: "postgres",
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

async function migrate(args: readonly string[], io: CliIo): Promise<number> {
  const [file, ...options] = args;
  if (!file || file.startsWith("--")) {
    io.stderr("Usage: air migrate <file> [--to air.dev/v0.8] [--output <file>]\n");
    return 2;
  }
  let target = "air.dev/v0.8";
  let output = `${file}.v0.8.yaml`;
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
    target !== "air.dev/v0.8"
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
  const usage = "Usage: air import-postgres --url <postgres-url> --output <file> [--name <name>] [--schema <schema>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--url", "--output", "--name", "--schema"].includes(option ?? "") || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--url") databaseUrl = value;
    else if (option === "--output") outputFile = value;
    else if (option === "--name") applicationName = value;
    else if (option === "--schema") schema = value;
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
    await writeFile(outputPath, serializeAir(result.air), { encoding: "utf8", flag: "wx" });
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
  const usage = "Usage: air import-openapi --input <file> --output <file> [--name <name>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !["--input", "--output", "--name"].includes(option) || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--input") inputFile = value;
    else if (option === "--output") outputFile = value;
    else applicationName = value;
  }
  if (!inputFile || !outputFile) {
    io.stderr(usage);
    return 2;
  }
  try {
    const result = importOpenApiSource(await readFile(resolve(inputFile), "utf8"), { applicationName });
    for (const diagnostic of result.diagnostics) {
      io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.sourcePath}: ${diagnostic.message}\n`);
    }
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return 1;
    const outputPath = resolve(outputFile);
    await writeFile(outputPath, serializeAir(result.air), { encoding: "utf8", flag: "wx" });
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
  const usage = "Usage: air import-nextjs --input <directory> --output <file> [--schema <path>] [--report <file>] [--name <name>]\n";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !["--input", "--output", "--schema", "--report", "--name"].includes(option) || !value || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    index += 1;
    if (option === "--input") inputDirectory = value;
    else if (option === "--output") outputFile = value;
    else if (option === "--schema") schemaPath = value;
    else if (option === "--report") reportFile = value;
    else applicationName = value;
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
  "air.dev/live-verification-evidence/v0.1",
  "air.dev/differential-verification-evidence/v0.1",
  "air.dev/live-benchmark-evidence/v0.1",
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
      const air = parsed.air as { sha256?: unknown } | undefined;
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
      const airHash = (evidence.air as { sha256?: unknown } | undefined)?.sha256;
      const suiteHash = (evidence.suite as { sha256?: unknown } | undefined)?.sha256;
      if (typeof manifest.airSha256 === "string" && airHash !== manifest.airSha256) {
        throw new Error(`AIR source hash mismatch for evidence artifact ${artifact.name}.`);
      }
      if (typeof manifest.suiteSha256 === "string" && suiteHash !== manifest.suiteSha256) {
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
    io.stdout("0.9.0\n");
    return 0;
  }

  if (command === "compile") return compile(args.slice(1), io);
  if (command === "import-postgres") return importPostgresCommand(args.slice(1), io);
  if (command === "import-openapi") return importOpenApiCommand(args.slice(1), io);
  if (command === "import-nextjs") return importNextjsCommand(args.slice(1), io);
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
    const document = await loadAirFile(filePath);
    if (command === "validate") {
      io.stdout(
        `Valid AIR document: ${filePath}\n` +
          `  ${Object.keys(document.spec.entities).length} entity/entities, ` +
          `${document.spec.http?.operations.length ?? 0} HTTP operation(s)\n`,
      );
    } else {
      io.stdout(inspect(document));
    }
    return 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

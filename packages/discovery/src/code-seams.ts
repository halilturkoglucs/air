import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import javascriptRules from "../rules/javascript.json" with { type: "json" };
import pythonRules from "../rules/python.json" with { type: "json" };
import goRules from "../rules/go.json" with { type: "json" };

// Static seam scan for any codebase. It only proposes: a seam counts as discovered once AIR has executed it
// (evidence moves inferred -> runnable -> observed -> baselined). No call graph, no symbol index.

export type SeamKind = "http" | "cli" | "job" | "consumer" | "function";
export type Evidence = "inferred" | "runnable" | "observed" | "baselined";
export interface SeamEffect { readonly kind: "database" | "outbound" | "message"; readonly name: string; readonly line: number }
export interface CodeSeam {
  readonly id: string; readonly kind: SeamKind; readonly framework?: string; readonly method?: string; readonly route?: string; readonly name?: string;
  readonly file: string; readonly line: number; readonly evidence: Evidence; readonly effects: readonly SeamEffect[];
}
export interface CodeSeamReport { readonly apiVersion: "air.dev/code-seams/v0.1"; readonly scope: { readonly path: string; readonly symbol?: string; readonly since?: string }; readonly files: number; readonly seams: readonly CodeSeam[] }

interface SeamRule { readonly kind: SeamKind; readonly framework: string; readonly pattern: string; readonly method?: number; readonly route?: number; readonly name?: number; readonly defaultMethod?: string; readonly routeFromPath?: string; readonly routePrefix?: string; readonly fileFilter?: string }
interface EffectRule { readonly kind: SeamEffect["kind"]; readonly pattern: string; readonly name: number; readonly flags?: string }
interface Ecosystem { readonly ecosystem: string; readonly extensions: readonly string[]; readonly lineComment: string; readonly seams: readonly SeamRule[]; readonly effects: readonly EffectRule[] }

const ECOSYSTEMS = [javascriptRules, pythonRules, goRules] as unknown as readonly Ecosystem[];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "venv", ".venv", "target", "__pycache__", "coverage", ".next", "graphify-out", ".air"]);
const MAX_FILE_BYTES = 1024 * 1024;

async function filesUnder(root: string, path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const output: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && (SKIP.has(entry.name) || entry.name.startsWith("."))) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(root, child));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

// Blanks comment-only lines and block comments while keeping line numbers; strings such as "http://..." are untouched.
function stripComments(source: string, lineComment: string): string {
  const withoutBlocks = lineComment === "//" ? source.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " ")) : source;
  return withoutBlocks.split("\n").map((line) => (line.trimStart().startsWith(lineComment) && !line.trimStart().startsWith("#!") ? "" : line)).join("\n");
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "root";

function symbolRange(source: string, symbol: string): { start: number; end: number } | undefined {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const definition = new RegExp(`^([ \\t]*)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?\\s+${escaped}\\b|def\\s+${escaped}\\b|func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b|(?:const|let|var)\\s+${escaped}\\s*=)`, "mu");
  const match = definition.exec(source); if (!match) return undefined;
  const start = lineOf(source, match.index); const indent = match[1]!.length;
  const lines = source.split("\n");
  // The definition ends at the next line with the same or smaller indentation that starts a new top-level statement.
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && line.length - line.trimStart().length <= indent && !/^\s*[})\]]/u.test(line)) { end = index; break; }
  }
  return { start, end };
}

export async function scanCodeSeams(options: { readonly root: string; readonly path?: string; readonly symbol?: string; readonly since?: string }): Promise<CodeSeamReport> {
  const scopePath = resolve(options.root, options.path ?? ".");
  let files = await filesUnder(options.root, scopePath);
  if (options.since) {
    const changed = execFileSync("git", ["diff", "--name-only", options.since, "--"], { cwd: options.root, encoding: "utf8" }).split("\n").filter(Boolean).map((file) => resolve(options.root, file));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: options.root, encoding: "utf8" }).split("\n").filter(Boolean).map((file) => resolve(options.root, file));
    const touched = new Set([...changed, ...untracked]); files = files.filter((file) => touched.has(file));
  }
  const seams: CodeSeam[] = []; let scanned = 0;
  for (const file of files) {
    const ecosystem = ECOSYSTEMS.find((item) => item.extensions.some((extension) => file.endsWith(extension)));
    if (!ecosystem || (await stat(file)).size > MAX_FILE_BYTES) continue;
    scanned += 1;
    const relativeFile = relative(options.root, file).split(sep).join("/");
    const source = stripComments(await readFile(file, "utf8"), ecosystem.lineComment);
    const range = options.symbol ? symbolRange(source, options.symbol) : undefined;
    if (options.symbol && !range) continue;
    const found: { line: number; seam: Omit<CodeSeam, "id" | "effects">; handler?: { start: number; end: number } | null }[] = [];
    if (range) found.push({ line: range.start, seam: { kind: "function", name: options.symbol!, file: relativeFile, line: range.start, evidence: "inferred" } });
    for (const rule of ecosystem.seams) {
      if (rule.fileFilter && !new RegExp(rule.fileFilter, "u").test(relativeFile)) continue;
      const routeFromPath = rule.routeFromPath ? new RegExp(rule.routeFromPath, "u").exec(relativeFile) : undefined;
      if (rule.routeFromPath && !routeFromPath) continue;
      for (const match of source.matchAll(new RegExp(rule.pattern, "gmu"))) {
        const line = lineOf(source, match.index);
        if (range && (line < range.start || line > range.end)) continue;
        const method = (rule.method !== undefined ? match[rule.method] : undefined)?.toUpperCase() ?? rule.defaultMethod;
        const route = routeFromPath ? routeFromPath[1]!.replace(/\[([^[\]/]+)\]/gu, ":$1") || "/" : rule.route !== undefined ? `${rule.routePrefix ?? ""}${match[rule.route] ?? ""}` || "/" : undefined;
        const name = rule.name !== undefined ? (rule.name === 0 ? relativeFile : match[rule.name]) : undefined;
        // A route that registers a named handler (", pay)") owns that function's effects; an unresolved name owns none.
        const lineText = source.split("\n")[line - 1] ?? "";
        const handlerName = /,\s*([A-Za-z_][\w]*)\s*\)\s*;?\s*$/u.exec(lineText)?.[1];
        const handler = handlerName ? (symbolRange(source, handlerName) ?? null) : undefined;
        found.push({ ...(handler === undefined ? {} : { handler }), line, seam: { kind: rule.kind, framework: rule.framework, ...(method ? { method } : {}), ...(route !== undefined ? { route } : {}), ...(name ? { name } : {}), file: relativeFile, line, evidence: "inferred" } });
      }
    }
    if (found.length === 0) continue;
    found.sort((left, right) => left.line - right.line);
    const effects: SeamEffect[] = [];
    for (const rule of ecosystem.effects) for (const match of source.matchAll(new RegExp(rule.pattern, `g${rule.flags ?? ""}u`))) effects.push({ kind: rule.kind, name: match[rule.name]!, line: lineOf(source, match.index) });
    for (const [index, entry] of found.entries()) {
      // An effect belongs to the nearest seam above it in the same file; a function seam owns everything in its range.
      const next = found.slice(index + 1).find((item) => item.line > entry.line)?.line ?? Number.POSITIVE_INFINITY;
      const [from, to] = entry.handler ? [entry.handler.start, entry.handler.end] : entry.handler === null ? [0, -1] : [entry.line, entry.seam.kind === "function" && range ? range.end : next - 1];
      const owned = effects.filter((effect) => effect.line >= from && effect.line <= to);
      const unique = [...new Map(owned.map((effect) => [`${effect.kind}:${effect.name}`, effect])).values()].sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
      const { seam } = entry;
      const id = seam.kind === "http" ? `http-${(seam.method ?? "any").toLowerCase()}-${slug(seam.route ?? "/")}` : `${seam.kind}-${slug(seam.name ?? seam.file)}`;
      seams.push({ id, ...seam, effects: unique });
    }
  }
  const counts = new Map<string, number>();
  const unique = seams.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line).map((seam) => { const count = (counts.get(seam.id) ?? 0) + 1; counts.set(seam.id, count); return count === 1 ? seam : { ...seam, id: `${seam.id}-${count}` }; });
  return { apiVersion: "air.dev/code-seams/v0.1", scope: { path: relative(options.root, scopePath).split(sep).join("/") || ".", ...(options.symbol ? { symbol: options.symbol } : {}), ...(options.since ? { since: options.since } : {}) }, files: scanned, seams: unique };
}

export function formatCodeSeams(report: CodeSeamReport): string {
  const scope = [report.scope.path, report.scope.symbol ? `symbol ${report.scope.symbol}` : "", report.scope.since ? `changed since ${report.scope.since}` : ""].filter(Boolean).join(", ");
  const lines = [`${report.seams.length} seam(s) in ${scope} (${report.files} file(s) scanned; all inferred until executed)`];
  for (const seam of report.seams) {
    const label = seam.kind === "http" ? `http ${seam.method ?? "ANY"} ${seam.route}` : `${seam.kind} ${seam.name ?? ""}`.trim();
    lines.push(`${label}  ${seam.file}:${seam.line}${seam.framework ? ` [${seam.framework}]` : ""}`);
    const effects = (["database", "outbound", "message"] as const).map((kind) => [kind, seam.effects.filter((effect) => effect.kind === kind).map((effect) => effect.name)] as const).filter(([, names]) => names.length > 0);
    if (effects.length > 0) lines.push(`  ${effects.map(([kind, names]) => `${kind === "database" ? "db" : kind === "outbound" ? "out" : "msg"}: ${names.join(", ")}`).join("   ")}`);
  }
  lines.push(report.seams.length === 0 ? "NEXT no seams found in this scope; widen --path, pass --symbol, or record traffic with `air check record`." : "NEXT review the seams; executing them (`air protect`) arrives in the next step of this milestone.");
  return `${lines.join("\n")}\n`;
}

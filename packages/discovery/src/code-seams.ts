import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import javascriptRules from "../rules/javascript.json" with { type: "json" };
import pythonRules from "../rules/python.json" with { type: "json" };
import goRules from "../rules/go.json" with { type: "json" };
import sqlRules from "../rules/sql.json" with { type: "json" };
import javaRules from "../rules/java.json" with { type: "json" };
import mybatisRules from "../rules/mybatis.json" with { type: "json" };
import csharpRules from "../rules/csharp.json" with { type: "json" };
import phpRules from "../rules/php.json" with { type: "json" };
import rustRules from "../rules/rust.json" with { type: "json" };
import rubyRules from "../rules/ruby.json" with { type: "json" };
import protoRules from "../rules/proto.json" with { type: "json" };

// Static seam scan for any codebase. It only proposes: a seam counts as discovered once AIR has executed it
// (evidence moves inferred -> runnable -> observed -> baselined). No call graph, no symbol index.

export type SeamKind = "http" | "rpc" | "cli" | "job" | "consumer" | "function";
export type Evidence = "inferred" | "runnable" | "observed" | "baselined";
export interface SeamEffect { readonly kind: "database" | "outbound" | "message" | "cache"; readonly name: string; readonly line: number }
export interface CodeSeam {
  readonly id: string; readonly kind: SeamKind; readonly framework?: string; readonly method?: string; readonly route?: string; readonly name?: string;
  readonly file: string; readonly line: number; readonly evidence: Evidence; readonly effects: readonly SeamEffect[];
}
export interface CodeSeamReport { readonly apiVersion: "air.dev/code-seams/v0.1"; readonly scope: { readonly path: string; readonly symbol?: string; readonly since?: string }; readonly files: number; readonly seams: readonly CodeSeam[]; readonly effects: readonly (SeamEffect & { readonly file: string })[] }

interface SeamRule { readonly kind: SeamKind; readonly framework: string; readonly pattern: string; readonly method?: number; readonly route?: number; readonly name?: number; readonly defaultMethod?: string; readonly routeFromPath?: string; readonly routePrefix?: string; readonly fileFilter?: string; readonly expand?: readonly string[]; readonly regexRoute?: boolean; readonly methodList?: number; readonly receiver?: number }
// A string name labels effects whose target is configured elsewhere (a Kafka client whose topic comes from the environment).
interface EffectRule { readonly kind: SeamEffect["kind"]; readonly pattern: string; readonly name: number | string; readonly flags?: string; readonly fileFilter?: string }
// Prefixes apply to routes declared later in the same file (a controller or router prefix).
interface PrefixRule { readonly pattern: string; readonly prefix: number; readonly className?: number }
// Mounts attach a prefix to routes in another file: a module, a dotted module path, a function, or an imported file.
interface MountRule { readonly pattern: string; readonly target: number; readonly prefix: number; readonly targetKind: "module" | "dotted" | "function" | "import"; readonly base?: number }
// Group variables chain prefixes inside a file: v1 := r.Group("/api"); users := v1.Group("/users").
interface GroupVarRule { readonly pattern: string; readonly variable: number; readonly base: number; readonly path: number }
interface Ecosystem { readonly ecosystem: string; readonly extensions: readonly string[]; readonly lineComment: string; readonly seams: readonly SeamRule[]; readonly effects: readonly EffectRule[]; readonly prefixes?: readonly PrefixRule[]; readonly mounts?: readonly MountRule[]; readonly pathPrefixes?: readonly { readonly file: string; readonly prefix: string }[]; readonly railsRoutes?: boolean; readonly groupVars?: readonly GroupVarRule[] }

const ECOSYSTEMS = [javascriptRules, pythonRules, goRules, sqlRules, javaRules, mybatisRules, csharpRules, phpRules, rustRules, rubyRules, protoRules] as unknown as readonly Ecosystem[];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "venv", ".venv", "target", "__pycache__", "coverage", ".next", "graphify-out", ".air"]);
const MAX_FILE_BYTES = 1024 * 1024;
// Words a loose SQL match can capture that are never table names (trigger rows, clauses, MyBatis attributes).
const NOT_TABLES = new Set(["on", "new", "old", "set", "values", "select", "where", "id", "as", "lateral", "only", "if", "exists", "table"]);

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
  const lines = withoutBlocks.split("\n").map((line) => (line.trimStart().startsWith(lineComment) && !line.trimStart().startsWith("#!") ? "" : line)).join("\n");
  // In SQL files, string literals are data ('... from https://...'), never table names.
  return lineComment === "--" ? lines.replace(/'(?:[^']|'')*'/gu, (literal) => literal.replace(/[^\n]/gu, " ")) : lines;
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;
// Joins prefix and route segments; a trailing slash declared by the route itself is kept (Django redirects without it).
const joinRoute = (...parts: readonly string[]): string => {
  const joined = `/${parts.map((part) => part.replace(/^\/+|\/+$/gu, "")).filter(Boolean).join("/")}`;
  const last = parts.at(-1) ?? "";
  return last.length > 1 && last.endsWith("/") && joined !== "/" ? `${joined}/` : joined;
};
// Django-style regex routes become path templates: ^profiles/(?P<username>\w+)/?$ -> profiles/:username
const fromRegexRoute = (route: string): string => route.replace(/^\^/u, "").replace(/\$$/u, "").replace(/\(\?P<(\w+)>[^)]*\)/gu, ":$1").replace(/\/\?/gu, "/").replace(/\?$/u, "");
const withoutExtension = (file: string): string => file.replace(/\.[^./]+$/u, "");
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

// A small interpreter for the Rails routes DSL: scope/namespace, nested resources and resource, member and
// collection routes, explicit verbs, and devise_for. Blocks are tracked by their do/end indentation.
function railsRoutes(source: string): { line: number; method: string; route: string }[] {
  const routes: { line: number; method: string; route: string }[] = [];
  const stack: { indent: number; member: string; collection: string }[] = [];
  const top = () => stack.at(-1) ?? { indent: -1, member: "", collection: "" };
  const symbols = (text: string | undefined): Set<string> => new Set([...(text ?? "").matchAll(/:(\w+)/gu)].map((item) => item[1]!));
  const lines = source.split("\n");
  lines.forEach((text, index) => {
    const line = index + 1; const indent = text.length - text.trimStart().length; const body = text.trim();
    if (!body) return;
    if (body === "end") { while (stack.length > 0 && top().indent >= indent) stack.pop(); return; }
    const opens = /\bdo(?:\s*\|[^|]*\|)?\s*$/u.test(body);
    const scope = /^(?:scope|namespace)\s+(?::(\w+)|["']\/?([^"']+)["']|path:\s*["']\/?([^"']+)["'])/u.exec(body);
    if (scope) { const path = joinRoute(top().member, scope[1] ?? scope[2] ?? scope[3] ?? ""); if (opens) stack.push({ indent, member: path, collection: path }); return; }
    const only = symbols(/\bonly:\s*\[([^\]]*)\]/u.exec(body)?.[1] ?? /\bonly:\s*(:\w+)/u.exec(body)?.[1]);
    const except = symbols(/\bexcept:\s*\[([^\]]*)\]/u.exec(body)?.[1] ?? /\bexcept:\s*(:\w+)/u.exec(body)?.[1]);
    const allowed = (action: string): boolean => (only.size === 0 || only.has(action)) && !except.has(action);
    const resources = /^resources\s+:(\w+)/u.exec(body);
    if (resources) {
      const base = joinRoute(top().member, resources[1]!); const param = /\bparam:\s*:(\w+)/u.exec(body)?.[1] ?? "id"; const member = `${base}/:${param}`;
      for (const [action, method, path] of [["index", "GET", base], ["create", "POST", base], ["show", "GET", member], ["update", "PUT", member], ["update", "PATCH", member], ["destroy", "DELETE", member]] as const) if (allowed(action)) routes.push({ line, method, route: path });
      if (opens) stack.push({ indent, member, collection: base });
      return;
    }
    const resource = /^resource\s+:(\w+)/u.exec(body);
    if (resource) {
      const base = joinRoute(top().member, resource[1]!);
      for (const [action, method] of [["show", "GET"], ["create", "POST"], ["update", "PUT"], ["update", "PATCH"], ["destroy", "DELETE"]] as const) if (allowed(action)) routes.push({ line, method, route: base });
      if (opens) stack.push({ indent, member: base, collection: base });
      return;
    }
    const verb = /^(get|post|put|patch|delete)\s+(?::(\w+)|["']([^"']+)["'])/u.exec(body);
    if (verb) {
      const parent = /\bon:\s*:collection\b/u.test(body) ? top().collection : top().member;
      routes.push({ line, method: verb[1]!.toUpperCase(), route: joinRoute(parent, verb[2] ?? verb[3]!.replace(/\s*=>.*$/u, "")) });
      return;
    }
    const devise = /^devise_for\s+:(\w+)/u.exec(body);
    if (devise) {
      const base = joinRoute(top().member, devise[1]!); const signIn = /\bsign_in:\s*:?["']?(\w+)/u.exec(lines.slice(index, index + 4).join(" "))?.[1] ?? "sign_in";
      routes.push({ line, method: "POST", route: base }, { line, method: "POST", route: joinRoute(base, signIn) }, { line, method: "DELETE", route: joinRoute(base, "sign_out") });
      return;
    }
    if (/^root\b/u.test(body)) { routes.push({ line, method: "GET", route: top().member || "/" }); return; }
    if (opens) stack.push({ indent, member: top().member, collection: top().collection });
  });
  return routes;
}

export async function scanCodeSeams(options: { readonly root: string; readonly path?: string; readonly symbol?: string; readonly since?: string }): Promise<CodeSeamReport> {
  const scopePath = resolve(options.root, options.path ?? ".");
  let files = await filesUnder(options.root, scopePath);
  if (options.since) {
    const changed = execFileSync("git", ["diff", "--name-only", options.since, "--"], { cwd: options.root, encoding: "utf8" }).split("\n").filter(Boolean).map((file) => resolve(options.root, file));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: options.root, encoding: "utf8" }).split("\n").filter(Boolean).map((file) => resolve(options.root, file));
    const touched = new Set([...changed, ...untracked]); files = files.filter((file) => touched.has(file));
  }
  const seams: CodeSeam[] = []; const allEffects: (SeamEffect & { file: string })[] = []; let scanned = 0;
  const sources = new Map<string, string>(); const mounts: { rule: MountRule; target: string; prefix: string; file: string }[] = [];
  for (const file of files) {
    const ecosystem = ECOSYSTEMS.find((item) => item.extensions.some((extension) => file.endsWith(extension)));
    if (!ecosystem || (await stat(file)).size > MAX_FILE_BYTES) continue;
    scanned += 1;
    const relativeFile = relative(options.root, file).split(sep).join("/");
    const source = stripComments(await readFile(file, "utf8"), ecosystem.lineComment);
    sources.set(relativeFile, source);
    const groups = new Map<string, { base: string; path: string }>();
    for (const rule of ecosystem.groupVars ?? []) for (const match of source.matchAll(new RegExp(rule.pattern, "gmu"))) groups.set(match[rule.variable]!, { base: match[rule.base]!, path: match[rule.path] ?? "" });
    const groupPrefix = (variable: string | undefined, depth = 0): string => { const group = variable ? groups.get(variable) : undefined; return group && depth < 16 ? joinRoute(groupPrefix(group.base, depth + 1), group.path) : ""; };
    for (const rule of ecosystem.mounts ?? []) for (const match of source.matchAll(new RegExp(rule.pattern, "gmu"))) mounts.push({ rule, target: match[rule.target]!, prefix: joinRoute(rule.base !== undefined ? groupPrefix(match[rule.base]) : "", match[rule.prefix] ?? ""), file: relativeFile });
    // "[controller]" in a class route (ASP.NET) stands for the class name without its Controller suffix.
    const prefixes = (ecosystem.prefixes ?? []).flatMap((rule) => [...source.matchAll(new RegExp(rule.pattern, "gmu"))].map((match) => ({ line: lineOf(source, match.index), prefix: (match[rule.prefix] ?? "").replace("[controller]", rule.className !== undefined ? (match[rule.className] ?? "").replace(/Controller$/u, "") : "[controller]") }))).sort((left, right) => left.line - right.line);
    const filePrefix = (ecosystem.pathPrefixes ?? []).find((item) => new RegExp(item.file, "u").test(relativeFile))?.prefix ?? "";
    const prefixAt = (line: number): string => joinRoute(filePrefix, prefixes.filter((item) => item.line <= line).at(-1)?.prefix ?? "");
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
        // A method list (axum's get(..).put(..), Laravel's Route::match([...])) yields one seam per method.
        const methods = rule.methodList !== undefined ? [...new Set([...(match[rule.methodList] ?? "").matchAll(/\b(get|post|put|patch|delete|head)\b/giu)].map((item) => item[1]!.toUpperCase()))] : [];
        const method = (rule.method !== undefined ? match[rule.method] : undefined)?.toUpperCase() ?? rule.defaultMethod;
        const route = routeFromPath ? routeFromPath[1]!.replace(/\[([^[\]/]+)\]/gu, ":$1") || "/" : rule.route !== undefined ? joinRoute(prefixAt(line), rule.receiver !== undefined ? groupPrefix(match[rule.receiver]) : "", `${rule.routePrefix ?? ""}${rule.regexRoute ? fromRegexRoute(match[rule.route] ?? "") : match[rule.route] ?? ""}`) : undefined;
        const name = rule.name !== undefined ? (rule.name === 0 ? relativeFile : match[rule.name]) : undefined;
        // A route that registers a named handler (", pay)") owns that function's effects; an unresolved name owns none.
        const lineText = source.split("\n")[line - 1] ?? "";
        const handlerName = /,\s*([A-Za-z_][\w]*)\s*\)\s*;?\s*$/u.exec(lineText)?.[1];
        const handler = handlerName ? (symbolRange(source, handlerName) ?? null) : undefined;
        // A resource registration (e.g. a REST framework router) expands into its conventional routes.
        const variants = rule.expand && route !== undefined ? rule.expand.map((template) => { const [verb, path] = template.split(" "); return { method: verb!, route: joinRoute(route, path!.replace("{route}", "")) }; }) : methods.length > 0 ? methods.map((item) => ({ method: item, route })) : [{ method, route }];
        for (const variant of variants) found.push({ ...(handler === undefined ? {} : { handler }), line, seam: { kind: rule.kind, framework: rule.framework, ...(variant.method ? { method: variant.method } : {}), ...(variant.route !== undefined ? { route: variant.route } : {}), ...(name ? { name } : {}), file: relativeFile, line, evidence: "inferred" } });
      }
    }
    // Effects are collected for every file, seam or not: they show behavior that HTTP checks alone cannot see.
    const effects: SeamEffect[] = [];
    if (ecosystem.railsRoutes && /(?:^|\/)config\/routes\.rb$/u.test(relativeFile)) for (const route of railsRoutes(source)) found.push({ line: route.line, seam: { kind: "http", framework: "rails", method: route.method, route: route.route, file: relativeFile, line: route.line, evidence: "inferred" } });
    for (const rule of ecosystem.effects) for (const match of (rule.fileFilter && !new RegExp(rule.fileFilter, "u").test(relativeFile) ? [] : source.matchAll(new RegExp(rule.pattern, `g${rule.flags ?? ""}u`)))) {
      const line = lineOf(source, match.index);
      const name = typeof rule.name === "string" ? rule.name : match[rule.name]!;
      if ((!range || (line >= range.start && line <= range.end)) && !(rule.kind === "database" && NOT_TABLES.has(name.toLowerCase()))) effects.push({ kind: rule.kind, name, line });
    }
    allEffects.push(...[...new Map(effects.map((effect) => [`${effect.kind}:${effect.name}:${effect.line}`, effect])).values()].map((effect) => ({ ...effect, file: relativeFile })));
    if (found.length === 0) continue;
    found.sort((left, right) => left.line - right.line);
    for (const [index, entry] of found.entries()) {
      // An effect belongs to the nearest seam above it in the same file; a function seam owns everything in its range.
      const next = found.slice(index + 1).find((item) => item.line > entry.line)?.line ?? Number.POSITIVE_INFINITY;
      const [from, to] = entry.handler ? [entry.handler.start, entry.handler.end] : entry.handler === null ? [0, -1] : [entry.line, entry.seam.kind === "function" && range ? range.end : next - 1];
      const owned = effects.filter((effect) => effect.line >= from && effect.line <= to);
      const unique = [...new Map(owned.map((effect) => [`${effect.kind}:${effect.name}`, effect])).values()].sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
      seams.push({ id: "", ...entry.seam, effects: unique });
    }
  }
  // Mount prefixes come from other files, so they are applied once every file has been read.
  const importTarget = (mount: (typeof mounts)[number]): string | undefined => {
    const source = sources.get(mount.file) ?? "";
    const escaped = mount.target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const specifier = new RegExp(`import\\s+(?:\\{[^}]*\\b${escaped}\\b[^}]*\\}|${escaped})\\s+from\\s+["'](\\.[^"']+)["']|(?:const|let|var)\\s+${escaped}\\s*=\\s*require\\(\\s*["'](\\.[^"']+)["']`, "u").exec(source);
    const path = specifier?.[1] ?? specifier?.[2];
    return path ? withoutExtension(join(dirname(mount.file), path)).replace(/\/index$/u, "") : undefined;
  };
  const mountFor = (seam: CodeSeam): string => {
    for (const mount of mounts) {
      const kind = mount.rule.targetKind;
      if (kind === "module" && withoutExtension(seam.file).split("/").at(-1) === mount.target) return mount.prefix;
      if (kind === "dotted" && withoutExtension(seam.file).replaceAll("/", ".").endsWith(mount.target)) return mount.prefix;
      if (kind === "function") { const range = symbolRange(sources.get(seam.file) ?? "", mount.target); if (range && seam.line >= range.start && seam.line <= range.end) return mount.prefix; }
      if (kind === "import") { const target = importTarget(mount); if (target && (withoutExtension(seam.file) === target || withoutExtension(seam.file) === `${target}/index`)) return mount.prefix; }
    }
    return "";
  };
  const mounted = seams.map((seam) => {
    const route = seam.kind === "http" && seam.route !== undefined ? joinRoute(mountFor(seam), seam.route) : seam.route;
    const next = { ...seam, ...(route !== undefined ? { route } : {}) };
    return { ...next, id: next.kind === "http" ? `http-${(next.method ?? "any").toLowerCase()}-${slug(next.route ?? "/")}` : `${next.kind}-${slug(next.name ?? next.file)}` };
  });
  const counts = new Map<string, number>();
  const unique = mounted.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line).map((seam) => { const count = (counts.get(seam.id) ?? 0) + 1; counts.set(seam.id, count); return count === 1 ? seam : { ...seam, id: `${seam.id}-${count}` }; });
  return { apiVersion: "air.dev/code-seams/v0.1", scope: { path: relative(options.root, scopePath).split(sep).join("/") || ".", ...(options.symbol ? { symbol: options.symbol } : {}), ...(options.since ? { since: options.since } : {}) }, files: scanned, seams: unique, effects: allEffects.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name)) };
}

export function formatCodeSeams(report: CodeSeamReport): string {
  const scope = [report.scope.path, report.scope.symbol ? `symbol ${report.scope.symbol}` : "", report.scope.since ? `changed since ${report.scope.since}` : ""].filter(Boolean).join(", ");
  const lines = [`${report.seams.length} seam(s) in ${scope} (${report.files} file(s) scanned; all inferred until executed)`];
  for (const seam of report.seams) {
    const label = seam.kind === "http" ? `http ${seam.method ?? "ANY"} ${seam.route}` : `${seam.kind} ${seam.route ?? seam.name ?? ""}`.trim();
    lines.push(`${label}  ${seam.file}:${seam.line}${seam.framework ? ` [${seam.framework}]` : ""}`);
    const effects = (["database", "outbound", "message", "cache"] as const).map((kind) => [kind, seam.effects.filter((effect) => effect.kind === kind).map((effect) => effect.name)] as const).filter(([, names]) => names.length > 0);
    if (effects.length > 0) lines.push(`  ${effects.map(([kind, names]) => `${kind === "database" ? "db" : kind === "outbound" ? "out" : "msg"}: ${names.join(", ")}`).join("   ")}`);
  }
  lines.push(report.seams.length === 0 ? "NEXT no seams found in this scope; widen --path, pass --symbol, or record traffic with `air check record`." : "NEXT run `air protect --url <running service>` to execute the safe ones; lock the rest with `air harness task`.");
  return `${lines.join("\n")}\n`;
}

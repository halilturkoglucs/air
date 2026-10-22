import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { parseCheckDocument, parseCheckTarget, type CheckDocument } from "./check.js";

// Turns observed HTTP traffic into reviewable check scenarios for any language or framework.
// Recording writes only requests; the baseline is created later by replaying them against legacy.
export interface RecordedExchange { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly status: number; readonly contentType?: string; readonly responseBody?: string; readonly setCookies?: readonly string[] }
export type HeaderSource = { readonly scenario: string; readonly pointer?: string; readonly setCookie?: string; readonly template: string };

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const STATIC_CONTENT = /^(text\/(html|css|javascript)|application\/javascript|image\/|font\/|video\/|audio\/)/u;
const CREDENTIAL_HEADERS = ["authorization", "cookie", "x-api-key", "x-auth-token"];
const escapePointer = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

function findString(value: unknown, needle: string, pointer = ""): string | undefined {
  if (typeof value === "string") return value === needle ? pointer : undefined;
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { const found = findString(item, needle, `${pointer}/${escapePointer(key)}`); if (found !== undefined) return found; }
  return undefined;
}

// Credentials are never written to a check. When a recorded request carries a token that an earlier response issued
// (a login body field or a Set-Cookie), the check records where to take it from at replay time instead.
export function checkFromExchanges(exchanges: readonly RecordedExchange[], options: { readonly name: string; readonly capability?: string; readonly keepHeaders?: readonly string[]; readonly includeStatic?: boolean; readonly existing?: CheckDocument["spec"]["scenarios"] }): { readonly check: CheckDocument; readonly skipped: number; readonly chained: number; readonly untraced: number } {
  const keep = new Set((options.keepHeaders ?? []).map((name) => name.toLowerCase()));
  // A signed-in request is a different scenario from the same request signed out (often a login wall).
  const credentialsOf = (headers: Readonly<Record<string, unknown>>): string[] => Object.keys(headers).map((name) => name.toLowerCase()).filter((name) => CREDENTIAL_HEADERS.includes(name)).sort();
  const keyOf = (method: string, path: string, body: unknown, credentials: readonly string[]): string => JSON.stringify([method, path, body ?? null, credentials]);
  const known = new Map<string, string>((options.existing ?? []).filter((scenario) => scenario.request.kind === "http").map((scenario) => {
    const request = scenario.request as { method: string; path: string; body?: unknown; headers?: Record<string, string>; headersFrom?: Record<string, unknown> };
    return [keyOf(request.method, request.path, request.body, credentialsOf({ ...request.headers, ...request.headersFrom })), scenario.id];
  }));
  const ids = new Map<string, number>(); for (const id of known.values()) ids.set(id, 1);
  const scenarios: CheckDocument["spec"]["scenarios"][number][] = []; const sources: { id: string; body: unknown; setCookies: readonly string[] }[] = [];
  let skipped = 0; let chained = 0; let untraced = 0;
  for (const exchange of exchanges) {
    const method = exchange.method.toUpperCase();
    let body: unknown;
    if (exchange.body !== undefined && exchange.body !== "") { try { body = JSON.parse(exchange.body) as unknown; } catch { skipped += 1; continue; } }
    if (!METHODS.has(method) || !exchange.path.startsWith("/") || (!options.includeStatic && STATIC_CONTENT.test(exchange.contentType ?? ""))) { skipped += 1; continue; }
    let responseBody: unknown; try { responseBody = exchange.responseBody ? JSON.parse(exchange.responseBody) as unknown : undefined; } catch { /* not JSON */ }
    const headers = Object.fromEntries(Object.entries(exchange.headers).filter(([name]) => keep.has(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value]));
    const headersFrom: Record<string, HeaderSource> = {}; let dropped = 0;
    for (const [rawName, value] of Object.entries(exchange.headers)) {
      const name = rawName.toLowerCase();
      if (!CREDENTIAL_HEADERS.includes(name) || keep.has(name)) continue;
      let source: HeaderSource | undefined;
      if (name === "cookie") {
        for (const pair of value.split(/;\s*/u)) {
          const [cookie, cookieValue] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
          const origin = sources.find((item) => item.setCookies.some((header) => header.startsWith(`${cookie}=${cookieValue}`)));
          if (origin && cookie) { source = { scenario: origin.id, setCookie: cookie, template: `${cookie}={value}` }; break; }
        }
      } else {
        const candidates = [value, value.split(" ").slice(1).join(" ")].filter((candidate) => candidate.length >= 8);
        for (const candidate of candidates) {
          // The earliest response carrying the value is the one that issued it (later ones, like GET /user, only echo it).
          const origin = sources.map((item) => ({ item, pointer: findString(item.body, candidate) })).find((entry) => entry.pointer !== undefined);
          if (origin) { source = { scenario: origin.item.id, pointer: origin.pointer!, template: value.replace(candidate, "{value}") }; break; }
        }
      }
      if (source) headersFrom[name] = source; else dropped += 1;
    }
    // Only credentials that replay (kept or chained) make the request a signed-in one.
    const credentials = credentialsOf({ ...headers, ...headersFrom });
    const key = keyOf(method, exchange.path, body, credentials);
    const existingId = known.get(key);
    if (existingId) { sources.push({ id: existingId, body: responseBody, setCookies: exchange.setCookies ?? [] }); continue; }
    chained += Object.keys(headersFrom).length; untraced += dropped;
    const slug = exchange.path.split("?")[0]!.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "root";
    const base = `${method.toLowerCase()}-${slug}${credentials.length > 0 ? "-signed-in" : ""}`; let id = base; for (let count = 2; ids.has(id); count += 1) id = `${base}-${count}`; ids.set(id, 1);
    known.set(key, id);
    sources.push({ id, body: responseBody, setCookies: exchange.setCookies ?? [] });
    scenarios.push({ id, description: `Recorded ${method} ${exchange.path} -> ${exchange.status}`, request: { kind: "http", method, path: exchange.path, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(Object.keys(headersFrom).length > 0 ? { headersFrom } : {}), ...(body === undefined ? {} : { body }) } });
  }
  if (scenarios.length === 0 && !options.existing) throw new Error("No replayable JSON/HTTP exchanges were recorded.");
  const check: CheckDocument = { apiVersion: "air.dev/check/v0.1", kind: "Check", metadata: { name: options.name }, spec: { capability: { id: options.capability ?? options.name }, observations: ["http"], scenarios } };
  return { check, skipped, chained, untraced };
}

interface HarEntry { readonly request?: { readonly method?: string; readonly url?: string; readonly headers?: readonly { readonly name: string; readonly value: string }[]; readonly postData?: { readonly text?: string } }; readonly response?: { readonly status?: number; readonly content?: { readonly mimeType?: string } } }

export function exchangesFromHar(har: unknown, origin: string): RecordedExchange[] {
  const entries = (har as { log?: { entries?: readonly HarEntry[] } })?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Not a HAR file: log.entries is missing.");
  const wanted = new URL(origin).origin; const output: RecordedExchange[] = [];
  for (const entry of entries) {
    if (!entry.request?.url || !entry.request.method) continue;
    const url = new URL(entry.request.url);
    if (url.origin !== wanted) continue;
    output.push({
      method: entry.request.method, path: `${url.pathname}${url.search}`, status: entry.response?.status ?? 0,
      headers: Object.fromEntries((entry.request.headers ?? []).map((header: { readonly name: string; readonly value: string }) => [header.name, header.value])),
      ...(entry.request.postData?.text === undefined ? {} : { body: entry.request.postData.text }),
      ...(entry.response?.content?.mimeType ? { contentType: entry.response.content.mimeType } : {}),
    });
  }
  return output;
}

const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection"]);
const readBody = async (request: IncomingMessage): Promise<string> => { let text = ""; for await (const chunk of request) text += chunk; return text; };

// Minimal recording reverse proxy: forwards each request upstream unchanged and remembers the exchange.
export async function recordHttpTraffic(options: { readonly upstream: string; readonly port?: number; readonly maxRequests?: number; readonly signal?: AbortSignal; readonly onListening?: (url: string) => void; readonly onExchange?: (exchange: RecordedExchange) => void }): Promise<RecordedExchange[]> {
  const exchanges: RecordedExchange[] = [];
  const upstreamBase = new URL(options.upstream);
  const server = createServer((request, response) => {
    void (async () => {
      try {
        // Only origin-form paths are forwarded, and only to the configured upstream origin: an absolute-form
        // request URL ("http://other/") or a "//host" path must never redirect the proxy elsewhere (SSRF).
        const path = request.url ?? "/";
        if (!/^\/(?![/\\])[^\s]*$/u.test(path)) {
          response.writeHead(400, { "content-type": "text/plain" }).end("AIR recorder forwards only paths on the configured upstream.");
          return;
        }
        // The host always comes from the configured upstream; the request contributes only a validated path.
        const targetUrl = `${upstreamBase.origin}${path}`;
        const body = await readBody(request);
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => !HOP_HEADERS.has(name) && typeof value === "string") as [string, string][]);
        const upstream = await fetch(targetUrl, { method: request.method ?? "GET", headers, redirect: "manual", ...(body && request.method !== "GET" && request.method !== "HEAD" ? { body } : {}) });
        const payload = Buffer.from(await upstream.arrayBuffer());
        const responseHeaders = Object.fromEntries([...upstream.headers.entries()].filter(([name]) => !HOP_HEADERS.has(name) && name !== "content-encoding"));
        response.writeHead(upstream.status, responseHeaders).end(payload);
        // Response bodies and Set-Cookie headers stay in memory only, to trace where later credentials came from.
        const exchange: RecordedExchange = { method: request.method ?? "GET", path: request.url ?? "/", headers, status: upstream.status, responseBody: payload.toString("utf8"), setCookies: upstream.headers.getSetCookie(), ...(body ? { body } : {}), ...(upstream.headers.get("content-type") ? { contentType: upstream.headers.get("content-type")! } : {}) };
        exchanges.push(exchange); options.onExchange?.(exchange);
        if (options.maxRequests && exchanges.length >= options.maxRequests) server.close();
      } catch (error) {
        response.writeHead(502, { "content-type": "text/plain" }).end(`AIR recorder could not reach upstream: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });
  await new Promise<void>((ready) => server.listen(options.port ?? 0, "127.0.0.1", ready));
  options.onListening?.(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  options.signal?.addEventListener("abort", () => server.close(), { once: true });
  await new Promise<void>((closed) => server.once("close", () => closed()));
  return exchanges;
}

// Writes check.yaml and an HTTP legacy target next to it; both are validated and never overwrite existing files.
export async function writeRecordedCheck(directory: string, check: CheckDocument, upstream: string): Promise<{ readonly check: string; readonly target: string }> {
  const checkSource = stringify(check); parseCheckDocument(checkSource);
  const targetSource = stringify({ apiVersion: "air.dev/check-target/v0.1", kind: "CheckTarget", metadata: { name: "legacy" }, spec: { type: "http", baseUrl: upstream } }); parseCheckTarget(targetSource);
  await mkdir(directory, { recursive: true });
  const paths = { check: resolve(directory, "check.yaml"), target: resolve(directory, "legacy.target.yaml") };
  await writeFile(paths.check, checkSource, { encoding: "utf8", flag: "wx" });
  await writeFile(paths.target, targetSource, { encoding: "utf8", flag: "wx" });
  return paths;
}


import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { parseCheckDocument, parseCheckTarget, type CheckDocument } from "./check.js";

// Turns observed HTTP traffic into reviewable check scenarios for any language or framework.
// Recording writes only requests; the baseline is created later by replaying them against legacy.
export interface RecordedExchange { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly status: number; readonly contentType?: string }

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const STATIC_CONTENT = /^(text\/(html|css|javascript)|application\/javascript|image\/|font\/|video\/|audio\/)/u;

export function checkFromExchanges(exchanges: readonly RecordedExchange[], options: { readonly name: string; readonly capability?: string; readonly keepHeaders?: readonly string[]; readonly includeStatic?: boolean }): { readonly check: CheckDocument; readonly skipped: number } {
  const keep = new Set((options.keepHeaders ?? []).map((name) => name.toLowerCase()));
  const seen = new Set<string>(); const ids = new Map<string, number>(); const scenarios: CheckDocument["spec"]["scenarios"][number][] = [];
  let skipped = 0;
  for (const exchange of exchanges) {
    const method = exchange.method.toUpperCase();
    let body: unknown;
    if (exchange.body !== undefined && exchange.body !== "") { try { body = JSON.parse(exchange.body) as unknown; } catch { skipped += 1; continue; } }
    if (!METHODS.has(method) || !exchange.path.startsWith("/") || (!options.includeStatic && STATIC_CONTENT.test(exchange.contentType ?? ""))) { skipped += 1; continue; }
    const key = JSON.stringify([method, exchange.path, body ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    const headers = Object.fromEntries(Object.entries(exchange.headers).filter(([name]) => keep.has(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value]));
    const slug = exchange.path.split("?")[0]!.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "root";
    const base = `${method.toLowerCase()}-${slug}`; const count = (ids.get(base) ?? 0) + 1; ids.set(base, count);
    scenarios.push({ id: count === 1 ? base : `${base}-${count}`, description: `Recorded ${method} ${exchange.path} -> ${exchange.status}`, request: { kind: "http", method, path: exchange.path, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(body === undefined ? {} : { body }) } });
  }
  if (scenarios.length === 0) throw new Error("No replayable JSON/HTTP exchanges were recorded.");
  const check: CheckDocument = { apiVersion: "air.dev/check/v0.1", kind: "Check", metadata: { name: options.name }, spec: { capability: { id: options.capability ?? options.name }, observations: ["http"], scenarios } };
  return { check, skipped };
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
        const targetUrl = new URL(path, upstreamBase);
        if (!path.startsWith("/") || path.startsWith("//") || targetUrl.origin !== upstreamBase.origin) {
          response.writeHead(400, { "content-type": "text/plain" }).end("AIR recorder forwards only paths on the configured upstream.");
          return;
        }
        const body = await readBody(request);
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => !HOP_HEADERS.has(name) && typeof value === "string") as [string, string][]);
        const upstream = await fetch(targetUrl, { method: request.method ?? "GET", headers, redirect: "manual", ...(body && request.method !== "GET" && request.method !== "HEAD" ? { body } : {}) });
        const payload = Buffer.from(await upstream.arrayBuffer());
        const responseHeaders = Object.fromEntries([...upstream.headers.entries()].filter(([name]) => !HOP_HEADERS.has(name) && name !== "content-encoding"));
        response.writeHead(upstream.status, responseHeaders).end(payload);
        const exchange: RecordedExchange = { method: request.method ?? "GET", path: request.url ?? "/", headers, status: upstream.status, ...(body ? { body } : {}), ...(upstream.headers.get("content-type") ? { contentType: upstream.headers.get("content-type")! } : {}) };
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


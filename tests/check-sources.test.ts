import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bin = resolve("packages/cli/dist/bin.js");
const value = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const span = (spanId: string, parentSpanId: string | undefined, kind: number | string, name: string, attributes: { key: string; value: { stringValue: string } }[]) => ({ traceId: "t1", spanId, ...(parentSpanId ? { parentSpanId } : {}), kind, name, attributes });
const otlp = { resourceSpans: [
  { resource: { attributes: [value("service.name", "orders")] }, scopeSpans: [{ spans: [
    span("a", undefined, 2, "POST /orders", [value("http.request.method", "POST"), value("http.route", "/orders")]),
    span("b", "a", 1, "insert", [value("db.system", "postgresql"), value("db.statement", "INSERT INTO orders (id) VALUES ($1)")]),
    span("c", "b", "SPAN_KIND_CLIENT", "POST", [value("http.request.method", "POST"), value("server.address", "billing"), value("url.path", "/invoices")]),
    span("d", "a", 4, "publish", [value("messaging.system", "kafka"), value("messaging.destination.name", "order-created")]),
  ] }] },
  { resource: { attributes: [value("service.name", "billing")] }, scopeSpans: [{ spans: [
    span("e", "c", "SPAN_KIND_SERVER", "POST /invoices", [value("http.method", "POST"), value("http.route", "/invoices")]),
    span("f", "e", 3, "find", [value("db.system.name", "mongodb"), value("db.collection.name", "invoices"), value("db.operation.name", "insert")]),
  ] }] },
] };
const openapi = `openapi: 3.0.3
servers: [{ url: http://localhost:3000 }]
paths:
  /books:
    get:
      operationId: listBooks
      parameters: [{ in: query, name: genre, required: true, schema: { type: string, enum: [fantasy, scifi] } }]
    post:
      operationId: createBook
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Book' } } } }
  /books/{id}:
    parameters: [{ in: path, name: id, required: true, example: b1, schema: { type: string } }]
    get: { operationId: getBook }
    delete: { summary: Remove a book }
components:
  schemas:
    Book: { type: object, required: [title, pages], properties: { title: { type: string }, pages: { type: integer, example: 100 }, note: { type: string } } }
`;

async function workspace() {
  const root = await mkdtemp(resolve(tmpdir(), "air-sources-"));
  await writeFile(resolve(root, "traces.json"), JSON.stringify(otlp));
  await writeFile(resolve(root, "openapi.yaml"), openapi);
  const air = (...args: string[]) => { const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" }); return { code: run.status ?? -1, out: run.stdout, err: run.stderr }; };
  return { root, air };
}

describe("framework-neutral check sources", () => {
  it("maps OpenTelemetry traces to endpoints with their database, outbound, and messaging effects", async () => {
    const { air } = await workspace();
    const map = air("discover", "traces", "traces.json");
    expect(map.code, map.err).toBe(0);
    expect(map.out).toBe([
      "2 endpoint(s) across 2 service(s): billing, orders",
      "billing POST /invoices (1 call)",
      "  db: mongodb:invoices INSERT",
      "orders POST /orders (1 call)",
      "  db: postgresql:orders",
      "  out: POST billing /invoices",
      "  msg: kafka:order-created",
      "",
    ].join("\n"));
    expect(air("discover", "traces", "traces.json", "--service", "billing").out).not.toContain("orders POST");
    expect(air("discover", "traces", "missing.json").code).toBe(2);
  });

  it("creates reviewable scenario skeletons from OpenAPI and reports coverage", async () => {
    const { root, air } = await workspace();
    const init = air("check", "init", "--from-openapi", "openapi.yaml", "--output", "api", "--name", "books");
    expect(init.code, init.err).toBe(0);
    expect(init.out).toContain("Created 4 scenario skeleton(s)");
    const check = await readFile(resolve(root, "api/check.yaml"), "utf8");
    expect(check).toContain("id: listbooks");
    expect(check).toContain("path: /books?genre=fantasy");
    expect(check).toMatch(/id: createbook[\s\S]*body:\n\s+title: example\n\s+pages: 100/u);
    expect(check).not.toContain("note:");
    expect(check).toContain("path: /books/b1");
    expect(check).toContain("id: delete-books-id");
    expect(await readFile(resolve(root, "api/legacy.target.yaml"), "utf8")).toContain("baseUrl: http://localhost:3000/");

    await writeFile(resolve(root, "partial.yaml"), "apiVersion: air.dev/check/v0.1\nkind: Check\nmetadata: { name: partial }\nspec:\n  capability: { id: books }\n  observations: [http]\n  scenarios:\n    - { id: one, request: { kind: http, method: GET, path: /books/b9 } }\n    - { id: two, request: { kind: http, method: POST, path: /orders } }\n");
    const coverage = air("check", "coverage", "partial.yaml", "--openapi", "openapi.yaml", "--traces", "traces.json");
    expect(coverage.code).toBe(0);
    expect(coverage.out).toContain("COVERAGE 2/6 operations (33%)");
    expect(coverage.out).toContain("covered   GET /books/{id} [openapi] <- one");
    expect(coverage.out).toContain("covered   POST /orders [traces] <- two");
    expect(coverage.out).toContain("UNCOVERED POST /invoices [traces]");
    expect(air("check", "coverage", "partial.yaml", "--openapi", "openapi.yaml", "--fail-under", "50").code).toBe(1);
    expect(air("check", "coverage", "partial.yaml").code).toBe(2);
  });
});

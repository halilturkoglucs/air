import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importNextjs } from "@air/import-nextjs";
import { parseAir, serializeAir } from "@air/parser";

async function fixture(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "air-nextjs-import-"));
  await mkdir(resolve(directory, "src/db"), { recursive: true });
  await mkdir(resolve(directory, "src/app/todos/[id]"), { recursive: true });
  await mkdir(resolve(directory, "src/app/todos"), { recursive: true });
  await writeFile(resolve(directory, "src/db/schema.ts"), `
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
export const todos = pgTable("todos", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  completed: boolean("completed").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
`);
  await writeFile(resolve(directory, "src/app/todos/route.ts"), `
export async function GET() { return Response.json([]); }
export async function POST(request: Request) { return Response.json(await request.json(), { status: 201 }); }
`);
  await writeFile(resolve(directory, "src/app/todos/[id]/route.ts"), `
export async function GET() { return Response.json({}); }
export async function PATCH() { return Response.json({}); }
export async function DELETE() { return new Response(null, { status: 204 }); }
`);
  return directory;
}

describe("Next.js reverse importer", () => {
  it("recovers Drizzle entities and App Router CRUD operations", async () => {
    const result = await importNextjs(await fixture(), { name: "imported-todo" });
    expect(result.document.spec.entities.Todo?.fields).toMatchObject({
      id: { type: "uuid", primaryKey: true, generated: "uuid" },
      title: { type: "string", required: true },
      completed: { type: "boolean", default: false },
    });
    expect(result.document.spec.http?.operations.map((operation) => operation.action)).toEqual(["read", "update", "delete", "list", "create"]);
    expect(result.sources.every((source) => source.confidence === "high")).toBe(true);
    expect(() => parseAir(serializeAir(result.document))).not.toThrow();
  });

  it("marks command routes for human review instead of inventing semantics", async () => {
    const directory = await fixture();
    await mkdir(resolve(directory, "src/app/todos/execute"), { recursive: true });
    await writeFile(resolve(directory, "src/app/todos/execute/route.ts"), `
import { executeTodo } from "@/commands/execute-todo";
export async function POST() { return Response.json(await executeTodo()); }
`);
    const result = await importNextjs(directory);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "NEXTJS_COMMAND_REQUIRES_REVIEW" }));
    expect(result.sources.find((source) => source.path.includes("execute"))?.confidence).toBe("review");
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importOpenApiSource } from "@air/import-openapi";
import { loadAirFile, validateAir } from "@air/parser";
import { runCli, type CliIo } from "@halilturkoglucs/air";

const source = `
openapi: 3.1.0
info: { title: Pets, version: 1.0.0 }
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: { type: string, format: uuid }
        name: { type: string, minLength: 1, maxLength: 100 }
        status: { type: string, enum: [available, adopted] }
paths:
  /pets:
    get:
      operationId: listPets
      security: [{ bearerAuth: [] }]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/Pet" } }
    post:
      operationId: createPet
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Pet" }
      responses:
        "201":
          description: created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pet" }
  /pets/{id}:
    get:
      operationId: readPet
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pet" }
`;

describe("OpenAPI importer", () => {
  it("maps portable object schemas and CRUD operations with uncertainty diagnostics", () => {
    const result = importOpenApiSource(source, { applicationName: "pets" });

    expect(validateAir(result.air).valid).toBe(true);
    expect(result.air.apiVersion).toBe("air.dev/v0.8");
    expect(result.air.spec.entities.Pet?.fields).toMatchObject({
      id: { type: "uuid", primaryKey: true },
      name: { type: "string", validation: { minLength: 1, maxLength: 100 } },
      status: { type: "string", nullable: true, validation: { enum: ["available", "adopted"] } },
    });
    expect(result.air.spec.http?.operations.map((operation) => operation.id)).toEqual([
      "listPets", "createPet", "readPet",
    ]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "OPENAPI_SECURITY_REQUIRES_POLICY_REVIEW",
    }));
  });

  it("imports through the CLI into a parseable AIR proposal", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "air-openapi-"));
    const input = resolve(directory, "openapi.yaml");
    const output = resolve(directory, "air.yaml");
    await writeFile(input, source, "utf8");
    let stdout = "";
    let stderr = "";
    const io: CliIo = { stdout: (message) => { stdout += message; }, stderr: (message) => { stderr += message; } };

    expect(await runCli(["import-openapi", "--input", input, "--output", output, "--name", "pets"], io)).toBe(0);
    expect(stdout).toContain("Imported OpenAPI");
    expect(stderr).toContain("OPENAPI_SECURITY_REQUIRES_POLICY_REVIEW");
    expect((await loadAirFile(output)).metadata.name).toBe("pets");
    expect(await readFile(output, "utf8")).toContain("apiVersion: air.dev/v0.8");
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AirMigrationError,
  AirParseError,
  AirValidationError,
  loadAirFile,
  diffAirDocuments,
  migrateAirDocument,
  planAirEvolution,
  parseAir,
} from "@air/parser";

const todoPath = resolve("examples/todo/air.yaml");

describe("AIR parser", () => {
  it("loads the Todo example", async () => {
    const document = await loadAirFile(todoPath);

    expect(document.apiVersion).toBe("air.dev/v0.2");
    expect(Object.keys(document.spec.entities)).toEqual(["Todo"]);
    expect(document.spec.http?.operations).toHaveLength(5);
  });

  it("loads explicit v0.2 foreign-key semantics", async () => {
    const document = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const customer = document.spec.entities.Order?.relationships?.customer;

    expect(customer).toMatchObject({
      target: "Customer",
      cardinality: "many-to-one",
      sourceField: "customerId",
      targetField: "id",
    });
  });

  it("loads v0.6 principals, invariants, authorization, and state transitions", async () => {
    const document = await loadAirFile(resolve("examples/ecommerce/air.yaml"));
    const command = document.spec.commands?.placeOrder;

    expect(document.apiVersion).toBe("air.dev/v0.6");
    expect(document.spec.principals?.CustomerPrincipal).toMatchObject({
      fields: { customerId: { type: "uuid", required: true } },
    });
    expect(command).toMatchObject({
      input: "PlaceOrderInput",
      output: { entity: "Order" },
      effect: { kind: "create", entity: "Order" },
      authorization: {
        principal: "CustomerPrincipal",
        unauthenticatedError: "UNAUTHENTICATED",
        rules: [
          {
            kind: "input-equals-principal",
            input: "customerId",
            principalField: "customerId",
            error: "FORBIDDEN",
          },
        ],
      },
    });
    expect(command?.guards?.[0]).toMatchObject({
      kind: "exists",
      entity: "Customer",
      error: "CUSTOMER_NOT_FOUND",
    });
    expect(command?.invariants?.[0]).toMatchObject({
      condition: {
        all: [
          { operator: "greater-than", left: { input: "total" }, right: { literal: 0 } },
          { not: { operator: "greater-than", right: { principal: "maximumOrderTotal" } } },
        ],
      },
      error: "ORDER_LIMIT_EXCEEDED",
    });
    expect(document.spec.commands?.markOrderPaid).toMatchObject({
      transaction: { isolation: "serializable", conflictError: "VERSION_CONFLICT" },
      effect: {
        kind: "update",
        identify: { field: "id", error: "ORDER_NOT_FOUND" },
        values: { version: { increment: 1 } },
      },
    });
  });

  it("rejects command guards that reference undeclared errors", async () => {
    const source = await readFile(resolve("examples/ecommerce/air.yaml"), "utf8");
    const invalid = source.replace("error: CUSTOMER_NOT_FOUND", "error: UNDECLARED_ERROR");

    expect(() => parseAir(invalid)).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "command.unknown_guard_error" })],
      }),
    );
  });

  it("type-checks state preconditions", async () => {
    const source = await readFile(resolve("examples/ecommerce/air.yaml"), "utf8");
    const invalid = source.replace("literal: pending", "literal: 3");

    expect(() => parseAir(invalid)).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "command.literal_type_mismatch" })],
      }),
    );
  });

  it("requires ownership failures to use a declared 403 error", async () => {
    const source = await readFile(resolve("examples/ecommerce/air.yaml"), "utf8");
    const invalid = source.replace("status: 403", "status: 401");

    expect(() => parseAir(invalid)).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "authorization.forbidden_status" })],
      }),
    );
  });

  it("type-checks invariant operands", async () => {
    const source = await readFile(resolve("examples/ecommerce/air.yaml"), "utf8");
    const invalid = source.replace(
      "right: { principal: maximumOrderTotal }",
      "right: { principal: customerId }",
    );

    expect(() => parseAir(invalid)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "invariant.operand_type_mismatch" }),
          expect.objectContaining({ code: "invariant.ordered_comparison_type" }),
        ]),
      }),
    );
  });

  it("loads v0.7 named effects, idempotency, and retry semantics", async () => {
    const document = await loadAirFile(resolve("examples/ledger/air.yaml"));
    const command = document.spec.commands?.transferFunds;

    expect(document.apiVersion).toBe("air.dev/v0.7");
    expect(command?.effects).toMatchObject({
      debitSource: { kind: "update", entity: "Account" },
      creditDestination: { kind: "update", entity: "Account" },
    });
    expect(command?.idempotency).toMatchObject({
      input: "idempotencyKey",
      entity: "Transfer",
      mode: "replay",
    });
    expect(command?.transaction).toMatchObject({ retry: { maxAttempts: 3 } });
  });

  it("loads v0.8 role, scope, collection, and delete semantics", async () => {
    const document = await loadAirFile(resolve("examples/library/air.yaml"));
    const command = document.spec.commands?.deleteDocument;
    const list = document.spec.http?.operations.find((operation) => operation.id === "listDocuments");

    expect(document.apiVersion).toBe("air.dev/v0.8");
    expect(command?.effect).toMatchObject({ kind: "delete", entity: "Document" });
    expect(command?.authorization?.rules).toContainEqual(expect.objectContaining({
      kind: "principal-field-in",
      principalField: "scope",
      values: ["documents:write"],
    }));
    expect(list).toMatchObject({
      authorization: { principal: "OperatorPrincipal" },
      collection: {
        pagination: { defaultLimit: 20, maxLimit: 100 },
        filters: [{ parameter: "status", field: "status", operator: "equals" }],
        orderBy: [{ field: "title", direction: "asc" }],
      },
    });
  });

  it("requires one explicit primary key for each v0.2 entity", () => {
    expect(() =>
      parseAir(`
apiVersion: air.dev/v0.2
kind: Application
metadata: { name: missing-primary }
spec:
  entities:
    Todo:
      fields:
        title: { type: string, required: true }
`),
    ).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "entity.primary_key_count" })],
      }),
    );
  });

  it("migrates unambiguous v0.1 identity and nullability semantics", () => {
    const legacy = parseAir(`
apiVersion: air.dev/v0.1
kind: Application
metadata: { name: legacy }
spec:
  entities:
    Todo:
      fields:
        id: { type: uuid, required: true }
        note: { type: string }
`);
    const migrated = migrateAirDocument(legacy, "air.dev/v0.2");

    expect(migrated.apiVersion).toBe("air.dev/v0.2");
    expect(migrated.spec.entities.Todo?.fields.id).toMatchObject({
      primaryKey: true,
      nullable: false,
    });
    expect(migrated.spec.entities.Todo?.fields.note?.nullable).toBe(true);
  });

  it("migrates v0.2 documents to the latest schema without inventing commands", async () => {
    const v0_2 = await loadAirFile(todoPath);
    const migrated = migrateAirDocument(v0_2);

    expect(migrated.apiVersion).toBe("air.dev/v0.8");
    expect(migrated.spec.commands).toBeUndefined();
  });

  it("classifies semantic changes and produces a deterministic evolution plan", () => {
    const before = parseAir(`
apiVersion: air.dev/v0.8
kind: Application
metadata: { name: evolution }
spec:
  entities:
    Item:
      fields:
        id: { type: uuid, primaryKey: true }
        name: { type: string, nullable: false }
`);
    const after = parseAir(`
apiVersion: air.dev/v0.8
kind: Application
metadata: { name: evolution }
spec:
  entities:
    Item:
      fields:
        id: { type: uuid, primaryKey: true }
        name: { type: integer, nullable: false }
        note: { type: string, nullable: true }
`);
    const diff = diffAirDocuments(before, after);
    const plan = planAirEvolution(before, after);

    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/spec/entities/Item/fields/name/type", impact: "breaking" }),
      expect.objectContaining({ path: "/spec/entities/Item/fields/note", impact: "safe" }),
    ]));
    expect(plan.executable).toBe(false);
    expect(plan.steps.map((step) => step.action)).toContain("alter-field-type");
  });

  it("refuses to guess v0.1 relationship ownership during migration", () => {
    const legacy = parseAir(`
apiVersion: air.dev/v0.1
kind: Application
metadata: { name: legacy-relations }
spec:
  entities:
    User:
      fields:
        id: { type: uuid }
    Todo:
      fields:
        id: { type: uuid }
      relationships:
        owner: { target: User, cardinality: many-to-one }
`);

    expect(() => migrateAirDocument(legacy)).toThrow(AirMigrationError);
  });

  it("rejects duplicate YAML keys before schema validation", () => {
    expect(() =>
      parseAir(`
apiVersion: air.dev/v0.1
apiVersion: air.dev/v0.1
kind: Application
metadata: { name: duplicate }
spec: { entities: {} }
`),
    ).toThrow(AirParseError);
  });

  it("rejects framework concepts in AIR", async () => {
    const source = await readFile(todoPath, "utf8");
    const withTargetConcept = source.replace(
      "spec:\n",
      "spec:\n  nextjs:\n    appRouter: true\n",
    );

    try {
      parseAir(withTargetConcept);
      expect.fail("Expected target-specific input to fail validation.");
    } catch (error) {
      expect(error).toBeInstanceOf(AirValidationError);
      expect((error as AirValidationError).issues).toContainEqual(
        expect.objectContaining({
          kind: "schema",
          path: "/spec/nextjs",
          code: "schema.additionalProperties",
        }),
      );
    }
  });

  it("rejects semantic references to undeclared entities", () => {
    const source = `
apiVersion: air.dev/v0.1
kind: Application
metadata:
  name: broken-reference
spec:
  entities:
    Todo:
      fields:
        id: { type: uuid }
      relationships:
        owner:
          target: User
          cardinality: many-to-one
  http:
    operations:
      - id: listUsers
        method: GET
        path: /users
        entity: User
        action: list
`;

    try {
      parseAir(source);
      expect.fail("Expected unresolved references to fail validation.");
    } catch (error) {
      expect(error).toBeInstanceOf(AirValidationError);
      const codes = (error as AirValidationError).issues.map((issue) => issue.code);
      expect(codes).toEqual(["relationship.unknown_target", "http.unknown_entity"]);
    }
  });

  it("checks constraint types and ranges deterministically", () => {
    const source = `
apiVersion: air.dev/v0.1
kind: Application
metadata: { name: invalid-constraints }
spec:
  entities:
    Counter:
      fields:
        value:
          type: integer
          validation:
            minLength: 5
            maxLength: 2
            minimum: 10
            maximum: 1
            enum: [1, 2.5]
`;

    try {
      parseAir(source);
      expect.fail("Expected invalid constraints to fail validation.");
    } catch (error) {
      expect(error).toBeInstanceOf(AirValidationError);
      const codes = (error as AirValidationError).issues.map((issue) => issue.code);
      expect(codes).toEqual([
        "field.string_constraint_type",
        "field.length_range",
        "field.numeric_range",
        "field.enum_type",
      ]);
    }
  });

  it("rejects repeated HTTP operation IDs", () => {
    const source = `
apiVersion: air.dev/v0.1
kind: Application
metadata: { name: duplicate-operations }
spec:
  entities:
    Todo:
      fields:
        id: { type: uuid }
  http:
    operations:
      - { id: listTodos, method: GET, path: /todos, entity: Todo, action: list }
      - { id: listTodos, method: GET, path: /todos/all, entity: Todo, action: list }
`;

    expect(() => parseAir(source)).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "http.duplicate_operation_id" })],
      }),
    );
  });
});

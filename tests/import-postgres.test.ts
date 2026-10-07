import { describe, expect, it } from "vitest";
import { importPostgresCatalog, type PostgresCatalog } from "@air/import-postgres";
import { validateAir } from "@air/parser";

const catalog: PostgresCatalog = {
  columns: [
    {
      tableName: "accounts", columnName: "id", dataType: "uuid", udtName: "uuid",
      nullable: false, defaultExpression: "gen_random_uuid()", identity: false, ordinal: 1,
      primaryKey: true, unique: false,
    },
    {
      tableName: "accounts", columnName: "owner_id", dataType: "uuid", udtName: "uuid",
      nullable: false, defaultExpression: null, identity: false, ordinal: 2,
      primaryKey: false, unique: false,
    },
    {
      tableName: "transfers", columnName: "id", dataType: "uuid", udtName: "uuid",
      nullable: false, defaultExpression: null, identity: false, ordinal: 1,
      primaryKey: true, unique: false,
    },
    {
      tableName: "transfers", columnName: "from_account_id", dataType: "uuid", udtName: "uuid",
      nullable: false, defaultExpression: null, identity: false, ordinal: 2,
      primaryKey: false, unique: false,
    },
    {
      tableName: "transfers", columnName: "metadata", dataType: "USER-DEFINED", udtName: "hstore",
      nullable: true, defaultExpression: "''::hstore", identity: false, ordinal: 3,
      primaryKey: false, unique: false,
    },
  ],
  foreignKeys: [
    {
      constraintName: "transfers_from_account_id_accounts_id_fk",
      tableName: "transfers",
      columnName: "from_account_id",
      targetTableName: "accounts",
      targetColumnName: "id",
      deleteRule: "RESTRICT",
    },
  ],
};

describe("PostgreSQL importer", () => {
  it("maps catalog semantics into valid AIR with explicit uncertainty", () => {
    const result = importPostgresCatalog(catalog, { applicationName: "ledger-import" });

    expect(validateAir(result.air).valid).toBe(true);
    expect(result.air.spec.entities.Account?.fields.id).toEqual({
      type: "uuid",
      primaryKey: true,
      generated: "uuid",
    });
    expect(result.air.spec.entities.Transfer?.relationships?.account).toEqual({
      target: "Account",
      cardinality: "many-to-one",
      sourceField: "fromAccountId",
      targetField: "id",
      required: true,
      onDelete: "restrict",
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "POSTGRES_TYPE_APPROXIMATED_AS_JSON",
      "POSTGRES_DEFAULT_NOT_IMPORTED",
    ]);
    expect(result.air.spec.http?.operations).toHaveLength(10);
  });

  it("reports composite primary keys instead of silently weakening identity", () => {
    const composite: PostgresCatalog = {
      columns: [
        { ...catalog.columns[0]!, columnName: "tenant_id", ordinal: 1, primaryKey: true, defaultExpression: null },
        { ...catalog.columns[1]!, columnName: "account_id", ordinal: 2, primaryKey: true },
      ],
      foreignKeys: [],
    };
    const result = importPostgresCatalog(composite, { applicationName: "composite" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "POSTGRES_COMPOSITE_PRIMARY_KEY_UNSUPPORTED" }),
    );
  });
});

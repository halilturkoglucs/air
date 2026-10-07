import airSchema from "../schema/air-0.1.schema.json" with { type: "json" };
import airSchemaV0_2 from "../schema/air-0.2.schema.json" with { type: "json" };
import airSchemaV0_3 from "../schema/air-0.3.schema.json" with { type: "json" };
import airSchemaV0_4 from "../schema/air-0.4.schema.json" with { type: "json" };
import airSchemaV0_5 from "../schema/air-0.5.schema.json" with { type: "json" };
import airSchemaV0_6 from "../schema/air-0.6.schema.json" with { type: "json" };
import airSchemaV0_7 from "../schema/air-0.7.schema.json" with { type: "json" };
import airSchemaV0_8 from "../schema/air-0.8.schema.json" with { type: "json" };

export * from "./types.js";

export const AIR_SCHEMA_V0_1 = airSchema;
export const AIR_SCHEMA_V0_2 = airSchemaV0_2;
export const AIR_SCHEMA_V0_3 = airSchemaV0_3;
export const AIR_SCHEMA_V0_4 = airSchemaV0_4;
export const AIR_SCHEMA_V0_5 = airSchemaV0_5;
export const AIR_SCHEMA_V0_6 = airSchemaV0_6;
export const AIR_SCHEMA_V0_7 = airSchemaV0_7;
export const AIR_SCHEMA_V0_8 = airSchemaV0_8;
export type AirJsonSchema = typeof airSchema;
export type AirJsonSchemaV0_2 = typeof airSchemaV0_2;
export type AirJsonSchemaV0_3 = typeof airSchemaV0_3;
export type AirJsonSchemaV0_4 = typeof airSchemaV0_4;
export type AirJsonSchemaV0_5 = typeof airSchemaV0_5;
export type AirJsonSchemaV0_6 = typeof airSchemaV0_6;
export type AirJsonSchemaV0_7 = typeof airSchemaV0_7;
export type AirJsonSchemaV0_8 = typeof airSchemaV0_8;

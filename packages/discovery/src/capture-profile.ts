import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import schema from "../schema/evidence-capture-0.1.schema.json" with { type: "json" };
import type { EvidenceCaptureProfile } from "./types.js";

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

export function parseEvidenceCaptureProfile(source: string): EvidenceCaptureProfile {
  const value = parseYaml(source) as unknown;
  if (!validate(value)) {
    throw new Error(`Evidence capture profile is invalid: ${(validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ")}`);
  }
  const profile = value as unknown as EvidenceCaptureProfile;
  const ids = new Set<string>();
  for (const item of profile.spec.sources) {
    if (ids.has(item.id)) throw new Error(`Evidence capture source id ${item.id} is duplicated.`);
    ids.add(item.id);
    if (item.kind === "postgres" && item.tables.some((table) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table))) throw new Error(`PostgreSQL capture source ${item.id} contains an unsafe table name.`);
  }
  return profile;
}

export async function loadEvidenceCaptureProfile(path: string): Promise<EvidenceCaptureProfile> {
  return parseEvidenceCaptureProfile(await readFile(resolve(path), "utf8"));
}

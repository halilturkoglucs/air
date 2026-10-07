import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AirDocument } from "@air/schema";
import { validateAir, type ValidationIssue } from "./validation.js";

export class AirValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  readonly sourceName: string;

  constructor(sourceName: string, issues: readonly ValidationIssue[]) {
    super(`AIR document ${sourceName} is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}).`);
    this.name = "AirValidationError";
    this.sourceName = sourceName;
    this.issues = issues;
  }
}

export class AirParseError extends Error {
  readonly sourceName: string;

  constructor(sourceName: string, cause: unknown) {
    super(`Could not parse YAML in ${sourceName}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AirParseError";
    this.sourceName = sourceName;
  }
}

export function parseAir(source: string, sourceName = "<input>"): AirDocument {
  let value: unknown;
  try {
    value = parse(source, { uniqueKeys: true });
  } catch (error) {
    throw new AirParseError(sourceName, error);
  }

  const result = validateAir(value);
  if (!result.valid) throw new AirValidationError(sourceName, result.issues);
  return result.document;
}

export async function loadAirFile(filePath: string): Promise<AirDocument> {
  const source = await readFile(filePath, "utf8");
  return parseAir(source, filePath);
}

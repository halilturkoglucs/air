import { createHash } from "node:crypto";

export function contentHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = contentHash(parts.map((part) => part.trim().replaceAll("\\", "/")).join("\u0000")).slice(0, 20);
  return `${prefix}:${digest}`;
}

export function evidenceHash(sources: readonly { readonly contentHash: string }[]): string {
  return contentHash(sources.map((source) => source.contentHash).sort().join(":"));
}

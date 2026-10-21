import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("creates a document response", () => {
  const input = { operation: "create", title: "Quarterly report", documentId: "11111111-1111-4111-8111-111111111111", timestamp: "2026-10-21T10:00:00.000Z", vendorStatus: 200, idempotencyKey: "create-1" };
  const run = spawnSync(process.execPath, ["candidate.mjs"], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.equal(result.http.status, 201);
  assert.equal(result.http.body.id, input.documentId);
  assert.equal(result.http.body.title, input.title);
});

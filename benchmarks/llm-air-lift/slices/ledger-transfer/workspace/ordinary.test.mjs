import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("moves funds", () => {
  const input = { transferId: "transfer-1", idempotencyKey: "key-1", fromId: "alice", toId: "bob", fromBalance: 100, toBalance: 20, amount: 30, fromVersion: 4, toVersion: 2 };
  const run = spawnSync(process.execPath, ["candidate.mjs"], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.equal(result.http.status, 201);
  assert.equal(result.http.body.fromBalance, 70);
  assert.equal(result.http.body.toBalance, 50);
});

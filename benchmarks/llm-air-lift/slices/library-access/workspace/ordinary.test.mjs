import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("lists books", () => {
  const input = { operation: "list", principal: { id: "user-1", role: "student" }, books: [{ id: "b1", ownerId: "user-1", title: "Dune", genre: "science-fiction" }] };
  const run = spawnSync(process.execPath, ["candidate.mjs"], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.equal(result.http.status, 200);
  assert.equal(result.http.body.items.length, 1);
});

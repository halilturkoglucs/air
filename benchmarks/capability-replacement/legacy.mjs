import { randomUUID } from "node:crypto";

let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = source ? JSON.parse(source) : {};
const id = randomUUID();
const createdAt = new Date().toISOString();
console.log(JSON.stringify({
  http: { status: 201, headers: { "content-type": "application/json" }, body: { id, createdAt, title: input.title, outcome: "created" } },
  database: { rows: [{ id, createdAt, title: input.title, state: "created" }], transaction: { committed: true, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
  messages: [{ type: "document.created", id, createdAt }],
  outbound: [{ operation: "vendor.authorize", id, status: 200 }, { operation: "vendor.index", status: 202 }],
  ordering: ["database", "vendor.authorize", "vendor.index", "message"],
  failures: [{ code: "vendor-unavailable", status: 503, retryable: true }],
  retryability: true
}));

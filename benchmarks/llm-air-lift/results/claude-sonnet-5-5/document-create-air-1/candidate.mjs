import { randomUUID } from "node:crypto";

let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const id = input.documentId ?? randomUUID();
const timestamp = input.timestamp ?? new Date().toISOString();
const key = input.idempotencyKey ?? null;
const vendorStatus = input.vendorStatus ?? 200;
const headers = { "content-type": "application/json" };
const doc = { id, title: input.title, createdAt: timestamp };

const out = (http, rest = {}) => ({
  http,
  database: {
    rows: [],
    idempotency: { key, replayed: false },
    transaction: { committed: false, rollsBackOnFailure: true },
  },
  messages: [],
  outbound: [],
  ordering: [],
  failures: [],
  retryability: false,
  ...rest,
});

let result;
const replay = input.replay === true || Number(input.attempt ?? 1) > 1 || input.existing != null;

if (typeof input.title !== "string" || input.title.trim() === "") {
  result = out(
    { status: 400, headers, body: { error: "invalid_title" } },
    { failures: [{ type: "validation", field: "title" }] }
  );
} else if (replay) {
  const existing = input.existing ?? doc;
  result = out(
    { status: 200, headers, body: { id: existing.id, title: existing.title, createdAt: existing.createdAt, outcome: "replayed" } },
    {
      database: {
        rows: [{ id: existing.id, createdAt: existing.createdAt, title: existing.title, state: "created" }],
        idempotency: { key, replayed: true },
        transaction: { committed: true, rollsBackOnFailure: true },
      },
      ordering: ["idempotency-read", "response"],
    }
  );
} else if (vendorStatus >= 200 && vendorStatus < 300) {
  result = out(
    { status: 201, headers, body: { ...doc, outcome: "created" } },
    {
      database: {
        rows: [{ id, createdAt: timestamp, title: input.title, state: "created" }],
        idempotency: { key, replayed: false },
        transaction: { committed: true, rollsBackOnFailure: true },
      },
      messages: [{ type: "document.created", id, createdAt: timestamp }],
      outbound: [
        { operation: "vendor.authorize", id, status: vendorStatus },
        { operation: "vendor.index", id, status: 202 },
      ],
      ordering: ["vendor.authorize", "database", "vendor.index", "message"],
    }
  );
} else {
  const retryable = vendorStatus >= 500 || vendorStatus === 429 || vendorStatus === 408;
  const auth = vendorStatus === 401 || vendorStatus === 403;
  const status = retryable ? 503 : 502;
  const code = retryable ? "vendor-unavailable" : auth ? "vendor-unauthorized" : "vendor-rejected";
  result = out(
    { status, headers, body: { error: { code, retryable } } },
    {
      outbound: [{ operation: "vendor.authorize", id, status: vendorStatus }],
      ordering: ["vendor.authorize", "rollback"],
      failures: [{ code, status, retryable }],
      retryability: retryable,
    }
  );
}

console.log(JSON.stringify(result));

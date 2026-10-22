import { randomUUID } from "node:crypto";

let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const documentId = input.documentId ?? randomUUID();
const timestamp = input.timestamp ?? new Date().toISOString();
const headers = { "content-type": "application/json" };
const vendorStatus = input.vendorStatus ?? 200;
const key = input.idempotencyKey;

function result(status, body, extra = {}) {
  return {
    http: { status, headers, body },
    database: {
      rows: [],
      transaction: { committed: false, rollsBackOnFailure: true },
      idempotency: { key, replayed: false },
      ...extra.database,
    },
    messages: [],
    outbound: [],
    ordering: [],
    failures: [],
    retryability: false,
    ...extra.rest,
  };
}

let out;
const prior = input.existing ?? input.replay ?? input.priorRequests?.[key];
if (key !== undefined && prior) {
  const orig = typeof prior === "object" ? prior : {};
  const src = orig.body ?? orig;
  const id = src.id ?? documentId;
  const title = src.title ?? input.title;
  const createdAt = src.createdAt ?? timestamp;
  out = result(200, { id, title, createdAt, outcome: "replayed" }, {
    database: {
      rows: [{ id, createdAt, title, state: "created" }],
      transaction: { committed: true, rollsBackOnFailure: true },
      idempotency: { key, replayed: true },
    },
    rest: { ordering: ["idempotency-read", "response"] },
  });
} else if (typeof input.title !== "string" || input.title.trim() === "") {
  out = result(400, { error: "validation_failed", field: "title" }, {
    rest: { failures: [{ code: "validation_failed", status: 400 }] },
  });
} else if (vendorStatus >= 200 && vendorStatus < 300) {
  out = result(201, { id: documentId, title: input.title, createdAt: timestamp, outcome: "created" }, {
    database: {
      rows: [{ id: documentId, createdAt: timestamp, title: input.title, state: "created" }],
      transaction: { committed: true, rollsBackOnFailure: true },
    },
    rest: {
      messages: [{ type: "document.created", id: documentId, createdAt: timestamp }],
      outbound: [
        { operation: "vendor.authorize", id: documentId, status: vendorStatus },
        { operation: "vendor.index", id: documentId, status: 202 },
      ],
      ordering: ["vendor.authorize", "database", "vendor.index", "message"],
    },
  });
} else {
  const retryable = vendorStatus === 408 || vendorStatus === 429 || vendorStatus >= 500;
  const status = retryable ? 503 : 502;
  const code = retryable ? "vendor-unavailable" : "vendor-rejected";
  out = result(status, { error: { code, retryable } }, {
    rest: {
      outbound: [{ operation: "vendor.authorize", id: documentId, status: vendorStatus }],
      ordering: ["vendor.authorize", "rollback"],
      failures: [{ code, status, retryable }],
      retryability: retryable,
    },
  });
}

console.log(JSON.stringify(out));

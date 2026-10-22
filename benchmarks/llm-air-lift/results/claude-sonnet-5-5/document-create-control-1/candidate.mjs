import { randomUUID } from "node:crypto";

let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const documentId = input.documentId ?? randomUUID();
const timestamp = input.timestamp ?? new Date().toISOString();
const correlationId = input.correlationId ?? documentId;
const idempotencyKey = input.idempotencyKey ?? null;
const vendorStatus = input.vendorStatus ?? 200;

const json = { "content-type": "application/json" };
const observation = (http, { rows = [], committed = false, messages = [], outbound = [], ordering = [], failures = [], retryability = false } = {}) => ({
  http: { status: http.status, headers: json, body: http.body },
  database: { rows, transaction: { committed, rolledBack: !committed && outbound.length > 0 } },
  messages,
  outbound,
  ordering,
  failures,
  retryability
});

function respond(obj) {
  console.log(JSON.stringify(obj));
}

// Idempotent replay: a previously stored result is returned without side effects.
const prior = input.existing ?? input.replay ?? input.previous;
if (prior && typeof prior === "object") {
  const row = prior.row ?? prior.document ?? { id: prior.id ?? documentId, title: prior.title ?? input.title, createdAt: prior.createdAt ?? timestamp };
  respond(observation(
    { status: 200, body: { id: row.id, title: row.title, createdAt: row.createdAt, replayed: true } },
    { rows: [row], committed: true, ordering: ["replay"] }
  ));
} else if (typeof input.title !== "string" || input.title.trim() === "") {
  respond(observation(
    { status: 400, body: { error: "validation_failed", field: "title" } },
    { failures: [{ type: "validation", field: "title" }] }
  ));
} else {
  const outbound = [];
  const ordering = [];
  const call = (name, path) => {
    outbound.push({ vendor: "documents", operation: name, method: "POST", path, documentId, correlationId, idempotencyKey, timestamp, status: vendorStatus });
    ordering.push(name);
    return vendorStatus >= 200 && vendorStatus < 300;
  };

  let ok = call("authorize", "/authorize");
  if (ok) ok = call("index", "/index");

  if (!ok) {
    const retryable = vendorStatus >= 500 || vendorStatus === 429 || vendorStatus === 408;
    respond(observation(
      { status: retryable ? 503 : 502, body: { error: retryable ? "vendor_unavailable" : "vendor_rejected", retryable } },
      {
        outbound,
        ordering,
        failures: [{ type: "vendor", operation: ordering[ordering.length - 1], vendorStatus, retryable }],
        retryability: retryable
      }
    ));
  } else {
    const row = { id: documentId, title: input.title, createdAt: timestamp, idempotencyKey };
    ordering.push("persist", "emit");
    respond(observation(
      { status: 201, body: { id: documentId, title: input.title, createdAt: timestamp } },
      {
        rows: [row],
        committed: true,
        messages: [{ type: "document.created", id: documentId, documentId, title: input.title, timestamp, correlationId }],
        outbound,
        ordering
      }
    ));
  }
}

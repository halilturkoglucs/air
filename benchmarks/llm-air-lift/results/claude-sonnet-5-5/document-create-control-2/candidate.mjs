let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const store = new Map(); // idempotencyKey -> { fingerprint, response, row }
const rows = [];
const messages = [];
const outbound = [];
const ordering = [];
const failures = [];
let retryability = false;

const requests = Array.isArray(input.requests) ? input.requests : [input];
if (input.replay === true && !Array.isArray(input.requests)) requests.push(input);

let http;
let committed = false;

for (const req of requests) {
  const key = req.idempotencyKey;
  const fingerprint = JSON.stringify([req.title, req.documentId]);
  const prior = key !== undefined ? store.get(key) : undefined;

  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      http = { status: 409, headers: { "content-type": "application/json" }, body: { error: "idempotency_key_conflict" } };
      failures.push({ code: "idempotency_key_conflict", status: 409 });
      retryability = false;
    } else {
      http = {
        status: prior.response.status,
        headers: { ...prior.response.headers, "idempotent-replay": "true" },
        body: prior.response.body,
      };
      ordering.push("replay");
    }
    continue;
  }

  if (typeof req.title !== "string" || req.title.trim() === "") {
    http = { status: 400, headers: { "content-type": "application/json" }, body: { error: "invalid_title" } };
    failures.push({ code: "invalid_title", status: 400 });
    retryability = false;
    continue;
  }

  const id = req.documentId;
  const timestamp = req.timestamp;
  const vendorStatus = req.vendorStatus ?? 200;

  outbound.push({ vendor: "authorize", documentId: id, status: vendorStatus });
  ordering.push("vendor.authorize");
  let ok = vendorStatus >= 200 && vendorStatus < 300;
  if (ok) {
    outbound.push({ vendor: "index", documentId: id, title: req.title, status: vendorStatus });
    ordering.push("vendor.index");
  }

  if (!ok) {
    const transient = vendorStatus === 429 || vendorStatus >= 500;
    const status = transient ? 503 : 502;
    http = { status, headers: { "content-type": "application/json" }, body: { error: transient ? "vendor_unavailable" : "vendor_rejected" } };
    failures.push({ code: transient ? "vendor_unavailable" : "vendor_rejected", vendorStatus, status });
    retryability = transient;
    ordering.push("rollback");
    continue;
  }

  const row = { id, title: req.title, createdAt: timestamp };
  rows.push(row);
  ordering.push("db.commit");
  committed = true;
  messages.push({ type: "document.created", documentId: id, title: req.title, occurredAt: timestamp });
  ordering.push("event.emit");
  http = {
    status: 201,
    headers: { "content-type": "application/json" },
    body: { id, title: req.title, createdAt: timestamp },
  };
  if (key !== undefined) store.set(key, { fingerprint, response: http, row });
}

console.log(JSON.stringify({
  http,
  database: { rows, transaction: { committed } },
  messages,
  outbound,
  ordering,
  failures,
  retryability,
}));

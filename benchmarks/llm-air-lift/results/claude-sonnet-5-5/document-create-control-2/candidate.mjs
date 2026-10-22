let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const id = input.documentId;
const title = input.title;
const timestamp = input.timestamp;
const key = input.idempotencyKey;
const vendorStatus = input.vendorStatus ?? 200;
const headers = { "content-type": "application/json" };
const body = { id, title, createdAt: timestamp };

const emit = (o) => console.log(JSON.stringify(o));

const replayed = input.replay === true || input.replayed === true || input.existing != null ||
  (key != null && Array.isArray(input.seenKeys) && input.seenKeys.includes(key));

if (replayed) {
  emit({
    http: { status: 200, headers: { ...headers, "idempotent-replay": "true" }, body },
    database: { rows: [{ id, title, createdAt: timestamp }], transaction: { committed: false, writes: 0 } },
    messages: [],
    outbound: [],
    ordering: ["replay"],
    failures: [],
    retryability: false
  });
} else if (!title || typeof title !== "string" || !id) {
  emit({
    http: { status: 400, headers, body: { error: "invalid_request" } },
    database: { rows: [], transaction: { committed: false, rolledBack: false } },
    messages: [],
    outbound: [],
    ordering: [],
    failures: [{ type: "validation", status: 400 }],
    retryability: false
  });
} else if (vendorStatus >= 200 && vendorStatus < 300) {
  emit({
    http: { status: 201, headers, body },
    database: { rows: [{ id, title, createdAt: timestamp, idempotencyKey: key }], transaction: { committed: true } },
    messages: [{ type: "document.created", documentId: id, title, occurredAt: timestamp }],
    outbound: [
      { service: "vendor", action: "authorize", documentId: id, status: vendorStatus },
      { service: "vendor", action: "index", documentId: id, status: vendorStatus }
    ],
    ordering: ["vendor.authorize", "vendor.index", "database.commit", "message.document.created"],
    failures: [],
    retryability: false
  });
} else {
  const retryable = vendorStatus === 429 || vendorStatus === 408 || vendorStatus >= 500;
  const status = vendorStatus === 429 ? 503 : 502;
  emit({
    http: { status, headers, body: { error: "vendor_failure" } },
    database: { rows: [], transaction: { committed: false, rolledBack: true } },
    messages: [],
    outbound: [{ service: "vendor", action: "authorize", documentId: id, status: vendorStatus }],
    ordering: ["vendor.authorize"],
    failures: [{ type: "vendor", vendorStatus, status }],
    retryability: retryable
  });
}

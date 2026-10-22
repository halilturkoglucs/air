let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const headers = { "content-type": "application/json" };
const out = (http, o = {}) =>
  console.log(JSON.stringify({
    http,
    database: o.database ?? { rows: [], transaction: { committed: false } },
    messages: o.messages ?? [],
    outbound: o.outbound ?? [],
    ordering: o.ordering ?? [],
    failures: o.failures ?? [],
    retryability: o.retryability ?? false
  }));

const title = input.title;
if (typeof title !== "string" || title.trim() === "") {
  out({ status: 400, headers, body: { error: "invalid_title" } }, {
    failures: [{ type: "validation", field: "title" }]
  });
} else if (input.existing && input.idempotencyKey && input.existing.idempotencyKey === input.idempotencyKey) {
  // Idempotent replay: return the stored response, no new side effects.
  const doc = input.existing.document ?? { id: input.existing.documentId, title: input.existing.title };
  out({ status: 201, headers: { ...headers, "idempotent-replay": "true" }, body: doc }, {
    database: { rows: [doc], transaction: { committed: false } }
  });
} else {
  const id = input.documentId;
  const timestamp = input.timestamp;
  const status = input.vendorStatus ?? 200;
  const calls = [
    { service: "vendor", operation: "authorize", documentId: id, status },
    { service: "vendor", operation: "index", documentId: id, status }
  ];
  if (status >= 200 && status < 300) {
    const doc = { id, title };
    const row = { ...doc, createdAt: timestamp };
    out({ status: 201, headers, body: { ...doc, createdAt: timestamp } }, {
      database: { rows: [row], transaction: { committed: true } },
      messages: [{ type: "document.created", documentId: id, title, occurredAt: timestamp, idempotencyKey: input.idempotencyKey }],
      outbound: calls,
      ordering: ["vendor.authorize", "vendor.index", "database.commit", "event.document.created"]
    });
  } else {
    // Authorization fails first; indexing is never attempted.
    out({ status: 502, headers, body: { error: "vendor_failure", vendorStatus: status } }, {
      outbound: [calls[0]],
      ordering: ["vendor.authorize", "database.rollback"],
      failures: [{ type: "vendor", status }],
      retryability: status >= 500 || status === 429 || status === 408
    });
  }
}

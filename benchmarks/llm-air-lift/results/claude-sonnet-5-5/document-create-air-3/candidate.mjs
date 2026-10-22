let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const { documentId, title, timestamp, idempotencyKey } = input;
const vendorStatus = input.vendorStatus ?? 200;
const json = { "content-type": "application/json" };

function observe(o) {
  console.log(JSON.stringify({
    http: o.http,
    database: o.database ?? { idempotency: { key: idempotencyKey, replayed: false }, rows: [], transaction: { committed: false, rollsBackOnFailure: true } },
    messages: o.messages ?? [],
    outbound: o.outbound ?? [],
    ordering: o.ordering ?? [],
    failures: o.failures ?? [],
    retryability: o.retryability ?? false
  }));
}

const body = { id: documentId, title, createdAt: timestamp };

// Idempotent replay: a prior record for the same key returns the original result without side effects.
const prior = input.replay === true ? (input.existing ?? body)
  : (idempotencyKey && input.idempotency?.[idempotencyKey]) || null;

if (prior) {
  if (prior.title !== undefined && prior.title !== title) {
    observe({
      http: { status: 409, headers: json, body: { error: "idempotency_conflict" } },
      failures: [{ type: "idempotency_conflict", key: idempotencyKey }]
    });
  } else {
    observe({
      http: { status: 200, headers: { ...json, "idempotent-replay": "true" }, body: { ...body, ...prior } },
      database: { idempotency: { key: idempotencyKey, replayed: true }, rows: [], transaction: { committed: false, rollsBackOnFailure: true } },
      ordering: ["replay"]
    });
  }
} else if (typeof title !== "string" || title.trim() === "") {
  observe({
    http: { status: 400, headers: json, body: { error: "validation_failed", field: "title" } },
    failures: [{ type: "validation", field: "title" }]
  });
} else {
  const authorize = { id: documentId, operation: "vendor.authorize" };
  const index = { id: documentId, operation: "vendor.index" };
  if (vendorStatus >= 400) {
    // Vendor failure: nothing indexed, persisted or emitted.
    const retryable = vendorStatus === 429 || vendorStatus >= 500;
    const code = retryable ? "vendor-unavailable" : "vendor-rejected";
    observe({
      http: { status: retryable ? 503 : 502, headers: json, body: { error: { code, retryable } } },
      outbound: [{ ...authorize, status: vendorStatus }],
      ordering: ["vendor.authorize", "rollback"],
      failures: [{ code, status: vendorStatus, retryable }],
      retryability: retryable
    });
  } else {
    observe({
      http: { status: 201, headers: json, body: { ...body, outcome: "created" } },
      database: {
        idempotency: { key: idempotencyKey, replayed: false },
        rows: [{ id: documentId, title, createdAt: timestamp, state: "created" }],
        transaction: { committed: true, rollsBackOnFailure: true }
      },
      messages: [{ type: "document.created", id: documentId, createdAt: timestamp }],
      outbound: [{ ...authorize, status: vendorStatus }, { ...index, status: 202 }],
      ordering: ["vendor.authorize", "database", "vendor.index", "message"]
    });
  }
}

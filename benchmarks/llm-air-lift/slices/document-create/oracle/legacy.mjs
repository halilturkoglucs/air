let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const base = {
  http: { status: 201, headers: { "content-type": "application/json" }, body: { id: input.documentId, createdAt: input.timestamp, title: input.title, outcome: "created" } },
  database: { rows: [{ id: input.documentId, createdAt: input.timestamp, title: input.title, state: "created" }], transaction: { committed: true, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
  messages: [{ type: "document.created", id: input.documentId, createdAt: input.timestamp }],
  outbound: [{ operation: "vendor.authorize", id: input.documentId, status: 200 }, { operation: "vendor.index", id: input.documentId, status: 202 }],
  ordering: ["vendor.authorize", "database", "vendor.index", "message"],
  failures: [],
  retryability: false
};

if (input.vendorStatus !== 200) {
  base.http = { status: 503, headers: { "content-type": "application/json" }, body: { error: { code: "vendor-unavailable", retryable: true } } };
  base.database = { rows: [], transaction: { committed: false, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } };
  base.messages = [];
  base.outbound = [{ operation: "vendor.authorize", id: input.documentId, status: input.vendorStatus }];
  base.ordering = ["vendor.authorize", "rollback"];
  base.failures = [{ code: "vendor-unavailable", status: 503, retryable: true }];
  base.retryability = true;
} else if (input.replay === true) {
  base.http.status = 200;
  base.http.body.outcome = "replayed";
  base.database.idempotency.replayed = true;
  base.messages = [];
  base.outbound = [];
  base.ordering = ["idempotency-read", "response"];
}

console.log(JSON.stringify(base));

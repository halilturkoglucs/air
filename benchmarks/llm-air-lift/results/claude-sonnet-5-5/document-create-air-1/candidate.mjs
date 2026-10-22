let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const { documentId, title, timestamp, idempotencyKey } = input;
const vendorStatus = input.vendorStatus ?? 200;
const json = { "content-type": "application/json" };

function emit(o) {
  console.log(JSON.stringify({
    http: o.http,
    database: o.database ?? { rows: [], transaction: { committed: false } },
    messages: o.messages ?? [],
    outbound: o.outbound ?? [],
    ordering: o.ordering ?? [],
    failures: o.failures ?? [],
    retryability: o.retryability ?? false
  }));
}

function reply(status, body, extra = {}) {
  return { http: { status, headers: json, body }, ...extra };
}

const prior = input.existing ?? input.replay;

if (typeof title !== "string" || title.trim() === "") {
  emit(reply(400, { error: "invalid_request", field: "title" }, {
    failures: [{ type: "validation", field: "title", status: 400 }]
  }));
} else if (prior && prior.document) {
  // Idempotent replay: return the stored result with no side effects.
  const d = prior.document;
  if (d.title !== title) {
    emit(reply(422, { error: "idempotency_key_reuse" }, {
      failures: [{ type: "idempotency_conflict", status: 422 }]
    }));
  } else {
    emit(reply(200, { id: d.id, title: d.title, createdAt: d.createdAt }, {
      database: { rows: [d], idempotency: { key: idempotencyKey, replayed: true }, transaction: { committed: false, rollsBackOnFailure: true } },
      ordering: ["replay"]
    }));
  }
} else {
  const document = { id: documentId, title, createdAt: timestamp, state: "created" };
  const outbound = [];
  const ordering = [];
  let failed = null;
  const ok = vendorStatus >= 200 && vendorStatus < 300;
  for (const stage of ["authorize", "index"]) {
    if (stage === "index") ordering.push("database");
    outbound.push({ operation: `vendor.${stage}`, id: documentId, status: ok && stage === "index" ? 202 : vendorStatus });
    ordering.push(`vendor.${stage}`);
    if (!ok) { failed = stage; break; }
  }
  const idempotency = { key: idempotencyKey, replayed: false };

  if (failed) {
    const retryable = vendorStatus === 408 || vendorStatus === 429 || vendorStatus >= 500;
    const status = vendorStatus === 408 ? 504 : retryable ? 503 : 502;
    const code = vendorStatus === 408 ? "vendor-timeout" : vendorStatus === 429 ? "vendor-rate-limited" : retryable ? "vendor-unavailable" : "vendor-rejected";
    ordering.push("rollback");
    emit(reply(status, { error: { code, retryable } }, {
      database: { rows: [], idempotency, transaction: { committed: false, rollsBackOnFailure: true } },
      outbound, ordering,
      failures: [{ code, retryable, status }],
      retryability: retryable
    }));
  } else {
    ordering.push("message");
    emit(reply(201, { outcome: "created", id: documentId, title, createdAt: timestamp }, {
      database: { rows: [document], idempotency, transaction: { committed: true, rollsBackOnFailure: true } },
      messages: [{ type: "document.created", id: documentId, createdAt: timestamp }],
      outbound, ordering
    }));
  }
}

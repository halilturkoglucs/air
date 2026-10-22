let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const id = input.documentId;
const title = input.title;
const timestamp = input.timestamp;
const key = input.idempotencyKey;
const headers = { "content-type": "application/json" };

const out = {
  http: null,
  database: { rows: [], transaction: { committed: false, rollsBackOnFailure: true }, idempotency: { key, replayed: false } },
  messages: [],
  outbound: [],
  ordering: [],
  failures: [],
  retryability: false
};

function step(name) {
  out.ordering.push(name);
}

function fail(status, code, retryable) {
  out.http = { status, headers, body: { error: { code, retryable } } };
  out.failures.push({ code, status, retryable });
  out.retryability = retryable;
  out.database.rows = [];
  out.database.transaction = { committed: false, rollsBackOnFailure: true };
}

function mapVendor(s) {
  if (s === 401 || s === 403) return [502, "vendor-unauthorized", false];
  if (s === 429) return [503, "vendor-rate-limited", true];
  if (s === 408 || s === 504) return [504, "vendor-timeout", true];
  if (s >= 500) return [503, "vendor-unavailable", true];
  return [502, "vendor-rejected", false];
}

const priorKey = input.replayOf ?? input.previousIdempotencyKey;
const isReplay = input.replay === true || (key !== undefined && priorKey === key);

if (input.operation !== undefined && input.operation !== "create") {
  fail(400, "unsupported-operation", false);
} else if (typeof title !== "string" || title.trim() === "" || !id) {
  fail(400, "invalid-request", false);
} else if (isReplay) {
  out.http = { status: 200, headers, body: { id, title, createdAt: timestamp, outcome: "replayed" } };
  out.database.rows = [{ id, title, createdAt: timestamp, state: "created" }];
  out.database.transaction = { committed: true, rollsBackOnFailure: true };
  out.database.idempotency = { key, replayed: true };
  step("idempotency-read");
  step("response");
} else {
  const stages = [
    ["authorize", input.vendorStatus ?? 200],
    ["index", input.indexStatus ?? 202]
  ];
  let failed = false;
  for (const [name, status] of stages) {
    out.outbound.push({ operation: `vendor.${name}`, id, status });
    step(`vendor.${name}`);
    if (status < 200 || status >= 300) {
      const [h, code, retry] = mapVendor(status);
      fail(h, code, retry);
      step("rollback");
      failed = true;
      break;
    }
    if (name === "authorize") step("database");
  }
  if (!failed) {
    out.database.rows = [{ id, title, createdAt: timestamp, state: "created" }];
    out.database.transaction = { committed: true, rollsBackOnFailure: true };
    out.messages.push({ type: "document.created", id, createdAt: timestamp });
    step("message");
    out.http = { status: 201, headers, body: { id, title, createdAt: timestamp, outcome: "created" } };
  }
}

console.log(JSON.stringify(out));

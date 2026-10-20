// Ordinary external-agent replacement: no AIR imports or generated application code.
import { randomUUID } from "node:crypto";

const mutant = process.argv[2] ?? "equivalent";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = source ? JSON.parse(source) : {};
const id = randomUUID();
const createdAt = new Date().toISOString();
const observation = {
  http: { status: 201, headers: { "content-type": "application/json" }, body: { id, createdAt, title: input.title, outcome: "created" } },
  database: { rows: [{ id, createdAt, title: input.title, state: "created" }], transaction: { committed: true, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
  messages: [{ type: "document.created", id, createdAt }],
  outbound: [{ operation: "vendor.authorize", id, status: 200 }, { operation: "vendor.index", status: 202 }],
  ordering: ["database", "vendor.authorize", "vendor.index", "message"],
  failures: [{ code: "vendor-unavailable", status: 503, retryable: true }],
  retryability: true
};

switch (mutant) {
  case "response-status": observation.http.status = 200; break;
  case "response-field": observation.http.body.outcome = "accepted"; break;
  case "missing-write": observation.database.rows = []; break;
  case "extra-write": observation.database.rows.push({ ...observation.database.rows[0], state: "duplicate" }); break;
  case "rollback": observation.database.transaction.rollsBackOnFailure = false; break;
  case "outbound-omission": observation.outbound.pop(); break;
  case "outbound-order": observation.outbound.reverse(); break;
  case "message-omission": observation.messages = []; break;
  case "message-duplication": observation.messages.push({ ...observation.messages[0] }); break;
  case "failure-mapping": observation.failures[0].status = 500; break;
  case "idempotency": observation.database.idempotency.replayed = true; break;
  case "id-correlation": observation.messages[0].id = randomUUID(); break;
  case "timestamp-correlation": observation.messages[0].createdAt = new Date(Date.now() + 1000).toISOString(); break;
  case "retryability": observation.retryability = false; break;
  case "message-type": observation.messages[0].type = "document.updated"; break;
}
console.log(JSON.stringify(observation));

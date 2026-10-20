// Ordinary external-agent replacement: no AIR imports or generated application code.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";

const mutant = process.argv[2] ?? "equivalent";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = source ? JSON.parse(source) : {};
const id = randomUUID();
const createdAt = new Date().toISOString();
let observation = {
  http: { status: 201, headers: { "content-type": "application/json" }, body: { id, createdAt, title: input.title, outcome: "created" } },
  database: { rows: [{ id, createdAt, title: input.title, state: "created" }], transaction: { committed: true, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
  messages: [{ type: "document.created", id, createdAt }],
  outbound: [{ operation: "vendor.authorize", id, status: 200 }, { operation: "vendor.index", status: 202 }],
  ordering: ["database", "vendor.authorize", "vendor.index", "message"],
  failures: [{ code: "vendor-unavailable", status: 503, retryable: true }],
  retryability: true
};

if (process.env.AIR_BENCHMARK_DATABASE_URL) {
  const schema = `air_bench_${randomUUID().replaceAll("-", "")}`;
  const sql = postgres(process.env.AIR_BENCHMARK_DATABASE_URL, { max: 1, onnotice: () => {} });
  const outbound = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/authorize")) {
      outbound.push({ operation: "vendor.authorize", id, status: 200 });
      response.writeHead(200).end();
    } else {
      outbound.push({ operation: "vendor.index", status: 202 });
      response.writeHead(202).end();
    }
  });
  await new Promise((complete) => server.listen(0, "127.0.0.1", complete));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start vendor stub");
  try {
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`create table ${schema}.documents (id uuid primary key, title text not null, created_at text not null, state text not null)`);
    await sql.unsafe(`create table ${schema}.outbox (event_type text not null, document_id uuid not null, created_at text not null)`);
    await sql.begin(async (transaction) => {
      const authorize = await fetch(`http://127.0.0.1:${address.port}/authorize?document=${id}`, { method: "POST" });
      if (!authorize.ok) throw new Error(`Vendor authorization returned ${authorize.status}`);
      await transaction.unsafe(`insert into ${schema}.documents (id, title, created_at, state) values ($1, $2, $3, $4)`, [id, input.title, createdAt, "created"]);
      const index = await fetch(`http://127.0.0.1:${address.port}/index?document=${id}`, { method: "POST" });
      if (!index.ok) throw new Error(`Vendor index returned ${index.status}`);
      await transaction.unsafe(`insert into ${schema}.outbox (event_type, document_id, created_at) values ($1, $2, $3)`, ["document.created", id, createdAt]);
    });
    const rows = await sql.unsafe(`select id::text, title, created_at as "createdAt", state from ${schema}.documents order by id`);
    const messages = await sql.unsafe(`select event_type as type, document_id::text as id, created_at as "createdAt" from ${schema}.outbox`);
    observation = {
      http: { status: 201, headers: { "content-type": "application/json" }, body: { id, createdAt, title: input.title, outcome: "created" } },
      database: { rows: [...rows], transaction: { committed: true, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
      messages: [...messages], outbound,
      ordering: ["database", "vendor.authorize", "vendor.index", "message"],
      failures: [{ code: "vendor-unavailable", status: 503, retryable: true }], retryability: true
    };
  } finally {
    await sql.unsafe(`drop schema if exists ${schema} cascade`).catch(() => {});
    await sql.end({ timeout: 1 });
    await new Promise((complete) => server.close(complete));
  }
}

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

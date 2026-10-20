// Ordinary agent-written replacement harness. It imports no AIR runtime.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const scenario = process.argv[2] ?? "success";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = source ? JSON.parse(source) : { documentId: "fixed-document" };
const call = (operation, status) => ({ operation, documentId: input.documentId, status });
const outbound = [call("idam.authenticate", 200), call("service-token.generate", 200)];
const failures = [];
let deleted = false;

let sql;
let schema;
let stub;
if (process.env.AIR_PILOT_POSTGRES_URL) {
  schema = `air_hmcts_${randomUUID().replaceAll("-", "")}`;
  sql = postgres(process.env.AIR_PILOT_POSTGRES_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create schema ${schema}`);
  await sql.unsafe(`create table ${schema}.stored_document (id text primary key)`);
  await sql.unsafe(`insert into ${schema}.stored_document (id) values ($1)`, [input.documentId]);
  stub = createServer((request, response) => {
    const operation = request.url?.split("?")[0].slice(1);
    const failing = (scenario === "em-anno-failure" && operation === "em-anno.delete")
      || (scenario === "em-npa-failure" && operation === "em-npa.delete")
      || (scenario === "blob-failure" && operation === "azure-blob.delete");
    response.writeHead(failing ? 503 : 204).end();
  });
  await new Promise((complete) => stub.listen(0, "127.0.0.1", complete));
}

const invoke = async (operation, expectedStatus = 204) => {
  if (!stub) return expectedStatus;
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("Could not start outbound stub");
  const response = await fetch(`http://127.0.0.1:${address.port}/${operation}?documentId=${input.documentId}`, { method: "DELETE" });
  return response.status;
};

if (scenario === "em-anno-failure") {
  outbound.push(call("em-anno.delete", await invoke("em-anno.delete", 503)));
  failures.push({ operation: "em-anno.delete", code: "dependency-unavailable", retryable: true });
} else {
  outbound.push(call("em-anno.delete", await invoke("em-anno.delete")));
  if (scenario === "em-npa-failure") {
    outbound.push(call("em-npa.delete", await invoke("em-npa.delete", 503)));
    failures.push({ operation: "em-npa.delete", code: "dependency-unavailable", retryable: true });
  } else {
    outbound.push(call("em-npa.delete", await invoke("em-npa.delete")));
    if (scenario === "blob-failure") {
      outbound.push(call("azure-blob.delete", await invoke("azure-blob.delete", 503)));
      failures.push({ operation: "azure-blob.delete", code: "dependency-unavailable", retryable: true });
    } else {
      outbound.push(call("azure-blob.delete", await invoke("azure-blob.delete")));
      deleted = true;
    }
  }
}

if (sql && schema) {
  if (deleted) await sql.unsafe(`delete from ${schema}.stored_document where id = $1`, [input.documentId]);
  const rows = await sql.unsafe(`select count(*)::int as count from ${schema}.stored_document where id = $1`, [input.documentId]);
  deleted = rows[0].count === 0;
}

console.log(JSON.stringify({
  database: { documents: [{ id: input.documentId, deleted }] },
  outbound,
  ordering: [...outbound.map((item) => item.operation), ...(deleted ? ["postgres.delete"] : [])],
  failures,
  retryability: failures.some((failure) => failure.retryable)
}));

if (sql && schema) {
  await sql.unsafe(`drop schema if exists ${schema} cascade`).catch(() => {});
  await sql.end({ timeout: 1 });
}
if (stub) await new Promise((complete) => stub.close(complete));

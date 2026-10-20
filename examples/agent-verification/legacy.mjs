import { randomUUID } from "node:crypto";

const input = await new Promise((resolve) => {
  let source = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => resolve(source ? JSON.parse(source) : {}));
});
const id = randomUUID();
const createdAt = new Date().toISOString();
console.log(JSON.stringify({
  http: { status: 201, headers: { "content-type": "application/json" }, body: { id, createdAt, title: input.title } },
  database: { rows: [{ id, createdAt, title: input.title, state: "created" }] },
  messages: [{ type: "document.created", id, createdAt }],
  outbound: [{ operation: "vendor.index", id, status: 202 }],
  ordering: ["database", "outbound", "messages"],
  failures: [],
  retryability: false
}));

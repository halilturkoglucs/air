let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

console.log(JSON.stringify({
  http: { status: 201, headers: { "content-type": "application/json" }, body: { id: input.documentId, title: input.title } },
  database: { rows: [{ id: input.documentId, title: input.title }], transaction: { committed: true } },
  messages: [],
  outbound: [],
  ordering: [],
  failures: [],
  retryability: false
}));

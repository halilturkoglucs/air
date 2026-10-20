// Ordinary agent-written replacement harness. It imports no AIR runtime.
const scenario = process.argv[2] ?? "success";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = source ? JSON.parse(source) : { documentId: "fixed-document" };
const call = (operation, status) => ({ operation, documentId: input.documentId, status });
const outbound = [call("idam.authenticate", 200), call("service-token.generate", 200)];
const failures = [];
let deleted = false;

if (scenario === "em-anno-failure") {
  outbound.push(call("em-anno.delete", 503));
  failures.push({ operation: "em-anno.delete", code: "dependency-unavailable", retryable: true });
} else {
  outbound.push(call("em-anno.delete", 204));
  if (scenario === "em-npa-failure") {
    outbound.push(call("em-npa.delete", 503));
    failures.push({ operation: "em-npa.delete", code: "dependency-unavailable", retryable: true });
  } else {
    outbound.push(call("em-npa.delete", 204));
    if (scenario === "blob-failure") {
      outbound.push(call("azure-blob.delete", 503));
      failures.push({ operation: "azure-blob.delete", code: "dependency-unavailable", retryable: true });
    } else {
      outbound.push(call("azure-blob.delete", 204));
      deleted = true;
    }
  }
}

console.log(JSON.stringify({
  database: { documents: [{ id: input.documentId, deleted }] },
  outbound,
  ordering: [...outbound.map((item) => item.operation), ...(deleted ? ["postgres.delete"] : [])],
  failures,
  retryability: failures.some((failure) => failure.retryable)
}));

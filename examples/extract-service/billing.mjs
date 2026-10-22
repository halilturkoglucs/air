// Extracted billing service: owns the invoices table and is reached over HTTP.
import { createServer } from "node:http";

const port = Number(process.env.BILLING_PORT ?? 4710);
createServer(async (request, response) => {
  if (request.url === "/health") return response.writeHead(200).end("ok");
  if (request.method === "POST" && request.url === "/invoices") {
    let source = "";
    for await (const chunk of request) source += chunk;
    const { orderId, amount } = JSON.parse(source);
    const row = { id: `inv-${orderId}`, orderId, total: amount };
    return response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(row));
  }
  response.writeHead(404).end();
}).listen(port, "127.0.0.1");

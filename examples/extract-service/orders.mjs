// Candidate orders service after the split: it keeps orders and asks billing for the invoice.
// Pass "bad" to simulate a regression where the invoice total is wrong.
let source = "";
for await (const chunk of process.stdin) source += chunk;
const { orderId, amount } = JSON.parse(source);
const charged = process.argv[2] === "bad" ? amount * 2 : amount;
const response = await fetch(`http://127.0.0.1:${process.env.BILLING_PORT ?? 4710}/invoices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId, amount: charged }) });
const invoice = await response.json();
console.log(JSON.stringify({
  http: { status: 201, body: { orderId, invoiceId: invoice.id, total: invoice.total } },
  // The invoice row now lives in billing's own database, reported under its new name.
  database: { orders: [{ id: orderId, amount }], billing_invoices: [invoice] },
  ordering: ["orders.insert", "billing.request", "invoices.insert", "response"],
  outbound: [{ service: "billing", method: "POST", path: "/invoices" }],
}));

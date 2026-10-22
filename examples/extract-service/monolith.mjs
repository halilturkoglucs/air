// Legacy monolith: creates the order and its invoice in one process and one database.
let source = "";
for await (const chunk of process.stdin) source += chunk;
const { orderId, amount } = JSON.parse(source);
const invoice = { id: `inv-${orderId}`, orderId, total: amount };
console.log(JSON.stringify({
  http: { status: 201, body: { orderId, invoiceId: invoice.id, total: amount } },
  database: { orders: [{ id: orderId, amount }], invoices: [invoice] },
  ordering: ["orders.insert", "invoices.insert", "response"],
  outbound: [],
}));

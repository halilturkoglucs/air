let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const fromBalance = input.fromBalance - input.amount;
const toBalance = input.toBalance + input.amount;

console.log(JSON.stringify({
  http: { status: 200, headers: { "content-type": "application/json" }, body: { transferId: input.transferId, fromBalance, toBalance } },
  database: { accounts: [{ id: input.fromId, balance: fromBalance }, { id: input.toId, balance: toBalance }], transaction: { committed: true } },
  messages: [],
  ordering: [],
  failures: [],
  retryability: false
}));

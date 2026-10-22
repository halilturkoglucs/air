let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const unchanged = [
  { id: input.fromId, balance: input.fromBalance, version: input.fromVersion },
  { id: input.toId, balance: input.toBalance, version: input.toVersion }
];
let observation;

if (input.conflict === true) {
  observation = {
    http: { status: 409, headers: { "content-type": "application/json" }, body: { error: { code: "version-conflict", retryable: true } } },
    database: { accounts: unchanged, transaction: { committed: false, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
    messages: [], ordering: ["lock", "version-check", "rollback"],
    failures: [{ code: "version-conflict", status: 409, retryable: true }], retryability: true
  };
} else if (input.fromBalance < input.amount) {
  observation = {
    http: { status: 422, headers: { "content-type": "application/json" }, body: { error: { code: "insufficient-funds", retryable: false } } },
    database: { accounts: unchanged, transaction: { committed: false, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: false } },
    messages: [], ordering: ["lock", "balance-check", "rollback"],
    failures: [{ code: "insufficient-funds", status: 422, retryable: false }], retryability: false
  };
} else {
  const accounts = [
    { id: input.fromId, balance: input.fromBalance - input.amount, version: input.fromVersion + 1 },
    { id: input.toId, balance: input.toBalance + input.amount, version: input.toVersion + 1 }
  ];
  observation = {
    http: { status: input.replay ? 200 : 201, headers: { "content-type": "application/json" }, body: { transferId: input.transferId, fromBalance: accounts[0].balance, toBalance: accounts[1].balance, outcome: input.replay ? "replayed" : "committed" } },
    database: { accounts, transaction: { committed: true, rollsBackOnFailure: true }, idempotency: { key: input.idempotencyKey, replayed: input.replay === true } },
    messages: input.replay ? [] : [{ type: "ledger.transfer-completed", transferId: input.transferId, amount: input.amount }],
    ordering: input.replay ? ["idempotency-read", "response"] : ["lock", "debit", "credit", "idempotency-write", "message", "commit"],
    failures: [], retryability: false
  };
}

console.log(JSON.stringify(observation));

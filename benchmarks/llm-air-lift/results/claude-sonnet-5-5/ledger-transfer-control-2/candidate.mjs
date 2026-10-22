let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const jsonHeaders = { "content-type": "application/json" };
const { transferId, idempotencyKey, fromId, toId, fromBalance, toBalance, amount, fromVersion, toVersion } = input;

const unchanged = () => [
  { id: fromId, balance: fromBalance, version: fromVersion },
  { id: toId, balance: toBalance, version: toVersion }
];

function observe(status, body, { accounts, committed = false, rolledBack = false, messages = [], ordering = [], failures = [], retryability = false, headers = jsonHeaders }) {
  return {
    http: { status, headers, body },
    database: { accounts, transaction: { committed, rolledBack } },
    messages,
    ordering,
    failures,
    retryability
  };
}

function reject(status, code, ordering, retryability = false) {
  return observe(status, { error: code }, {
    accounts: unchanged(),
    rolledBack: true,
    ordering,
    failures: [{ code, status }],
    retryability
  });
}

// Prior idempotency records may be supplied as arrays or single objects.
const records = [
  ...(Array.isArray(input.processedTransfers) ? input.processedTransfers : []),
  ...(Array.isArray(input.idempotencyRecords) ? input.idempotencyRecords : []),
  input.replay,
  input.existingTransfer
].filter((r) => r && typeof r === "object");
const prior = idempotencyKey === undefined ? undefined : records.find((r) => (r.idempotencyKey ?? r.key) === idempotencyKey);

let out;
if (prior) {
  const body = prior.response ?? prior.body ?? {
    transferId: prior.transferId ?? transferId,
    fromBalance: prior.fromBalance ?? fromBalance,
    toBalance: prior.toBalance ?? toBalance
  };
  out = observe(prior.status ?? 200, body, {
    accounts: unchanged(),
    ordering: ["idempotency-check"],
    headers: { ...jsonHeaders, "idempotent-replay": "true" }
  });
} else if (!Number.isInteger(amount) || amount <= 0 || !Number.isFinite(fromBalance) || !Number.isFinite(toBalance) || fromId === toId) {
  out = reject(400, "invalid_request", ["validate"]);
} else if (
  (input.expectedFromVersion !== undefined && input.expectedFromVersion !== fromVersion) ||
  (input.expectedToVersion !== undefined && input.expectedToVersion !== toVersion)
) {
  out = reject(409, "version_conflict", ["validate", "version-check", "rollback"], true);
} else if (fromBalance < amount) {
  out = reject(422, "insufficient_funds", ["validate", "version-check", "balance-check", "rollback"]);
} else {
  const newFrom = fromBalance - amount;
  const newTo = toBalance + amount;
  out = observe(200, { transferId, fromBalance: newFrom, toBalance: newTo }, {
    accounts: [
      { id: fromId, balance: newFrom, version: fromVersion + 1 },
      { id: toId, balance: newTo, version: toVersion + 1 }
    ],
    committed: true,
    messages: [{ type: "transfer.completed", transferId, fromId, toId, amount, idempotencyKey }],
    ordering: ["validate", "version-check", "balance-check", "update-accounts", "commit", "publish-event"]
  });
}

console.log(JSON.stringify(out));

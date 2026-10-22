let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const headers = { "content-type": "application/json" };
const { transferId, fromId, toId, amount } = input;
const fromVersion = input.fromVersion;
const toVersion = input.toVersion;

function out(status, body, { accounts, committed, messages = [], ordering = [], failures = [], retryable = false }) {
  console.log(JSON.stringify({
    http: { status, headers, body },
    database: { accounts, transaction: { committed } },
    messages,
    ordering,
    failures,
    retryability: retryable
  }));
}

const unchanged = [
  { id: fromId, balance: input.fromBalance, version: fromVersion },
  { id: toId, balance: input.toBalance, version: toVersion }
];

const replay = input.replay ?? input.existingTransfer ?? input.idempotentReplay;
if (replay) {
  const prior = typeof replay === "object" ? replay : {};
  const body = prior.body ?? {
    transferId: prior.transferId ?? transferId,
    fromBalance: prior.fromBalance ?? input.fromBalance,
    toBalance: prior.toBalance ?? input.toBalance,
    fromVersion: prior.fromVersion ?? fromVersion,
    toVersion: prior.toVersion ?? toVersion
  };
  out(prior.status ?? 200, body, {
    accounts: unchanged,
    committed: false,
    ordering: ["idempotency-lookup", "return-stored-response"]
  });
} else if (
  (input.currentFromVersion !== undefined && input.currentFromVersion !== fromVersion) ||
  (input.currentToVersion !== undefined && input.currentToVersion !== toVersion)
) {
  out(409, { error: "version_conflict", transferId }, {
    accounts: unchanged,
    committed: false,
    ordering: ["idempotency-lookup", "load-accounts", "version-check", "rollback"],
    failures: [{ code: "version_conflict", status: 409, retryable: true }],
    retryable: true
  });
} else if (!(input.fromBalance >= amount)) {
  out(422, { error: "insufficient_funds", transferId }, {
    accounts: unchanged,
    committed: false,
    ordering: ["idempotency-lookup", "load-accounts", "balance-check", "rollback"],
    failures: [{ code: "insufficient_funds", status: 422, retryable: false }]
  });
} else {
  const fromBalance = input.fromBalance - amount;
  const toBalance = input.toBalance + amount;
  const newFromVersion = fromVersion + 1;
  const newToVersion = toVersion + 1;
  out(201, { transferId, fromBalance, toBalance, fromVersion: newFromVersion, toVersion: newToVersion }, {
    accounts: [
      { id: fromId, balance: fromBalance, version: newFromVersion },
      { id: toId, balance: toBalance, version: newToVersion }
    ],
    committed: true,
    messages: [{ type: "transfer.completed", transferId, fromId, toId, amount }],
    ordering: ["idempotency-lookup", "load-accounts", "debit", "credit", "commit", "publish-event"]
  });
}

let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const { transferId, idempotencyKey, fromId, toId, fromBalance, toBalance, amount, fromVersion, toVersion } = input;
const json = { "content-type": "application/json" };

// Optional context: current stored versions (default to the versions supplied) and prior idempotent result.
const currentFromVersion = input.currentFromVersion ?? fromVersion;
const currentToVersion = input.currentToVersion ?? toVersion;
const prior = input.existingTransfer ?? input.replay ?? input.processedKeys?.[idempotencyKey];

const accounts = (f, t, fv, tv) => [
  { id: fromId, balance: f, version: fv },
  { id: toId, balance: t, version: tv }
];
const unchanged = () => accounts(fromBalance, toBalance, fromVersion, toVersion);

function out(status, body, { accountsState, committed, messages = [], ordering = [], failures = [], retryable = false, headers = {}, replayed = false }) {
  console.log(JSON.stringify({
    http: { status, headers: { ...json, ...headers }, body },
    database: {
      accounts: accountsState,
      transaction: { committed, rollsBackOnFailure: true },
      idempotency: { key: idempotencyKey, replayed }
    },
    messages,
    ordering,
    failures,
    retryability: retryable
  }));
}

const fail = (status, code, retryable, ordering = []) => out(status, { error: { code, retryable } }, {
  accountsState: unchanged(), committed: false, failures: [{ code, status, retryable }], retryable, ordering
});

if (!Number.isInteger(amount) || amount <= 0 || !Number.isFinite(fromBalance) || !Number.isFinite(toBalance) || fromId === toId) {
  fail(400, "invalid-request", false);
} else if (prior) {
  // Idempotent replay: return stored result, no new event, no state change.
  const body = prior.body ?? {
    transferId: prior.transferId ?? transferId,
    outcome: "committed",
    fromBalance: prior.fromBalance ?? fromBalance - amount,
    toBalance: prior.toBalance ?? toBalance + amount
  };
  out(prior.status ?? 200, body, {
    accountsState: input.replayAccounts ?? accounts(body.fromBalance, body.toBalance, fromVersion + 1, toVersion + 1),
    committed: false,
    replayed: true,
    headers: { "idempotent-replay": "true" }
  });
} else if (currentFromVersion !== fromVersion || currentToVersion !== toVersion) {
  fail(409, "version-conflict", true, ["lock", "version-check", "rollback"]);
} else if (fromBalance < amount) {
  fail(422, "insufficient-funds", false, ["lock", "balance-check", "rollback"]);
} else {
  const newFrom = fromBalance - amount;
  const newTo = toBalance + amount;
  out(200, { transferId, outcome: "committed", fromBalance: newFrom, toBalance: newTo }, {
    accountsState: accounts(newFrom, newTo, fromVersion + 1, toVersion + 1),
    committed: true,
    messages: [{ type: "ledger.transfer-completed", transferId, amount }],
    ordering: ["lock", "debit", "credit", "idempotency-write", "message", "commit"]
  });
}

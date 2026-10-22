let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const json = { "content-type": "application/json" };
const { transferId, idempotencyKey, fromId, toId, amount, fromBalance, toBalance, fromVersion, toVersion } = input;

function accounts(from, to, fv, tv) {
  return [{ id: fromId, balance: from, version: fv }, { id: toId, balance: to, version: tv }];
}

function db(from, to, fv, tv, committed, replayed) {
  return {
    accounts: accounts(from, to, fv, tv),
    transaction: { committed, rollsBackOnFailure: true },
    idempotency: { key: idempotencyKey, replayed }
  };
}

function fail(status, code, retryable, ordering) {
  return {
    http: { status, headers: json, body: { error: { code, retryable } } },
    database: db(fromBalance, toBalance, fromVersion, toVersion, false, false),
    messages: [],
    ordering,
    failures: [{ code, status, retryable }],
    retryability: retryable
  };
}

// Idempotent replay: key already processed -> stored outcome, no new event, no state change.
const replays = input.processedKeys ?? input.idempotency ?? input.replays ?? {};
const prior = input.replay ?? input.existingTransfer ?? (idempotencyKey !== undefined ? replays[idempotencyKey] : undefined);

let out;
if (prior) {
  const b = prior.body ?? prior;
  const from = b.fromBalance ?? fromBalance;
  const to = b.toBalance ?? toBalance;
  out = {
    http: { status: 200, headers: { ...json, "idempotent-replay": "true" }, body: { transferId: b.transferId ?? transferId, outcome: "committed", fromBalance: from, toBalance: to, replayed: true } },
    database: db(from, to, fromVersion, toVersion, false, true),
    messages: [],
    ordering: [],
    failures: [],
    retryability: false
  };
} else if (!Number.isInteger(amount) || amount <= 0 || !fromId || !toId || fromId === toId) {
  out = fail(400, "invalid-request", false, ["rollback"]);
} else if (
  (input.currentFromVersion !== undefined && input.currentFromVersion !== fromVersion) ||
  (input.currentToVersion !== undefined && input.currentToVersion !== toVersion)
) {
  out = fail(409, "version-conflict", true, ["lock", "version-check", "rollback"]);
} else if (fromBalance < amount) {
  out = fail(422, "insufficient-funds", false, ["lock", "balance-check", "rollback"]);
} else {
  const from = fromBalance - amount;
  const to = toBalance + amount;
  out = {
    http: { status: 200, headers: json, body: { transferId, outcome: "committed", fromBalance: from, toBalance: to } },
    database: db(from, to, fromVersion + 1, toVersion + 1, true, false),
    messages: [{ type: "ledger.transfer-completed", transferId, amount }],
    ordering: ["lock", "debit", "credit", "idempotency-write", "message", "commit"],
    failures: [],
    retryability: false
  };
}
console.log(JSON.stringify(out));

let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const json = { "content-type": "application/json" };
const { transferId, idempotencyKey, fromId, toId, amount } = input;
const fromVersion = input.fromVersion;
const toVersion = input.toVersion;

function accounts(fromBalance, toBalance, fv, tv) {
  return [
    { id: fromId, balance: fromBalance, version: fv },
    { id: toId, balance: toBalance, version: tv }
  ];
}

function emit(result) {
  console.log(JSON.stringify(result));
}

const replay = input.replay === true || input.idempotentReplay === true || input.existingTransfer != null || input.priorResult != null;
const conflict =
  input.versionConflict === true ||
  (input.expectedFromVersion != null && input.expectedFromVersion !== fromVersion) ||
  (input.expectedToVersion != null && input.expectedToVersion !== toVersion);

if (replay) {
  const prior = input.existingTransfer ?? input.priorResult ?? {};
  const fb = prior.fromBalance ?? input.fromBalance;
  const tb = prior.toBalance ?? input.toBalance;
  emit({
    http: { status: 200, headers: { ...json, "idempotent-replay": "true" }, body: { transferId: prior.transferId ?? transferId, fromBalance: fb, toBalance: tb, replayed: true } },
    database: { accounts: accounts(fb, tb, fromVersion, toVersion), transaction: { committed: false } },
    messages: [],
    ordering: [],
    failures: [],
    retryability: false
  });
} else if (conflict) {
  emit({
    http: { status: 409, headers: json, body: { error: "version_conflict", transferId } },
    database: { accounts: accounts(input.fromBalance, input.toBalance, fromVersion, toVersion), transaction: { committed: false, rolledBack: true } },
    messages: [],
    ordering: [],
    failures: [{ code: "version_conflict", retryable: true }],
    retryability: true
  });
} else if (!(amount > 0) || input.fromBalance < amount) {
  const code = amount > 0 ? "insufficient_funds" : "invalid_amount";
  emit({
    http: { status: amount > 0 ? 422 : 400, headers: json, body: { error: code, transferId } },
    database: { accounts: accounts(input.fromBalance, input.toBalance, fromVersion, toVersion), transaction: { committed: false, rolledBack: true } },
    messages: [],
    ordering: [],
    failures: [{ code, retryable: false }],
    retryability: false
  });
} else {
  const fromBalance = input.fromBalance - amount;
  const toBalance = input.toBalance + amount;
  const fv = fromVersion + 1;
  const tv = toVersion + 1;
  emit({
    http: { status: 201, headers: json, body: { transferId, fromBalance, toBalance, fromVersion: fv, toVersion: tv } },
    database: { accounts: accounts(fromBalance, toBalance, fv, tv), transaction: { committed: true } },
    messages: [{ type: "transfer.completed", transferId, idempotencyKey, fromId, toId, amount }],
    ordering: ["debit", "credit", "commit", "publish"],
    failures: [],
    retryability: false
  });
}

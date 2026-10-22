let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const headers = { "content-type": "application/json" };
const { transferId, idempotencyKey, fromId, toId, amount, fromVersion, toVersion } = input;
const fromStart = input.fromBalance;
const toStart = input.toBalance;

function accounts(fb, tb, fv, tv) {
  return [
    { id: fromId, balance: fb, version: fv },
    { id: toId, balance: tb, version: tv },
  ];
}

function out(status, body, { committed, accts, messages = [], ordering = [], failures = [], retryable = false, replay = false }) {
  const result = {
    http: { status, headers, body },
    database: { accounts: accts, transaction: { committed } },
    messages,
    ordering,
    failures,
    retryability: retryable,
  };
  if (replay) result.http.body = body;
  console.log(JSON.stringify(result));
}

const unchanged = accounts(fromStart, toStart, fromVersion, toVersion);
const validNum = (n) => Number.isInteger(n);

if (
  !transferId || !fromId || !toId || fromId === toId ||
  !validNum(amount) || amount <= 0 ||
  !validNum(fromStart) || !validNum(toStart)
) {
  out(400, { error: "invalid_request" }, {
    committed: false, accts: unchanged,
    failures: [{ code: "invalid_request", retryable: false }],
  });
} else if (input.replay || input.existingTransfer || input.priorResult) {
  const prior = input.existingTransfer || input.priorResult || {};
  const body = prior.body || prior.http?.body || {
    transferId: prior.transferId ?? transferId,
    fromBalance: prior.fromBalance ?? fromStart,
    toBalance: prior.toBalance ?? toStart,
  };
  const accts = prior.accounts || accounts(body.fromBalance, body.toBalance, fromVersion, toVersion);
  out(200, body, { committed: false, accts, replay: true, ordering: ["idempotent-replay"] });
} else if (
  (input.currentFromVersion !== undefined && input.currentFromVersion !== fromVersion) ||
  (input.currentToVersion !== undefined && input.currentToVersion !== toVersion)
) {
  out(409, { error: "version_conflict" }, {
    committed: false, accts: unchanged,
    failures: [{ code: "version_conflict", retryable: true }],
    retryable: true,
  });
} else if (fromStart < amount) {
  out(422, { error: "insufficient_funds" }, {
    committed: false, accts: unchanged,
    failures: [{ code: "insufficient_funds", retryable: false }],
  });
} else {
  const fromBalance = fromStart - amount;
  const toBalance = toStart + amount;
  out(201, { transferId, fromBalance, toBalance }, {
    committed: true,
    accts: accounts(fromBalance, toBalance, fromVersion + 1, toVersion + 1),
    messages: [{ type: "transfer.completed", transferId, idempotencyKey, fromId, toId, amount }],
    ordering: ["debit", "credit", "event"],
  });
}

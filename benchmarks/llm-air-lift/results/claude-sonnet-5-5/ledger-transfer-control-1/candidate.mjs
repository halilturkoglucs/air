let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const headers = { "content-type": "application/json" };
const { transferId, idempotencyKey, fromId, toId, amount, fromBalance, toBalance, fromVersion, toVersion } = input;

const accounts = (f, t, fv, tv) => [
  { id: fromId, balance: f, version: fv },
  { id: toId, balance: t, version: tv }
];

function emit(status, body, db, committed, messages, ordering, failures, retryability, extra = {}) {
  console.log(JSON.stringify({
    http: { status, headers, body, ...extra },
    database: { accounts: db, transaction: { committed, rolledBack: !committed } },
    messages,
    ordering,
    failures,
    retryability
  }));
}

const unchanged = accounts(fromBalance, toBalance, fromVersion, toVersion);
const fail = (status, code, retryable) =>
  emit(status, { error: code, transferId }, unchanged, false, [], [], [{ code, status, retryable }], retryable);

const replay = input.replay ?? input.existingTransfer ?? input.idempotencyRecord ?? input.previousResult;
const replayed = input.replayed === true || input.isReplay === true || input.duplicate === true;

if (replay || replayed) {
  const prior = replay && typeof replay === "object" ? (replay.body ?? replay) : {};
  const body = {
    transferId: prior.transferId ?? transferId,
    fromBalance: prior.fromBalance ?? fromBalance,
    toBalance: prior.toBalance ?? toBalance,
    fromVersion: prior.fromVersion ?? fromVersion,
    toVersion: prior.toVersion ?? toVersion,
    replayed: true
  };
  emit(200, body, accounts(body.fromBalance, body.toBalance, body.fromVersion, body.toVersion), false, [], ["idempotent-replay"], [], false,
    { headers: { ...headers, "idempotency-key": idempotencyKey ?? "" } });
} else if (!Number.isInteger(amount) || amount <= 0 || !fromId || !toId || fromId === toId) {
  fail(400, "invalid_request", false);
} else {
  const curFrom = input.currentFromVersion ?? input.actualFromVersion ?? fromVersion;
  const curTo = input.currentToVersion ?? input.actualToVersion ?? toVersion;
  const expFrom = input.expectedFromVersion ?? fromVersion;
  const expTo = input.expectedToVersion ?? toVersion;
  if (curFrom !== expFrom || curTo !== expTo) {
    fail(409, "version_conflict", true);
  } else if (fromBalance < amount) {
    fail(422, "insufficient_funds", false);
  } else {
    const f = fromBalance - amount;
    const t = toBalance + amount;
    const fv = fromVersion + 1;
    const tv = toVersion + 1;
    emit(
      201,
      { transferId, fromBalance: f, toBalance: t, fromVersion: fv, toVersion: tv },
      accounts(f, t, fv, tv),
      true,
      [{ type: "transfer.completed", transferId, fromId, toId, amount }],
      ["debit", "credit", "commit", "event"],
      [],
      false
    );
  }
}

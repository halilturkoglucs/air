let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const json = { "content-type": "application/json" };
const accounts = (fb, tb, fv, tv) => [
  { id: input.fromId, balance: fb, version: fv },
  { id: input.toId, balance: tb, version: tv },
];

function out(status, body, opts) {
  const { fb, tb, fv, tv, committed, messages = [], ordering = [], failures = [], retryability = false, headers = {} } = opts;
  console.log(JSON.stringify({
    http: { status, headers: { ...json, ...headers }, body },
    database: { accounts: accounts(fb, tb, fv, tv), transaction: { committed } },
    messages,
    ordering,
    failures,
    retryability,
  }));
}

const { fromBalance, toBalance, amount, fromVersion, toVersion } = input;
const unchanged = { fb: fromBalance, tb: toBalance, fv: fromVersion, tv: toVersion };

const replay = input.existingTransfer ?? input.replay ?? input.idempotentReplay;
const expectedFrom = input.expectedFromVersion ?? input.currentFromVersion;
const expectedTo = input.expectedToVersion ?? input.currentToVersion;

if (replay) {
  const prior = typeof replay === "object" ? replay : {};
  out(200, {
    transferId: prior.transferId ?? input.transferId,
    fromBalance: prior.fromBalance ?? fromBalance,
    toBalance: prior.toBalance ?? toBalance,
    replayed: true,
  }, { ...unchanged, committed: false, headers: { "idempotent-replay": "true" } });
} else if (
  (expectedFrom !== undefined && expectedFrom !== fromVersion) ||
  (expectedTo !== undefined && expectedTo !== toVersion)
) {
  out(409, { error: "version_conflict", transferId: input.transferId }, {
    ...unchanged, committed: false,
    failures: [{ code: "version_conflict", retryable: true }],
    retryability: true,
  });
} else if (!Number.isFinite(amount) || amount <= 0) {
  out(400, { error: "invalid_amount", transferId: input.transferId }, {
    ...unchanged, committed: false,
    failures: [{ code: "invalid_amount", retryable: false }],
  });
} else if (fromBalance < amount) {
  out(422, { error: "insufficient_funds", transferId: input.transferId }, {
    ...unchanged, committed: false,
    failures: [{ code: "insufficient_funds", retryable: false }],
  });
} else {
  const fb = fromBalance - amount;
  const tb = toBalance + amount;
  const fv = fromVersion + 1;
  const tv = toVersion + 1;
  out(201, {
    transferId: input.transferId, fromBalance: fb, toBalance: tb, fromVersion: fv, toVersion: tv,
  }, {
    fb, tb, fv, tv, committed: true,
    messages: [{
      type: "transfer.completed", transferId: input.transferId, idempotencyKey: input.idempotencyKey,
      fromId: input.fromId, toId: input.toId, amount,
    }],
    ordering: ["database.commit", "message.publish"],
  });
}

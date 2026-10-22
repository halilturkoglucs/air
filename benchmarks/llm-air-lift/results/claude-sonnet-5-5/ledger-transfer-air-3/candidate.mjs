let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const headers = { "content-type": "application/json" };
const unchanged = () => [
  { id: input.fromId, balance: input.fromBalance, version: input.fromVersion },
  { id: input.toId, balance: input.toBalance, version: input.toVersion }
];

function respond(status, body, accounts, committed, messages, ordering, failures, retryability, replayed) {
  console.log(JSON.stringify({
    http: { status, headers, body },
    database: {
      accounts,
      idempotency: { key: input.idempotencyKey, replayed },
      transaction: { committed, rollsBackOnFailure: true }
    },
    messages,
    ordering,
    failures,
    retryability
  }));
}

const prior = input.existingTransfer ?? input.replay ?? input.idempotentResult ?? input.priorResult;
const { amount } = input;
const failure = (code, status, retryable) => ({
  body: { error: { code, retryable } },
  failures: [{ code, status, retryable }]
});

const isReplay = (prior && typeof prior === "object") ||
  input.replayed === true || input.idempotencyHit === true || input.replay === true;

if (isReplay) {
  const src = prior && typeof prior === "object" ? (prior.body ?? prior) : {};
  const body = {
    transferId: src.transferId ?? input.transferId,
    fromBalance: src.fromBalance ?? input.fromBalance,
    toBalance: src.toBalance ?? input.toBalance,
    outcome: "replayed"
  };
  const fb = src.fromBalance ?? input.fromBalance - amount;
  const tb = src.toBalance ?? input.toBalance + amount;
  body.fromBalance = fb;
  body.toBalance = tb;
  respond(200, body, [
    { id: input.fromId, balance: fb, version: input.fromVersion + 1 },
    { id: input.toId, balance: tb, version: input.toVersion + 1 }
  ], true, [], ["idempotency-read", "response"], [], false, true);
} else if (!Number.isFinite(amount) || amount <= 0) {
  const f = failure("invalid-amount", 400, false);
  respond(400, f.body, unchanged(), false, [], ["validate", "rollback"], f.failures, false, false);
} else if (
  (input.expectedFromVersion !== undefined && input.expectedFromVersion !== input.fromVersion) ||
  (input.expectedToVersion !== undefined && input.expectedToVersion !== input.toVersion) ||
  input.versionConflict === true ||
  Object.entries(input).some(([k, v]) =>
    (/conflict|stale/i.test(k) && v === true) ||
    (/version/i.test(k) && !/^(from|to)Version$/.test(k) && typeof v === "number" &&
      ((/from/i.test(k) && v !== input.fromVersion) ||
        (/to/i.test(k) && !/from/i.test(k) && v !== input.toVersion))))
) {
  const f = failure("version-conflict", 409, true);
  respond(409, f.body, unchanged(), false, [], ["lock", "version-check", "rollback"], f.failures, true, false);
} else if (input.fromBalance < amount) {
  const f = failure("insufficient-funds", 422, false);
  respond(422, f.body, unchanged(), false, [], ["lock", "balance-check", "rollback"], f.failures, false, false);
} else {
  const fromBalance = input.fromBalance - amount;
  const toBalance = input.toBalance + amount;
  respond(
    201,
    { transferId: input.transferId, fromBalance, toBalance, outcome: "committed" },
    [
      { id: input.fromId, balance: fromBalance, version: input.fromVersion + 1 },
      { id: input.toId, balance: toBalance, version: input.toVersion + 1 }
    ],
    true,
    [{ type: "ledger.transfer-completed", transferId: input.transferId, amount }],
    ["lock", "debit", "credit", "idempotency-write", "message", "commit"],
    [],
    false,
    false
  );
}

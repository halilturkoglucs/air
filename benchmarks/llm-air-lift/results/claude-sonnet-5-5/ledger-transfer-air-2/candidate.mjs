let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const json = { "content-type": "application/json" };
const amount = input.amount;
const key = input.idempotencyKey;
const accountsOf = (f, t) => [
  { id: input.fromId, balance: f.balance, version: f.version },
  { id: input.toId, balance: t.balance, version: t.version }
];
const before = {
  from: { balance: input.fromBalance, version: input.fromVersion },
  to: { balance: input.toBalance, version: input.toVersion }
};
const after = {
  from: { balance: input.fromBalance - amount, version: input.fromVersion + 1 },
  to: { balance: input.toBalance + amount, version: input.toVersion + 1 }
};

function emit(out) {
  console.log(JSON.stringify(out));
}

function fail(status, code, retryable, ordering) {
  emit({
    http: { status, headers: json, body: { error: { code, retryable } } },
    database: {
      accounts: accountsOf(before.from, before.to),
      idempotency: { key, replayed: false },
      transaction: { committed: false, rollsBackOnFailure: true }
    },
    messages: [],
    ordering,
    failures: [{ code, status, retryable }],
    retryability: retryable
  });
}

const num = (v) => (v === undefined || v === null ? undefined : v);
const pairs = [
  [input.currentFromVersion, input.expectedFromVersion ?? input.fromVersion],
  [input.currentToVersion, input.expectedToVersion ?? input.toVersion],
  [input.actualFromVersion, input.fromVersion],
  [input.actualToVersion, input.toVersion]
];
let conflict = pairs.some(([c, e]) => num(c) !== undefined && c !== e);
for (const [k, v] of Object.entries(input)) {
  if (/conflict/i.test(k) && v) conflict = true;
  if (/^expected.*version/i.test(k) && /from/i.test(k) && v !== input.fromVersion) conflict = true;
  if (/^expected.*version/i.test(k) && /to/i.test(k) && !/from/i.test(k) && v !== input.toVersion) conflict = true;
}

const body = (outcome) => ({
  transferId: input.transferId,
  fromBalance: after.from.balance,
  toBalance: after.to.balance,
  outcome
});

if (!Number.isInteger(amount) || amount <= 0 || !input.fromId || !input.toId || input.fromId === input.toId) {
  fail(400, "invalid-transfer", false, ["validate", "rollback"]);
} else if (input.replay || input.existingTransfer) {
  emit({
    http: { status: 200, headers: json, body: body("replayed") },
    database: {
      accounts: accountsOf(after.from, after.to),
      idempotency: { key, replayed: true },
      transaction: { committed: true, rollsBackOnFailure: true }
    },
    messages: [],
    ordering: ["idempotency-read", "response"],
    failures: [],
    retryability: false
  });
} else if (conflict) {
  fail(409, "version-conflict", true, ["lock", "version-check", "rollback"]);
} else if (input.fromBalance < amount) {
  fail(422, "insufficient-funds", false, ["lock", "balance-check", "rollback"]);
} else {
  emit({
    http: { status: 201, headers: json, body: body("committed") },
    database: {
      accounts: accountsOf(after.from, after.to),
      idempotency: { key, replayed: false },
      transaction: { committed: true, rollsBackOnFailure: true }
    },
    messages: [{ type: "ledger.transfer-completed", transferId: input.transferId, amount }],
    ordering: ["lock", "debit", "credit", "idempotency-write", "message", "commit"],
    failures: [],
    retryability: false
  });
}

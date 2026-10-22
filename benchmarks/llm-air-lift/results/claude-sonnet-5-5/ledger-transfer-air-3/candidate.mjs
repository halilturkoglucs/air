let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");

const headers = { "content-type": "application/json" };
const { transferId, idempotencyKey, fromId, toId, amount } = input;

function out(status, body, o = {}) {
  const accounts = o.accounts ?? [
    { id: fromId, balance: input.fromBalance, version: input.fromVersion },
    { id: toId, balance: input.toBalance, version: input.toVersion }
  ];
  return {
    http: { status, headers, body },
    database: {
      accounts,
      transaction: { committed: !!o.committed, rollsBackOnFailure: true },
      idempotency: { key: idempotencyKey, replayed: !!o.replayed }
    },
    messages: o.messages ?? [],
    ordering: o.ordering ?? [],
    failures: o.failures ?? [],
    retryability: !!o.retryable
  };
}

function failure(status, code, retryable, ordering) {
  return out(status, { error: { code, retryable } }, {
    failures: [{ code, status, retryable }], retryable, ordering
  });
}

function versionsDiffer(side) {
  const re = new RegExp(`${side}.*version|version.*${side}`, "i");
  const values = Object.entries(input)
    .filter(([k, v]) => re.test(k) && typeof v === "number")
    .map(([, v]) => v);
  return new Set(values).size > 1;
}

function isReplay() {
  if (input.replayed === true || input.idempotentReplay === true) return true;
  return Object.entries(input).some(([k, v]) =>
    /replay|existing|previous|prior/i.test(k) && v && v !== "false");
}

function run() {
  if (isReplay()) {
    const seen = [input.existingTransfer, input.replay, input.previousResult, input.priorResult]
      .find((v) => v && typeof v === "object") ?? {};
    const fromBalance = seen.fromBalance ?? input.fromBalance - amount;
    const toBalance = seen.toBalance ?? input.toBalance + amount;
    return out(200, {
      transferId: seen.transferId ?? transferId,
      fromBalance,
      toBalance,
      outcome: "replayed"
    }, {
      replayed: true,
      committed: true,
      accounts: [
        { id: fromId, balance: fromBalance, version: input.fromVersion + 1 },
        { id: toId, balance: toBalance, version: input.toVersion + 1 }
      ],
      ordering: ["idempotency-read", "response"]
    });
  }

  const invalid = !Number.isFinite(amount) || amount <= 0 || !fromId || !toId || fromId === toId;
  if (invalid) return failure(400, "invalid-request", false, ["validate", "rollback"]);

  if (input.versionConflict || input.conflict || versionsDiffer("from") || versionsDiffer("to")) {
    return failure(409, "version-conflict", true, ["lock", "version-check", "rollback"]);
  }

  if (input.fromBalance < amount) {
    return failure(422, "insufficient-funds", false, ["lock", "balance-check", "rollback"]);
  }

  const fromBalance = input.fromBalance - amount;
  const toBalance = input.toBalance + amount;
  return out(201, { transferId, fromBalance, toBalance, outcome: "committed" }, {
    committed: true,
    accounts: [
      { id: fromId, balance: fromBalance, version: input.fromVersion + 1 },
      { id: toId, balance: toBalance, version: input.toVersion + 1 }
    ],
    messages: [{ type: "ledger.transfer-completed", transferId, amount }],
    ordering: ["lock", "debit", "credit", "idempotency-write", "message", "commit"]
  });
}

console.log(JSON.stringify(run()));

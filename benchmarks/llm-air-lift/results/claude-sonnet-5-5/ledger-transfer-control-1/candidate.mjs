let source = "";
for await (const chunk of process.stdin) source += chunk;

const json = { "content-type": "application/json" };

function respond(status, body, o = {}) {
  const { accounts = [], committed = false, messages = [], ordering = [], failures = [], retryability = false } = o;
  console.log(JSON.stringify({
    http: { status, headers: json, body },
    database: { accounts, transaction: { committed } },
    messages,
    ordering,
    failures,
    retryability
  }));
}

function fail(status, code, message, o = {}) {
  respond(status, { error: code, message }, { ...o, failures: [{ code, message }] });
}

function main() {
  let input;
  try {
    input = JSON.parse(source || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object");
  } catch {
    return fail(400, "invalid_request", "request must be a JSON object");
  }

  const { transferId, idempotencyKey, fromId, toId, fromBalance, toBalance, amount, fromVersion, toVersion } = input;
  const isInt = (v) => Number.isInteger(v);

  if (typeof fromId !== "string" || typeof toId !== "string" || fromId === toId ||
      !isInt(fromBalance) || !isInt(toBalance) || !isInt(amount) || amount <= 0 ||
      fromBalance < 0 || toBalance < 0) {
    return fail(400, "invalid_request", "invalid transfer request");
  }

  // Idempotent replay: key already applied; return the original result with no new event.
  const lookup = (store) => (store && !Array.isArray(store) && idempotencyKey !== undefined ? store[idempotencyKey] : undefined);
  const prior = input.replay ?? input.existingTransfer ?? lookup(input.processedKeys) ?? lookup(input.idempotencyStore);
  const replayed = prior || (Array.isArray(input.processedKeys) && input.processedKeys.includes(idempotencyKey));
  if (replayed) {
    const p = typeof prior === "object" && prior !== null ? prior : {};
    const body = {
      transferId: p.transferId ?? transferId,
      fromBalance: p.fromBalance ?? fromBalance,
      toBalance: p.toBalance ?? toBalance,
      replayed: true
    };
    return respond(200, body, {
      accounts: [
        { id: fromId, balance: body.fromBalance, version: p.fromVersion ?? fromVersion },
        { id: toId, balance: body.toBalance, version: p.toVersion ?? toVersion }
      ]
    });
  }

  // Optimistic concurrency: stored versions must match the versions the caller read.
  const curFrom = input.currentFromVersion ?? input.storedFromVersion ?? fromVersion;
  const curTo = input.currentToVersion ?? input.storedToVersion ?? toVersion;
  if (curFrom !== fromVersion || curTo !== toVersion) {
    return fail(409, "version_conflict", "account version conflict", {
      accounts: [
        { id: fromId, balance: fromBalance, version: curFrom },
        { id: toId, balance: toBalance, version: curTo }
      ],
      retryability: true
    });
  }

  if (fromBalance < amount) {
    return fail(422, "insufficient_funds", "insufficient funds", {
      accounts: [
        { id: fromId, balance: fromBalance, version: fromVersion },
        { id: toId, balance: toBalance, version: toVersion }
      ]
    });
  }

  const newFrom = fromBalance - amount;
  const newTo = toBalance + amount;

  respond(200, { transferId, fromBalance: newFrom, toBalance: newTo }, {
    accounts: [
      { id: fromId, balance: newFrom, version: fromVersion + 1 },
      { id: toId, balance: newTo, version: toVersion + 1 }
    ],
    committed: true,
    messages: [{ type: "transfer.completed", transferId, idempotencyKey, fromId, toId, amount }],
    ordering: ["debit", "credit", "commit", "publish"]
  });
}

main();

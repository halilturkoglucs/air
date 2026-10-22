# Replace the ledger-transfer capability

Implement `candidate.mjs` as an ordinary Node.js command target. Read one JSON request from stdin and write one JSON observation object to stdout.

The capability transfers funds between versioned accounts. It must update both accounts atomically, emit one transfer event, reject insufficient funds without changing state, return idempotent replays without another event, and map version conflicts as retryable.

Required observation keys are `http`, `database`, `messages`, `ordering`, `failures`, and `retryability`. Preserve exact status codes, balances, versions, transaction outcome, event cardinality, ordering, replay behavior, and failure mapping.

Use only the Node.js standard library. Run `npm test` after changes. Do not access parent directories or external networks.

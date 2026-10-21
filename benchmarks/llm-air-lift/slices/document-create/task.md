# Replace the document-creation capability

Implement `candidate.mjs` as an ordinary Node.js command target. Read one JSON request from stdin and write one JSON observation object to stdout.

The capability creates a document, authorizes and indexes it through a vendor, persists it, emits `document.created`, and supports idempotent replay. Vendor failures must not persist or emit anything. Generated identifiers and timestamps must remain correlated across boundaries.

Required observation keys are `http`, `database`, `messages`, `outbound`, `ordering`, `failures`, and `retryability`. Preserve exact status codes, response fields, transaction outcome, outbound order, event cardinality, failure mapping, and replay behavior.

Use only the Node.js standard library. Run `npm test` after changes. Do not access parent directories or external networks.

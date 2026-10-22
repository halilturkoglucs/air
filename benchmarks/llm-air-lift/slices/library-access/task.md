# Replace the library-access capability

Implement `candidate.mjs` as an ordinary Node.js command target. Read one JSON request from stdin and write one JSON observation object to stdout.

The capability lists visible books with ownership, role-based access, filtering, deterministic ordering, offset, and limit. It also deletes books only when the caller owns the book or has the `librarian` role. Forbidden deletes must leave data unchanged.

Required observation keys are `http`, `database`, and `failures`. Preserve exact status codes, projected response fields, authorization behavior, filtering, ordering, pagination, and post-state.

Use only the Node.js standard library. Run `npm test` after changes. Do not access parent directories or external networks.

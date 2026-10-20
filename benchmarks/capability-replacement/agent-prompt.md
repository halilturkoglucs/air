# External coding-agent prompt

Implement an ordinary Node/TypeScript replacement for the supplied legacy capability contract. Do not use AIR generation or import an AIR runtime. Read one JSON request from stdin and emit one JSON observation document on stdout. Preserve response status and fields, transactional database effects, rollback declaration, outbound calls and order, emitted message cardinality and type, failure mapping, retryability, idempotency state, and correlation of generated identifiers/timestamps across all boundaries.

# Extract a service from a monolith

`monolith.mjs` creates an order and its invoice in one process. After the split, `orders.mjs` keeps orders and calls the new `billing.mjs` service, which owns invoices. AIR checks that the externally visible behavior is unchanged:

- `lifecycle.services` starts billing before each run and waits for `readinessUrl`.
- `rename` maps billing's `billing_invoices` table back to `invoices`.
- `internal-boundary` drops the orders-to-billing call from `outbound` and `ordering`, because it is internal after the split.

Everything else, including the HTTP response, both rows, and the remaining ordering, is still compared strictly. From the repository root:

```bash
air check baseline examples/extract-service/check.yaml --policy examples/extract-service/policy.yaml --target examples/extract-service/legacy.target.yaml --output out/extract-baseline --allow-dirty
air check run examples/extract-service/check.yaml --policy examples/extract-service/policy.yaml --baseline out/extract-baseline --target examples/extract-service/candidate.target.yaml --output out/extract-run --agent --reveal
```

Merging services into a monolith is the same check in reverse: the services are legacy, the monolith is the candidate, and the same two rules describe the boundary that disappears.

# AIR and Keploy on the same planted bug

Keploy is the closest existing tool: it records real traffic to a service and replays it as tests, with the service's dependencies mocked. This page runs both tools on the same service, the same user journey, and the same planted bug. It reports what each caught and what each needed to get there, including where Keploy does better.

## Setup

- Service: the [OpenTelemetry demo](https://github.com/open-telemetry/opentelemetry-demo) at `ad06a6f`, run in Docker Desktop on an Apple Silicon Mac (core services, Kafka, Valkey, PostgreSQL; no load generator). The AIR side is the [field trial](design/discover-code.md#field-trial-opentelemetry-demo).
- Keploy: open-source build 3.6.106 (`keploy_darwin_arm64`), recording the `frontend` container, which serves the shop's HTTP API. The open-source build supports HTTP and MySQL. Its banner says Kafka, PostgreSQL, gRPC, and HTTP/2 need the keploy.io build with an account, which was not used here.
- Journey for both: view a product, add two to the cart, read the cart, get a shipping quote, check out, read the emptied cart. Keploy also recorded four read-only routes (products, recommendations, ads, currencies).
- Planted bug: `checkout` (Go) publishes only the first item of each order to Kafka. Every HTTP response stays the same.

## Results

| | Keploy (open-source build) | AIR 0.18.0 |
| --- | --- | --- |
| Tests or scenarios | 10 HTTP tests, 18 gRPC mocks, 1 HTTP mock | 14 HTTP scenarios, plus a 2-scenario harness for the Kafka event and the accounting database |
| Unchanged code | 9/10 pass. `GET /api/shipping` returned 400 under replay instead of 200 (not investigated). | 14/14 and 2/2 pass |
| Planted bug | 9/10, the same as unchanged code: **not caught** | HTTP 14/14 pass. Harness **fails** on `/events/0/order/items/1` and `/data/items/1` (missing) |
| One run | 3 min 45 s (Keploy starts the app under its own Compose file each run) | 2.3 s (against the running stack) |

### Why Keploy cannot see this bug

Keploy tests one service with its dependencies replaced by recorded mocks. With `frontend` under test, its gRPC call to `checkout` returns the recorded response, so the changed `checkout` code never runs. Recording `checkout` itself would need gRPC ingress and Kafka egress. The open-source build lists neither, and the account build was not tested. Keploy's `--assert-dependencies` flag fails a test only when a recorded dependency call disappears. Here the Kafka publish still happens, only with different content.

AIR runs the real system and compares what it did, including effects outside the HTTP response. HTTP checks alone also missed this bug (14/14 pass). The harness caught it.

## What each needed

Keploy needed no test code, and no reset or noise handling: mocked dependencies make carts, generated order IDs, and random recommendations repeat exactly. AIR needed all of these:

- a recorded journey script (`air protect --add -- node flow.mjs`)
- a cart reset command (`--reset`, `--reset-scope run`)
- two `shape` rules for ads and recommendations, which AIR suggested
- an agent-written harness, about 30 lines, which reads the accounting consumer's log and two tables
- deploy and restore scripts, so `air harness verify --setup/--teardown` could prove the harness catches a planted change

Keploy also needed changes to the service's Compose setup:

- `HOSTNAME=0.0.0.0` for `frontend`. Keploy forwards to the app on `127.0.0.1`, and Next.js standalone listens only on the container hostname.
- `frontend` published on host port 8080. Keploy replays tests to the recorded port.
- Its generated Compose file starts the Keploy agent as a dependency of the app, so `up --no-deps` fails. The runs removed `frontend-proxy` and left `checkout` stopped, so the stack had to be restored by hand.

## Takeaways

- For a single service whose dependencies can be mocked, Keploy gives tests from traffic with less setup.
- AIR fits when the risk is in effects behind the response (events, stored data, caches), or when a change spans services. AIR runs the real dependencies and checks whatever the harness reports.
- The two tools can be combined: Keploy for per-service regression tests, AIR for cross-service effects and agent-driven changes.

## Reproduce

```bash
# OpenTelemetry demo, AIR side: see design/discover-code.md#field-trial-opentelemetry-demo
keploy record -c "docker compose -f compose.yaml -f compose.full.yaml -f keploy.override.yaml up frontend" \
  --container-name frontend -n opentelemetry-demo --cmd-type docker-compose
# drive the journey against frontend, then Ctrl+C
keploy test -c "<same command>" --container-name frontend -n opentelemetry-demo --cmd-type docker-compose --delay 40
git apply first-item-only.patch   # rebuild and redeploy checkout, then rerun both tools
```

`keploy.override.yaml` sets `HOSTNAME=0.0.0.0` on `frontend`, and `compose.yaml` publishes `${FRONTEND_PORT}:${FRONTEND_PORT}`. Run on 2026-10-23.

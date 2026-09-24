# Gridbot — Next.js + TypeScript

Next.js App Router application with a server-side grid strategy engine and
an interactive simulation dashboard. Replaces the initial Python prototype.
This version does not connect to Hyperliquid or place real orders.

## Run locally

Install Node.js 22 or later, then:

```powershell
npm install
npm run dev
```

Open http://localhost:3000. For validation and production builds:

```powershell
npm test
npm run typecheck
npm run build
npm start
```

On this Windows workspace, a local Node.js runtime is available in the ignored
`.tools` folder. Use the wrapper without changing your system PATH:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run.ps1 dev
```

Replace `dev` with `test`, `typecheck`, `build` or `start` as needed.

The development and production commands bind to localhost. A future AWS
deployment should put an authenticated reverse proxy in front of the app.
Official setup reference: https://nextjs.org/docs/app/getting-started/installation

## Structure

- `src/lib/grid/engine.ts`: Decimal-based strategy, cumulative fills, cancellation intents.
- `src/lib/grid/config.ts`: runtime input validation.
- `src/lib/grid/simulate.ts`: deterministic simulated exchange replay.
- `src/app/api/simulate/route.ts`: bounded, stateless POST endpoint.
- `src/app/page.tsx`: configuration, order simulation, step counter and log export.
- `tests/`: strategy and API tests.

## Strategy rules

Start with two base buys below the anchor and two base sells above it.
Absolute spacing uses anchor + interval × level. Percentage spacing uses
anchor × (1 + interval)^level; enter `0.01` for 1%. Quantities are asset
units. Prices use decimal arithmetic and are returned as strings.

Every fully filled order, including a target, increments the counter. Unless
the limit is reached, it creates an opposite target one grid level away and
a new base order beyond the furthest base level issued on that side.
The target uses the order's grid price, not the actual execution price.
Partial fills do not increment the counter; duplicate cumulative updates
do not create extra orders. Orders may share grid prices.

At the limit, no replacements are issued. The engine requests cancellation
of its own outstanding orders and waits for confirmation before reporting
stopped. Racing full fills still count, so the final count can exceed the
limit. The simulator confirms all cancellations immediately.

### Pending base-order rule

The user requested two base buys and two base sells plus separate targets,
and both replacements for every fill. A target fill can produce a third
base order. Until a policy is confirmed, `pending` stops and cancels at the
first conflict. The dashboard allows experimenting with cancellation of
the nearest or farthest **existing** base order (relative to the filled
order price), or allowing extras. These are explicit simulation choices,
not a selected live trading policy. Cancellation requests precede placements;
a real adapter must await and reconcile them before sending new orders.

## Simulation API

POST `/api/simulate`:

```json
{
  "config": {
    "anchor": "100",
    "interval": "10",
    "quantity": "1",
    "maxSteps": 10,
    "spacing": "absolute",
    "baseOverflow": "pending"
  },
  "fills": [{ "orderId": "grid-1", "cumulativeQuantity": "1" }],
  "stop": false
}
```

Each request replays the supplied history from scratch. No shared server
singleton, wallet, background loop or persisted session exists. Refreshing
clears the dashboard. Download the JSON execution log to retain a simulation.
Simulation history is limited to 500 updates per request.

## Next integration stage

Market, spot/perpetuals, live parameters and overflow policy still need to be
confirmed. Hyperliquid integration needs tick/size rounding, order acceptance
and rejection handling, durable state and logs, restart reconciliation,
stream deduplication and cancellation retries. Late fills on canceled orders
must be reconciled by that adapter; the simulation engine alone is insufficient.
Stopping cancels orders and does not flatten inventory or positions.

Run the future live trading loop as a separate persistent Node worker on AWS,
not inside a Next.js request handler. Authentication, secret storage, worker
supervision and deployment configuration will be added with that integration.
Do not commit wallet keys. Commits and deployment occur only when requested.

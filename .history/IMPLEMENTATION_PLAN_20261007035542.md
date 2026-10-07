# Gate.io Futures & Options Paper-Trading Platform

## Goal

Build a learning platform that streams public Gate.io market data and lets a user trade against a persistent simulated account. The simulator will model order execution, fees, funding, margin, PnL, and contract expiry transparently. It will never submit, amend, or cancel real exchange orders.

A live Gate.io book and tape make the market inputs real; paper fills are still an estimate because public data cannot reveal our place in Gate's matching-engine queue. The UI and trade history must label simulated results accordingly.

## Product Scope

Gate.io documents Perpetual Futures, Delivery Futures, and Options as separate API product groups. We will keep them as separate instrument types and accounting rules.

- **Perpetual futures:** Start with liquid USDT-settled linear contracts. Support long/short, limit and market orders, reduce-only, leverage, position margin, maker/taker fees, mark-price PnL, and periodic funding.
- **Delivery futures:** Add dated contracts after perpetual accounting is validated. Model expiry/settlement separately; do not apply perpetual funding to a dated contract unless the exchange contract rules say so.
- **Options:** Support Gate-listed calls and puts, strikes, expirations (including the exchange's day/week/month tags), contract multiplier, premium orders, fees, positions, Greeks/IV where supplied, and expiry/settlement. Verify exercise and settlement rules against the live contract/API documentation before coding the settlement engine.
- **Market data:** Instrument list, ticker/mark/index prices, trades, order book, funding rates/times, and contract metadata. A price chart is optional and comes after the trading/accounting workflow.
- **Paper account only:** Starting balance, resettable practice accounts, order/position/history views, and an append-only transaction ledger. No deposit/withdrawal or real-trading controls.

## Proposed Architecture

- **Frontend:** React + TypeScript + Vite. Trading workspace with product selector, instrument/expiry selectors, order ticket, order book, recent trades, positions, open orders, account/risk summary, and activity history. Chart is an optional later panel.
- **Backend:** Node.js + TypeScript + Fastify. Owns Gate public-data connections, normalized market state, simulation engine, persistence, and a WebSocket API to the browser.
- **Market-data adapter:** Separate Gate REST bootstrap and public WebSocket feed from the simulator. Normalize exchange payloads into internal instrument, ticker, trade, order-book, and funding events. Keep a source timestamp, receive timestamp, and connection/staleness status on updates.
- **Simulation engine:** Deterministic domain module that consumes normalized data and user paper orders. It must not import or call Gate private order APIs.
- **Persistence:** SQLite for the initial single-user learning app, with migrations and transactional ledger updates. Keep the repository/data interfaces portable if multi-user deployment later requires PostgreSQL.
- **Testing:** Unit tests for accounting and matching rules; recorded market-data fixtures for adapter tests; integration tests for end-to-end simulated orders and restarts.

## Build Steps

### 1. Verify the exchange contract and data surface

Inspect Gate.io's current REST and WebSocket references for each product before implementing its adapter. Record WebSocket URLs/channels, snapshot/update semantics, sequence IDs, heartbeat, reconnect rules, rate limits, settlement currencies, contract multipliers, tick/size increments, fee fields, funding intervals, and expiry settlement details.

**Deliverable:** A short API mapping table in the project docs, with separate rows for perpetual futures, delivery futures, and options. Treat unsupported or unavailable fields as unavailable; do not silently invent values.

**Acceptance checks:** We can retrieve active contract metadata and REST snapshots, subscribe to a public feed, reconnect after a forced disconnect, and detect stale or out-of-sequence book data. The UI shows a clear disconnected/stale state.

### 2. Create the application skeleton and paper-trading boundary

Create frontend and backend packages, typed shared market/domain models, configuration, database migrations, health checks, and local run commands. Implement a paper-only execution interface and tests proving order commands cannot reach Gate's authenticated trading endpoints. Do not request or store Gate API keys.

**Acceptance checks:** The app starts locally from documented commands, opens a paper account, persists it across restart, and has no real-order code path or credentials screen.

### 3. Build Gate public market data

Implement the adapter for USDT perpetual futures first: contract discovery, initial REST snapshot, WebSocket deltas, ticker/mark/index values, trades, order book, funding rate and next funding time. Rebuild the local book from a valid snapshot and ordered deltas; discard and resnapshot after sequence gaps. Add bounded reconnect/backoff and subscription management.

**Acceptance checks:** A selected contract's book and trade tape update live; bid/ask ordering and sizes are validated; disconnect, stale data, and recovery are observable; numerical values retain exchange precision.

### 4. Implement the paper order book and fill model

Support limit and market orders, cancellation, partial fills, and order status history. Market orders walk currently visible opposing depth, calculate a volume-weighted execution price, and expose spread/slippage. Limit orders use a documented conservative rule based on subsequent public trades/book movement; do not claim queue-position accuracy. Add configurable latency and slippage stress settings, defaulting to conservative values.

Every simulated fill records the market-data time/version, reference price, execution price, filled quantity, fee, and fill-model version for replay and auditing.

**Acceptance checks:** Tests cover buy/sell direction, depth exhaustion, partial fills, unfilled limits, cancellation races, tick/size constraints, and deterministic replay from the same event sequence.

### 5. Add perpetual position and account accounting

Track signed position size, average entry, realized/unrealized PnL, mark price, initial/maintenance margin estimates, leverage, and available balance. Use exchange contract metadata and correct linear-contract units. Charge maker or taker trading fees per fill using configurable account rates, sourced from Gate where available or clearly labeled defaults.

Apply funding only to eligible perpetual positions at the exchange funding timestamp using the applicable funding rate and contract notional convention. Store each funding debit/credit as a separate ledger entry. Show the next funding time/rate and estimated payment before the event. Calculate liquidation price/risk as an educational estimate, clearly distinct from Gate's live liquidation engine.

**Acceptance checks:** Hand-calculated accounting examples match unit tests for long and short positions, partial close, fee debit, positive/negative funding, insufficient margin, and mark-price changes. Ledger sums reconcile to account equity.

### 6. Add Gate options instruments and paper trading

Load underlyings, expirations, option contracts, tickers, and option order-book/trade data from Gate's documented Options APIs/feeds. Present calls and puts by underlying, expiry, and strike; surface multiplier, bid/ask, mark, implied volatility, and exchange-provided Greeks when available. Support paper limit/market orders, fills, premium/fees, positions, and PnL in the contract's quote/settlement units.

Implement expiry/settlement only after confirming Gate's current payoff, settlement-price source, timing, and fee rules. If any input is unavailable, label a configurable approximation and retain the source/rule on the settlement ledger entry. Do not apply futures funding to options.

**Acceptance checks:** Fixture tests cover call/put metadata, quantity multiplier, premium cashflow, fee, Greek display, and expiry settlement. Live option books and contract lifecycle states work independently of the futures feed.

### 7. Add delivery contracts and advanced controls

Once the perpetual and option accounting tests pass, add Gate delivery-futures metadata, order book, dated order handling, and settlement/expiry. Then consider hedge/one-way position modes, isolated/cross margin, stop/trigger orders, take-profit/stop-loss, and risk-limit tiers as distinct milestones. Implement only rules confirmed in Gate's contract/API metadata.

**Acceptance checks:** Delivery contracts do not receive perpetual funding; expiry closes/settles exactly once; mode and margin controls have independent scenario tests.

### 8. Build the trading interface

Assemble the live workspace around instrument selection, order entry, book/tape, open orders, positions, balances, and realized/unrealized PnL. Include explicit Paper mode, feed freshness, product type, fee/funding assumptions, and an order confirmation summary showing estimated cost and slippage. Persist user settings and allow a safe paper-account reset with confirmation.

**Acceptance checks:** A user can select an instrument, place/cancel a paper order, observe fills and account updates, close a position, and inspect the full fee/funding/settlement history without leaving the main workflow.

### 9. Add optional charting and historical replay

Add a lightweight candlestick chart from Gate's public candle data if useful. Later, persist normalized market events or compact snapshots to replay a chosen interval, compare fill/slippage settings, and repeat a paper-trading exercise deterministically.

**Acceptance checks:** Chart and replay are explicitly sourced/timestamped; missing history is shown as a gap rather than fabricated data.

### 10. Harden, document, and release the learning build

Add API/feed health indicators, structured logs, safe error handling, data retention controls, keyboard/accessibility checks, and mobile layout checks. Document setup, architecture, market-data limitations, simulator rules, formula assumptions, and how to add a product adapter. Keep the deployment private or clearly marked educational; do not present simulated performance as actual exchange results.

**Acceptance checks:** Fresh setup follows the README; tests pass; feed failure does not create fabricated fills; all paper fills and ledger entries are auditable and reproducible.

## Core Simulation Rules to Agree Before Coding

- Initial account balance and currency.
- Which fee tier/rates to use: user-configurable, Gate public contract rates, or explicit educational defaults.
- Fill assumptions: conservative trade-through vs. simulated queue model, plus configurable latency/slippage.
- Whether v1 supports isolated margin only or also cross margin; the recommended first version is isolated.
- Options settlement behavior for each supported contract; verify from Gate data/docs rather than applying a generic options formula blindly.
- Local-only, single-user app for v1. No live order placement in any phase unless the project scope is explicitly changed.

## Official References

- [Gate.io API v4 overview](https://www.gate.com/docs/developers/apiv4/en/)
- [Gate.io Perpetual Futures API](https://www.gate.com/docs/developers/apiv4/en/futures/)
- [Gate.io Delivery Futures API](https://www.gate.com/docs/developers/apiv4/en/delivery/)
- [Gate.io Options API](https://www.gate.com/docs/developers/apiv4/en/options/)

Gate's API site provides separate WebSocket documentation alongside REST docs. The exact WebSocket endpoints and channel payload contracts will be recorded in Step 1 and checked again when implementation begins, since exchange documentation and supported markets can change.

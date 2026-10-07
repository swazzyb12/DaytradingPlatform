# Gate.io Futures & Options Paper-Trading Platform

## Goal

Build a learning platform that streams public Gate.io market data and lets a user trade against a persistent simulated account. The simulator will model order execution, fees, funding, margin, PnL, and contract expiry transparently. It will never submit, amend, or cancel real exchange orders.

A live Gate.io book and tape make the market inputs real; paper fills are still an estimate because public data cannot reveal our place in Gate's matching-engine queue. The UI and trade history must label simulated results accordingly.

## Implementation Status

Implemented in the current local build:

- React/Vite trading workspace, Fastify API, SQLite-WASM paper persistence, and browser WebSocket updates.
- USDT perpetual market data from Gate REST plus the verified Futures WebSocket; snapshot recovery buffers depth deltas and resyncs on real sequence gaps.
- Paper market/limit orders, depth-walk fills, conservative trade-based limit fills, fees, extra slippage, positions, realized/unrealized PnL, configurable leverage, balance ledger, and scheduled funding.
- Gate Options catalogue, contract detail, ticker/Greeks, REST book polling, premium/fee cashflows, long option positions, short-open guard, and Gate-published expiry settlement profit/fee when available.
- Gate direct USDT delivery contracts, REST-polling books/trades, dated positions, and Gate-reported settlement price/fee when available. Inverse delivery contracts are excluded.
- Futures and dated-delivery order entry accepts either USDT order value or USDT margin; margin is multiplied by selected leverage before conversion to a valid contract size. Options continue to accept contract quantity.
- Responsive workspace for instruments, order book, tape, account metrics, positions, orders, fills, ledger, simulator settings, and reset.

Implemented baseline: public Gate USDT perpetual risk-tier loading, isolated one-way margin estimates, risk-increase guards, and depth-based simulated liquidation. This is educational simulation, not Gate's private account or liquidation engine. Remaining risk work includes independently confirming the live payload across contracts, risk-limit-table fallback, configurable warning thresholds, and broader stress/restart reconciliation. Stop/trigger orders, hedge mode, cross-margin simulation, charting/replay, and opening short options remain unimplemented. Options and delivery use REST polling because a supported public derivative WebSocket channel was not verified for those product families.

## Product Scope

Gate.io documents Perpetual Futures, Delivery Futures, and Options as separate API product groups. We will keep them as separate instrument types and accounting rules.

- **Perpetual futures:** Start with liquid USDT-settled linear contracts. Support long/short, limit and market orders, reduce-only, leverage, position margin, maker/taker fees, mark-price PnL, and periodic funding.
- **Futures order sizing:** Offer USDT order-value mode and USDT margin mode. Margin mode derives target notional as `margin × leverage`. Compute contracts as `floor_to_size_step(target_notional / (reference_price × contract_multiplier))`. Use limit price for limit orders and current mark (falling back to the executable quote) for market-order preview. Show estimated contracts, actual notional, and estimated initial margin; reject sizes below Gate's minimum. Options remain quantity-in-contracts.
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

### 5A. Priority: Gate-aligned liquidation and risk tiers

This is the next implementation milestone and blocks work on cross margin and hedge mode. Keep the implementation paper-only; Gate private account endpoints are not available or required. Use live public mark/index prices and contract/tier metadata, and label every computed risk value as a simulator estimate rather than Gate's live account result.

**Status:** The isolated risk baseline is implemented: the adapter loads `risk_limit_tiers` and refreshes it once per minute; incomplete/stale tiers block live exposure increases; direct USDT perpetual positions snapshot leverage and initial margin; risk outputs include formula version, multiplier, mark/tier freshness, tiered maintenance deduction, estimated liquidation price and distance; funding is applied before each maintenance check; and the simulator records depth-walk liquidation fills and residuals without claiming Gate insurance/ADL parity. Remaining before treating this milestone as complete: verify the live endpoint payload across representative contracts (including `risk_limit_table` where needed), add configurable warning thresholds, and broaden tier-transition, mark-gap, liquidation-accounting, and restart-recovery stress tests. Cross-margin and hedge mode remain blocked.

1. **Risk data adapter:** Extend `MarketSnapshot` with contract type, multiplier, order-size limits, leverage limits, risk-limit table identifier, and source timestamps. Fetch `GET /futures/usdt/risk_limit_tiers?contract=...` and, when the contract supplies a table ID, `GET /futures/usdt/risk_limit_table?table_id=...`. Preserve each tier's `risk_limit`, `initial_rate`, `maintenance_rate`, `leverage_max`, and `deduction`; reject unsupported inverse contracts from the linear simulator. Refresh/cache tiers by contract and surface missing/stale metadata.
2. **Reconcile the Gate model before calculating liquidation:** Implement public documentation's effective position-value rule using contracts × mark price × multiplier, with the larger of long or short exposure used when dual-sided positions are later enabled. Use the matching tier's initial and maintenance rates and the tier deduction. Verify cumulative/tier application against Gate's current Risk Limit and Maintenance Margin articles and checked worked examples; do not assume one flat `maintenance_rate` applies at every size. Add fixture tests for tier boundaries and deduction behavior.
3. **Isolated one-way model first:** Store position margin separately from wallet balance; calculate mark-to-market equity, maintenance requirement, estimated liquidation threshold/price, and distance-to-liquidation from the verified tier model. Account for entry/closing fees and funding in equity. Use mark price, never last trade, as the risk trigger. If a required rule/input cannot be verified, show `risk unavailable` and block an order that would increase that position instead of falling back to a guessed formula.
4. **Risk controls and presentation:** Before accepting an order, estimate post-fill tier, initial margin, maintenance margin, and liquidation price. Reject insufficient-margin or risk-limit-exceeding orders. Add a persistent risk panel with margin ratio, available margin, distance to estimated liquidation, tier, and source/freshness. Add configurable warnings at tested margin-ratio thresholds; distinguish warning from simulated liquidation.
5. **Liquidation event engine:** On mark-price updates, detect when isolated equity breaches maintenance. Create one deterministic simulated liquidation event, cancel conflicting reduce/increase orders as specified by the simulator rule, charge modeled close/liquidation fees, and walk available opposing depth with explicit impact/slippage. If depth is insufficient, record residual exposure and flag it; do not claim to reproduce Gate's insurance fund or ADL. Public `liq_orders`, insurance history, contract statistics, and ADL risk states may be displayed as market context, never treated as the user's private liquidation state.
6. **Stress and replay tests:** Test long/short threshold crossings, tier changes, mark-price gaps, funding immediately before liquidation, partial close, insufficient depth, repeated ticks (no duplicate liquidation), and restart recovery. Compare sample calculations to Gate's published examples. Only after this isolated model and its accounting invariants pass should the UI offer cross-margin or hedge-mode simulation.

**Risk milestone acceptance:** Every risk number identifies formula version, mark timestamp, contract multiplier, and tier source. No silent defaults for absent tiers. Tests prove equity and ledger reconciliation through tier changes and liquidation. A stale mark disables new/increasing orders and risk-trigger processing; the UI clearly distinguishes stale from safe.

### 5B. Trigger orders after risk model

Add paper stop-loss, take-profit, and trigger-limit/trigger-market orders after the risk milestone. Define reference price (`last`, `mark`, or `index`), direction rule, reduce-only behavior, expiry, trigger time, and resulting child-order state. Evaluate triggers from normalized market events, not browser timers; persist the trigger transition before creating the child order. For market triggers, use the same depth-walk fill model and record both trigger and fill prices. Ensure protective orders cannot accidentally increase exposure.

**Status:** Trigger-market and trigger-limit paper orders are implemented with mark/last/index references, one-shot activation, visible-depth execution, reduce-only validation, and persisted trigger timestamps. Remaining work is trigger expiry, explicit child-order modeling, and the full trigger/close race and gap stress matrix.

**Acceptance checks:** Tests cover gaps through trigger price, trigger/close races, trigger expiry, partial child fills, duplicate event delivery, and risk-engine interaction.

### 5C. Hedge mode and cross margin after isolated risk

Add position mode as an explicit account setting that can only change while positions and pending orders are empty. Hedge mode keys positions by `(contract, long|short)` and maintains each side's entry, margin, realized PnL, and reduce-only orders independently. Cross margin then pools eligible USDT collateral/equity across supported positions while preserving per-position maintenance requirements and Gate tier selection. Do not reuse the isolated liquidation threshold for a pooled account: evaluate account maintenance margin across positions, then determine which positions/orders the educational liquidation policy reduces.

**Acceptance checks:** Verify simultaneous long/short, mode-change restrictions, shared collateral, one position's loss consuming shared margin, correlated tier changes, and deterministic liquidation ordering. Keep modes disabled until all scenarios reconcile.

### 5D. Charts and deterministic replay after risk controls

Add Gate candles as an optional chart. For replay, persist normalized market events with exchange time, receive time, sequence/book ID, and schema/model versions; take periodic book/account checkpoints. Replay the same event stream through the same paper engine to reproduce fills, funding, triggers, and liquidations. Represent missing/out-of-order data as gaps and pause simulation rather than interpolate fabricated market states.

**Acceptance checks:** A saved run reproduces balances, fills, funding, risk events, and final book state byte-for-byte under the same model version; tests verify gap detection and version mismatch handling.

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

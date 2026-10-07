import { Decimal } from 'decimal.js';
import { randomUUID } from 'node:crypto';

export type OrderSide = 'buy' | 'sell';
export type OrderKind = 'market' | 'limit' | 'trigger-market' | 'trigger-limit';
export type TriggerReference = 'mark' | 'last' | 'index';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';
export type ProductKind = 'perpetual' | 'delivery' | 'option';

export interface BookLevel {
  price: string;
  size: string;
}

export interface RiskTier {
  tier: number;
  riskLimit: string;
  initialRate: string;
  maintenanceRate: string;
  leverageMax: string;
  deduction: string;
}

export interface MarketSnapshot {
  contract: string;
  product: ProductKind;
  source: 'gate-rest' | 'gate-websocket' | 'fixture';
  connected: boolean;
  updatedAt: number;
  bookId?: number;
  feedError?: string;
  last: string;
  mark: string;
  index: string;
  multiplier: string;
  priceStep: string;
  sizeStep: string;
  minSize: string;
  makerFeeRate: string;
  takerFeeRate: string;
  fundingRate: string | null;
  nextFundingAt: number | null;
  expiryAt?: number | null;
  settlementPrice?: string | null;
  settlementFeeRate?: string | null;
  contractType?: 'direct' | 'inverse' | 'unknown';
  riskTiers?: RiskTier[];
  riskUpdatedAt?: number;
  riskDataError?: string;
  exitFeeRate?: string;
  bids: BookLevel[];
  asks: BookLevel[];
  trades: Array<{ id: string; price: string; size: string; side: OrderSide; time: number }>;
  options?: {
    underlying: string;
    strike: string;
    expiryAt: number;
    call: boolean;
    impliedVolatility: string | null;
    delta: string | null;
    gamma: string | null;
    vega: string | null;
    theta: string | null;
    settlement?: {
      profitPerContract: string;
      feePerContract: string;
      settlePrice: string;
      strikePrice: string;
    } | null;
  };
}

export interface PaperOrder {
  id: string;
  contract: string;
  product: ProductKind;
  side: OrderSide;
  kind: OrderKind;
  quantity: string;
  remaining: string;
  limitPrice: string | null;
  status: OrderStatus;
  createdAt: number;
  note: string;
  leverage?: number;
  triggerPrice?: string | null;
  triggerReference?: TriggerReference;
  reduceOnly?: boolean;
  triggeredAt?: number;
  expiresAt?: number | null;
}

export interface PaperPosition {
  contract: string;
  product: ProductKind;
  quantity: string;
  entryPrice: string;
  multiplier: string;
  markPrice: string;
  updatedAt: number;
  initialMargin?: string;
  leverage?: number;
  marginAdjustment?: string;
  liquidationTriggeredAt?: number;
}

export interface PaperFill {
  id: string;
  orderId: string;
  contract: string;
  product: ProductKind;
  side: OrderSide;
  quantity: string;
  price: string;
  fee: string;
  feeRate: string;
  liquidity: 'maker' | 'taker';
  referencePrice: string;
  marketUpdatedAt: number;
  createdAt: number;
  slippageBps: string;
}

export interface LedgerEntry {
  id: string;
  type: 'initial_balance' | 'trade_fee' | 'realized_pnl' | 'funding' | 'option_premium' | 'option_settlement' | 'delivery_settlement';
  contract: string | null;
  amount: string;
  balance: string;
  description: string;
  createdAt: number;
}

export interface RiskEvent {
  id: string;
  type: 'simulated_liquidation';
  contract: string;
  markPrice: string;
  marginRatio: string;
  quantity: string;
  executedQuantity: string;
  residualQuantity: string;
  status: 'complete' | 'partial' | 'no_depth';
  createdAt: number;
  note: string;
}

export interface PaperState {
  version: 1;
  initialBalance: string;
  balance: string;
  leverage: number;
  warningMarginRatio: number;
  makerFeeRate: string;
  takerFeeRate: string;
  slippageBps: string;
  orders: PaperOrder[];
  positions: PaperPosition[];
  fills: PaperFill[];
  ledger: LedgerEntry[];
  riskEvents: RiskEvent[];
  lastFundingAt: Record<string, number>;
}

export interface PlaceOrderInput {
  contract: string;
  product?: ProductKind;
  side: OrderSide;
  kind: OrderKind;
  quantity?: string;
  notionalUsdt?: string;
  limitPrice?: string;
  triggerPrice?: string;
  triggerReference?: TriggerReference;
  reduceOnly?: boolean;
  expiresAt?: number;
}

const D = (value: Decimal.Value) => new Decimal(value);
const ZERO = new Decimal(0);
const MAX_ROWS = 250;
const RISK_MAX_AGE_MS = 5 * 60_000;

export interface PositionRisk {
  status: 'ready' | 'unavailable' | 'over_limit';
  formulaVersion: string;
  multiplier: string;
  reason?: string;
  tier: number | null;
  positionNotional: string | null;
  effectivePositionValue: string | null;
  initialMargin: string | null;
  maintenanceMargin: string | null;
  marginRatio: string | null;
  liquidationPrice: string | null;
  distanceToLiquidationPct: string | null;
  markUpdatedAt: number | null;
  riskUpdatedAt: number | null;
}

export function createInitialState(initialBalance = '10000'): PaperState {
  const balance = D(initialBalance).toFixed();
  return {
    version: 1,
    initialBalance: balance,
    balance,
    leverage: 5,
    warningMarginRatio: 110,
    makerFeeRate: '0.0002',
    takerFeeRate: '0.0005',
    slippageBps: '2',
    orders: [],
    positions: [],
    fills: [],
    ledger: [{
      id: randomUUID(), type: 'initial_balance', contract: null, amount: balance,
      balance, description: 'Practice account initialized', createdAt: Date.now(),
    }],
    riskEvents: [],
    lastFundingAt: {},
  };
}

function addLedger(state: PaperState, type: LedgerEntry['type'], amount: Decimal, description: string, contract: string | null) {
  state.balance = D(state.balance).plus(amount).toFixed();
  state.ledger.unshift({
    id: randomUUID(), type, contract, amount: amount.toFixed(), balance: state.balance,
    description, createdAt: Date.now(),
  });
  state.ledger = state.ledger.slice(0, MAX_ROWS);
}

export function accountMetrics(state: PaperState, markets: Record<string, MarketSnapshot>) {
  const unrealized = state.positions.reduce((total, position) => {
    const market = markets[position.contract];
    if (!market) return total;
    if (market.product === 'option' && !D(market.mark).gt(0)) return total;
    const signedSize = D(position.quantity);
    const pnl = signedSize.times(D(market.mark).minus(position.entryPrice)).times(position.multiplier);
    return total.plus(pnl);
  }, ZERO);
  const usedMargin = state.positions.reduce((total, position) => {
    const market = markets[position.contract];
    if (!market || market.product === 'option') return total;
    const margin = position.initialMargin
      ? D(position.initialMargin)
      : D(position.quantity).abs().times(position.multiplier).times(position.entryPrice).times(D(1).div(position.leverage ?? state.leverage).plus(market.exitFeeRate ?? '0'));
    return total.plus(margin);
  }, ZERO);
  const pendingMargin = state.orders.filter((order) => order.status === 'open').reduce((total, order) => {
    const market = markets[order.contract];
    if (!market || market.product === 'option') return total;
    const reference = order.limitPrice ?? market.mark;
    const notional = D(order.remaining).times(market.multiplier).times(reference);
    const leverage = order.leverage ?? state.leverage;
    const tier = market.riskTiers?.length ? tierForNotional(notional, market.riskTiers) : undefined;
    const initialRate = tier ? Decimal.max(D(1).div(leverage), D(tier.initialRate)) : D(1).div(leverage);
    return total.plus(notional.times(initialRate.plus(market.exitFeeRate ?? '0')));
  }, ZERO);
  const equity = D(state.balance).plus(unrealized);
  return {
    balance: state.balance,
    unrealizedPnl: unrealized.toFixed(2),
    equity: equity.toFixed(2),
    usedMargin: usedMargin.toFixed(2),
    pendingMargin: pendingMargin.toFixed(2),
    availableMargin: equity.minus(usedMargin).minus(pendingMargin).toFixed(2),
    positionRisks: Object.fromEntries(state.positions.map((position) => {
      const market = markets[position.contract];
      return [position.contract, market ? calculatePositionRisk(position, market) : null];
    })),
  };
}

function tierForNotional(notional: Decimal, tiers: RiskTier[]) {
  return [...tiers]
    .sort((left, right) => D(left.riskLimit).cmp(right.riskLimit))
    .find((tier) => notional.lte(tier.riskLimit));
}

function tierInitialMargin(notional: Decimal, leverage: number, tier: RiskTier, exitFeeRate: string) {
  const leverageRate = D(1).div(leverage);
  const tierRate = D(tier.initialRate);
  const initialRate = Decimal.max(leverageRate, tierRate);
  return notional.times(initialRate.plus(exitFeeRate));
}

function tierMaintenanceMargin(notional: Decimal, tier: RiskTier, exitFeeRate: string) {
  return Decimal.max(ZERO, notional.times(tier.maintenanceRate).minus(tier.deduction))
    .plus(notional.times(exitFeeRate));
}

function initialMarginFor(notional: Decimal, leverage: number, market: MarketSnapshot) {
  const tier = market.riskTiers?.length ? tierForNotional(notional, market.riskTiers) : undefined;
  if (market.product === 'perpetual' && market.source !== 'fixture' && !tier) {
    throw new Error('Gate risk tiers are unavailable or the position exceeds the published risk limit.');
  }
  const initialRate = tier ? Decimal.max(D(1).div(leverage), D(tier.initialRate)) : D(1).div(leverage);
  if (tier && leverage > Number(tier.leverageMax)) throw new Error('Selected leverage exceeds the maximum for this risk tier.');
  return notional.times(initialRate.plus(market.exitFeeRate ?? '0'));
}

function liquidationPriceForPosition(position: PaperPosition, market: MarketSnapshot, initialMargin: Decimal) {
  const tiers = market.riskTiers ?? [];
  const quantity = D(position.quantity);
  const sizeMultiplier = quantity.abs().times(position.multiplier);
  const entry = D(position.entryPrice);
  const currentMark = D(market.mark);
  const bufferAt = (price: Decimal) => {
    const tier = tierForNotional(sizeMultiplier.times(price), tiers);
    if (!tier) return null;
    const equity = initialMargin.plus(position.marginAdjustment ?? '0').plus(quantity.times(price.minus(entry)).times(position.multiplier));
    return equity.minus(tierMaintenanceMargin(sizeMultiplier.times(price), tier, market.exitFeeRate ?? '0'));
  };

  if (quantity.gt(0)) {
    let low = ZERO;
    let high = currentMark;
    const atLow = bufferAt(low);
    const atHigh = bufferAt(high);
    if (!atLow || !atHigh || atLow.gt(0)) return null;
    if (atHigh.lte(0)) return currentMark;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const middle = low.plus(high).div(2);
      const buffer = bufferAt(middle);
      if (!buffer || buffer.lte(0)) low = middle;
      else high = middle;
    }
    return high;
  }

  const lastTier = [...tiers].sort((left, right) => D(left.riskLimit).cmp(right.riskLimit)).at(-1);
  if (!lastTier || !sizeMultiplier.gt(0)) return null;
  let low = currentMark;
  let high = D(lastTier.riskLimit).div(sizeMultiplier);
  if (!high.gt(low)) return null;
  const atHigh = bufferAt(high);
  const atLow = bufferAt(low);
  if (!atLow || !atHigh || atLow.lte(0) || atHigh.gt(0)) return null;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = low.plus(high).div(2);
    const buffer = bufferAt(middle);
    if (!buffer || buffer.lte(0)) high = middle;
    else low = middle;
  }
  return high;
}

export function calculatePositionRisk(position: PaperPosition, market: MarketSnapshot, now = Date.now()): PositionRisk {
  const unavailable = (reason: string): PositionRisk => ({
    status: 'unavailable', formulaVersion: 'gate-usdt-isolated-v1', multiplier: position.multiplier, reason, tier: null, positionNotional: null,
    effectivePositionValue: null, initialMargin: null, maintenanceMargin: null,
    marginRatio: null, liquidationPrice: null, distanceToLiquidationPct: null,
    markUpdatedAt: market.updatedAt, riskUpdatedAt: market.riskUpdatedAt ?? null,
  });
  if (market.contractType !== 'direct') return unavailable('Only direct USDT linear contracts are modeled.');
  if (!market.riskTiers?.length || !market.riskUpdatedAt) return unavailable(market.riskDataError ?? 'Gate risk tiers are unavailable.');
  if (now - market.riskUpdatedAt > RISK_MAX_AGE_MS) return unavailable('Gate risk tiers are stale.');
  if (now - market.updatedAt > 15_000 || !D(market.mark).gt(0)) return unavailable('Mark price is stale or unavailable.');

  const quantity = D(position.quantity);
  const multiplier = D(position.multiplier);
  const mark = D(market.mark);
  const notional = quantity.abs().times(multiplier).times(mark);
  const tier = tierForNotional(notional, market.riskTiers);
  if (!tier) return { ...unavailable('Position exceeds the largest published Gate risk tier.'), status: 'over_limit', positionNotional: notional.toFixed(2), effectivePositionValue: notional.toFixed(2) };
  const leverage = position.leverage ?? 5;
  if (leverage > Number(tier.leverageMax)) return { ...unavailable('Selected leverage exceeds the maximum for this risk tier.'), status: 'over_limit', tier: tier.tier, positionNotional: notional.toFixed(2), effectivePositionValue: notional.toFixed(2) };
  const initialMargin = position.initialMargin
    ? D(position.initialMargin)
    : tierInitialMargin(D(quantity.abs().times(multiplier).times(position.entryPrice)), leverage, tier, market.exitFeeRate ?? '0');
  const maintenanceMargin = tierMaintenanceMargin(notional, tier, market.exitFeeRate ?? '0');
  const unrealizedPnl = quantity.times(mark.minus(position.entryPrice)).times(multiplier);
  const isolatedEquity = initialMargin.plus(position.marginAdjustment ?? '0').plus(unrealizedPnl);
  const ratio = maintenanceMargin.gt(0) ? isolatedEquity.div(maintenanceMargin).times(100) : null;
  const liquidationPrice = liquidationPriceForPosition(position, market, initialMargin);
  const distance = liquidationPrice && mark.gt(0)
    ? liquidationPrice.minus(mark).abs().div(mark).times(100)
    : null;
  return {
    status: 'ready', formulaVersion: 'gate-usdt-isolated-v1', multiplier: position.multiplier, tier: tier.tier, positionNotional: notional.toFixed(2),
    effectivePositionValue: notional.toFixed(2), initialMargin: initialMargin.toFixed(2),
    maintenanceMargin: maintenanceMargin.toFixed(2), marginRatio: ratio?.toFixed(2) ?? null,
    liquidationPrice: liquidationPrice?.toFixed() ?? null,
    distanceToLiquidationPct: distance?.toFixed(2) ?? null,
    markUpdatedAt: market.updatedAt, riskUpdatedAt: market.riskUpdatedAt,
  };
}

function validateOrder(input: PlaceOrderInput, market: MarketSnapshot) {
  if (market.product !== (input.product ?? 'perpetual')) throw new Error('Selected product does not match the contract.');
  if (input.notionalUsdt !== undefined && market.product === 'option') throw new Error('Options orders use contract quantity, not USDT notional.');
  if (input.quantity === undefined) throw new Error('Contract quantity or USDT notional is required.');
  const quantity = D(input.quantity);
  if (!quantity.isFinite() || !quantity.gt(0)) throw new Error('Quantity must be greater than zero.');
  if (quantity.lt(market.minSize)) throw new Error(`Minimum size is ${market.minSize}.`);
  if (!quantity.mod(market.sizeStep).eq(0)) throw new Error(`Quantity must follow the ${market.sizeStep} size step.`);
  if (input.kind === 'limit' || input.kind === 'trigger-limit') {
    if (!input.limitPrice || !D(input.limitPrice).isFinite() || !D(input.limitPrice).gt(0)) throw new Error('A positive limit price is required.');
    if (!D(input.limitPrice).mod(market.priceStep).eq(0)) throw new Error(`Price must follow the ${market.priceStep} tick size.`);
  }
  if (input.kind === 'trigger-market' || input.kind === 'trigger-limit') {
    if (!input.triggerPrice || !D(input.triggerPrice).isFinite() || !D(input.triggerPrice).gt(0)) throw new Error('A positive trigger price is required.');
    if (!D(input.triggerPrice).mod(market.priceStep).eq(0)) throw new Error(`Trigger price must follow the ${market.priceStep} tick size.`);
    if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now())) throw new Error('Trigger expiry must be in the future.');
  }
}

export function contractsForUsdtNotional(input: PlaceOrderInput, market: MarketSnapshot) {
  if (input.notionalUsdt === undefined) return input.quantity ?? '';
  const notional = D(input.notionalUsdt);
  if (!notional.isFinite() || !notional.gt(0)) throw new Error('USDT amount must be greater than zero.');
  const referencePrice = input.kind === 'limit' ? D(input.limitPrice ?? 0) : D(market.mark);
  if (!referencePrice.isFinite() || !referencePrice.gt(0)) throw new Error('A valid reference price is required to size this futures order.');
  const contractNotional = referencePrice.times(market.multiplier);
  if (!contractNotional.gt(0)) throw new Error('This contract has no valid USDT multiplier.');
  const step = D(market.sizeStep);
  const contracts = notional.div(contractNotional).div(step).floor().times(step);
  if (contracts.lt(market.minSize)) {
    const minimum = D(market.minSize).times(step).times(contractNotional);
    throw new Error(`Amount is below this contract's minimum of ${minimum.toFixed(2)} USDT.`);
  }
  return contracts.toFixed();
}

function applyFill(state: PaperState, order: PaperOrder, market: MarketSnapshot, size: Decimal, basePrice: Decimal, liquidity: 'maker' | 'taker', liquidation = false) {
  if (!size.gt(0)) return;
  const sign = order.side === 'buy' ? 1 : -1;
  const extraSlippage = liquidity === 'taker' ? D(state.slippageBps).div(10000) : ZERO;
  const price = basePrice.times(sign > 0 ? D(1).plus(extraSlippage) : D(1).minus(extraSlippage));
  const multiplier = D(market.multiplier);
  const feeRate = liquidation
    ? Decimal.max(D(state.takerFeeRate), D(market.exitFeeRate ?? state.takerFeeRate))
    : D(liquidity === 'maker' ? state.makerFeeRate : state.takerFeeRate);
  const notional = market.product === 'option'
    ? size.times(price).times(multiplier)
    : size.times(price).times(multiplier);
  const fee = notional.times(feeRate);
  const signedFill = size.times(sign);
  const current = state.positions.find((position) => position.contract === market.contract);
  const currentSize = current ? D(current.quantity) : ZERO;
  let realized = ZERO;

  if (current && !currentSize.eq(0) && currentSize.isPositive() !== signedFill.isPositive()) {
    const closed = Decimal.min(currentSize.abs(), signedFill.abs());
    realized = closed.times(price.minus(current.entryPrice)).times(currentSize.isPositive() ? 1 : -1).times(multiplier);
  }

  if (current) {
    const nextSize = currentSize.plus(signedFill);
    if (nextSize.eq(0)) {
      state.positions = state.positions.filter((position) => position.contract !== market.contract);
    } else {
      const adding = currentSize.isPositive() === signedFill.isPositive();
      const remainsSameSide = currentSize.isPositive() === nextSize.isPositive();
      const nextEntry = !remainsSameSide
        ? price
        : adding
          ? currentSize.abs().times(current.entryPrice).plus(signedFill.abs().times(price)).div(currentSize.abs().plus(signedFill.abs()))
          : D(current.entryPrice);
      current.quantity = nextSize.toFixed();
      current.entryPrice = nextEntry.toFixed();
      current.markPrice = market.mark;
      current.updatedAt = Date.now();
      current.multiplier = multiplier.toFixed();
      if (remainsSameSide && adding) {
        current.leverage ??= state.leverage;
        current.initialMargin = initialMarginFor(nextSize.abs().times(multiplier).times(nextEntry), current.leverage, market).toFixed();
      } else if (remainsSameSide) {
        current.initialMargin = current.initialMargin
          ? D(current.initialMargin).times(nextSize.abs()).div(currentSize.abs()).toFixed()
          : initialMarginFor(nextSize.abs().times(multiplier).times(nextEntry), current.leverage ?? state.leverage, market).toFixed();
      } else {
        current.leverage = state.leverage;
        current.initialMargin = initialMarginFor(nextSize.abs().times(multiplier).times(price), state.leverage, market).toFixed();
      }
    }
  } else {
    const leverage = state.leverage;
    const initialMargin = market.product === 'option'
      ? ZERO
      : initialMarginFor(signedFill.abs().times(multiplier).times(price), leverage, market);
    state.positions.push({
      contract: market.contract, product: market.product, quantity: signedFill.toFixed(),
      entryPrice: price.toFixed(), multiplier: multiplier.toFixed(), markPrice: market.mark, updatedAt: Date.now(),
      ...(market.product === 'option' ? {} : { initialMargin: initialMargin.toFixed(), leverage }),
    });
  }

  order.remaining = D(order.remaining).minus(size).toFixed();
  if (D(order.remaining).lte(0)) order.status = 'filled';
  const fill: PaperFill = {
    id: randomUUID(), orderId: order.id, contract: order.contract, product: market.product,
    side: order.side, quantity: size.toFixed(), price: price.toFixed(), fee: fee.toFixed(),
    feeRate: feeRate.toFixed(), liquidity, referencePrice: basePrice.toFixed(),
    marketUpdatedAt: market.updatedAt, createdAt: Date.now(), slippageBps: extraSlippage.times(10000).toFixed(),
  };
  state.fills.unshift(fill);
  state.fills = state.fills.slice(0, MAX_ROWS);
  if (!realized.eq(0) && market.product !== 'option') addLedger(state, 'realized_pnl', realized, 'Position closed or reduced', market.contract);
  if (!fee.eq(0)) addLedger(state, 'trade_fee', fee.negated(), liquidation ? 'Simulated liquidation fee' : `${liquidity} trading fee`, market.contract);
  if (market.product === 'option') addLedger(state, 'option_premium', size.times(price).times(multiplier).times(-sign), 'Options premium cashflow', market.contract);
}

function simulateLiquidation(state: PaperState, market: MarketSnapshot) {
  if (market.product !== 'perpetual' || market.contractType !== 'direct') return;
  const position = state.positions.find((item) => item.contract === market.contract);
  if (!position || position.liquidationTriggeredAt) return;
  const risk = calculatePositionRisk(position, market);
  if (risk.status !== 'ready' || Number(risk.marginRatio) > 100) return;

  const quantity = D(position.quantity).abs();
  const closeSide: OrderSide = D(position.quantity).gt(0) ? 'sell' : 'buy';
  position.liquidationTriggeredAt = Date.now();
  for (const order of state.orders) {
    if (order.contract === market.contract && order.status === 'open') {
      order.status = 'cancelled';
      order.note = 'Cancelled by simulated liquidation.';
    }
  }
  const order: PaperOrder = {
    id: randomUUID(), contract: market.contract, product: market.product, side: closeSide, kind: 'market',
    quantity: quantity.toFixed(), remaining: quantity.toFixed(), limitPrice: null, status: 'open',
    createdAt: Date.now(), note: 'Simulated liquidation; public visible depth only.',
  };
  const levels = closeSide === 'sell' ? market.bids : market.asks;
  for (const level of levels) {
    if (!D(order.remaining).gt(0)) break;
    const size = Decimal.min(D(order.remaining), D(level.size));
    applyFill(state, order, market, size, D(level.price), 'taker', true);
  }
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, MAX_ROWS);
  const residual = D(order.remaining);
  order.status = residual.eq(0) ? 'filled' : 'cancelled';
  if (residual.gt(0)) order.note = 'Simulated liquidation depth was insufficient; residual position retained and frozen.';
  const events = state.riskEvents ?? (state.riskEvents = []);
  events.unshift({
    id: randomUUID(), type: 'simulated_liquidation', contract: market.contract, markPrice: market.mark,
    marginRatio: risk.marginRatio ?? '0', quantity: quantity.toFixed(),
    executedQuantity: quantity.minus(residual).toFixed(), residualQuantity: residual.toFixed(),
    status: residual.eq(0) ? 'complete' : residual.eq(quantity) ? 'no_depth' : 'partial',
    createdAt: Date.now(), note: residual.gt(0) ? 'Residual exposure remains frozen; Gate insurance/ADL is not simulated.' : 'Closed against visible public order-book depth.',
  });
  state.riskEvents = events.slice(0, MAX_ROWS);
}

function checkMargin(state: PaperState, market: MarketSnapshot, quantity: Decimal, side: OrderSide, markets: Record<string, MarketSnapshot>) {
  if (market.product === 'option') {
    const position = state.positions.find((item) => item.contract === market.contract);
    if (side === 'sell' && (!position || !D(position.quantity).gt(0) || quantity.gt(position.quantity))) {
      throw new Error('Opening short options is disabled until Gate-specific option margin rules are modeled.');
    }
    return;
  }
  const metrics = accountMetrics(state, markets);
  const current = state.positions.find((position) => position.contract === market.contract);
  const currentQuantity = current ? D(current.quantity) : ZERO;
  const signedOrder = quantity.times(side === 'buy' ? 1 : -1);
  const projected = currentQuantity.plus(signedOrder);
  const reversed = !currentQuantity.eq(0) && currentQuantity.isPositive() !== signedOrder.isPositive();
  const increasing = reversed ? projected.abs().gt(0) : projected.abs().gt(currentQuantity.abs());
  if (!increasing) return;

  const reference = market.mark;
  const exposureQuantity = projected.abs();
  let projectedEntry = D(reference);
  if (current && !reversed && currentQuantity.isPositive() === signedOrder.isPositive()) {
    projectedEntry = currentQuantity.abs().times(current.entryPrice).plus(quantity.times(reference)).div(exposureQuantity);
  }
  const liveGatePerpetual = market.product === 'perpetual' && market.source !== 'fixture';
  if (liveGatePerpetual) {
    if (market.contractType !== 'direct') throw new Error('Risk-increasing orders require a verified direct USDT contract.');
    if (!market.riskTiers?.length || !market.riskUpdatedAt || Date.now() - market.riskUpdatedAt > RISK_MAX_AGE_MS) {
      throw new Error(market.riskDataError ?? 'Fresh Gate risk tiers are required to increase exposure.');
    }
  }
  const notional = exposureQuantity.times(market.multiplier).times(projectedEntry);
  const required = initialMarginFor(notional, current && !reversed ? current.leverage ?? state.leverage : state.leverage, market);
  const existingMargin = current && !reversed ? D(current.initialMargin ?? 0) : ZERO;
  const incremental = Decimal.max(ZERO, required.minus(existingMargin));
  if (D(metrics.availableMargin).lt(incremental)) throw new Error('Not enough available margin for this paper order.');
}

export function placeOrder(
  state: PaperState,
  input: PlaceOrderInput,
  market: MarketSnapshot,
  markets: Record<string, MarketSnapshot> = { [market.contract]: market },
): PaperOrder {
  if (!market.connected || Date.now() - market.updatedAt > 15_000) throw new Error('Market data is stale or disconnected; paper orders are disabled.');
  const resolvedInput = input.notionalUsdt === undefined
    ? input
    : { ...input, quantity: contractsForUsdtNotional(input, market) };
  validateOrder(resolvedInput, market);
  const quantity = D(resolvedInput.quantity ?? 0);
  checkMargin(state, market, quantity, input.side, markets);
  const reduceOnly = input.reduceOnly === true;
  if (reduceOnly) {
    const position = state.positions.find((item) => item.contract === market.contract);
    if (!position || D(position.quantity).eq(0) || (input.side === 'buy' ? D(position.quantity).gt(0) : D(position.quantity).lt(0)) || quantity.gt(D(position.quantity).abs())) {
      throw new Error('Reduce-only orders must decrease an existing position.');
    }
  }
  const order: PaperOrder = {
    id: randomUUID(), contract: input.contract, product: market.product, side: input.side, kind: input.kind,
    quantity: quantity.toFixed(), remaining: quantity.toFixed(), limitPrice: input.limitPrice ?? null,
    status: 'open', createdAt: Date.now(), note: input.kind.startsWith('trigger-') ? 'Paper trigger order; waiting for reference price.' : 'Paper order; estimated execution',
    ...(market.product === 'option' ? {} : { leverage: state.leverage }),
    triggerPrice: input.triggerPrice ?? null, triggerReference: input.triggerReference ?? 'mark', reduceOnly, expiresAt: input.expiresAt ?? null,
  };
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, MAX_ROWS);

  if (input.kind === 'trigger-market' || input.kind === 'trigger-limit') return order;
  if (input.kind === 'market') {
    const levels = input.side === 'buy' ? market.asks : market.bids;
    let remaining = quantity;
    for (const level of levels) {
      if (!remaining.gt(0)) break;
      const available = D(level.size);
      const fillSize = Decimal.min(remaining, available);
      applyFill(state, order, market, fillSize, D(level.price), 'taker');
      remaining = D(order.remaining);
    }
    if (D(order.remaining).gt(0)) {
      order.status = D(order.remaining).eq(quantity) ? 'rejected' : 'cancelled';
      order.note = 'Visible order-book depth was insufficient; unfilled quantity was cancelled.';
    }
  } else {
    const limit = D(input.limitPrice!);
    const levels = input.side === 'buy' ? market.asks : market.bids;
    let remaining = quantity;
    for (const level of levels) {
      const levelPrice = D(level.price);
      const marketable = input.side === 'buy' ? levelPrice.lte(limit) : levelPrice.gte(limit);
      if (!marketable || !remaining.gt(0)) break;
      const fillSize = Decimal.min(remaining, D(level.size));
      applyFill(state, order, market, fillSize, levelPrice, 'taker');
      remaining = D(order.remaining);
    }
  }
  return order;
}

export function cancelOrder(state: PaperState, orderId: string) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order || order.status !== 'open') throw new Error('Open paper order not found.');
  order.status = 'cancelled';
  return order;
}

export function processTrade(state: PaperState, market: MarketSnapshot, trade: MarketSnapshot['trades'][number]) {
  const resting = state.orders
    .filter((order) => order.status === 'open' && order.contract === market.contract && order.kind === 'limit')
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const order of resting) {
    if (!D(order.remaining).gt(0)) continue;
    if (trade.time < order.createdAt) continue;
    const restingSide = trade.side === 'buy' ? 'sell' : 'buy';
    if (order.side !== restingSide) continue;
    const crossed = order.side === 'buy'
      ? D(trade.price).lte(order.limitPrice!)
      : D(trade.price).gte(order.limitPrice!);
    if (!crossed) continue;
    const size = Decimal.min(order.remaining, trade.size);
    applyFill(state, order, market, size, D(order.limitPrice!), 'maker');
  }
}

function processTriggers(state: PaperState, market: MarketSnapshot) {
  const referencePrices: Record<TriggerReference, string> = {
    mark: market.mark,
    last: market.last,
    index: market.index,
  };
  const triggered = state.orders.filter((order) => (
    order.status === 'open' && order.contract === market.contract &&
    (order.kind === 'trigger-market' || order.kind === 'trigger-limit') && order.triggerPrice
  ));
  for (const order of triggered) {
    if (order.expiresAt && Date.now() >= order.expiresAt) {
      order.status = 'cancelled';
      order.note = 'Trigger expired before activation.';
      continue;
    }
    const reference = D(referencePrices[order.triggerReference ?? 'mark']);
    const trigger = D(order.triggerPrice!);
    const crossed = order.side === 'buy' ? reference.gte(trigger) : reference.lte(trigger);
    if (!crossed) continue;
    if (order.reduceOnly) {
      const position = state.positions.find((item) => item.contract === market.contract);
      const positionQuantity = position ? D(position.quantity) : ZERO;
      const reduces = position && !positionQuantity.eq(0) &&
        (order.side === 'sell' ? positionQuantity.gt(0) : positionQuantity.lt(0)) &&
        D(order.remaining).lte(positionQuantity.abs());
      if (!reduces) {
        order.status = 'cancelled';
        order.note = 'Reduce-only trigger cancelled because the position was already closed or changed.';
        continue;
      }
    }
    order.triggeredAt = Date.now();
    order.note = `Triggered from ${order.triggerReference ?? 'mark'} price.`;
    order.kind = order.kind === 'trigger-market' ? 'market' : 'limit';
    const levels = order.side === 'buy' ? market.asks : market.bids;
    let remaining = D(order.remaining);
    for (const level of levels) {
      if (!remaining.gt(0)) break;
      const levelPrice = D(level.price);
      const marketable = order.kind === 'market' || (order.side === 'buy' ? levelPrice.lte(order.limitPrice!) : levelPrice.gte(order.limitPrice!));
      if (!marketable) break;
      const size = Decimal.min(remaining, D(level.size));
      applyFill(state, order, market, size, levelPrice, 'taker');
      remaining = D(order.remaining);
    }
    if (remaining.gt(0)) {
      order.status = remaining.eq(D(order.quantity)) ? 'rejected' : 'cancelled';
      order.note += ' Visible depth was insufficient; unfilled quantity was cancelled.';
    }
  }
}

export function markToMarket(
  state: PaperState,
  market: MarketSnapshot,
  fundingEvent?: { at: number; rate: string; markPrice: string },
) {
  if (market.product === 'option' && market.options?.settlement) {
    const position = state.positions.find((item) => item.contract === market.contract);
    if (!position) return;
    const payout = D(position.quantity).times(market.options.settlement.profitPerContract);
    const settlementFee = D(position.quantity).abs().times(market.options.settlement.feePerContract);
    addLedger(
      state,
      'option_settlement',
      payout.minus(settlementFee),
      `Gate expiry settlement at ${market.options.settlement.settlePrice}`,
      market.contract,
    );
    state.positions = state.positions.filter((item) => item.contract !== market.contract);
    return;
  }
  if (market.product === 'delivery' && market.expiryAt && Date.now() >= market.expiryAt && Number(market.settlementPrice) > 0) {
    const position = state.positions.find((item) => item.contract === market.contract);
    if (position) {
      const quantity = D(position.quantity);
      const settlementPrice = D(market.settlementPrice!);
      const multiplier = D(position.multiplier);
      const pnl = quantity.times(settlementPrice.minus(position.entryPrice)).times(multiplier);
      const fee = quantity.abs().times(settlementPrice).times(multiplier).times(market.settlementFeeRate ?? '0');
      addLedger(state, 'delivery_settlement', pnl, `Gate delivery settlement at ${settlementPrice.toFixed()}`, market.contract);
      if (!fee.eq(0)) addLedger(state, 'trade_fee', fee.negated(), 'Delivery settlement fee', market.contract);
      state.positions = state.positions.filter((item) => item.contract !== market.contract);
    }
    for (const order of state.orders) {
      if (order.contract === market.contract && order.status === 'open') {
        order.status = 'cancelled';
        order.note = 'Cancelled at contract expiry.';
      }
    }
    return;
  }
  for (const position of state.positions) {
    if (position.contract !== market.contract) continue;
    if (market.product === 'option' && !D(market.mark).gt(0)) continue;
    position.markPrice = market.mark;
    position.updatedAt = Date.now();
  }
  processTriggers(state, market);
  if (fundingEvent && market.product === 'perpetual' && Date.now() >= fundingEvent.at && (state.lastFundingAt[market.contract] ?? 0) < fundingEvent.at) {
    state.lastFundingAt[market.contract] = fundingEvent.at;
    const position = state.positions.find((item) => item.contract === market.contract);
    if (position) {
      const signedNotional = D(position.quantity).times(position.multiplier).times(fundingEvent.markPrice);
      const payment = signedNotional.times(fundingEvent.rate).negated();
      position.marginAdjustment = D(position.marginAdjustment ?? 0).plus(payment).toFixed();
      addLedger(state, 'funding', payment, `Funding at ${(D(fundingEvent.rate).times(100)).toFixed(5)}%`, market.contract);
    }
  }
  simulateLiquidation(state, market);
}

export function updateSettings(state: PaperState, input: { leverage?: number; warningMarginRatio?: number; makerFeeRate?: string; takerFeeRate?: string; slippageBps?: string }) {
  if (input.leverage !== undefined) {
    if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 100) throw new Error('Leverage must be a whole number between 1 and 100.');
    state.leverage = input.leverage;
  }
  if (input.warningMarginRatio !== undefined) {
    if (!Number.isFinite(input.warningMarginRatio) || input.warningMarginRatio < 100 || input.warningMarginRatio > 500) {
      throw new Error('Warning margin ratio must be between 100% and 500%.');
    }
    state.warningMarginRatio = input.warningMarginRatio;
  }
  for (const key of ['makerFeeRate', 'takerFeeRate', 'slippageBps'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const amount = D(value);
    if (!amount.isFinite() || amount.lt(0) || (key === 'slippageBps' && amount.gt(1000)) || (key !== 'slippageBps' && amount.gt(0.02))) {
      throw new Error(`Invalid ${key}.`);
    }
    state[key] = amount.toFixed();
  }
}

export function resetAccount(state: PaperState, initialBalance = state.initialBalance): PaperState {
  return createInitialState(initialBalance);
}

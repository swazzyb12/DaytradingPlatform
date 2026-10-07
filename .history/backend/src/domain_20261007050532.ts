import { Decimal } from 'decimal.js';
import { randomUUID } from 'node:crypto';

export type OrderSide = 'buy' | 'sell';
export type OrderKind = 'market' | 'limit';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';
export type ProductKind = 'perpetual' | 'delivery' | 'option';

export interface BookLevel {
  price: string;
  size: string;
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
}

export interface PaperPosition {
  contract: string;
  product: ProductKind;
  quantity: string;
  entryPrice: string;
  multiplier: string;
  markPrice: string;
  updatedAt: number;
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

export interface PaperState {
  version: 1;
  initialBalance: string;
  balance: string;
  leverage: number;
  makerFeeRate: string;
  takerFeeRate: string;
  slippageBps: string;
  orders: PaperOrder[];
  positions: PaperPosition[];
  fills: PaperFill[];
  ledger: LedgerEntry[];
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
}

const D = (value: Decimal.Value) => new Decimal(value);
const ZERO = new Decimal(0);
const MAX_ROWS = 250;

export function createInitialState(initialBalance = '10000'): PaperState {
  const balance = D(initialBalance).toFixed();
  return {
    version: 1,
    initialBalance: balance,
    balance,
    leverage: 5,
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
    return total.plus(D(position.quantity).abs().times(position.multiplier).times(market.mark).div(state.leverage));
  }, ZERO);
  const pendingMargin = state.orders.filter((order) => order.status === 'open').reduce((total, order) => {
    const market = markets[order.contract];
    if (!market || market.product === 'option') return total;
    const reference = order.limitPrice ?? market.mark;
    return total.plus(D(order.remaining).times(market.multiplier).times(reference).div(state.leverage));
  }, ZERO);
  const equity = D(state.balance).plus(unrealized);
  return {
    balance: state.balance,
    unrealizedPnl: unrealized.toFixed(2),
    equity: equity.toFixed(2),
    usedMargin: usedMargin.toFixed(2),
    pendingMargin: pendingMargin.toFixed(2),
    availableMargin: equity.minus(usedMargin).minus(pendingMargin).toFixed(2),
  };
}

function validateOrder(input: PlaceOrderInput, market: MarketSnapshot) {
  if (market.product !== (input.product ?? 'perpetual')) throw new Error('Selected product does not match the contract.');
  if (input.notionalUsdt !== undefined && market.product === 'option') throw new Error('Options orders use contract quantity, not USDT notional.');
  const quantity = D(input.quantity);
  if (!quantity.isFinite() || !quantity.gt(0)) throw new Error('Quantity must be greater than zero.');
  if (quantity.lt(market.minSize)) throw new Error(`Minimum size is ${market.minSize}.`);
  if (!quantity.mod(market.sizeStep).eq(0)) throw new Error(`Quantity must follow the ${market.sizeStep} size step.`);
  if (input.kind === 'limit') {
    if (!input.limitPrice || !D(input.limitPrice).isFinite() || !D(input.limitPrice).gt(0)) throw new Error('A positive limit price is required.');
    if (!D(input.limitPrice).mod(market.priceStep).eq(0)) throw new Error(`Price must follow the ${market.priceStep} tick size.`);
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

function applyFill(state: PaperState, order: PaperOrder, market: MarketSnapshot, size: Decimal, basePrice: Decimal, liquidity: 'maker' | 'taker') {
  if (!size.gt(0)) return;
  const sign = order.side === 'buy' ? 1 : -1;
  const extraSlippage = liquidity === 'taker' ? D(state.slippageBps).div(10000) : ZERO;
  const price = basePrice.times(sign > 0 ? D(1).plus(extraSlippage) : D(1).minus(extraSlippage));
  const multiplier = D(market.multiplier);
  const feeRate = D(liquidity === 'maker' ? state.makerFeeRate : state.takerFeeRate);
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
    }
  } else {
    state.positions.push({
      contract: market.contract, product: market.product, quantity: signedFill.toFixed(),
      entryPrice: price.toFixed(), multiplier: multiplier.toFixed(), markPrice: market.mark, updatedAt: Date.now(),
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
  if (!fee.eq(0)) addLedger(state, 'trade_fee', fee.negated(), `${liquidity} trading fee`, market.contract);
  if (market.product === 'option') addLedger(state, 'option_premium', size.times(price).times(multiplier).times(-sign), 'Options premium cashflow', market.contract);
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
  const required = quantity.times(market.multiplier).times(market.mark).div(state.leverage);
  if (D(metrics.availableMargin).lt(required)) throw new Error('Not enough available margin for this paper order.');
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
  const order: PaperOrder = {
    id: randomUUID(), contract: input.contract, product: market.product, side: input.side, kind: input.kind,
    quantity: quantity.toFixed(), remaining: quantity.toFixed(), limitPrice: input.limitPrice ?? null,
    status: 'open', createdAt: Date.now(), note: 'Paper order; estimated execution',
  };
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, MAX_ROWS);

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
  if (!fundingEvent || market.product !== 'perpetual') return;
  if (Date.now() < fundingEvent.at || (state.lastFundingAt[market.contract] ?? 0) >= fundingEvent.at) return;
  state.lastFundingAt[market.contract] = fundingEvent.at;
  const position = state.positions.find((item) => item.contract === market.contract);
  if (!position) return;
  const signedNotional = D(position.quantity).times(position.multiplier).times(fundingEvent.markPrice);
  const payment = signedNotional.times(fundingEvent.rate).negated();
  addLedger(state, 'funding', payment, `Funding at ${(D(fundingEvent.rate).times(100)).toFixed(5)}%`, market.contract);
}

export function updateSettings(state: PaperState, input: { leverage?: number; makerFeeRate?: string; takerFeeRate?: string; slippageBps?: string }) {
  if (input.leverage !== undefined) {
    if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 100) throw new Error('Leverage must be a whole number between 1 and 100.');
    state.leverage = input.leverage;
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { accountMetrics, calculatePositionRisk, contractsForUsdtNotional, createInitialState, markToMarket, placeOrder, processTrade, updateSettings, type MarketSnapshot, type RiskTier } from './domain.js';

const market: MarketSnapshot = {
  contract: 'BTC_USDT', product: 'perpetual', source: 'fixture', connected: true,
  updatedAt: Date.now(), last: '100', mark: '100', index: '100', multiplier: '1',
  priceStep: '0.1', sizeStep: '1', minSize: '1', makerFeeRate: '0.0002', takerFeeRate: '0.0005',
  fundingRate: null, nextFundingAt: null,
  bids: [{ price: '99', size: '5' }], asks: [{ price: '101', size: '2' }, { price: '102', size: '2' }], trades: [],
};

const riskTiers: RiskTier[] = [
  { tier: 1, riskLimit: '20000', initialRate: '0.008', maintenanceRate: '0.004', leverageMax: '125', deduction: '0' },
  { tier: 2, riskLimit: '50000', initialRate: '0.009', maintenanceRate: '0.0045', leverageMax: '111', deduction: '10' },
  { tier: 3, riskLimit: '100000', initialRate: '0.01', maintenanceRate: '0.005', leverageMax: '100', deduction: '35' },
  { tier: 4, riskLimit: '200000', initialRate: '0.0133', maintenanceRate: '0.007', leverageMax: '75', deduction: '235' },
];

test('market buy walks visible asks and records fees and slippage', () => {
  const state = createInitialState('10000');
  const order = placeOrder(state, { contract: market.contract, side: 'buy', kind: 'market', quantity: '3' }, market);
  assert.equal(order.status, 'filled');
  assert.equal(state.fills.length, 2);
  assert.equal(state.fills[0].liquidity, 'taker');
  assert.ok(Number(state.balance) < 10000);
  assert.equal(state.positions[0].quantity, '3');
  assert.equal(accountMetrics(state, { [market.contract]: market }).unrealizedPnl, '-4.06');
});

test('resting limits fill only when a qualifying opposing trade arrives', () => {
  const state = createInitialState('10000');
  const order = placeOrder(state, { contract: market.contract, side: 'buy', kind: 'limit', quantity: '2', limitPrice: '99' }, market);
  assert.equal(order.status, 'open');
  processTrade(state, market, { id: '1', price: '98.9', size: '1', side: 'sell', time: Date.now() });
  assert.equal(order.remaining, '1');
  assert.equal(state.fills[0].liquidity, 'maker');
});

test('partial closes preserve the original entry price for remaining size', () => {
  const state = createInitialState('10000');
  placeOrder(state, { contract: market.contract, side: 'buy', kind: 'market', quantity: '2' }, market);
  const entry = state.positions[0].entryPrice;
  placeOrder(state, { contract: market.contract, side: 'sell', kind: 'market', quantity: '1' }, market);
  assert.equal(state.positions[0].quantity, '1');
  assert.equal(state.positions[0].entryPrice, entry);
});

test('margin checks include positions held in other contracts', () => {
  const state = createInitialState('100');
  state.positions.push({ contract: 'BTC_USDT', product: 'perpetual', quantity: '4', entryPrice: '100', multiplier: '1', markPrice: '100', updatedAt: Date.now() });
  const nextMarket = { ...market, contract: 'ETH_USDT', mark: '105', last: '105', index: '105', bids: [{ price: '104', size: '5' }], asks: [{ price: '105', size: '5' }] };
  assert.throws(() => placeOrder(state, { contract: nextMarket.contract, side: 'buy', kind: 'market', quantity: '1' }, nextMarket, { [market.contract]: market, [nextMarket.contract]: nextMarket }), /available margin/);
});

test('option premium cashflows settle once using Gate profit and fee fields', () => {
  const optionMarket: MarketSnapshot = {
    ...market,
    contract: 'BTC_USDT-TEST-C',
    product: 'option',
    mark: '0',
    multiplier: '0.01',
    sizeStep: '1',
    asks: [{ price: '10', size: '5' }],
    bids: [],
    options: {
      underlying: 'BTC_USDT', strike: '100', expiryAt: Date.now() - 1, call: true,
      impliedVolatility: '0.7', delta: '0.5', gamma: '0.1', vega: '0.2', theta: '-0.1',
      settlement: null,
    },
  };
  const state = createInitialState('10000');
  placeOrder(state, { contract: optionMarket.contract, product: 'option', side: 'buy', kind: 'market', quantity: '1' }, optionMarket);
  assert.equal(accountMetrics(state, { [optionMarket.contract]: optionMarket }).unrealizedPnl, '0.00');
  const balanceBeforeSettlement = Number(state.balance);
  optionMarket.options!.settlement = { profitPerContract: '0.5', feePerContract: '0.1', settlePrice: '101', strikePrice: '100' };
  markToMarket(state, optionMarket);
  assert.equal(state.positions.length, 0);
  assert.equal(Number(state.balance), Number((balanceBeforeSettlement + 0.4).toFixed(12)));
  assert.equal(state.ledger[0].type, 'option_settlement');
  assert.equal(state.ledger[0].amount, '0.4');
  markToMarket(state, optionMarket);
  assert.equal(state.ledger.filter((entry) => entry.type === 'option_settlement').length, 1);
});

test('rejects option sells that would open an unmodeled short position', () => {
  const optionMarket: MarketSnapshot = {
    ...market, contract: 'BTC_USDT-TEST-P', product: 'option', mark: '1', multiplier: '0.01',
    options: { underlying: 'BTC_USDT', strike: '100', expiryAt: Date.now() + 60_000, call: false, impliedVolatility: '0.5', delta: '-0.2', gamma: '0.1', vega: '0.2', theta: '-0.1' },
  };
  assert.throws(() => placeOrder(createInitialState(), { contract: optionMarket.contract, product: 'option', side: 'sell', kind: 'market', quantity: '1' }, optionMarket), /Opening short options is disabled/);
});

test('direct delivery positions settle only at Gate price and cancel open orders', () => {
  const state = createInitialState('1000');
  state.positions.push({ contract: 'BTC_USDT_20261007', product: 'delivery', quantity: '2', entryPrice: '100', multiplier: '1', markPrice: '104', updatedAt: Date.now() });
  state.orders.push({ id: 'pending', contract: 'BTC_USDT_20261007', product: 'delivery', side: 'buy', kind: 'limit', quantity: '1', remaining: '1', limitPrice: '99', status: 'open', createdAt: Date.now(), note: 'paper' });
  const deliveryMarket = { ...market, contract: 'BTC_USDT_20261007', product: 'delivery' as const, expiryAt: Date.now() - 1, settlementPrice: '105', settlementFeeRate: '0.001' };
  markToMarket(state, deliveryMarket);
  assert.equal(state.positions.length, 0);
  assert.equal(state.orders[0].status, 'cancelled');
  assert.equal(state.balance, '1009.79');
  assert.equal(state.ledger[1].type, 'delivery_settlement');
  assert.equal(state.ledger[1].amount, '10');
});

test('funding is applied once at its published time with opposite long and short cashflows', () => {
  const state = createInitialState('1000');
  state.positions.push({ contract: market.contract, product: 'perpetual', quantity: '2', entryPrice: '100', multiplier: '1', markPrice: '100', updatedAt: Date.now() });
  const fundingMarket = { ...market, mark: '100' };
  const at = Date.now() - 1;
  markToMarket(state, fundingMarket, { at, rate: '0.01', markPrice: '100' });
  markToMarket(state, fundingMarket, { at, rate: '0.01', markPrice: '100' });
  assert.equal(state.balance, '998');
  assert.equal(state.ledger.filter((entry) => entry.type === 'funding').length, 1);

  const shortState = createInitialState('1000');
  shortState.positions.push({ contract: market.contract, product: 'perpetual', quantity: '-2', entryPrice: '100', multiplier: '1', markPrice: '100', updatedAt: Date.now() });
  markToMarket(shortState, fundingMarket, { at, rate: '0.01', markPrice: '100' });
  assert.equal(shortState.balance, '1002');
});

test('rejects stale feed and invalid price increments', () => {
  const state = createInitialState();
  assert.throws(() => placeOrder(state, { contract: market.contract, side: 'buy', kind: 'market', quantity: '1' }, { ...market, updatedAt: 0 }), /stale/);
  assert.throws(() => placeOrder(state, { contract: market.contract, side: 'buy', kind: 'limit', quantity: '1', limitPrice: '99.05' }, market), /tick size/);
});

test('converts USDT notional to contracts by flooring to the contract size step', () => {
  const futures = { ...market, multiplier: '1', sizeStep: '1', minSize: '1' };
  const input = { contract: futures.contract, product: 'perpetual' as const, side: 'buy' as const, kind: 'market' as const, notionalUsdt: '350' };
  assert.equal(contractsForUsdtNotional(input, futures), '3');
  assert.throws(() => contractsForUsdtNotional({ ...input, notionalUsdt: '99' }, futures), /minimum of 100.00 USDT/);
});

test('USDT-sized futures orders retain contract quantity in fills and positions', () => {
  const futures = { ...market, multiplier: '1', sizeStep: '1', minSize: '1' };
  const state = createInitialState('10000');
  const order = placeOrder(state, { contract: futures.contract, product: 'perpetual', side: 'buy', kind: 'market', notionalUsdt: '350' }, futures);
  assert.equal(order.quantity, '3');
  assert.equal(state.positions[0].quantity, '3');
});

test('leverage changes futures margin requirement for the same USDT order', () => {
  const state = createInitialState('50');
  const input = { contract: market.contract, product: 'perpetual' as const, side: 'buy' as const, kind: 'market' as const, notionalUsdt: '300' };
  updateSettings(state, { leverage: 5 });
  assert.throws(() => placeOrder(state, input, market), /available margin/);
  updateSettings(state, { leverage: 10 });
  const order = placeOrder(state, input, market);
  assert.equal(order.quantity, '3');
  assert.equal(order.status, 'filled');
});

test('changing default leverage does not retroactively reduce an open position margin', () => {
  const state = createInitialState('10000');
  placeOrder(state, { contract: market.contract, side: 'buy', kind: 'market', quantity: '1' }, market);
  assert.equal(state.positions[0].leverage, 5);
  assert.equal(accountMetrics(state, { [market.contract]: market }).usedMargin, '20.00');
  updateSettings(state, { leverage: 10 });
  assert.equal(accountMetrics(state, { [market.contract]: market }).usedMargin, '20.00');
  assert.equal(state.positions[0].leverage, 5);
});

test('Gate tier maintenance is cumulative and includes the estimated liquidation fee', () => {
  const riskMarket = {
    ...market, contractType: 'direct' as const, riskTiers, riskUpdatedAt: Date.now(), exitFeeRate: '0.00075',
  };
  const position = {
    contract: market.contract, product: 'perpetual' as const, quantity: '1500', entryPrice: '100',
    multiplier: '1', markPrice: '100', updatedAt: Date.now(), initialMargin: '3112.5', leverage: 50,
  };
  const risk = calculatePositionRisk(position, riskMarket);
  assert.equal(risk.status, 'ready');
  assert.equal(risk.tier, 4);
  assert.equal(risk.maintenanceMargin, '927.50');
  assert.equal(risk.initialMargin, '3112.50');
});

test('isolated liquidation estimates sit below mark for longs and above mark for shorts', () => {
  const riskMarket = {
    ...market, contractType: 'direct' as const,
    riskTiers: [{ tier: 1, riskLimit: '1000', initialRate: '0.1', maintenanceRate: '0.01', leverageMax: '10', deduction: '0' }],
    riskUpdatedAt: Date.now(), exitFeeRate: '0.00075',
  };
  const base = {
    contract: market.contract, product: 'perpetual' as const, entryPrice: '100', multiplier: '1',
    markPrice: '100', updatedAt: Date.now(), initialMargin: '20', leverage: 5,
  };
  const longRisk = calculatePositionRisk({ ...base, quantity: '1' }, riskMarket);
  const shortRisk = calculatePositionRisk({ ...base, quantity: '-1' }, riskMarket);
  assert.equal(longRisk.status, 'ready');
  assert.equal(shortRisk.status, 'ready');
  assert.ok(Number(longRisk.liquidationPrice) < 100);
  assert.ok(Number(shortRisk.liquidationPrice) > 100);
});

test('live futures exposure increases require fresh risk tiers but closes remain available', () => {
  const liveMarket = { ...market, source: 'gate-rest' as const, contractType: 'direct' as const };
  const state = createInitialState('1000');
  assert.throws(() => placeOrder(state, { contract: market.contract, side: 'buy', kind: 'market', quantity: '1' }, liveMarket), /risk tiers/i);
  state.positions.push({
    contract: market.contract, product: 'perpetual', quantity: '1', entryPrice: '100', multiplier: '1',
    markPrice: '100', updatedAt: Date.now(), initialMargin: '20', leverage: 5,
  });
  assert.equal(placeOrder(state, { contract: market.contract, side: 'sell', kind: 'market', quantity: '1' }, liveMarket).status, 'filled');
  assert.equal(state.positions.length, 0);
});

test('liquidation walks available depth once and records insufficient depth residuals', () => {
  const riskMarket = {
    ...market, source: 'gate-rest' as const, contractType: 'direct' as const,
    riskTiers: [{ tier: 1, riskLimit: '1000', initialRate: '0.1', maintenanceRate: '0.01', leverageMax: '10', deduction: '0' }],
    riskUpdatedAt: Date.now(), exitFeeRate: '0.00075', mark: '90', updatedAt: Date.now(),
  };
  const state = createInitialState('1000');
  state.positions.push({
    contract: market.contract, product: 'perpetual', quantity: '1', entryPrice: '100', multiplier: '1',
    markPrice: '100', updatedAt: Date.now(), initialMargin: '1', leverage: 5,
  });
  state.orders.push({ id: 'resting', contract: market.contract, product: 'perpetual', side: 'buy', kind: 'limit', quantity: '1', remaining: '1', limitPrice: '80', status: 'open', createdAt: Date.now(), note: 'paper' });
  markToMarket(state, { ...riskMarket, bids: [{ price: '89', size: '1' }] });
  assert.equal(state.riskEvents[0].status, 'complete');
  assert.equal(state.positions.length, 0);
  assert.equal(state.orders.find((order) => order.id === 'resting')?.status, 'cancelled');

  const noDepthState = createInitialState('1000');
  noDepthState.positions.push({
    contract: market.contract, product: 'perpetual', quantity: '1', entryPrice: '100', multiplier: '1',
    markPrice: '100', updatedAt: Date.now(), initialMargin: '1', leverage: 5,
  });
  const noDepthMarket = { ...riskMarket, bids: [] };
  markToMarket(noDepthState, noDepthMarket);
  markToMarket(noDepthState, noDepthMarket);
  assert.equal(noDepthState.riskEvents.length, 1);
  assert.equal(noDepthState.riskEvents[0].status, 'no_depth');
  assert.equal(noDepthState.riskEvents[0].residualQuantity, '1');
  assert.ok(noDepthState.positions[0].liquidationTriggeredAt);
});

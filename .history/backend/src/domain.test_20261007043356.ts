import assert from 'node:assert/strict';
import test from 'node:test';
import { accountMetrics, createInitialState, placeOrder, processTrade, type MarketSnapshot } from './domain.js';

const market: MarketSnapshot = {
  contract: 'BTC_USDT', product: 'perpetual', source: 'fixture', connected: true,
  updatedAt: Date.now(), last: '100', mark: '100', index: '100', multiplier: '1',
  priceStep: '0.1', sizeStep: '1', minSize: '1', makerFeeRate: '0.0002', takerFeeRate: '0.0005',
  fundingRate: null, nextFundingAt: null,
  bids: [{ price: '99', size: '5' }], asks: [{ price: '101', size: '2' }, { price: '102', size: '2' }], trades: [],
};

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

test('rejects stale feed and invalid price increments', () => {
  const state = createInitialState();
  assert.throws(() => placeOrder(state, { contract: market.contract, side: 'buy', kind: 'market', quantity: '1' }, { ...market, updatedAt: 0 }), /stale/);
  assert.throws(() => placeOrder(state, { contract: market.contract, side: 'buy', kind: 'limit', quantity: '1', limitPrice: '99.05' }, market), /tick size/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBookDelta, bookUpdateHasGap, marketIsFresh, normalizeFuturesTrade, parseCandles, parseRiskTiers, type RawBookLevel } from './market.js';

test('book delta replaces levels and removes zero-size levels', () => {
  const bids: RawBookLevel[] = [{ price: '99', size: '2' }, { price: '98', size: '1' }];
  const asks: RawBookLevel[] = [{ price: '101', size: '3' }];
  applyBookDelta(bids, [['99', '0'], ['97', '4']]);
  applyBookDelta(asks, [['101', '5']]);
  assert.deepEqual(bids, [{ price: '98', size: '1' }, { price: '97', size: '4' }]);
  assert.deepEqual(asks, [{ price: '101', size: '5' }]);
});

test('fresh options REST snapshots are usable without claiming a socket feed', () => {
  assert.equal(marketIsFresh({ connected: true, updatedAt: Date.now(), product: 'option' } as never), true);
});

test('order-book resync accepts overlapping ranges and detects skipped IDs', () => {
  assert.equal(bookUpdateHasGap(100, 100, 102), false);
  assert.equal(bookUpdateHasGap(100, 101, 102), false);
  assert.equal(bookUpdateHasGap(100, 102, 103), true);
});

test('Gate sell trade sizes become positive quantities with a separate sell side', () => {
  assert.deepEqual(normalizeFuturesTrade('BTC_USDT', { id: 7, size: -12, price: '99', create_time_ms: 10 }, '100'), {
    id: '7', price: '99', size: '12', side: 'sell', time: 10,
  });
});

test('risk tier parser sorts valid rows and rejects incomplete metadata', () => {
  const rows = [
    { tier: 2, risk_limit: '50000', initial_rate: '0.02', maintenance_rate: '0.01', leverage_max: '50', deduction: '10' },
    { tier: 1, risk_limit: '20000', initial_rate: '0.01', maintenance_rate: '0.005', leverage_max: '100', deduction: '0' },
  ];
  assert.deepEqual(parseRiskTiers(rows).map((tier) => tier.tier), [1, 2]);
  assert.deepEqual(parseRiskTiers([{ ...rows[0], deduction: undefined }]), []);
  assert.deepEqual(parseRiskTiers({ data: rows }).map((tier) => tier.tier), [1, 2]);
});

test('candle parser normalizes Gate array candles and rejects malformed rows', () => {
  assert.deepEqual(parseCandles([['100', '4', '105', '106', '99', '100']]), [{ time: 100000, volume: '4', close: '105', high: '106', low: '99', open: '100' }]);
  assert.deepEqual(parseCandles([{ t: 100, v: 4, c: '105', h: '106', l: '99', o: '100' }]), [{ time: 100000, volume: '4', close: '105', high: '106', low: '99', open: '100' }]);
  assert.deepEqual(parseCandles([['bad', '4', '105']]), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBookDelta, bookUpdateHasGap, marketIsFresh, normalizeFuturesTrade, type RawBookLevel } from './market.js';

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

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBookDelta, type RawBookLevel } from './market.js';

test('book delta replaces levels and removes zero-size levels', () => {
  const bids: RawBookLevel[] = [{ price: '99', size: '2' }, { price: '98', size: '1' }];
  const asks: RawBookLevel[] = [{ price: '101', size: '3' }];
  applyBookDelta(bids, [['99', '0'], ['97', '4']]);
  applyBookDelta(asks, [['101', '5']]);
  assert.deepEqual(bids, [{ price: '98', size: '1' }, { price: '97', size: '4' }]);
  assert.deepEqual(asks, [{ price: '101', size: '5' }]);
});

import type { MarketSnapshot } from './domain.js';

export interface ReplayMarketEvent {
  id: number;
  modelVersion: 'paper-market-v1';
  contract: string;
  product: MarketSnapshot['product'];
  receivedAt: number;
  marketUpdatedAt: number;
  last: string;
  mark: string;
  index: string;
  bids: MarketSnapshot['bids'];
  asks: MarketSnapshot['asks'];
  trades: MarketSnapshot['trades'];
}

const MAX_EVENTS = 2_000;
let nextId = 1;
const events: ReplayMarketEvent[] = [];

export function recordMarketEvent(market: MarketSnapshot, receivedAt = Date.now()) {
  events.push({
    id: nextId++, modelVersion: 'paper-market-v1', contract: market.contract, product: market.product,
    receivedAt, marketUpdatedAt: market.updatedAt, last: market.last, mark: market.mark, index: market.index,
    bids: market.bids.slice(0, 20), asks: market.asks.slice(0, 20), trades: market.trades.slice(0, 40),
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function listMarketEvents(contract?: string, limit = 500) {
  const filtered = contract ? events.filter((event) => event.contract === contract) : events;
  return filtered.slice(-Math.min(Math.max(limit, 1), MAX_EVENTS));
}

export function clearMarketEvents() {
  events.length = 0;
}

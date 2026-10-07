import WebSocket from 'ws';
import type { BookLevel, MarketSnapshot, ProductKind } from './domain.js';

const REST = 'https://api.gateio.ws/api/v4';
const FUTURES_WS = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
const DEPTH = 20;
const FRESH_MS = 15_000;

export interface RawBookLevel {
  price: string;
  size: string;
}

export interface InstrumentSummary {
  contract: string;
  product: ProductKind;
  underlying?: string;
  strike?: string;
  expiryAt?: number;
  call?: boolean;
  mark?: string;
  last?: string;
  quoteCurrency?: string;
  multiplier?: string;
  makerFeeRate?: string;
  takerFeeRate?: string;
  priceStep?: string;
  sizeStep?: string;
  minSize?: string;
  fundingRate?: string;
  nextFundingAt?: number;
  impliedVolatility?: string;
  delta?: string;
  gamma?: string;
  vega?: string;
  theta?: string;
}

interface GateContract extends Record<string, unknown> {
  name: string;
  in_delisting?: boolean;
  quanto_multiplier?: string;
  multiplier?: string;
  order_price_round?: string;
  order_size_round?: string;
  order_size_min?: string;
  maker_fee_rate?: string;
  taker_fee_rate?: string;
  mark_price?: string;
  index_price?: string;
  last_price?: string;
  funding_rate?: string;
  funding_rate_indicative?: string;
  funding_next_apply?: number;
  orderbook_id?: number;
}

interface GateBook {
  id?: number;
  asks?: Array<{ p?: string; s?: string } | [string, string]>;
  bids?: Array<{ p?: string; s?: string } | [string, string]>;
}

interface GateWsMessage {
  channel?: string;
  event?: string;
  error?: unknown;
  result?: unknown;
}

function numeric(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : fallback;
}

function rows(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (Array.isArray(item)) return { price: String(item[0]), size: String(item[1]) };
    const level = item as { p?: unknown; s?: unknown; price?: unknown; size?: unknown };
    return { price: String(level.p ?? level.price ?? '0'), size: String(level.s ?? level.size ?? '0') };
  }).filter((level) => Number(level.price) > 0 && Number(level.size) > 0);
}

export function applyBookDelta(book: RawBookLevel[], updates: Array<[string, string] | { p: string; s: string }>) {
  for (const update of updates) {
    const price = Array.isArray(update) ? update[0] : update.p;
    const size = Array.isArray(update) ? update[1] : update.s;
    const existing = book.findIndex((level) => level.price === price);
    if (Number(size) === 0) {
      if (existing !== -1) book.splice(existing, 1);
    } else if (existing === -1) {
      book.push({ price, size });
    } else {
      book[existing].size = size;
    }
  }
}

function sortBook(bids: RawBookLevel[], asks: RawBookLevel[]) {
  bids.sort((left, right) => Number(right.price) - Number(left.price));
  asks.sort((left, right) => Number(left.price) - Number(right.price));
  bids.splice(DEPTH);
  asks.splice(DEPTH);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${REST}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Gate public API returned ${response.status} for ${path}`);
  return await response.json() as T;
}

function marketFromContract(contract: GateContract, book: GateBook, product: ProductKind): MarketSnapshot {
  const market: MarketSnapshot = {
    contract: contract.name,
    product,
    source: 'gate-rest',
    connected: false,
    updatedAt: Date.now(),
    last: numeric(contract.last_price, numeric(contract.mark_price, '0')),
    mark: numeric(contract.mark_price, numeric(contract.last_price, '0')),
    index: numeric(contract.index_price, numeric(contract.mark_price, '0')),
    multiplier: numeric(contract.quanto_multiplier ?? contract.multiplier, '1'),
    priceStep: numeric(contract.order_price_round, '0.01'),
    sizeStep: numeric(contract.order_size_round, '1'),
    minSize: numeric(contract.order_size_min, '1'),
    makerFeeRate: numeric(contract.maker_fee_rate, '0.0002'),
    takerFeeRate: numeric(contract.taker_fee_rate, '0.0005'),
    fundingRate: product === 'perpetual' ? numeric(contract.funding_rate, numeric(contract.funding_rate_indicative, '0')) : null,
    nextFundingAt: product === 'perpetual' && contract.funding_next_apply ? Number(contract.funding_next_apply) * 1000 : null,
    bids: rows(book.bids),
    asks: rows(book.asks),
    trades: [],
  };
  return market;
}

function tickerUpdate(current: MarketSnapshot, data: Record<string, unknown>) {
  current.last = numeric(data.last, current.last);
  current.mark = numeric(data.mark_price, current.mark);
  current.index = numeric(data.index_price, current.index);
  current.fundingRate = current.product === 'perpetual'
    ? numeric(data.funding_rate, numeric(data.funding_rate_indicative, current.fundingRate ?? '0'))
    : null;
  if (data.funding_next_apply) current.nextFundingAt = Number(data.funding_next_apply) * 1000;
  current.updatedAt = Date.now();
  current.source = 'gate-websocket';
}

export class GateMarketService {
  private markets: Record<string, MarketSnapshot> = {};
  private selected = 'BTC_USDT';
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1_000;
  private optionsTimer: NodeJS.Timeout | null = null;
  private orderBookId = 0;
  private stopped = false;
  private onUpdate: (market: MarketSnapshot, trade?: MarketSnapshot['trades'][number]) => void = () => {};

  setUpdateHandler(handler: (market: MarketSnapshot, trade?: MarketSnapshot['trades'][number]) => void) {
    this.onUpdate = handler;
  }

  getMarket(contract = this.selected) {
    return this.markets[contract] ?? null;
  }

  getMarkets() {
    return this.markets;
  }

  async listFutures(product: 'perpetual' | 'delivery' = 'perpetual'): Promise<InstrumentSummary[]> {
    const group = product === 'delivery' ? 'delivery' : 'futures';
    const contracts = await getJson<GateContract[]>(`/${group}/usdt/contracts`);
    return contracts.filter((item) => !item.in_delisting).map((item) => ({
      contract: item.name,
      product,
      mark: numeric(item.mark_price, '0'),
      last: numeric(item.last_price, '0'),
      multiplier: numeric(item.quanto_multiplier ?? item.multiplier, '1'),
      makerFeeRate: numeric(item.maker_fee_rate, '0.0002'),
      takerFeeRate: numeric(item.taker_fee_rate, '0.0005'),
      priceStep: numeric(item.order_price_round, '0.01'),
      sizeStep: numeric(item.order_size_round, '1'),
      minSize: numeric(item.order_size_min, '1'),
      fundingRate: product === 'perpetual' ? numeric(item.funding_rate, numeric(item.funding_rate_indicative, '0')) : undefined,
      nextFundingAt: product === 'perpetual' && item.funding_next_apply ? Number(item.funding_next_apply) * 1000 : undefined,
    })).sort((left, right) => left.contract.localeCompare(right.contract));
  }

  async listOptions(underlying?: string, expiration?: number): Promise<InstrumentSummary[]> {
    const base = underlying ? `/options/contracts?underlying=${encodeURIComponent(underlying)}` : '/options/underlyings';
    if (!underlying) {
      const underlyings = await getJson<Array<{ name: string }>>(base);
      const first = underlyings[0]?.name;
      if (!first) return [];
      return this.listOptions(first);
    }
    const expiryQuery = expiration ? `&expiration=${expiration}` : '';
    const contracts = await getJson<Array<Record<string, unknown> & { name: string }>>(`${base}${expiryQuery}`);
    return contracts.map((item) => ({
      contract: item.name,
      product: 'option' as const,
      underlying: String(item.underlying ?? underlying),
      strike: numeric(item.strike_price, '0'),
      expiryAt: Number(item.expiration_time ?? 0) * 1000,
      call: Boolean(item.is_call),
      mark: numeric(item.mark_price, numeric(item.last_price, '0')),
      last: numeric(item.last_price, '0'),
      multiplier: numeric(item.multiplier, '1'),
      makerFeeRate: numeric(item.maker_fee_rate, '0.0002'),
      takerFeeRate: numeric(item.taker_fee_rate, '0.0005'),
      priceStep: numeric(item.order_price_round, '0.0001'),
      sizeStep: '1',
      minSize: numeric(item.order_size_min, '1'),
      impliedVolatility: numeric(item.mark_iv, '0'),
      delta: numeric(item.delta, '0'),
      gamma: numeric(item.gamma, '0'),
      vega: numeric(item.vega, '0'),
      theta: numeric(item.theta, '0'),
    })).sort((left, right) => Number(left.expiryAt) - Number(right.expiryAt) || Number(left.strike) - Number(right.strike));
  }

  async select(contract: string, product: ProductKind = 'perpetual') {
    this.selected = contract;
    if (product === 'option') {
      await this.refreshOption(contract);
      this.startOptionPolling();
      this.closeSocket();
      return this.getMarket(contract);
    }
    this.stopOptionPolling();
    await this.refreshFuture(contract, product);
    this.connectSocket();
    return this.getMarket(contract);
  }

  async start() {
    const contracts = await this.listFutures('perpetual');
    const initial = contracts.find((item) => item.contract === 'BTC_USDT') ?? contracts[0];
    if (!initial) throw new Error('Gate returned no active USDT perpetual futures contracts.');
    await this.refreshFuture(initial.contract, 'perpetual');
    this.connectSocket();
  }

  stop() {
    this.stopped = true;
    this.stopOptionPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeSocket();
  }

  private async refreshFuture(contract: string, product: 'perpetual' | 'delivery') {
    const group = product === 'delivery' ? 'delivery' : 'futures';
    const [metadata, book] = await Promise.all([
      getJson<GateContract>(`/${group}/usdt/contracts/${encodeURIComponent(contract)}`),
      getJson<GateBook>(`/${group}/usdt/order_book?contract=${encodeURIComponent(contract)}&limit=${DEPTH}&with_id=true`),
    ]);
    const market = marketFromContract(metadata, book, product);
    this.orderBookId = Number(book.id ?? metadata.orderbook_id ?? 0);
    this.markets[contract] = market;
    this.onUpdate(market);
  }

  private async refreshOption(contract: string) {
    const [metadata, book] = await Promise.all([
      getJson<Record<string, unknown> & { name: string }>(`/options/contracts/${encodeURIComponent(contract)}`),
      getJson<GateBook>(`/options/order_book?contract=${encodeURIComponent(contract)}&limit=${DEPTH}`),
    ]);
    const underlying = String(metadata.underlying ?? 'BTC_USDT');
    const tickers = await getJson<Array<Record<string, unknown> & { name: string }>>(`/options/tickers?underlying=${encodeURIComponent(underlying)}`);
    const ticker = tickers.find((item) => item.name === contract) ?? {};
    const market: MarketSnapshot = {
      contract, product: 'option', source: 'gate-rest', connected: true, updatedAt: Date.now(),
      last: numeric(ticker.last_price, numeric(metadata.last_price, '0')),
      mark: numeric(ticker.mark_price, numeric(metadata.mark_price, '0')),
      index: numeric(ticker.index_price, numeric(metadata.underlying_price, '0')),
      multiplier: numeric(metadata.multiplier, '1'),
      priceStep: numeric(metadata.order_price_round, '0.0001'), sizeStep: '1',
      minSize: numeric(metadata.order_size_min, '1'),
      makerFeeRate: numeric(metadata.maker_fee_rate, '0.0002'),
      takerFeeRate: numeric(metadata.taker_fee_rate, '0.0005'),
      fundingRate: null, nextFundingAt: null, bids: rows(book.bids), asks: rows(book.asks), trades: [],
      options: {
        underlying, strike: numeric(metadata.strike_price, '0'),
        expiryAt: Number(metadata.expiration_time ?? 0) * 1000, call: Boolean(metadata.is_call),
        impliedVolatility: numeric(ticker.mark_iv, '0'), delta: numeric(ticker.delta, '0'),
        gamma: numeric(ticker.gamma, '0'), vega: numeric(ticker.vega, '0'), theta: numeric(ticker.theta, '0'),
      },
    };
    this.markets[contract] = market;
    this.onUpdate(market);
  }

  private startOptionPolling() {
    this.stopOptionPolling();
    this.optionsTimer = setInterval(() => {
      void this.refreshOption(this.selected).catch(() => {
        const market = this.markets[this.selected];
        if (market) market.connected = false;
      });
    }, 2_000);
  }

  private stopOptionPolling() {
    if (this.optionsTimer) clearInterval(this.optionsTimer);
    this.optionsTimer = null;
  }

  private connectSocket() {
    this.closeSocket();
    if (this.stopped) return;
    const socket = new WebSocket(FUTURES_WS);
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectDelay = 1_000;
      const contract = this.selected;
      for (const [channel, payload] of [
        ['futures.book_ticker', [contract]],
        ['futures.trades', [contract]],
        ['futures.order_book_update', [contract, '100ms']],
        ['futures.tickers', [contract]],
      ] as Array<[string, string[]]>) {
        socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel, event: 'subscribe', payload }));
      }
    });
    socket.on('message', (raw) => this.handleSocketMessage(raw.toString()));
    socket.on('error', () => {
      const market = this.markets[this.selected];
      if (market) market.connected = false;
    });
    socket.on('close', () => {
      const market = this.markets[this.selected];
      if (market) market.connected = false;
      this.socket = null;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connectSocket(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    });
  }

  private closeSocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  private handleSocketMessage(raw: string) {
    let message: GateWsMessage;
    try {
      message = JSON.parse(raw) as GateWsMessage;
    } catch {
      return;
    }
    if (message.event !== 'update' || !message.result || typeof message.result !== 'object') return;
    const data = message.result as Record<string, unknown>;
    const market = this.markets[this.selected];
    if (!market || market.product === 'option') return;
    if (message.channel === 'futures.tickers' || message.channel === 'futures.book_ticker') {
      if (data.contract && data.contract !== market.contract) return;
      tickerUpdate(market, data);
      market.connected = true;
      this.onUpdate(market);
      return;
    }
    if (message.channel === 'futures.order_book_update') {
      if (String(data.s ?? data.contract) !== market.contract) return;
      const first = Number(data.U ?? 0);
      const last = Number(data.u ?? data.id ?? 0);
      if (last && last <= this.orderBookId) return;
      if (first && this.orderBookId && first !== this.orderBookId + 1) {
        void this.refreshFuture(market.contract, 'perpetual').then(() => this.connectSocket());
        return;
      }
      applyBookDelta(market.bids, (data.b ?? data.bids ?? []) as Array<[string, string] | { p: string; s: string }>);
      applyBookDelta(market.asks, (data.a ?? data.asks ?? []) as Array<[string, string] | { p: string; s: string }>);
      sortBook(market.bids, market.asks);
      this.orderBookId = last || this.orderBookId;
      market.connected = true;
      market.source = 'gate-websocket';
      market.updatedAt = Date.now();
      this.onUpdate(market);
      return;
    }
    if (message.channel === 'futures.trades') {
      const messages = Array.isArray(data) ? data : [data];
      for (const item of messages as Array<Record<string, unknown>>) {
        if (item.contract && item.contract !== market.contract) continue;
        const trade = {
          id: String(item.id ?? `${Date.now()}-${Math.random()}`),
          price: numeric(item.price, market.last),
          size: numeric(item.size, '0'),
          side: item.size && Number(item.size) < 0 ? 'sell' as const : 'buy' as const,
          time: Number(item.create_time_ms ?? Number(item.create_time ?? Date.now() / 1000) * 1000),
        };
        market.last = trade.price;
        market.trades.unshift(trade);
        market.trades = market.trades.slice(0, 40);
        market.connected = true;
        market.updatedAt = Date.now();
        market.source = 'gate-websocket';
        this.onUpdate(market, trade);
      }
    }
  }
}

export function marketIsFresh(market: MarketSnapshot | null): boolean {
  return Boolean(market?.connected && Date.now() - market.updatedAt < FRESH_MS);
}

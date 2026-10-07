import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import {
  accountMetrics, cancelOrder, createInitialState, markToMarket, placeOrder,
  processTrade, resetAccount, updateSettings, type MarketSnapshot, type PaperState, type PlaceOrderInput,
} from './domain.js';
import { GateMarketService, marketIsFresh, type InstrumentSummary } from './market.js';
import { openPaperStore } from './store.js';

const port = Number(process.env.PORT ?? 3001);
const api = Fastify({ logger: true });
await api.register(cors, { origin: true });
await api.register(websocket);

const store = await openPaperStore();
let paper: PaperState = store.load();
paper.riskEvents ??= [];
const gate = new GateMarketService();
const clients = new Set<WebSocket>();
const fundingTimers = new Map<string, { at: number; rate: string; markPrice: string; timer: NodeJS.Timeout }>();

function publish(event: unknown) {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function persistAndPublish() {
  store.save(paper);
  publish({ type: 'paper', state: paper, metrics: accountMetrics(paper, gate.getMarkets()) });
}

function scheduleFunding(market: MarketSnapshot) {
  if (market.product !== 'perpetual' || !market.fundingRate || !market.nextFundingAt || !market.mark) return;
  const current = fundingTimers.get(market.contract);
  if (current && current.at === market.nextFundingAt && current.rate === market.fundingRate) return;
  if (current) {
    clearTimeout(current.timer);
    fundingTimers.delete(market.contract);
    if (current.at <= Date.now()) {
      markToMarket(paper, market, current);
      persistAndPublish();
    }
  }
  if ((paper.lastFundingAt[market.contract] ?? 0) >= market.nextFundingAt) return;
  const event = { at: market.nextFundingAt, rate: market.fundingRate, markPrice: market.mark };
  const timer = setTimeout(() => {
    fundingTimers.delete(market.contract);
    markToMarket(paper, market, event);
    persistAndPublish();
  }, Math.max(0, event.at - Date.now()));
  fundingTimers.set(market.contract, { ...event, timer });
}

gate.setUpdateHandler((market, trade) => {
  if (trade) processTrade(paper, market, trade);
  markToMarket(paper, market);
  scheduleFunding(market);
  store.save(paper);
  publish({ type: 'market', market });
  publish({ type: 'paper', state: paper, metrics: accountMetrics(paper, gate.getMarkets()) });
});

api.get('/api/health', async () => ({ status: 'ok', mode: 'paper-only' }));

api.get<{ Querystring: { product?: 'perpetual' | 'delivery' | 'option'; underlying?: string; expiration?: string } }>(
  '/api/instruments', async (request, reply) => {
    try {
      const product = request.query.product ?? 'perpetual';
      let instruments: InstrumentSummary[];
      if (product === 'option') {
        instruments = await gate.listOptions(request.query.underlying, request.query.expiration ? Number(request.query.expiration) : undefined);
      } else {
        instruments = await gate.listFutures(product);
      }
      return { instruments, source: 'gate-rest', updatedAt: Date.now() };
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: 'Gate market data is temporarily unavailable.' });
    }
  },
);

api.get('/api/market', async () => ({ market: gate.getMarket(), feed: gate.getMarket()?.connected ? 'connected' : 'disconnected' }));
api.post<{ Body: { contract: string; product?: 'perpetual' | 'delivery' | 'option' } }>('/api/market/select', async (request, reply) => {
  try {
    const market = await gate.select(request.body.contract, request.body.product ?? 'perpetual');
    return { market, feed: market?.connected ? 'connected' : 'connecting' };
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : 'Unable to load market.' });
  }
});

api.get('/api/paper/state', async () => ({
  mode: 'paper-only', state: paper, metrics: accountMetrics(paper, gate.getMarkets()),
}));

api.post<{ Body: PlaceOrderInput }>('/api/paper/orders', async (request, reply) => {
  const market = gate.getMarket(request.body.contract);
  if (!market || !marketIsFresh(market)) return reply.code(409).send({ error: 'Live Gate market data is stale or unavailable; order rejected.' });
  try {
    const order = placeOrder(paper, request.body, market, gate.getMarkets());
    persistAndPublish();
    if (order.status === 'rejected') return reply.code(409).send({ error: order.note });
    return { order, state: paper, metrics: accountMetrics(paper, gate.getMarkets()) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Order rejected.' });
  }
});

api.delete<{ Params: { id: string } }>('/api/paper/orders/:id', async (request, reply) => {
  try {
    const order = cancelOrder(paper, request.params.id);
    persistAndPublish();
    return { order, state: paper };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Order not found.' });
  }
});

api.patch<{ Body: { leverage?: number; makerFeeRate?: string; takerFeeRate?: string; slippageBps?: string } }>('/api/paper/settings', async (request, reply) => {
  try {
    updateSettings(paper, request.body);
    persistAndPublish();
    return { state: paper, metrics: accountMetrics(paper, gate.getMarkets()) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid settings.' });
  }
});

api.post<{ Body: { initialBalance?: string } }>('/api/paper/reset', async (request, reply) => {
  const initialBalance = request.body.initialBalance ?? paper.initialBalance;
  if (!Number.isFinite(Number(initialBalance)) || Number(initialBalance) <= 0 || Number(initialBalance) > 1_000_000_000) {
    return reply.code(400).send({ error: 'Starting balance must be between 0 and 1,000,000,000.' });
  }
  paper = resetAccount(paper, initialBalance);
  persistAndPublish();
  return { state: paper, metrics: accountMetrics(paper, gate.getMarkets()) };
});

api.get('/api/ws', { websocket: true }, (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({
    type: 'snapshot', market: gate.getMarket(), state: paper,
    metrics: accountMetrics(paper, gate.getMarkets()),
  }));
  socket.on('close', () => clients.delete(socket));
});

try {
  await gate.start();
} catch (error) {
  api.log.error({ err: error }, 'Gate initial market snapshot failed; API will remain available and retry via market selection.');
}

await api.listen({ port, host: '127.0.0.1' });

const shutdown = async () => {
  gate.stop();
  store.close();
  await api.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

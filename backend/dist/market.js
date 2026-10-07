import WebSocket from 'ws';
const REST = 'https://api.gateio.ws/api/v4';
const FUTURES_WS = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
const DEPTH = 20;
const FRESH_MS = 15_000;
function numeric(value, fallback) {
    if (value === undefined || value === null || value === '')
        return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(value) : fallback;
}
function rows(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => {
        if (Array.isArray(item))
            return { price: String(item[0]), size: String(item[1]) };
        const level = item;
        return { price: String(level.p ?? level.price ?? '0'), size: String(level.s ?? level.size ?? '0') };
    }).filter((level) => Number(level.price) > 0 && Number(level.size) > 0);
}
export function parseRiskTiers(value) {
    const source = Array.isArray(value)
        ? value
        : Object.values((value ?? {})).find((item) => Array.isArray(item)) ?? [];
    if (!Array.isArray(source) || source.length === 0)
        return [];
    const tiers = source.map((item, index) => {
        const row = item;
        const parsed = {
            tier: Number(row.tier ?? index + 1),
            riskLimit: numeric(row.risk_limit, ''),
            initialRate: numeric(row.initial_rate, ''),
            maintenanceRate: numeric(row.maintenance_rate, ''),
            leverageMax: numeric(row.leverage_max, ''),
            deduction: numeric(row.deduction, ''),
        };
        if (!Number.isInteger(parsed.tier) || parsed.tier < 1 || Object.values(parsed).some((field) => field === '' || !Number.isFinite(Number(field))))
            return null;
        if (Number(parsed.riskLimit) <= 0 || Number(parsed.initialRate) < 0 || Number(parsed.maintenanceRate) < 0 || Number(parsed.leverageMax) <= 0)
            return null;
        return parsed;
    });
    if (tiers.some((tier) => tier === null))
        return [];
    const sorted = tiers.sort((left, right) => Number(left.riskLimit) - Number(right.riskLimit));
    if (sorted.some((tier, index) => index > 0 && Number(tier.riskLimit) <= Number(sorted[index - 1].riskLimit)))
        return [];
    return sorted;
}
function riskTableId(contract) {
    const direct = contract.risk_limit_table_id;
    if (typeof direct === 'string' || typeof direct === 'number')
        return String(direct);
    const table = contract.risk_limit_table;
    if (typeof table === 'string' || typeof table === 'number')
        return String(table);
    if (table && typeof table === 'object') {
        const row = table;
        const id = row.table_id ?? row.id;
        if (typeof id === 'string' || typeof id === 'number')
            return String(id);
    }
    return null;
}
export function applyBookDelta(book, updates) {
    for (const update of updates) {
        const price = Array.isArray(update) ? update[0] : update.p;
        const size = Array.isArray(update) ? update[1] : update.s;
        const existing = book.findIndex((level) => level.price === price);
        if (Number(size) === 0) {
            if (existing !== -1)
                book.splice(existing, 1);
        }
        else if (existing === -1) {
            book.push({ price, size });
        }
        else {
            book[existing].size = size;
        }
    }
}
export function bookUpdateHasGap(currentId, firstId, lastId) {
    return currentId > 0 && firstId > currentId + 1 && lastId > currentId;
}
function sortBook(bids, asks) {
    bids.sort((left, right) => Number(right.price) - Number(left.price));
    asks.sort((left, right) => Number(left.price) - Number(right.price));
    bids.splice(DEPTH);
    asks.splice(DEPTH);
}
async function getJson(path) {
    const response = await fetch(`${REST}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok)
        throw new Error(`Gate public API returned ${response.status} for ${path}`);
    return await response.json();
}
function marketFromContract(contract, book, product) {
    const market = {
        contract: contract.name,
        product,
        source: 'gate-rest',
        connected: product === 'delivery',
        updatedAt: Date.now(),
        bookId: Number(book.id ?? contract.orderbook_id ?? 0),
        expiryAt: contract.expire_time ? Number(contract.expire_time) * 1000 : null,
        settlementPrice: product === 'delivery' ? numeric(contract.settle_price, '0') : null,
        settlementFeeRate: product === 'delivery' ? numeric(contract.settle_fee_rate, '0') : null,
        contractType: contract.type === 'direct' ? 'direct' : contract.type === 'inverse' ? 'inverse' : 'unknown',
        exitFeeRate: product === 'perpetual' ? '0.00075' : undefined,
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
function tickerUpdate(current, data) {
    current.last = numeric(data.last, current.last);
    current.mark = numeric(data.mark_price, current.mark);
    current.index = numeric(data.index_price, current.index);
    current.fundingRate = current.product === 'perpetual'
        ? numeric(data.funding_rate, numeric(data.funding_rate_indicative, current.fundingRate ?? '0'))
        : null;
    if (data.funding_next_apply)
        current.nextFundingAt = Number(data.funding_next_apply) * 1000;
    current.updatedAt = Date.now();
    current.source = 'gate-websocket';
}
export function normalizeFuturesTrade(contract, item, fallbackPrice) {
    const signedSize = Number(item.size ?? 0);
    return {
        id: String(item.id ?? `${Date.now()}-${Math.random()}`),
        price: numeric(item.price, fallbackPrice),
        size: String(Math.abs(signedSize)),
        side: signedSize < 0 ? 'sell' : 'buy',
        time: Number(item.create_time_ms ?? Number(item.create_time ?? Date.now() / 1000) * 1000),
    };
}
export class GateMarketService {
    markets = {};
    selected = 'BTC_USDT';
    socket = null;
    reconnectTimer = null;
    reconnectDelay = 1_000;
    optionsTimer = null;
    riskTimer = null;
    orderBookId = 0;
    bookResyncPending = false;
    bookBuffer = [];
    deliveryTimer = null;
    deliveryRefreshPending = false;
    optionRefreshPending = false;
    seenDeliveryTrades = new Map();
    stopped = false;
    onUpdate = () => { };
    setUpdateHandler(handler) {
        this.onUpdate = handler;
    }
    getMarket(contract = this.selected) {
        return this.markets[contract] ?? null;
    }
    getMarkets() {
        return this.markets;
    }
    async listFutures(product = 'perpetual') {
        const group = product === 'delivery' ? 'delivery' : 'futures';
        const [contracts, tickers] = await Promise.all([
            getJson(`/${group}/usdt/contracts`),
            getJson(`/${group}/usdt/tickers`).catch(() => []),
        ]);
        const tickerByContract = new Map(tickers.map((ticker) => [String(ticker.contract ?? ticker.name ?? ''), ticker]));
        return contracts.filter((item) => !item.in_delisting && (product !== 'delivery' || item.type === 'direct')).map((item) => ({
            ...(() => { const ticker = tickerByContract.get(item.name) ?? {}; return { volume24hQuote: numeric(ticker.volume_24h_quote, '0'), change24hPct: numeric(ticker.change_percentage, '0'), change24hPrice: numeric(ticker.change_price, '0') }; })(),
            contract: item.name,
            product,
            expiryAt: product === 'delivery' && item.expire_time ? Number(item.expire_time) * 1000 : undefined,
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
    async listOptions(underlying, expiration) {
        const base = underlying ? `/options/contracts?underlying=${encodeURIComponent(underlying)}` : '/options/underlyings';
        if (!underlying) {
            const underlyings = await getJson(base);
            const first = underlyings[0]?.name;
            if (!first)
                return [];
            return this.listOptions(first);
        }
        const expiryQuery = expiration ? `&expiration=${expiration}` : '';
        const contracts = await getJson(`${base}${expiryQuery}`);
        return contracts.map((item) => ({
            contract: item.name,
            product: 'option',
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
    async select(contract, product = 'perpetual') {
        this.selected = contract;
        this.stopRiskPolling();
        if (product === 'option') {
            this.stopDeliveryPolling();
            await this.refreshOption(contract);
            this.startOptionPolling();
            this.closeSocket();
            return this.getMarket(contract);
        }
        this.stopOptionPolling();
        await this.refreshFuture(contract, product);
        if (product === 'delivery') {
            this.closeSocket();
            this.startDeliveryPolling();
        }
        else {
            this.stopDeliveryPolling();
            this.connectSocket();
            this.startRiskPolling(contract);
        }
        return this.getMarket(contract);
    }
    async start() {
        const contracts = await this.listFutures('perpetual');
        const initial = contracts.find((item) => item.contract === 'BTC_USDT') ?? contracts[0];
        if (!initial)
            throw new Error('Gate returned no active USDT perpetual futures contracts.');
        await this.refreshFuture(initial.contract, 'perpetual');
        this.startRiskPolling(initial.contract);
        this.connectSocket();
    }
    stop() {
        this.stopped = true;
        this.stopOptionPolling();
        this.stopDeliveryPolling();
        this.stopRiskPolling();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.closeSocket();
    }
    async refreshFuture(contract, product) {
        const group = product === 'delivery' ? 'delivery' : 'futures';
        const [metadata, book, trades] = await Promise.all([
            getJson(`/${group}/usdt/contracts/${encodeURIComponent(contract)}`),
            getJson(`/${group}/usdt/order_book?contract=${encodeURIComponent(contract)}&limit=${DEPTH}&with_id=true`),
            product === 'delivery'
                ? getJson(`/${group}/usdt/trades?contract=${encodeURIComponent(contract)}&limit=40`).catch(() => [])
                : Promise.resolve([]),
        ]);
        const market = marketFromContract(metadata, book, product);
        if (product === 'perpetual') {
            try {
                market.riskTiers = await this.loadRiskTiers(contract, metadata);
                market.riskUpdatedAt = Date.now();
            }
            catch (error) {
                market.riskDataError = error instanceof Error ? error.message : 'Gate risk tiers are unavailable.';
            }
        }
        this.orderBookId = Number(book.id ?? metadata.orderbook_id ?? 0);
        let newTrades = [];
        if (product === 'delivery') {
            const seen = this.seenDeliveryTrades.get(contract);
            if (seen) {
                newTrades = trades.filter((trade) => !seen.has(String(trade.id)));
                for (const trade of newTrades)
                    seen.add(String(trade.id));
                if (seen.size > 2000)
                    this.seenDeliveryTrades.set(contract, new Set([...seen].slice(-1000)));
            }
            else {
                this.seenDeliveryTrades.set(contract, new Set(trades.map((trade) => String(trade.id))));
            }
            market.trades = trades.slice(0, 40).map((trade) => normalizeFuturesTrade(contract, trade, market.last));
        }
        this.markets[contract] = market;
        this.onUpdate(market);
        for (const trade of newTrades) {
            const normalized = normalizeFuturesTrade(contract, trade, market.last);
            market.trades.unshift(normalized);
            market.trades = market.trades.slice(0, 40);
            this.onUpdate(market, normalized);
        }
    }
    async loadRiskTiers(contract, metadata) {
        let directError = 'Gate risk tiers are unavailable.';
        try {
            const direct = parseRiskTiers(await getJson(`/futures/usdt/risk_limit_tiers?contract=${encodeURIComponent(contract)}`));
            if (direct.length > 0)
                return direct;
            directError = 'Gate returned invalid or unsupported risk tier metadata.';
        }
        catch (error) {
            directError = error instanceof Error ? error.message : directError;
        }
        const tableId = riskTableId(metadata);
        if (!tableId)
            throw new Error(directError);
        const fallback = parseRiskTiers(await getJson(`/futures/usdt/risk_limit_table?table_id=${encodeURIComponent(tableId)}`));
        if (fallback.length === 0)
            throw new Error('Gate risk-limit table returned invalid or unsupported metadata.');
        return fallback;
    }
    startDeliveryPolling() {
        this.stopDeliveryPolling();
        this.deliveryTimer = setInterval(() => {
            if (this.deliveryRefreshPending)
                return;
            this.deliveryRefreshPending = true;
            void this.refreshFuture(this.selected, 'delivery').catch((error) => {
                const market = this.markets[this.selected];
                if (market) {
                    market.connected = false;
                    market.feedError = error instanceof Error ? error.message : 'Delivery market refresh failed.';
                }
            }).finally(() => { this.deliveryRefreshPending = false; });
        }, 2_000);
    }
    stopDeliveryPolling() {
        if (this.deliveryTimer)
            clearInterval(this.deliveryTimer);
        this.deliveryTimer = null;
    }
    startRiskPolling(contract) {
        this.stopRiskPolling();
        this.riskTimer = setInterval(() => void this.refreshRiskTiers(contract), 60_000);
    }
    stopRiskPolling() {
        if (this.riskTimer)
            clearInterval(this.riskTimer);
        this.riskTimer = null;
    }
    async refreshRiskTiers(contract) {
        const market = this.markets[contract];
        if (!market || market.product !== 'perpetual')
            return;
        try {
            const tiers = parseRiskTiers(await getJson(`/futures/usdt/risk_limit_tiers?contract=${encodeURIComponent(contract)}`));
            if (tiers.length === 0)
                throw new Error('Gate returned invalid or unsupported risk tier metadata.');
            market.riskTiers = tiers;
            market.riskUpdatedAt = Date.now();
            delete market.riskDataError;
        }
        catch (error) {
            market.riskDataError = error instanceof Error ? error.message : 'Gate risk tier refresh failed.';
        }
        this.onUpdate(market);
    }
    async refreshOption(contract) {
        const [metadata, book] = await Promise.all([
            getJson(`/options/contracts/${encodeURIComponent(contract)}`),
            getJson(`/options/order_book?contract=${encodeURIComponent(contract)}&limit=${DEPTH}`),
        ]);
        const underlying = String(metadata.underlying ?? 'BTC_USDT');
        const tickers = await getJson(`/options/tickers?underlying=${encodeURIComponent(underlying)}`);
        const ticker = tickers.find((item) => item.name === contract) ?? {};
        const expiryAt = Number(metadata.expiration_time ?? 0) * 1000;
        let settlement = null;
        if (expiryAt > 0 && Date.now() >= expiryAt) {
            try {
                const result = await getJson(`/options/settlements/${encodeURIComponent(contract)}?underlying=${encodeURIComponent(underlying)}&at=${Math.floor(expiryAt / 1000)}`);
                settlement = {
                    profitPerContract: numeric(result.profit, '0'),
                    feePerContract: numeric(result.fee, '0'),
                    settlePrice: numeric(result.settle_price, '0'),
                    strikePrice: numeric(result.strike_price, numeric(metadata.strike_price, '0')),
                };
            }
            catch {
                settlement = null;
            }
        }
        const market = {
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
                expiryAt, call: Boolean(metadata.is_call),
                impliedVolatility: numeric(ticker.mark_iv, '0'), delta: numeric(ticker.delta, '0'),
                gamma: numeric(ticker.gamma, '0'), vega: numeric(ticker.vega, '0'), theta: numeric(ticker.theta, '0'),
                settlement,
            },
        };
        this.markets[contract] = market;
        this.onUpdate(market);
    }
    startOptionPolling() {
        this.stopOptionPolling();
        this.optionsTimer = setInterval(() => {
            if (this.optionRefreshPending)
                return;
            this.optionRefreshPending = true;
            void this.refreshOption(this.selected).catch(() => {
                const market = this.markets[this.selected];
                if (market)
                    market.connected = false;
            }).finally(() => { this.optionRefreshPending = false; });
        }, 2_000);
    }
    stopOptionPolling() {
        if (this.optionsTimer)
            clearInterval(this.optionsTimer);
        this.optionsTimer = null;
    }
    connectSocket() {
        this.closeSocket();
        if (this.stopped)
            return;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const socket = new WebSocket(FUTURES_WS);
        this.socket = socket;
        socket.on('open', () => {
            this.reconnectDelay = 1_000;
            console.info('Gate futures WebSocket connected.');
            const contract = this.selected;
            for (const [channel, payload] of [
                ['futures.book_ticker', [contract]],
                ['futures.trades', [contract]],
                ['futures.order_book_update', [contract, '100ms']],
                ['futures.tickers', [contract]],
            ]) {
                socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel, event: 'subscribe', payload }));
            }
        });
        socket.on('message', (raw) => this.handleSocketMessage(raw.toString()));
        socket.on('error', () => {
            const market = this.markets[this.selected];
            if (market)
                market.connected = false;
        });
        socket.on('close', (code, reason) => {
            const market = this.markets[this.selected];
            if (market) {
                market.connected = false;
                market.feedError = `Socket closed (${code}): ${reason.toString() || 'no reason supplied'}`;
            }
            console.warn('Gate futures WebSocket closed.', code, reason.toString());
            this.socket = null;
            this.queueReconnect();
        });
    }
    queueReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectSocket();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    }
    closeSocket() {
        const socket = this.socket;
        this.socket = null;
        if (!socket)
            return;
        socket.removeAllListeners();
        socket.on('error', () => { });
        if (socket.readyState === WebSocket.CONNECTING)
            socket.terminate();
        else if (socket.readyState === WebSocket.OPEN)
            socket.close();
    }
    handleSocketMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (message.error) {
            const market = this.markets[this.selected];
            if (market)
                market.feedError = JSON.stringify(message.error);
            console.warn('Gate futures subscription error.', message.channel, message.error);
            return;
        }
        if (message.event !== 'update' || !message.result || typeof message.result !== 'object')
            return;
        const data = message.result;
        const market = this.markets[this.selected];
        if (!market || market.product === 'option')
            return;
        if (message.channel === 'futures.tickers' || message.channel === 'futures.book_ticker') {
            const updates = Array.isArray(message.result) ? message.result : [data];
            const update = updates.find((item) => String(item.contract ?? item.s ?? '') === market.contract);
            if (!update)
                return;
            tickerUpdate(market, update);
            if (!this.bookResyncPending) {
                market.connected = true;
                market.feedError = undefined;
            }
            this.onUpdate(market);
            return;
        }
        if (message.channel === 'futures.order_book_update') {
            if (String(data.s ?? data.contract) !== market.contract)
                return;
            if (this.bookResyncPending) {
                this.bookBuffer.push(data);
                if (this.bookBuffer.length > 2000)
                    this.bookBuffer.shift();
                return;
            }
            const first = Number(data.U ?? 0);
            const last = Number(data.u ?? data.id ?? 0);
            if (last && last <= this.orderBookId)
                return;
            if (bookUpdateHasGap(this.orderBookId, first, last) && !this.bookResyncPending) {
                console.warn('Gate order-book sequence gap; rebuilding from REST.', this.orderBookId, first, last);
                this.bookBuffer = [data];
                void this.resyncBook(market.contract);
                return;
            }
            this.applyBookUpdate(market, data);
            return;
        }
        if (message.channel === 'futures.trades') {
            const messages = Array.isArray(data) ? data : [data];
            for (const item of messages) {
                if (item.contract && item.contract !== market.contract)
                    continue;
                const trade = normalizeFuturesTrade(market.contract, item, market.last);
                market.last = trade.price;
                market.trades.unshift(trade);
                market.trades = market.trades.slice(0, 40);
                market.connected = true;
                market.feedError = undefined;
                market.updatedAt = Date.now();
                market.source = 'gate-websocket';
                this.onUpdate(market, trade);
            }
        }
    }
    applyBookUpdate(market, data, publish = true) {
        applyBookDelta(market.bids, (data.b ?? data.bids ?? []));
        applyBookDelta(market.asks, (data.a ?? data.asks ?? []));
        sortBook(market.bids, market.asks);
        this.orderBookId = Number(data.u ?? data.id ?? this.orderBookId);
        market.bookId = this.orderBookId;
        market.connected = !this.bookResyncPending;
        market.feedError = undefined;
        market.source = 'gate-websocket';
        market.updatedAt = Date.now();
        if (publish)
            this.onUpdate(market);
    }
    async resyncBook(contract) {
        if (this.bookResyncPending)
            return;
        this.bookResyncPending = true;
        const market = this.markets[contract];
        if (market)
            market.connected = false;
        try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                this.bookBuffer = [];
                await this.refreshFuture(contract, 'perpetual');
                const current = this.markets[contract];
                if (!current)
                    throw new Error('Market snapshot disappeared during book recovery.');
                const updates = this.bookBuffer;
                this.bookBuffer = [];
                let foundGap = false;
                for (const update of updates) {
                    const first = Number(update.U ?? 0);
                    const last = Number(update.u ?? update.id ?? 0);
                    if (last && last <= this.orderBookId)
                        continue;
                    if (bookUpdateHasGap(this.orderBookId, first, last)) {
                        foundGap = true;
                        break;
                    }
                    this.applyBookUpdate(current, update, false);
                }
                if (foundGap)
                    continue;
                current.connected = true;
                current.source = 'gate-websocket';
                current.updatedAt = Date.now();
                current.feedError = undefined;
                return;
            }
            throw new Error('Could not bridge the Gate order-book snapshot to live updates.');
        }
        catch (error) {
            const current = this.markets[contract];
            if (current) {
                current.connected = false;
                current.feedError = error instanceof Error ? error.message : 'Order-book recovery failed.';
            }
            this.queueReconnect();
        }
        finally {
            this.bookResyncPending = false;
            const current = this.markets[contract];
            if (current)
                this.onUpdate(current);
        }
    }
}
export function marketIsFresh(market) {
    return Boolean(market?.connected && Date.now() - market.updatedAt < FRESH_MS);
}

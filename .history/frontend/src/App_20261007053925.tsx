import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import {
  Activity, ArrowDownRight, ArrowUpRight, CandlestickChart, ChevronDown, CircleHelp,
  Clock3, Gauge, History, LayoutDashboard, LoaderCircle, RefreshCw, RotateCcw,
  Settings2, ShieldCheck, SlidersHorizontal, Wifi, WifiOff, X,
} from 'lucide-react'
import './App.css'

type Product = 'perpetual' | 'delivery' | 'option'
type Side = 'buy' | 'sell'
type View = 'positions' | 'orders' | 'fills' | 'ledger'
interface Level { price: string; size: string }
interface Market {
  contract: string; product: Product; source: string; connected: boolean; updatedAt: number; expiryAt?: number | null
  contractType?: 'direct' | 'inverse' | 'unknown'; riskUpdatedAt?: number; riskDataError?: string; exitFeeRate?: string
  riskTiers?: Array<{ tier: number; riskLimit: string; initialRate: string; maintenanceRate: string; leverageMax: string; deduction: string }>
  last: string; mark: string; index: string; multiplier: string; priceStep: string; sizeStep: string
  minSize: string; makerFeeRate: string; takerFeeRate: string; fundingRate: string | null
  nextFundingAt: number | null; bids: Level[]; asks: Level[]
  trades: Array<{ id: string; price: string; size: string; side: Side; time: number }>
  options?: { underlying: string; strike: string; expiryAt: number; call: boolean; impliedVolatility: string | null; delta: string | null; gamma: string | null; vega: string | null; theta: string | null }
}
interface Instrument {
  contract: string; product: Product; underlying?: string; strike?: string; expiryAt?: number; call?: boolean
  mark?: string; priceStep?: string; sizeStep?: string; minSize?: string
}
interface Order { id: string; contract: string; product: Product; side: Side; kind: 'market' | 'limit'; quantity: string; remaining: string; limitPrice: string | null; status: string; createdAt: number }
interface Position { contract: string; product: Product; quantity: string; entryPrice: string; multiplier: string; markPrice: string; updatedAt: number; liquidationTriggeredAt?: number }
interface PositionRisk { status: 'ready' | 'unavailable' | 'over_limit'; reason?: string; tier: number | null; positionNotional: string | null; initialMargin: string | null; maintenanceMargin: string | null; marginRatio: string | null; liquidationPrice: string | null; distanceToLiquidationPct: string | null; markUpdatedAt: number | null; riskUpdatedAt: number | null }
interface RiskEvent { id: string; contract: string; status: 'complete' | 'partial' | 'no_depth'; residualQuantity: string; createdAt: number; note: string }
interface Fill { id: string; contract: string; side: Side; quantity: string; price: string; fee: string; liquidity: string; createdAt: number; slippageBps: string }
interface LedgerEntry { id: string; type: string; contract: string | null; amount: string; balance: string; description: string; createdAt: number }
interface PaperState { balance: string; leverage: number; makerFeeRate: string; takerFeeRate: string; slippageBps: string; orders: Order[]; positions: Position[]; fills: Fill[]; ledger: LedgerEntry[]; riskEvents?: RiskEvent[] }
interface Metrics { balance: string; unrealizedPnl: string; equity: string; usedMargin: string; availableMargin: string; positionRisks?: Record<string, PositionRisk | null> }

const API = import.meta.env.VITE_API_URL ?? window.location.origin
const API_WS = import.meta.env.VITE_API_URL
  ? API.replace(/^http/, 'ws')
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}
function money(value: string | number, digits = 2) {
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number) : '--'
}
function marketPrice(value: string | number | undefined, digits = 2) {
  return Number(value) > 0 ? money(value ?? 0, digits) : '—'
}
function shortTime(value: number) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function expiry(value?: number) { return value ? new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : 'Perpetual' }

function App() {
  const [product, setProduct] = useState<Product>('perpetual')
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [market, setMarket] = useState<Market | null>(null)
  const [paper, setPaper] = useState<PaperState | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [selectedContract, setSelectedContract] = useState('BTC_USDT')
  const [side, setSide] = useState<Side>('buy')
  const [orderKind, setOrderKind] = useState<'market' | 'limit'>('market')
  const [sizingMode, setSizingMode] = useState<'notional' | 'margin'>('notional')
  const [quantity, setQuantity] = useState('100')
  const [limitPrice, setLimitPrice] = useState('')
  const [activeView, setActiveView] = useState<View>('positions')
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [socketOnline, setSocketOnline] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const fresh = Boolean(market?.connected && clock - market.updatedAt < 15_000)
  const visibleInstruments = useMemo(() => instruments.filter((item) => item.contract.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 100), [instruments, search])

  const selectInstrument = useCallback(async (contract: string, nextProduct = product) => {
    setSelectedContract(contract); setBusy(true)
    try {
      const value = await request<{ market: Market }>('/api/market/select', { method: 'POST', body: JSON.stringify({ contract, product: nextProduct }) })
      if (value.market) setMarket(value.market)
      setMessage('')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load this market.') }
    finally { setBusy(false) }
  }, [product])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    void request<{ state: PaperState; metrics: Metrics }>('/api/paper/state').then((value) => { setPaper(value.state); setMetrics(value.metrics) }).catch((error: Error) => setMessage(error.message))
    void request<{ market: Market | null }>('/api/market').then((value) => {
      if (value.market) { setMarket(value.market); setSelectedContract(value.market.contract); setProduct(value.market.product) }
    }).catch(() => undefined)
    const socket = new WebSocket(`${API_WS}/api/ws`)
    socket.addEventListener('open', () => setSocketOnline(true))
    socket.addEventListener('close', () => setSocketOnline(false))
    socket.addEventListener('error', () => setSocketOnline(false))
    socket.addEventListener('message', (event) => {
      try {
        const update = JSON.parse(String(event.data)) as { type: string; market?: Market; state?: PaperState; metrics?: Metrics }
        if (update.market) setMarket(update.market)
        if (update.state) setPaper(update.state)
        if (update.metrics) setMetrics(update.metrics)
      } catch { setMessage('Received an unreadable market update.') }
    })
    return () => { window.clearInterval(timer); socket.close() }
  }, [])

  useEffect(() => {
    let active = true
    setSearch('')
    setQuantity(product === 'option' ? '1' : '100')
    if (product === 'option') setSizingMode('notional')
    void request<{ instruments: Instrument[] }>(`/api/instruments?product=${product}`).then((value) => {
      if (!active) return
      setInstruments(value.instruments)
      if (value.instruments.length) {
        const preferred = value.instruments.find((item) => item.contract === (product === 'perpetual' ? 'BTC_USDT' : '')) ?? value.instruments[0]
        setSelectedContract(preferred.contract)
        void selectInstrument(preferred.contract, product)
      }
    }).catch((error: Error) => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [product, selectInstrument])

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!market) return; setBusy(true)
    try {
      const leverage = paper?.leverage ?? 5
      const notionalUsdt = Number(quantity) * (sizingMode === 'margin' ? leverage : 1)
      const value = await request<{ order: Order; state: PaperState; metrics: Metrics }>('/api/paper/orders', { method: 'POST', body: JSON.stringify({ contract: selectedContract, product, side, kind: orderKind, ...(product === 'option' ? { quantity } : { notionalUsdt }), ...(orderKind === 'limit' ? { limitPrice } : {}) }) })
      setPaper(value.state); setMetrics(value.metrics)
      setMessage(value.order.status === 'open' ? 'Paper limit order is working.' : value.order.status === 'cancelled' ? 'Partial fill completed; remainder cancelled.' : 'Paper order filled.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Order rejected.') }
    finally { setBusy(false) }
  }
  async function cancelOrder(id: string) {
    try { await request(`/api/paper/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }); setMessage('Paper order cancelled.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not cancel order.') }
  }
  async function saveSettings(patch: Partial<Pick<PaperState, 'leverage' | 'makerFeeRate' | 'takerFeeRate' | 'slippageBps'>>) {
    try {
      const value = await request<{ state: PaperState; metrics: Metrics }>('/api/paper/settings', { method: 'PATCH', body: JSON.stringify(patch) })
      setPaper(value.state); setMetrics(value.metrics); setMessage('Paper settings saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save settings.') }
  }
  async function resetAccount() {
    if (!window.confirm('Reset the practice account, positions, orders, fills and history?')) return
    try {
      const value = await request<{ state: PaperState; metrics: Metrics }>('/api/paper/reset', { method: 'POST', body: '{}' })
      setPaper(value.state); setMetrics(value.metrics); setMessage('Practice account reset.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not reset account.') }
  }
  async function closePosition(position: Position) {
    const closeSide = Number(position.quantity) > 0 ? 'sell' : 'buy'
    try {
      await request('/api/paper/orders', { method: 'POST', body: JSON.stringify({ contract: position.contract, product: position.product, side: closeSide, kind: 'market', quantity: String(Math.abs(Number(position.quantity))) }) })
      setMessage(`Close order sent for ${position.contract}.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not close position.') }
  }

  const marketAge = market ? Math.max(0, Math.floor((clock - market.updatedAt) / 1000)) : null
  const spread = market?.asks[0] && market?.bids[0] ? Number(market.asks[0].price) - Number(market.bids[0].price) : null
  const referencePrice = market && Number(market.mark) > 0
    ? Number(market.mark)
    : Number((side === 'buy' ? market?.asks[0] : market?.bids[0])?.price ?? 0)
  const sizingPrice = orderKind === 'limit' && Number(limitPrice) > 0 ? Number(limitPrice) : referencePrice
  const targetNotional = product === 'option' ? 0 : Number(quantity || 0) * (sizingMode === 'margin' ? paper?.leverage ?? 5 : 1)
  const estimatedContracts = market && sizingPrice > 0 && Number(market.multiplier) > 0
    ? Math.floor((targetNotional / (sizingPrice * Number(market.multiplier))) / Number(market.sizeStep)) * Number(market.sizeStep)
    : 0
  const estimatedNotional = product === 'option'
    ? Number(quantity || 0) * referencePrice * Number(market?.multiplier ?? 0)
    : estimatedContracts * sizingPrice * Number(market?.multiplier ?? 0)
  const estimatedFee = paper ? estimatedNotional * Number(paper.takerFeeRate) : 0
  const estimatedTier = market?.riskTiers?.find((tier) => estimatedNotional <= Number(tier.riskLimit))
  const estimatedLeverage = paper?.leverage ?? 5
  const estimatedInitialMargin = estimatedNotional > 0
    ? estimatedNotional * (Math.max(1 / estimatedLeverage, Number(estimatedTier?.initialRate ?? 1 / estimatedLeverage)) + Number(market?.exitFeeRate ?? 0))
    : 0
  const selectedPosition = paper?.positions.find((position) => position.contract === selectedContract)
  const currentPositionSize = Number(selectedPosition?.quantity ?? 0)
  const projectedPositionSize = currentPositionSize + (side === 'buy' ? estimatedContracts : -estimatedContracts)
  const orderReducesPosition = currentPositionSize !== 0 && Math.abs(projectedPositionSize) < Math.abs(currentPositionSize)
  const riskDataUnavailable = product === 'perpetual' && Boolean(market && market.source !== 'fixture' && (
    market.contractType !== 'direct' || !market.riskTiers?.length || !market.riskUpdatedAt || clock - market.riskUpdatedAt > 5 * 60_000
  ))
  const riskIncreaseBlocked = riskDataUnavailable && !orderReducesPosition && estimatedContracts > 0
  const selectedRisk = metrics?.positionRisks?.[selectedContract] ?? null
  const latestRiskEvent = paper?.riskEvents?.find((event) => event.contract === selectedContract)

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Paper Market home"><span className="brand-mark"><CandlestickChart size={19} /></span><span>PAPER<span className="brand-slash">/</span>MARKET</span></a>
      <div className="topbar-center"><span className="mode-dot" /> SIMULATED EXECUTION <span className="topbar-divider">/</span> GATE PUBLIC DATA</div>
      <div className="topbar-actions">
        <div className={`feed-pill ${fresh ? 'is-live' : 'is-down'}`}>{fresh ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{market?.product === 'option' ? (fresh ? 'REST SYNC' : 'OPTIONS OFFLINE') : market?.product === 'delivery' ? (fresh ? 'REST POLL' : 'DELIVERY OFFLINE') : (fresh ? 'FEED LIVE' : 'FEED WAITING')}</span></div>
        <button className="icon-button" title="Paper settings" aria-label="Paper settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button>
        <button className="reset-button" onClick={() => void resetAccount()}><RotateCcw size={14} /> Reset</button>
      </div>
    </header>

    <main id="top" className="workspace">
      <aside className="market-rail panel">
        <div className="rail-heading"><div><span className="eyebrow">MARKETS</span><h2>Instruments</h2></div><button className="icon-button" title="Cycle product type" aria-label="Cycle product type" onClick={() => setProduct((value) => value === 'perpetual' ? 'delivery' : value === 'delivery' ? 'option' : 'perpetual')}><RefreshCw size={15} /></button></div>
        <div className="product-switch" role="tablist" aria-label="Product type">
          <button className={product === 'perpetual' ? 'selected' : ''} role="tab" aria-selected={product === 'perpetual'} onClick={() => setProduct('perpetual')}>PERP</button>
          <button className={product === 'delivery' ? 'selected' : ''} role="tab" aria-selected={product === 'delivery'} onClick={() => setProduct('delivery')}>DATED</button>
          <button className={product === 'option' ? 'selected' : ''} role="tab" aria-selected={product === 'option'} onClick={() => setProduct('option')}>OPTIONS</button>
        </div>
        <label className="search-box"><SlidersHorizontal size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find contract" aria-label="Find contract" /><span>{visibleInstruments.length}</span></label>
        <div className="instrument-head"><span>CONTRACT</span><span>MARK</span></div>
        <div className="instrument-list">
          {visibleInstruments.map((item) => <button key={item.contract} className={`instrument-row ${item.contract === selectedContract ? 'active' : ''}`} onClick={() => void selectInstrument(item.contract)}>
            <span className="instrument-name"><strong>{item.contract}</strong>{product === 'option' && <small>{item.call ? 'CALL' : 'PUT'} · {money(item.strike ?? '0', 0)} · {expiry(item.expiryAt)}</small>}{product === 'delivery' && <small>DELIVERY · {expiry(item.expiryAt)}</small>}</span>
            <span className="instrument-mark">{marketPrice(item.mark, product === 'option' ? 4 : 2)}</span>
          </button>)}
          {!visibleInstruments.length && <div className="empty-note">No matching contracts</div>}
        </div>
        <div className="rail-foot"><ShieldCheck size={14} /> PUBLIC MARKET DATA ONLY</div>
      </aside>

      <section className="market-column">
        <section className="ticker-panel panel">
          <div className="contract-title"><div className="contract-icon">{product === 'option' ? 'O' : product === 'delivery' ? 'D' : 'P'}</div><div><div className="contract-line"><h1>{selectedContract}</h1><ChevronDown size={16} /></div><span className="subline">{product === 'option' ? 'GATE OPTIONS' : product === 'delivery' ? 'USDT-M DELIVERY' : 'USDT-M PERPETUAL'} <span className="dot-separator">·</span> PAPER</span></div></div>
          <div className="main-price"><span className="eyebrow">LAST TRADED</span><strong>{marketPrice(market?.last, product === 'option' ? 4 : 2)}</strong><span className="price-note">Mark {marketPrice(market?.mark, product === 'option' ? 4 : 2)}</span></div>
          <div className="ticker-stat"><span>INDEX</span><strong>{marketPrice(market?.index, 2)}</strong></div>
          <div className="ticker-stat"><span>SPREAD</span><strong>{spread === null ? '—' : money(spread, product === 'option' ? 4 : 2)}</strong></div>
          {product === 'perpetual' ? <div className="ticker-stat"><span>FUNDING / NEXT</span><strong className={Number(market?.fundingRate ?? 0) >= 0 ? 'positive' : 'negative'}>{market?.fundingRate ? `${(Number(market.fundingRate) * 100).toFixed(4)}%` : '—'}</strong><small>{market?.nextFundingAt ? new Date(market.nextFundingAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</small></div> : product === 'option' ? <div className="ticker-stat"><span>IMPLIED VOL</span><strong>{market?.options?.impliedVolatility && Number(market.options.impliedVolatility) > 0 ? `${(Number(market.options.impliedVolatility) * 100).toFixed(2)}%` : '—'}</strong></div> : <div className="ticker-stat"><span>EXPIRY</span><strong>{expiry(market?.expiryAt ?? undefined)}</strong></div>}
          <div className="feed-age"><span className={`pulse ${fresh ? 'active' : ''}`} />{marketAge === null ? 'No feed' : fresh ? `${marketAge}s` : 'Stale'}</div>
        </section>
        {market?.options && <section className="greeks-strip panel"><span className="greeks-title">OPTION GREEKS</span><Greek label="DELTA" value={market.options.delta} /><Greek label="GAMMA" value={market.options.gamma} /><Greek label="VEGA" value={market.options.vega} /><Greek label="THETA" value={market.options.theta} /><Greek label="EXPIRY" value={expiry(market.options.expiryAt)} /></section>}
        <section className="book-panel panel">
          <div className="section-head"><div><span className="eyebrow">LIVE MARKET</span><h2>Order book</h2></div><span className="book-depth">{market?.bids.length ?? 0} × {market?.asks.length ?? 0} LEVELS</span></div>
          <div className="book-columns"><span>PRICE <small>USDT</small></span><span>SIZE <small>CONTRACTS</small></span><span>TOTAL <small>USDT</small></span></div>
          <div className="depth-list asks">{market?.asks.slice(0, 8).reverse().map((level, index) => <DepthRow key={`a-${level.price}`} level={level} side="sell" multiplier={market.multiplier} max={maxDepth(market)} delay={index} />)}</div>
          <div className="mid-price"><strong>{marketPrice(market?.mark, product === 'option' ? 4 : 2)}</strong><span>MARK PRICE</span></div>
          <div className="depth-list bids">{market?.bids.slice(0, 8).map((level, index) => <DepthRow key={`b-${level.price}`} level={level} side="buy" multiplier={market.multiplier} max={maxDepth(market)} delay={index} />)}</div>
          {(!market || (!market.asks.length && !market.bids.length)) && <div className="book-empty"><LoaderCircle size={16} className="spin" /> Waiting for Gate order book snapshot</div>}
          <div className="book-footer"><span>Source <b>{market?.source === 'gate-websocket' ? 'Gate WebSocket' : market?.source === 'gate-rest' ? 'Gate REST' : '—'}</b></span><span>Updated <b>{market ? shortTime(market.updatedAt) : '—'}</b></span></div>
        </section>
        <section className="activity-panel panel">
          <div className="activity-tabs" role="tablist" aria-label="Account activity">{(['positions', 'orders', 'fills', 'ledger'] as View[]).map((view) => <button key={view} className={activeView === view ? 'active' : ''} role="tab" aria-selected={activeView === view} onClick={() => setActiveView(view)}>{view}<span>{countFor(view, paper)}</span></button>)}</div>
          <div className="table-wrap">{activeView === 'positions' && <PositionsView positions={paper?.positions ?? []} risks={metrics?.positionRisks ?? {}} onClose={(position) => void closePosition(position)} />}{activeView === 'orders' && <OrdersView orders={paper?.orders ?? []} onCancel={(id) => void cancelOrder(id)} />}{activeView === 'fills' && <FillsView fills={paper?.fills ?? []} />}{activeView === 'ledger' && <LedgerView entries={paper?.ledger ?? []} />}</div>
        </section>
      </section>

      <aside className="ticket-column">
        <section className="account-panel panel"><div className="section-head compact"><div><span className="eyebrow">PRACTICE ACCOUNT</span><h2>USDT balance</h2></div><span className="paper-label">SIM</span></div><strong className="equity-value">{metrics ? money(metrics.equity) : '—'} <small>USDT</small></strong><div className="account-metrics"><Metric label="Wallet" value={metrics ? money(metrics.balance) : '—'} /><Metric label="Unrealized PnL" value={metrics ? money(metrics.unrealizedPnl) : '—'} tone={Number(metrics?.unrealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'} /><Metric label="Available" value={metrics ? money(metrics.availableMargin) : '—'} /><Metric label="Used margin" value={metrics ? money(metrics.usedMargin) : '—'} /></div>
          {product === 'perpetual' && <div className="risk-readout"><div className="risk-heading"><span>ISOLATED RISK · {selectedContract}</span><strong className={selectedRisk?.status === 'ready' ? 'positive' : 'risk-muted'}>{selectedPosition ? selectedPosition.liquidationTriggeredAt ? 'FROZEN' : selectedRisk?.status === 'ready' ? `TIER ${selectedRisk.tier}` : 'UNAVAILABLE' : market?.riskUpdatedAt && clock - market.riskUpdatedAt <= 5 * 60_000 ? 'NO POSITION' : 'TIER DATA UNAVAILABLE'}</strong></div>
            {selectedPosition && selectedRisk?.status === 'ready' ? <div className="risk-grid"><Metric label="Margin ratio" value={`${money(selectedRisk.marginRatio ?? '0')}%`} tone={Number(selectedRisk.marginRatio) <= 110 ? 'negative' : 'positive'} /><Metric label="Liq. price" value={`${money(selectedRisk.liquidationPrice ?? '0', 4)} USDT`} /><Metric label="Initial margin" value={`${money(selectedRisk.initialMargin ?? '0')} USDT`} /><Metric label="Maintenance" value={`${money(selectedRisk.maintenanceMargin ?? '0')} USDT`} /><Metric label="Distance" value={`${money(selectedRisk.distanceToLiquidationPct ?? '0')}%`} /><Metric label="Tier cap" value={selectedRisk.tier ? `${selectedRisk.tier} / ${money(market?.riskTiers?.find((tier) => tier.tier === selectedRisk.tier)?.riskLimit ?? '0')} USDT` : '—'} /></div> : <p className="risk-message">{selectedPosition ? selectedRisk?.reason ?? 'Risk inputs are not available.' : market?.riskDataError ?? (market?.riskUpdatedAt ? `Gate tier data updated ${Math.max(0, Math.floor((clock - market.riskUpdatedAt) / 1000))}s ago.` : 'Waiting for fresh Gate risk tiers.')}</p>}
            {selectedPosition?.liquidationTriggeredAt && <p className="risk-alert">Simulated liquidation triggered. Residual: {money(selectedPosition.quantity, 4)} contracts.</p>}
            {latestRiskEvent && <p className="risk-event">Last simulation: {latestRiskEvent.status.replace('_', ' ')} · {shortTime(latestRiskEvent.createdAt)}{Number(latestRiskEvent.residualQuantity) > 0 ? ` · ${money(latestRiskEvent.residualQuantity, 4)} residual` : ''}</p>}
            <small className="risk-disclaimer">Educational isolated estimate. Gate insurance, ADL, and liquidation engine are not simulated.</small>
          </div>}
        </section>
        <section className="order-panel panel">
          <div className="section-head compact"><div><span className="eyebrow">ORDER TICKET</span><h2>Place paper order</h2></div><span className="ticket-status"><span className={`pulse ${fresh ? 'active' : ''}`} />{fresh ? 'READY' : 'WAITING'}</span></div>
          <div className="side-switch" role="group" aria-label="Order side"><button className={side === 'buy' ? 'buy selected' : 'buy'} onClick={() => setSide('buy')}><ArrowUpRight size={15} /> Buy / Long</button><button className={side === 'sell' ? 'sell selected' : 'sell'} onClick={() => setSide('sell')}><ArrowDownRight size={15} /> Sell / Short</button></div>
          {product === 'option' && side === 'sell' && <p className="disabled-reason"><CircleHelp size={13} /> Option sells can only reduce an existing long; short margin rules are not simulated.</p>}
          <div className="order-kind" role="group" aria-label="Order type"><button className={orderKind === 'market' ? 'selected' : ''} onClick={() => setOrderKind('market')}>Market</button><button className={orderKind === 'limit' ? 'selected' : ''} onClick={() => setOrderKind('limit')}>Limit</button></div>
          <form onSubmit={(event) => void submitOrder(event)} className="ticket-form">
            {orderKind === 'limit' && <label className="field-label">Limit price <span>USDT</span><input type="number" min="0" step={market?.priceStep ?? '0.01'} value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} placeholder={market?.mark ?? '0.00'} required /></label>}
            {product !== 'option' && <div className="order-kind sizing-mode" role="group" aria-label="Futures order sizing"><button type="button" className={sizingMode === 'notional' ? 'selected' : ''} aria-pressed={sizingMode === 'notional'} onClick={() => { if (sizingMode === 'margin') setQuantity(String(Number(quantity) * (paper?.leverage ?? 5))); setSizingMode('notional') }}>Order value</button><button type="button" className={sizingMode === 'margin' ? 'selected' : ''} aria-pressed={sizingMode === 'margin'} onClick={() => { if (sizingMode === 'notional') setQuantity(String(Number(quantity) / (paper?.leverage ?? 5))); setSizingMode('margin') }}>Margin</button></div>}
            <label className="field-label">{product === 'option' ? 'Quantity' : sizingMode === 'margin' ? 'Margin to use' : 'Order value'} <span>{product === 'option' ? 'CONTRACTS' : 'USDT'}</span><input type="number" min={product === 'option' ? market?.minSize ?? '1' : '1'} step={product === 'option' ? market?.sizeStep ?? '1' : '1'} value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></label>
            {product !== 'option' && <div className="leverage-row"><span>Leverage <small className="leverage-explainer">Changes required margin, not order value</small></span><select value={paper?.leverage ?? 5} onChange={(event) => void saveSettings({ leverage: Number(event.target.value) })} aria-label="Paper leverage">{[1, 2, 3, 5, 10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}×</option>)}</select></div>}
            <div className="estimate-box"><div><span>{product === 'option' ? 'Est. premium' : 'Est. contracts'}</span><b>{product === 'option' ? `${money(estimatedNotional)} USDT` : estimatedContracts > 0 ? money(estimatedContracts, 4) : 'Below minimum'}</b></div><div><span>Est. notional</span><b>{market && referencePrice > 0 ? `${money(estimatedNotional)} USDT` : '—'}</b></div>{product !== 'option' && <div><span>Est. initial margin ({paper?.leverage ?? 5}×)</span><b>{market && estimatedNotional > 0 ? product === 'perpetual' && !estimatedTier ? 'Risk tier unavailable' : `${money(estimatedInitialMargin)} USDT` : '—'}</b></div>}{product === 'perpetual' && estimatedTier && <div><span>Risk tier / max leverage</span><b>{estimatedTier.tier} / {estimatedTier.leverageMax}×</b></div>}<div><span>Taker fee est.</span><b>{market && referencePrice > 0 ? `${money(estimatedFee)} USDT` : '—'}</b></div><div><span>Extra slippage</span><b>{paper?.slippageBps ?? '2'} bps</b></div></div>
            <button className={`submit-order ${side}`} type="submit" disabled={!fresh || busy || !market || riskIncreaseBlocked}>{busy ? <LoaderCircle size={17} className="spin" /> : side === 'buy' ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}{busy ? 'Processing' : `${side === 'buy' ? 'Buy / Long' : 'Sell / Short'} ${selectedContract}`}</button>
            {!fresh && <p className="disabled-reason"><CircleHelp size={13} /> Orders unlock when fresh Gate market data is available.</p>}
            {riskIncreaseBlocked && <p className="disabled-reason"><ShieldCheck size={13} /> Exposure increases are disabled until fresh Gate risk tiers are available. Position reductions remain enabled.</p>}
          </form>
        </section>
        <section className="recent-trades panel"><div className="section-head compact"><div><span className="eyebrow">PUBLIC TAPE</span><h2>Recent trades</h2></div><Activity size={16} className="muted-icon" /></div><div className="trade-head"><span>PRICE</span><span>SIZE</span><span>TIME</span></div><div className="trade-list">{market?.trades.slice(0, 8).map((trade) => <div className="trade-row" key={trade.id}><strong className={trade.side === 'buy' ? 'positive' : 'negative'}>{money(trade.price, product === 'option' ? 4 : 2)}</strong><span>{money(trade.size, 0)}</span><time>{shortTime(trade.time)}</time></div>)}{!market?.trades.length && <div className="empty-note">Waiting for public trades</div>}</div></section>
      </aside>
    </main>

    <footer className="statusbar"><span><span className={`pulse ${socketOnline ? 'active' : ''}`} />{socketOnline ? 'APP SOCKET CONNECTED' : 'APP SOCKET DISCONNECTED'}</span><span><ShieldCheck size={13} /> PAPER EXECUTION ONLY</span><span><Clock3 size={13} /> {new Date(clock).toLocaleTimeString()}</span><span className="status-warning">Simulated fills do not model Gate queue priority</span></footer>
    {message && <div className={`toast ${message.includes('unavailable') || message.includes('stale') || message.includes('rejected') ? 'warning' : ''}`} role="status">{message}<button aria-label="Dismiss" className="icon-button" onClick={() => setMessage('')}><X size={14} /></button></div>}
    {settingsOpen && <div className="settings-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="settings-drawer panel" aria-label="Paper trading settings"><div className="drawer-head"><div><span className="eyebrow">SIMULATOR</span><h2>Paper settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div><p className="settings-copy">Rates below are configurable simulation assumptions. They do not change Gate account fees.</p><SettingInput label="Maker fee rate" value={paper?.makerFeeRate ?? '0.0002'} suffix="fraction" onSave={(value) => void saveSettings({ makerFeeRate: value })} /><SettingInput label="Taker fee rate" value={paper?.takerFeeRate ?? '0.0005'} suffix="fraction" onSave={(value) => void saveSettings({ takerFeeRate: value })} /><SettingInput label="Additional slippage" value={paper?.slippageBps ?? '2'} suffix="bps" onSave={(value) => void saveSettings({ slippageBps: value })} /><div className="risk-note"><Gauge size={16} /><span>Initial and liquidation margin are educational estimates. Gate's risk engine is not replicated.</span></div><button className="reset-wide" onClick={() => void resetAccount()}><RotateCcw size={15} /> Reset practice account</button></section></div>}
  </div>
}

function Greek({ label, value }: { label: string; value: string | number | null }) { return <div className="greek"><span>{label}</span><strong>{value === null || value === undefined ? '—' : typeof value === 'number' ? value.toFixed(4) : value}</strong></div> }
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong></div> }
function maxDepth(market: Market) { return Math.max(1, ...market.bids.concat(market.asks).slice(0, 16).map((level) => Number(level.size))) }
function DepthRow({ level, side, multiplier, max, delay }: { level: Level; side: Side; multiplier: string; max: number; delay: number }) {
  const size = Number(level.size); const width = Math.max(2, Math.min(100, size / max * 100))
  return <div className={`depth-row ${side}`} style={{ '--depth-width': `${width}%`, '--row-delay': `${delay * 25}ms` } as CSSProperties}><span className="depth-price">{money(level.price, Number(level.price) < 1 ? 4 : 2)}</span><span>{money(level.size, 2)}</span><span>{money(size * Number(level.price) * Number(multiplier), 2)}</span><i /></div>
}
function countFor(view: View, paper: PaperState | null) {
  if (!paper) return 0
  if (view === 'positions') return paper.positions.length
  if (view === 'orders') return paper.orders.filter((order) => order.status === 'open').length
  if (view === 'fills') return paper.fills.length
  return paper.ledger.length
}
function PositionsView({ positions, risks, onClose }: { positions: Position[]; risks: Record<string, PositionRisk | null>; onClose: (position: Position) => void }) {
  if (!positions.length) return <div className="empty-state"><LayoutDashboard size={19} /><strong>No open positions</strong><span>Paper fills will appear here.</span></div>
  return <table><thead><tr><th>CONTRACT</th><th>SIDE</th><th>SIZE</th><th>NOTIONAL USDT</th><th>ENTRY</th><th>MARK</th><th>UNREALIZED PNL</th><th>MMR</th><th>LIQ. PRICE</th><th /></tr></thead><tbody>{positions.map((position) => { const marked = Number(position.markPrice) > 0; const notional = marked ? Math.abs(Number(position.quantity)) * Number(position.markPrice) * Number(position.multiplier) : null; const pnl = marked ? (Number(position.markPrice) - Number(position.entryPrice)) * Number(position.quantity) * Number(position.multiplier) : null; const risk = risks[position.contract]; return <tr key={position.contract}><td className="strong-cell">{position.contract}{position.liquidationTriggeredAt && <small className="frozen-label">FROZEN</small>}</td><td className={Number(position.quantity) > 0 ? 'positive' : 'negative'}>{Number(position.quantity) > 0 ? 'LONG' : 'SHORT'}</td><td>{money(Math.abs(Number(position.quantity)), 4)}</td><td>{notional === null ? '—' : money(notional, 2)}</td><td>{money(position.entryPrice, 2)}</td><td>{marketPrice(position.markPrice, 4)}</td><td className={pnl === null ? '' : pnl >= 0 ? 'positive' : 'negative'}>{pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${money(pnl)}`}</td><td>{risk?.status === 'ready' ? `${money(risk.marginRatio ?? '0')}%` : '—'}</td><td>{risk?.status === 'ready' ? money(risk.liquidationPrice ?? '0', 4) : '—'}</td><td><button className="close-position" onClick={() => onClose(position)}>Close</button></td></tr> })}</tbody></table>
}
function OrdersView({ orders, onCancel }: { orders: Order[]; onCancel: (id: string) => void }) {
  if (!orders.length) return <div className="empty-state"><History size={19} /><strong>No orders yet</strong><span>Paper orders remain separate from Gate.</span></div>
  return <table><thead><tr><th>TIME</th><th>CONTRACT</th><th>SIDE / TYPE</th><th>PRICE</th><th>SIZE / LEFT</th><th>STATUS</th><th /></tr></thead><tbody>{orders.slice(0, 20).map((order) => <tr key={order.id}><td>{shortTime(order.createdAt)}</td><td className="strong-cell">{order.contract}</td><td className={order.side === 'buy' ? 'positive' : 'negative'}>{order.side.toUpperCase()} / {order.kind.toUpperCase()}</td><td>{order.limitPrice ? money(order.limitPrice, 2) : 'Market'}</td><td>{money(order.quantity, 4)} / {money(order.remaining, 4)}</td><td><span className={`order-state ${order.status}`}>{order.status}</span></td><td>{order.status === 'open' && <button className="close-position" onClick={() => onCancel(order.id)}>Cancel</button>}</td></tr>)}</tbody></table>
}
function FillsView({ fills }: { fills: Fill[] }) {
  if (!fills.length) return <div className="empty-state"><Activity size={19} /><strong>No fills yet</strong><span>Execution details and slippage will be recorded here.</span></div>
  return <table><thead><tr><th>TIME</th><th>CONTRACT</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>LIQUIDITY</th><th>FEE</th><th>SLIPPAGE</th></tr></thead><tbody>{fills.slice(0, 30).map((fill) => <tr key={fill.id}><td>{shortTime(fill.createdAt)}</td><td className="strong-cell">{fill.contract}</td><td className={fill.side === 'buy' ? 'positive' : 'negative'}>{fill.side.toUpperCase()}</td><td>{money(fill.quantity, 4)}</td><td>{money(fill.price, 4)}</td><td>{fill.liquidity.toUpperCase()}</td><td>{money(fill.fee, 4)}</td><td>{fill.slippageBps} bps</td></tr>)}</tbody></table>
}
function LedgerView({ entries }: { entries: LedgerEntry[] }) {
  if (!entries.length) return <div className="empty-state"><History size={19} /><strong>No account activity</strong><span>Fees, realized PnL and funding post as separate entries.</span></div>
  return <table><thead><tr><th>TIME</th><th>TYPE</th><th>CONTRACT</th><th>DETAIL</th><th>CHANGE</th><th>BALANCE</th></tr></thead><tbody>{entries.slice(0, 40).map((entry) => <tr key={entry.id}><td>{shortTime(entry.createdAt)}</td><td><span className="ledger-type">{entry.type.replace(/_/g, ' ').toUpperCase()}</span></td><td className="strong-cell">{entry.contract ?? 'ACCOUNT'}</td><td>{entry.description}</td><td className={Number(entry.amount) >= 0 ? 'positive' : 'negative'}>{Number(entry.amount) >= 0 ? '+' : ''}{money(entry.amount, 4)}</td><td>{money(entry.balance, 2)}</td></tr>)}</tbody></table>
}
function SettingInput({ label, value, suffix, onSave }: { label: string; value: string; suffix: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <label className="setting-row"><span>{label}</span><span className="setting-control"><input type="number" min="0" step="any" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => onSave(draft)} /><small>{suffix}</small></span></label>
}

export default App

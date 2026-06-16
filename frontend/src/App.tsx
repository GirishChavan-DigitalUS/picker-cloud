import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useWebSocket } from './hooks/useWebSocket'
import { useMarketStore } from './stores/marketStore'
import type { IndicatorSnapshot, PredictionRow, Session } from './stores/marketStore'
import { TICKERS, API_BASE, formatPrice } from './utils/formatters'
import { TIMEFRAME_REFRESH_MS, TIMEFRAME_STAGGER_MS } from './stores/marketStore'
import {
  isPushSupported,
  getPushPermission,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSubscribed,
} from './utils/pushNotifications'
import {
  getMarketState, getHolidayName, getNextOpenTime, formatCountdown,
  getHistoricalTradingDate,
  type MarketState,
} from './utils/marketHours'
import TickerGrid from './components/Dashboard/TickerGrid'
import InsightGrid from './components/Dashboard/InsightGrid'
import TickerDetail from './components/Detail/TickerDetail'
import AlertsPanel from './components/Alerts/AlertsPanel'
import TimeframeSelector from './components/TimeframeSelector'
import CostDashboard from './components/Costs/CostDashboard'
import AdminPanel from './components/Admin/AdminPanel'
import { useAuth } from './components/Auth/authContext'
import './App.css'

// ── Mobile ticker chip (shown in detail-view header for quick nav) ────────────
const MobileChip: React.FC<{ ticker: string; selected: boolean; onClick: () => void }> = ({ ticker, selected, onClick }) => {
  const state = useMarketStore((s) => s.tickers[ticker])
  const emaState = state?.indicators?.ema_state
  const price = state?.price
  const color = emaState === 'BULLISH' ? 'var(--green)' : emaState === 'BEARISH' ? 'var(--red)' : 'var(--border)'
  return (
    <button
      className={`mobile-ticker-chip${selected ? ' selected' : ''}`}
      onClick={onClick}
      style={{ borderColor: selected ? 'var(--accent)' : color }}
    >
      <span className="chip-ticker" style={{ color: selected ? '#fff' : emaState ? (emaState === 'BULLISH' ? 'var(--green)' : 'var(--red)') : 'var(--text)' }}>{ticker}</span>
      {price != null && <span className="chip-price">{formatPrice(price)}</span>}
    </button>
  )
}

// ── Off-hours price row (pre-market / after-hours gate panel) ─────────────────
const GatePriceRow: React.FC<{ ticker: string; onClick?: () => void }> = ({ ticker, onClick }) => {
  const price = useMarketStore((s) => s.tickers[ticker]?.price ?? null)
  return (
    <button
      className={`market-gate-price-row${onClick ? ' gate-row-clickable' : ''}`}
      onClick={onClick}
      style={onClick ? undefined : { cursor: 'default', background: 'none', border: 'none' }}
    >
      <span className="gate-ticker">{ticker}</span>
      <span className="gate-price">{formatPrice(price)}</span>
    </button>
  )
}


function App() {
  const { username, logout } = useAuth()
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [costOpen, setCostOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768)
  const [mobileAdding, setMobileAdding] = useState(false)
  const [mobileInput, setMobileInput] = useState('')
  const [mobileAlertsOpen, setMobileAlertsOpen] = useState(false)
  const [displayTickers, setDisplayTickers] = useState<string[]>([...TICKERS])

  // ── Push notification state (mobile + desktop) ────────────────────────────
  const [pushSupported] = useState(() => isPushSupported())
  const [pushPermission, setPushPermission] = useState<NotificationPermission>(() => getPushPermission())
  const [pushSubscribed, setPushSubscribed] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)

  useEffect(() => {
    if (!pushSupported) return
    isPushSubscribed().then(setPushSubscribed)
  }, [pushSupported])
  const [sortBy, setSortBy] = useState<'ticker' | 'price' | 'ai' | null>(null)

  // ── Market state ──────────────────────────────────────────────────────────
  const [marketState, setMarketState] = useState<MarketState>(() => getMarketState(new Date()))
  const [refreshCountdown, setRefreshCountdown] = useState('')
  const [openCountdown, setOpenCountdown] = useState('')

  // Re-evaluate market state every 60 seconds so the UI transitions automatically
  useEffect(() => {
    const id = setInterval(() => setMarketState(getMarketState(new Date())), 60_000)
    return () => clearInterval(id)
  }, [])

  // Clear selected ticker when transitioning INTO a live state so a stale
  // gate-panel selection doesn't auto-open TickerDetail on the dashboard.
  const prevMarketStateRef = useRef<MarketState>(marketState)
  useEffect(() => {
    const wasGate = prevMarketStateRef.current === 'CLOSED' || prevMarketStateRef.current === 'HOLIDAY' || prevMarketStateRef.current === 'AFTER_HOURS'
    const isNowLive = marketState === 'REGULAR' || marketState === 'PRE_MARKET'
    if (wasGate && isNowLive) setSelectedTicker(null)
    prevMarketStateRef.current = marketState
  }, [marketState])

  // 1-second countdown tick for both "next refresh" and "market opens in"
  useEffect(() => {
    const id = setInterval(() => {
      const tf = useMarketStore.getState().selectedTimeframe
      // Align refresh boundaries to top of hour (e.g. 5m fires at :00,:05,:10,...).
      // Unix epoch 0 is on the hour and 2/5/15 all divide 60, so flooring by
      // the interval in UTC milliseconds yields an hour-aligned boundary. Then
      // add the backend's stagger offset so the displayed countdown matches the
      // actual fetch tick (which fires a few seconds after bar close).
      const intervalMs = TIMEFRAME_REFRESH_MS[tf]
      const staggerMs = TIMEFRAME_STAGGER_MS[tf]
      const now = Date.now()
      const base = now - staggerMs
      const nextBoundary = (Math.floor(base / intervalMs) + 1) * intervalMs + staggerMs
      const msLeft = Math.max(0, nextBoundary - now)
      setRefreshCountdown(formatCountdown(msLeft))

      if (getMarketState(new Date()) === 'PRE_MARKET') {
        const msToOpen = Math.max(0, getNextOpenTime(new Date()).getTime() - Date.now())
        setOpenCountdown(formatCountdown(msToOpen))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Only connect WebSocket when market is active (pre-market / regular / after-hours)
  const wsEnabled = marketState !== 'CLOSED' && marketState !== 'HOLIDAY'
  const { connected } = useWebSocket(wsEnabled)
  const { setIndicators, setPrediction, setInitialized, initTicker, setPrice } = useMarketStore()
  const initialized = useMarketStore((s) => s.initialized)
  const selectedTimeframe = useMarketStore((s) => s.selectedTimeframe)
  const compositeAlerts = useMarketStore((s) => s.compositeAlerts)
  const [unseenAlerts, setUnseenAlerts] = useState(0)
  const seenCountRef = useRef(0)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])



  // Track unseen alerts while sidebar is closed
  useEffect(() => {
    if (sidebarOpen) {
      seenCountRef.current = compositeAlerts.length;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUnseenAlerts(0);
    } else {
      const newCount = compositeAlerts.length - seenCountRef.current;
       
      if (newCount > 0) setUnseenAlerts(newCount);
    }
  }, [compositeAlerts, sidebarOpen]);

  useEffect(() => {
    if (initialized) return
    // Always fetch the last cached dashboard snapshot from SQLite, even on
    // weekends/holidays — the backend serves the most recent session's data.
    // Only LIVE WebSocket streaming is paused when the market is closed.
    displayTickers.forEach((ticker) => initTicker(ticker))
    axios.get(`${API_BASE}/dashboard`, { params: { tickers: displayTickers.join(','), timeframe: selectedTimeframe }, timeout: 10000 }).then((r) => {
      const dashboard = r.data.dashboard as Record<string, {
        indicators: Record<string, unknown> | null
        prediction: Record<string, unknown> | null
        price: number | null
        change_pct: number | null
        session: string | null
      }>
      for (const [ticker, data] of Object.entries(dashboard)) {
        if (data.indicators) setIndicators(ticker, data.indicators as unknown as IndicatorSnapshot)
        if (data.prediction) setPrediction(ticker, data.prediction as unknown as PredictionRow)
        if (data.price != null) {
          const session = (data.session ?? 'closed') as Session
          setPrice(ticker, data.price, session, data.change_pct)
        }
      }
    }).finally(() => setInitialized(true))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized])

  // When timeframe changes (after init), re-fetch the dashboard so all tickers'
  // indicators + predictions reflect the new TF. Runs even on closed days so
  // the last cached session snapshot is shown.
  useEffect(() => {
    if (!initialized) return
    axios.get(`${API_BASE}/dashboard`, { params: { tickers: displayTickers.join(','), timeframe: selectedTimeframe }, timeout: 10000 }).then((r) => {
      const dashboard = r.data.dashboard as Record<string, {
        indicators: Record<string, unknown> | null
        prediction: Record<string, unknown> | null
        price: number | null
        change_pct: number | null
        session: string | null
      }>
      for (const [ticker, data] of Object.entries(dashboard)) {
        if (data.indicators) setIndicators(ticker, data.indicators as unknown as IndicatorSnapshot)
        if (data.prediction) setPrediction(ticker, data.prediction as unknown as PredictionRow)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTimeframe])

  const handleSelectTicker = (ticker: string) =>
    setSelectedTicker(ticker === selectedTicker ? null : ticker)

  const handleAddTicker = async (t: string): Promise<string | null> => {
    initTicker(t);
    setDisplayTickers((p) => [...p, t]);
    try {
      const r = await axios.post(`${API_BASE}/ticker/${t}/refresh`);
      if (r.data.indicators) setIndicators(t, r.data.indicators as unknown as IndicatorSnapshot);
      if (r.data.price != null) setPrice(t, r.data.price, (r.data.session ?? 'closed') as Session);
      if (r.data.prediction) setPrediction(t, r.data.prediction as unknown as PredictionRow);
      return null;
    } catch (e: unknown) {
      setDisplayTickers((p) => p.filter((x) => x !== t));
      if (selectedTicker === t) setSelectedTicker(null);
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      return detail ?? `Could not find ticker "${t}"`;
    }
  };
  const handleRemoveTicker = (t: string) => {
    setDisplayTickers((p) => p.filter((x) => x !== t));
    if (selectedTicker === t) setSelectedTicker(null);
  };

  // ── Draggable left-panel divider ──
  const [listWidth, setListWidth] = useState(170);
  const dragRef = useRef(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragStartX.current;
      setListWidth(Math.max(120, Math.min(340, dragStartW.current + delta)));
    };
    const onUp = () => { dragRef.current = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
      <header className="app-header">
        {isMobile && selectedTicker && (
          <button className="mobile-back-btn" onClick={() => setSelectedTicker(null)}>←</button>
        )}
        <span className="app-title">
          {isMobile ? 'Picker 📈' : 'Picker 📈 NYSE Dashboard'}
        </span>
        <div className="header-controls">
          <TimeframeSelector size={isMobile ? 'sm' : 'sm'} />
          {/* Desktop: alerts sidebar toggle */}
          {!isMobile ? (
            <>
              <a
                href="/landing.html"
                target="_blank"
                rel="noopener noreferrer"
                title="About Picker"
                style={{
                  background: 'rgba(124,77,255,0.08)', border: '1px solid rgba(124,77,255,0.35)',
                  borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
                  color: '#a78bfa', fontSize: '0.68rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, lineHeight: 1,
                  textDecoration: 'none',
                }}
              >ℹ About</a>
              <button
                onClick={() => setInfoOpen(true)}
                title="How to read the signals"
                style={{
                  background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.35)',
                  borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
                  color: '#fb923c', fontSize: '0.68rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, lineHeight: 1,
                }}
              >? Help</button>
              <a
                href="/manual.html"
                target="_blank"
                rel="noopener noreferrer"
                title="User Manual"
                style={{
                  background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.35)',
                  borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
                  color: '#22d3ee', fontSize: '0.68rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, lineHeight: 1,
                  textDecoration: 'none',
                }}
              >📖 Manual</a>
              <button
                onClick={() => setCostOpen(true)}
                title="AWS cost dashboard"
                style={{
                  background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)',
                  borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
                  color: '#22c55e', fontSize: '0.68rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, lineHeight: 1,
                }}
              >$ Cost</button>
              {username === 'admin' && (
                <button
                  onClick={() => setAdminOpen(true)}
                  title="Admin panel"
                  style={{
                    background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.35)',
                    borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
                    color: '#818cf8', fontSize: '0.68rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, lineHeight: 1,
                  }}
                >🔐 Admin</button>
              )}
              <button
                style={{
                  background: 'rgba(239,83,80,0.08)', border: '1px solid rgba(239,83,80,0.35)',
                  borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
                  color: '#ef5350', fontSize: '0.68rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, lineHeight: 1,
                }}
              >↪ Logout</button>
              <button
                className="sidebar-toggle"
                onClick={() => setSidebarOpen((o) => !o)}
                title={sidebarOpen ? 'Hide alerts' : 'Show alerts'}
                style={{ position: 'relative' }}
              >
              {sidebarOpen ? '◀ Alerts' : '▶ Alerts'}
              {!sidebarOpen && unseenAlerts > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -7,
                  background: '#ef5350', color: '#fff',
                  fontSize: '0.58rem', fontWeight: 700,
                  borderRadius: '50%', minWidth: 16, height: 16,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 3px', lineHeight: 1,
                  boxShadow: '0 0 0 2px var(--surface)',
                }}>
                  {unseenAlerts > 99 ? '99+' : unseenAlerts}
                </span>
              )}
              </button>
            </>
          ) : (
            /* Mobile: bell icon with badge */
            <>
              <a
                href="/landing.html"
                target="_blank"
                rel="noopener noreferrer"
                title="About Picker"
                aria-label="About Picker"
                style={{
                  background: 'rgba(124,77,255,0.08)', border: '1px solid rgba(124,77,255,0.35)',
                  borderRadius: 5, padding: '3px 6px', cursor: 'pointer',
                  color: '#a78bfa', fontSize: '0.85rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  textDecoration: 'none', lineHeight: 1,
                }}
              >ℹ</a>
              <button
                onClick={() => setInfoOpen(true)}
                title="How to read the signals"
                aria-label="Help"
                style={{
                  background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.35)',
                  borderRadius: 5, padding: '3px 6px', cursor: 'pointer',
                  color: '#fb923c', fontSize: '0.85rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1,
                }}
              >?</button>
              <a
                href="/manual.html"
                target="_blank"
                rel="noopener noreferrer"
                title="User Manual"
                aria-label="User Manual"
                style={{
                  background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.35)',
                  borderRadius: 5, padding: '3px 6px', cursor: 'pointer',
                  color: '#22d3ee', fontSize: '0.85rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  textDecoration: 'none', lineHeight: 1,
                }}
              >📖</a>
              <button
                onClick={() => setCostOpen(true)}
                title="AWS cost dashboard"
                aria-label="Cost dashboard"
                style={{
                  background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)',
                  borderRadius: 5, padding: '3px 6px', cursor: 'pointer',
                  color: '#22c55e', fontSize: '0.85rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1,
                }}
              >$</button>
              {username === 'admin' && (
                <button
                  onClick={() => setAdminOpen(true)}
                  title="Admin panel"
                  aria-label="Admin panel"
                  style={{
                    background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.35)',
                    borderRadius: 5, padding: '3px 6px', cursor: 'pointer',
                    color: '#818cf8', fontSize: '0.85rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1,
                  }}
                >🔐</button>
              )}
              <button
                onClick={logout}
                title={username ? `Sign out (${username})` : 'Sign out'}
                aria-label="Sign out"
                style={{
                  background: 'rgba(239,83,80,0.08)', border: '1px solid rgba(239,83,80,0.35)',
                  borderRadius: 5, padding: '3px 6px', cursor: 'pointer',
                  color: '#ef5350', fontSize: '0.85rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1,
                }}
              >↪</button>
              <button
                className="mobile-bell-btn"
                onClick={() => { setMobileAlertsOpen(true); setUnseenAlerts(0); seenCountRef.current = compositeAlerts.length; }}
                aria-label="Open alerts"
              >
                🔔
                {unseenAlerts > 0 && (
                  <span className="mobile-bell-badge">
                    {unseenAlerts > 99 ? '99+' : unseenAlerts}
                  </span>
                )}
              </button>
            </>
          )}
          <span className={`ws-status ${connected ? 'connected' : 'disconnected'}`}>
            {isMobile ? (connected ? '●' : '○') : (connected ? '● LIVE' : '○ CONNECTING…')}
          </span>
          {wsEnabled && refreshCountdown ? (
            <span className="refresh-countdown" title="Next data refresh">
              ⟳ {refreshCountdown}
            </span>
          ) : (
            <span className="refresh-countdown" title={`Market ${marketState.toLowerCase().replace('_', '-')}`}>
              {marketState === 'CLOSED' ? '⏸ CLOSED'
                : marketState === 'HOLIDAY' ? '⏸ HOLIDAY'
                : marketState === 'PRE_MARKET' ? `⏰ ${openCountdown || 'PRE'}`
                : marketState === 'AFTER_HOURS' ? '🌙 AFTER-HRS'
                : '⟳ —'}
            </span>
          )}
        </div>
      </header>

      {/* ── Mobile: alerts bottom sheet popup ── */}
      {isMobile && mobileAlertsOpen && (
        <div className="mobile-alerts-sheet">
          <div className="sheet-backdrop" onClick={() => setMobileAlertsOpen(false)} />
          <div className="mobile-alerts-inner">
            <div className="mobile-alerts-handle-bar"><div className="sheet-handle" /></div>
            <div className="mobile-alerts-header">
              <span>🔔 Alerts</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {pushSupported && pushPermission !== 'denied' && (
                  <button
                    onClick={async () => {
                      if (pushBusy) return
                      setPushBusy(true)
                      try {
                        if (pushSubscribed) {
                          await unsubscribeFromPush()
                          setPushSubscribed(false)
                          setPushPermission(getPushPermission())
                        } else {
                          const result = await subscribeToPush()
                          if (result === 'subscribed') setPushSubscribed(true)
                          setPushPermission(getPushPermission())
                        }
                      } finally {
                        setPushBusy(false)
                      }
                    }}
                    title={pushSubscribed ? 'Disable push notifications' : 'Enable push notifications for Tier 1 & 2 alerts'}
                    style={{
                      fontSize: '1rem', padding: '4px 8px',
                      borderRadius: 6, cursor: pushBusy ? 'not-allowed' : 'pointer',
                      border: `1px solid ${pushSubscribed ? '#26a69a' : '#334155'}`,
                      background: pushSubscribed ? '#26a69a22' : 'transparent',
                      color: pushSubscribed ? '#26a69a' : '#64748b',
                    }}
                  >
                    {pushBusy ? '…' : pushSubscribed ? '🔔' : '🔕'}
                  </button>
                )}
                <button className="mobile-alerts-close" onClick={() => setMobileAlertsOpen(false)}>✕</button>
              </div>
            </div>
            <div className="mobile-alerts-list">
              {compositeAlerts.length === 0 ? (
                <div className="mobile-alerts-empty">No alerts yet</div>
              ) : (
                [...compositeAlerts]
                  .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                  .slice(0, 10)
                  .map((alert, i) => {
                    // eslint-disable-next-line react-hooks/purity
                    const minsAgo = Math.round((Date.now() - new Date(alert.timestamp).getTime()) / 60000)
                    const timeLabel = minsAgo < 1 ? 'just now' : minsAgo < 60 ? `${minsAgo}m ago` : `${Math.round(minsAgo/60)}h ago`
                    return (
                      <button
                        key={alert.id ?? i}
                        className={`mobile-alert-row dir-${alert.direction.toLowerCase()}`}
                        onClick={() => { setSelectedTicker(alert.ticker); setMobileAlertsOpen(false); }}
                      >
                        <span className="alert-row-ticker">{alert.ticker}</span>
                        <span className="alert-row-body">
                          <span className="alert-row-signal">{alert.signal.replace(/_/g, ' ')}</span>
                          <span className="alert-row-time">{timeLabel}</span>
                        </span>
                        <span className={`alert-row-dir dir-${alert.direction.toLowerCase()}`}>
                          {alert.direction === 'UP' ? '▲' : alert.direction === 'DOWN' ? '▼' : '⚠'}
                        </span>
                      </button>
                    )
                  })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile: chip bar (only in detail view for quick ticker switching) ── */}
      {isMobile && selectedTicker && (
        <div className="mobile-ticker-bar">
          {mobileAdding ? (
            <div className="mobile-add-row">
              <input
                className="mobile-add-input"
                autoFocus
                value={mobileInput}
                onChange={(e) => setMobileInput(e.target.value.toUpperCase())}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    const sym = mobileInput.trim()
                    if (sym) await handleAddTicker(sym)
                    setMobileAdding(false)
                    setMobileInput('')
                  }
                  if (e.key === 'Escape') { setMobileAdding(false); setMobileInput('') }
                }}
                placeholder="e.g. AAPL"
                maxLength={8}
              />
              <button className="mobile-add-cancel" onClick={() => { setMobileAdding(false); setMobileInput('') }}>✕</button>
            </div>
          ) : (
            <>
              {displayTickers.map((ticker) => (
                <MobileChip
                  key={ticker}
                  ticker={ticker}
                  selected={selectedTicker === ticker}
                  onClick={() => handleSelectTicker(ticker)}
                />
              ))}
              <button className="mobile-add-chip" onClick={() => setMobileAdding(true)}>+</button>
            </>
          )}
        </div>
      )}

      <main className="app-main">
        {/* ── Closed / Holiday ─────────────────────────────────────────── */}
        {(marketState === 'CLOSED' || marketState === 'HOLIDAY') ? (
          selectedTicker ? (
            <div className="detail-area">
              <TickerDetail
                key={selectedTicker}
                ticker={selectedTicker}
                onClose={() => setSelectedTicker(null)}
                historicalDate={getHistoricalTradingDate(marketState)}
              />
            </div>
          ) : (
            <div className="market-gate-panel">
              <div className="market-gate-icon">🔒</div>
              <div className="market-gate-title">
                {marketState === 'HOLIDAY'
                  ? `Market closed — ${getHolidayName(new Date()) ?? 'Holiday'}`
                  : 'Market is closed'}
              </div>
              <div className="market-gate-sub">Regular market hours are over — wait till next trading day</div>
              <div className="market-gate-sub" style={{ color: 'rgba(167,139,250,0.75)', marginTop: 4 }}>
                Click on a ticker below to view the previous regular session's chart &amp; indicators
              </div>
              <div className="market-gate-prices">
                {displayTickers.map((ticker) => (
                  <GatePriceRow key={ticker} ticker={ticker} onClick={() => handleSelectTicker(ticker)} />
                ))}
              </div>
            </div>
          )

        ) : marketState === 'PRE_MARKET' ? (
          /* ── Pre-market ─────────────────────────────────────────────── */
          selectedTicker ? (
            <div className="detail-area">
              <TickerDetail
                key={selectedTicker}
                ticker={selectedTicker}
                onClose={() => setSelectedTicker(null)}
                historicalDate={getHistoricalTradingDate(marketState)}
              />
            </div>
          ) : (
            <div className="market-gate-panel market-gate-panel--premarket">
              <div className="market-gate-icon">🌅</div>
              <div className="market-gate-title">Pre-Market</div>
              {openCountdown && (
                <div className="market-gate-countdown">Market opens in {openCountdown}</div>
              )}
              <div className="market-gate-sub" style={{ color: 'rgba(167,139,250,0.75)', marginTop: 4 }}>
                Click on a ticker below to view the previous regular session's chart &amp; indicators
              </div>
              <div className="market-gate-prices">
                {displayTickers.map((ticker) => (
                  <GatePriceRow key={ticker} ticker={ticker} onClick={() => handleSelectTicker(ticker)} />
                ))}
              </div>
            </div>
          )

        ) : marketState === 'AFTER_HOURS' ? (
          /* ── After-hours ─────────────────────────────────────────────── */
          selectedTicker ? (
            <div className="detail-area">
              <TickerDetail
                key={selectedTicker}
                ticker={selectedTicker}
                onClose={() => setSelectedTicker(null)}
                historicalDate={getHistoricalTradingDate(marketState)}
              />
            </div>
          ) : (
            <div className="market-gate-panel market-gate-panel--afterhours">
              <div className="market-gate-icon">🌙</div>
              <div className="market-gate-title">After Hours</div>
              <div className="market-gate-sub">Regular market hours are over</div>
              <div className="market-gate-sub" style={{ color: 'rgba(167,139,250,0.75)', marginTop: 4 }}>
                Click on a ticker below to view today's regular session chart &amp; indicators
              </div>
              <div className="market-gate-prices">
                {displayTickers.map((ticker) => (
                  <GatePriceRow key={ticker} ticker={ticker} onClick={() => handleSelectTicker(ticker)} />
                ))}
              </div>
            </div>
          )

        ) : (
          /* ── Regular session — full dashboard ───────────────────────── */
          <>
        {/* ── Mobile: home = card grid; detail = TickerDetail ── */}
        {isMobile ? (
          selectedTicker ? (
            <div className="detail-area">
              <TickerDetail key={selectedTicker} ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
            </div>
          ) : (
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <InsightGrid tickers={displayTickers} isMobile onSelectTicker={handleSelectTicker} sortBy={sortBy} />
              {mobileAdding ? (
                <div className="mobile-add-row mobile-card-add-row">
                  <input
                    className="mobile-add-input"
                    autoFocus
                    value={mobileInput}
                    onChange={(e) => setMobileInput(e.target.value.toUpperCase())}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') {
                        const sym = mobileInput.trim()
                        if (sym) await handleAddTicker(sym)
                        setMobileAdding(false)
                        setMobileInput('')
                      }
                      if (e.key === 'Escape') { setMobileAdding(false); setMobileInput('') }
                    }}
                    placeholder="e.g. AAPL"
                    maxLength={8}
                  />
                  <button className="mobile-add-cancel" onClick={() => { setMobileAdding(false); setMobileInput('') }}>✕</button>
                </div>
              ) : (
                <button className="mobile-card-add" onClick={() => setMobileAdding(true)}>+ Add ticker</button>
              )}
            </div>
          )
        ) : (
          /* Desktop layout */
          <>
            <div className="ticker-list-panel" style={{ width: listWidth }}>
              <TickerGrid
                tickers={displayTickers}
                onSelectTicker={handleSelectTicker}
                selectedTicker={selectedTicker}
                sortBy={sortBy}
                onSortChange={setSortBy}
                onAddTicker={handleAddTicker}
                onRemoveTicker={handleRemoveTicker}
              />
            </div>
            <div
              onMouseDown={(e) => {
                dragRef.current = true;
                dragStartX.current = e.clientX;
                dragStartW.current = listWidth;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
              }}
              style={{
                width: 4, flexShrink: 0, cursor: 'col-resize',
                background: 'transparent',
                borderRight: '1px solid var(--border)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent)')}
              onMouseLeave={(e) => { if (!dragRef.current) e.currentTarget.style.background = 'transparent'; }}
            />
            <div className="detail-area" style={selectedTicker ? undefined : { overflowY: 'auto', overflowX: 'hidden' }}>
              {selectedTicker ? (
                <TickerDetail key={selectedTicker} ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
              ) : (
                <InsightGrid tickers={displayTickers} isMobile={false} onSelectTicker={handleSelectTicker} sortBy={sortBy} />
              )}
            </div>
          </>
        )}
          </>
        )}
      </main>

      {/* Alerts sidebar (desktop) / bottom sheet (mobile) */}
      {sidebarOpen && (
        <aside className={`app-sidebar${isMobile ? ' mobile-bottom-sheet' : ''}`}>
          {isMobile && <div className="sheet-backdrop" onClick={() => setSidebarOpen(false)} />}
          <div className="sheet-inner">
            {isMobile && <div className="sheet-handle-bar"><div className="sheet-handle" /></div>}
            <AlertsPanel
              onSelectTicker={(t) => { handleSelectTicker(t); if (isMobile) setSidebarOpen(false); }}
              selectedTicker={selectedTicker}
            />
          </div>
        </aside>
      )}

      {/* ── AWS Cost Dashboard ────────────────────────────────────────── */}
      <CostDashboard open={costOpen} onClose={() => setCostOpen(false)} />

      {/* ── Admin Panel ─────────────────────────────────────────────── */}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}

      {/* ── Signal Guide Modal ─────────────────────────────────────────── */}
      {infoOpen && (
        <div
          onClick={() => setInfoOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1a1a2e', border: '1px solid #2d2d44',
              borderRadius: 12, width: '100%', maxWidth: 560,
              maxHeight: '88vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
            }}
          >
            {/* Modal header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 18px 12px', borderBottom: '1px solid #2d2d44', flexShrink: 0,
            }}>
              <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#e0e0e0' }}>
                How to read the signals
              </span>
              <button
                onClick={() => setInfoOpen(false)}
                style={{
                  background: 'none', border: 'none', color: '#64748b',
                  fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: 4,
                }}
              >✕</button>
            </div>

            {/* Scrollable body */}
            <div style={{ overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* Traffic Light */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>TRAFFIC LIGHT (left circle)</div>
                {([
                  ['#00C896', 'Green', 'Strong bullish signal — confidence ≥ 65% with UP trend'],
                  ['#FF4C4C', 'Red', 'Strong bearish signal — confidence ≥ 65% with DOWN trend'],
                  ['#FFD700', 'Yellow', 'Caution / mixed — signal present but low confidence or choppy'],
                  ['#fb923c', 'Orange', 'Trap pattern (Fakeout / Rejection) — do not chase, wait'],
                  ['#64748b', 'Grey', 'No clear signal — choppy market, stay flat'],
                ] as [string,string,string][]).map(([hex, name, desc]) => (
                  <div key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 7 }}>
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%', background: hex,
                      boxShadow: `0 0 7px ${hex}99`, flexShrink: 0, marginTop: 3,
                    }} />
                    <div>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: hex }}>{name}</span>
                      <span style={{ fontSize: '0.68rem', color: '#94a3b8', marginLeft: 6 }}>{desc}</span>
                    </div>
                  </div>
                ))}
              </section>

              {/* Pattern Labels */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>PATTERN LABEL (header badge)</div>
                {([
                  ['#00C896', 'Breakout', 'Price leaving a COILING compression zone with momentum ≥ 65%'],
                  ['#fb923c', 'Fakeout', 'Signal flipped right after COILING — likely a trap, skip it'],
                  ['#fb923c', 'Rejection', 'Strong signal immediately reversed — possible range boundary'],
                  ['#22c55e', 'Reversal', '4+ aligned bars then strong flip ≥ 65% — trend change forming'],
                  ['#FFD700', 'Bounce', 'red → yellow → green (or reverse) — short-term exhaustion move'],
                  ['#00C896', 'Continuation', '3+ same-direction bars with matching structure — ride the trend'],
                  ['#FFD700', 'Buildup', '2+ COILING bars, no strong signal — energy compressing, prepare'],
                  ['#64748b', 'Chop Zone', '3+ yellow or choppy bars — no edge, stay flat'],
                ] as [string,string,string][]).map(([hex, name, desc]) => (
                  <div key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 7 }}>
                    <span style={{
                      fontSize: '0.58rem', fontWeight: 700, color: hex,
                      background: `${hex}18`, border: `1px solid ${hex}44`,
                      borderRadius: 3, padding: '1px 5px', flexShrink: 0, lineHeight: 1.6,
                    }}>{name}</span>
                    <span style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
              </section>

              {/* HTF Bias */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>HTF DAILY BIAS (D↑ / D↓ badge)</div>
                <p style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
                  The daily trend computed from EMA alignment + close position.
                  <br />
                  <span style={{ color: '#22c55e', fontWeight: 700 }}>D↑ BULL</span> — favors long setups. Breakouts are more trustworthy.<br />
                  <span style={{ color: '#ef5350', fontWeight: 700 }}>D↓ BEAR</span> — favors short setups. Bounces are likely to fail.<br />
                  <span style={{ color: '#64748b', fontWeight: 700 }}>D— NEUT</span> — range day, no directional edge.<br />
                  <span style={{ color: '#FFD700' }}>Trading against the HTF tag significantly increases risk.</span>
                </p>
              </section>

              {/* Volume */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>VOLUME CHIP (rvol × state)</div>
                <p style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.6, margin: '0 0 6px' }}>
                  rvol = current bar volume ÷ 20-bar average. Reads as a multiplier (e.g. 1.8×).
                </p>
                {([
                  ['#00C896', 'HIGH', 'Above-average volume. Confirms the signal — increases edge'],
                  ['#ef5350', 'LOW',  'Below-average volume. Treat every signal with caution — fakeout risk is elevated'],
                  ['#64748b', 'NORMAL', 'Average participation. Signal is valid but not amplified'],
                ] as [string,string,string][]).map(([hex, name, desc]) => (
                  <div key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                    <span style={{
                      fontSize: '0.55rem', fontWeight: 700, color: hex,
                      background: `${hex}18`, border: `1px solid ${hex}44`,
                      borderRadius: 3, padding: '1px 5px', flexShrink: 0, lineHeight: 1.6,
                    }}>{name}</span>
                    <span style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
              </section>

              {/* Signal Age */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>SIGNAL AGE (~Nm)</div>
                <p style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.6, margin: '0 0 6px' }}>
                  Time since the current signal direction was last established (i.e. last color flip).
                </p>
                {([
                  ['#22c55e', '≤ 3 min', 'Fresh flip — highest-conviction moment to act'],
                  ['#FFD700', '4 – 7 min', 'Aging — still valid but momentum may be fading'],
                  ['#ef5350', '≥ 8 min (STALE)', 'Stale — signal may no longer reflect current conditions. Wait for a fresh flip'],
                ] as [string,string,string][]).map(([hex, label, desc]) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: hex, flexShrink: 0, minWidth: 70 }}>{label}</span>
                    <span style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
              </section>

              {/* Macro Banner */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>MACRO INDEX BANNER (top of grid)</div>
                <p style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.6, margin: '0 0 6px' }}>
                  Shows the daily trend of SPY, QQQ, and SPX — the three macro indices. Derived from the same HTF bias computation.
                </p>
                {([
                  ['#22c55e', 'Macro Tailwind ↑', 'All three indices BULL — macro supports long trades across the board'],
                  ['#ef5350', 'Macro Headwind ↓', 'All three indices BEAR — macro supports short trades, bounces likely fail'],
                  ['#FFD700', 'Lean Bullish ↗',  '2 of 3 BULL — mild tailwind, size smaller'],
                  ['#fb923c', 'Lean Bearish ↘',  '2 of 3 BEAR — mild headwind, be cautious on longs'],
                  ['#fb923c', 'Index Conflict ⚠', 'Indices disagree — hidden macro risk. Trade individual names only with extra confirmation'],
                ] as [string,string,string][]).map(([hex, name, desc]) => (
                  <div key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 7 }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: hex, flexShrink: 0, minWidth: 120 }}>{name}</span>
                    <span style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
              </section>

              {/* History Strip */}
              <section>
                <div style={{ fontSize: '0.52rem', letterSpacing: '0.1em', color: '#475569', marginBottom: 8 }}>SIGNAL HISTORY STRIP (bottom of card)</div>
                <p style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.6, margin: '0 0 6px' }}>
                  Last 10 signal readings, oldest left → newest right (NOW). Each chip shows signal type, confidence %, and structure.
                </p>
                {([
                  ['#00C896', 'BUY',  'UP trend with confidence ≥ 45%'],
                  ['#FF4C4C', 'SELL', 'DOWN trend with confidence ≥ 45%'],
                  ['#FFD700', 'CAUT', 'Mixed or low-confidence signal — monitor'],
                  ['#64748b', 'STAY', 'No trend (ABSTAIN / NEUTRAL) — stay flat'],
                ] as [string,string,string][]).map(([hex, name, desc]) => (
                  <div key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                    <span style={{
                      fontSize: '0.58rem', fontWeight: 700, color: hex,
                      background: `${hex}22`, border: `1px solid ${hex}55`,
                      borderRadius: 4, padding: '2px 7px', flexShrink: 0, lineHeight: 1.6,
                    }}>{name}</span>
                    <span style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
                <p style={{ fontSize: '0.66rem', color: '#FFD700', lineHeight: 1.5, margin: '8px 0 0' }}>
                  Tip: a consistent run of the same colour = reliable trend. Alternating colours = choppy, no edge.
                </p>
              </section>

              <div style={{ fontSize: '0.6rem', color: '#334155', textAlign: 'center', paddingTop: 4, borderTop: '1px solid #2d2d44' }}>
                This tool is a scanner and attention router — use signals as context, not as trade execution commands.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

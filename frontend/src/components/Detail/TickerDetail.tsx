import React, { useEffect, useRef } from 'react';
import axios from 'axios';
import { useMarketStore } from '../../stores/marketStore';
import { API_BASE, formatPrice, confColor } from '../../utils/formatters';
import CandlestickChart from '../Chart/CandlestickChart';
import MarketReadPanel from './MarketReadPanel';
import TrendStructureTimeline from './TrendStructureTimeline';

interface ConfluenceSignal { label: string; side: 'bull' | 'bear'; }
function computeConfluenceBreakdown(ind: import('../../stores/marketStore').IndicatorSnapshot | null, price: number | null): ConfluenceSignal[] {
  if (!ind) return [];
  const out: ConfluenceSignal[] = [];

  // 1. EMA state
  if (ind.ema_state === 'BULLISH') out.push({ label: 'EMA Cross', side: 'bull' });
  else if (ind.ema_state === 'BEARISH') out.push({ label: 'EMA Cross', side: 'bear' });

  // 2. EMA stack
  if (ind.ema9 != null && ind.ema21 != null && ind.ema50 != null) {
    if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) out.push({ label: 'EMA Stack', side: 'bull' });
    else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50) out.push({ label: 'EMA Stack', side: 'bear' });
  }

  // 3. VWAP position
  if (ind.price_vs_vwap === 'ABOVE') out.push({ label: 'VWAP Position', side: 'bull' });
  else if (ind.price_vs_vwap === 'BELOW') out.push({ label: 'VWAP Position', side: 'bear' });

  // 4. VWAP motion (AWAY in same direction as position)
  if (ind.vwap_motion === 'AWAY') {
    if (ind.price_vs_vwap === 'ABOVE') out.push({ label: 'VWAP Motion', side: 'bull' });
    else if (ind.price_vs_vwap === 'BELOW') out.push({ label: 'VWAP Motion', side: 'bear' });
  }

  // 5. Daily trend
  if (ind.daily_trend === 'BULL') out.push({ label: 'Daily Trend', side: 'bull' });
  else if (ind.daily_trend === 'BEAR') out.push({ label: 'Daily Trend', side: 'bear' });

  // 6. RSI vs 50
  if (ind.rsi_14 != null) {
    if (ind.rsi_14 > 50) out.push({ label: `RSI ${ind.rsi_14.toFixed(0)} > 50`, side: 'bull' });
    else if (ind.rsi_14 < 50) out.push({ label: `RSI ${ind.rsi_14.toFixed(0)} < 50`, side: 'bear' });
  }

  // 7. Price vs POC
  if (ind.poc != null && price != null) {
    if (price > ind.poc) out.push({ label: 'Price vs POC', side: 'bull' });
    else if (price < ind.poc) out.push({ label: 'Price vs POC', side: 'bear' });
  }

  // 8. Price vs ORB high
  if (ind.orb_high != null && price != null) {
    if (price > ind.orb_high) out.push({ label: 'Price vs ORB', side: 'bull' });
    else out.push({ label: 'Price vs ORB', side: 'bear' });
  }

  // 9. RVOL conviction
  if (ind.rvol != null && ind.recent_return_5m != null && ind.rvol > 1.5) {
    if (ind.recent_return_5m > 0) out.push({ label: 'RVOL Conviction', side: 'bull' });
    else if (ind.recent_return_5m < 0) out.push({ label: 'RVOL Conviction', side: 'bear' });
  }

  return out;
}

interface TickerDetailProps {
  ticker: string;
  onClose: () => void;
  /** When set, show historical data for this ET date (YYYY-MM-DD) instead of live store data. */
  historicalDate?: string;
}

const TickerDetail: React.FC<TickerDetailProps> = ({ ticker, onClose, historicalDate }) => {
  const isHistorical = !!historicalDate;
  const state = useMarketStore((s) => s.tickers[ticker]);
  const setCandles = useMarketStore((s) => s.setCandles);
  const tf = useMarketStore((s) => s.selectedTimeframe);

  // Historical-mode override state (populated by REST call, not WebSocket)
  const [histInd, setHistInd] = React.useState<import('../../stores/marketStore').IndicatorSnapshot | null>(null);
  const [histPred, setHistPred] = React.useState<import('../../stores/marketStore').PredictionRow | null>(null);

  const ind = isHistorical ? histInd : (state?.indicators ?? null);
  const pred = isHistorical ? histPred : (state?.latestPrediction ?? null);
  // Each backend refresh cycle updates this timestamp via WebSocket price_update.
  // Using it as a dependency causes candles to re-fetch on every cycle so the
  // chart always shows the latest bars without the user having to re-click.
  const indicatorTimestamp = state?.indicators?.timestamp ?? null;

  // Draggable chart/sidebar divider
  const [chartPct, setChartPct] = React.useState(65);
  const bodyRef = useRef<HTMLDivElement>(null);
  const divDrag = useRef(false);
  const divStartX = useRef(0);
  const divStartPct = useRef(0);

  // Draggable AI/Indicators vertical divider
  const [aiPct, setAiPct] = React.useState(70);
  const sidebarColRef = useRef<HTMLDivElement>(null);
  const sidebarDivDrag = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!divDrag.current || !bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setChartPct(Math.max(25, Math.min(80, pct)));
    };
    const onUp = () => { divDrag.current = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDivDrag.current || !sidebarColRef.current) return;
      const rect = sidebarColRef.current.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setAiPct(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      sidebarDivDrag.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    if (!isHistorical) {
      // Live mode: re-fetch candles whenever ticker, cycle, or TF changes
      axios.get(`${API_BASE}/candles/${ticker}?timeframe=${tf}&limit=400&today_only=true`).then((r) => {
        setCandles(ticker, r.data.bars);
      });
    } else {
      // Historical mode: fetch candles + last indicator/prediction snapshot for the trading date
      axios.get(`${API_BASE}/candles/${ticker}?timeframe=${tf}&limit=400&trading_date=${historicalDate}`).then((r) => {
        setCandles(ticker, r.data.bars);
      });
      axios.get(`${API_BASE}/indicators/${ticker}/session-snapshot?trading_date=${historicalDate}&timeframe=${tf}`).then((r) => {
        if (r.data.snapshot) setHistInd(r.data.snapshot as import('../../stores/marketStore').IndicatorSnapshot);
        if (r.data.prediction) setHistPred(r.data.prediction as import('../../stores/marketStore').PredictionRow);
      });
    }
  }, [ticker, tf, isHistorical ? historicalDate : indicatorTimestamp, setCandles]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Live mode: when ticker or TF changes, also re-fetch latest indicators + prediction
  // for THIS TF so Market Read / Indicators / chips update immediately (rather than
  // waiting for the next WS scheduler cycle which may be 1–5 minutes away).
  const setIndicators = useMarketStore((s) => s.setIndicators);
  const setPrediction = useMarketStore((s) => s.setPrediction);
  useEffect(() => {
    if (isHistorical) return;
    axios.get(`${API_BASE}/indicators/${ticker}?timeframe=${tf}`).then((r) => {
      if (r.data?.snapshot) setIndicators(ticker, r.data.snapshot as import('../../stores/marketStore').IndicatorSnapshot);
    }).catch(() => { /* ignore */ });
    axios.get(`${API_BASE}/predictions/${ticker}`, { params: { limit: 1, timeframe: tf } }).then((r) => {
      const latest = r.data?.predictions?.[0];
      if (latest) setPrediction(ticker, latest as import('../../stores/marketStore').PredictionRow);
    }).catch(() => { /* ignore */ });
  }, [ticker, tf, isHistorical, setIndicators, setPrediction]);

  const rules = pred?.rules_triggered ? (() => {
    try { return JSON.parse(pred.rules_triggered) as string[]; } catch { return []; }
  })() : [];

  return (
    <div className="detail-panel">
      {/* ── Trend / Structure 30-min timeline ── */}
      <TrendStructureTimeline ticker={ticker} refreshKey={isHistorical ? historicalDate ?? null : indicatorTimestamp} />

      {/* ── Historical mode banner ── */}
      {isHistorical && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 14px',
          background: 'rgba(124,77,255,0.10)', borderBottom: '1px solid rgba(124,77,255,0.22)',
          fontSize: '0.7rem', color: '#a78bfa', fontWeight: 600,
        }}>
          <span>📅</span>
          <span>Viewing previous session: {historicalDate} · Regular hours (09:30–16:00 ET)</span>
        </div>
      )}

      {/* ── Header + inline summary ── */}
      {(() => {
        const dir = pred?.prediction;
        const conf = pred?.confidence;
        const isUp = dir === 'UP';
        const isDown = dir === 'DOWN';
        const dirColor = isUp ? '#26a69a' : isDown ? '#ef5350' : '#9e9e9e';
        const arrow = isUp ? '▲' : isDown ? '▼' : '—';
        const dirLabel = isUp ? 'BULLISH' : isDown ? 'BEARISH' : (dir ?? '');

        type Chip = { label: string; color: string };
        const chips: Chip[] = [];
        if (rules.includes('ema_stack_bullish'))      chips.push({ label: 'EMA Stack ▲▲▲', color: '#26a69a' });
        else if (rules.includes('ema_stack_bearish')) chips.push({ label: 'EMA Stack ▼▼▼', color: '#ef5350' });
        else if (ind?.ema_state === 'BULLISH')        chips.push({ label: 'EMA ▲', color: '#26a69a' });
        else if (ind?.ema_state === 'BEARISH')        chips.push({ label: 'EMA ▼', color: '#ef5350' });
        if (rules.includes('vwap_reclaim_bullish'))   chips.push({ label: 'VWAP Reclaim ⚡', color: '#26a69a' });
        else if (rules.includes('vwap_lose_bearish')) chips.push({ label: 'VWAP Lost ⚡', color: '#ef5350' });
        else if (ind?.price_vs_vwap === 'ABOVE')      chips.push({ label: 'Above VWAP', color: '#26a69a' });
        else if (ind?.price_vs_vwap === 'BELOW')      chips.push({ label: 'Below VWAP', color: '#ef5350' });
        if (ind?.daily_trend === 'BULL')              chips.push({ label: 'Daily Bull', color: '#26a69a' });
        else if (ind?.daily_trend === 'BEAR')         chips.push({ label: 'Daily Bear', color: '#ef5350' });

        return (
          <div className="detail-header" style={{ gap: 10 }}>
            <h2 style={{ marginRight: 4, whiteSpace: 'nowrap' }}>
              {ticker} — {isHistorical ? `Session ${historicalDate}` : 'Detail View'}
            </h2>
            {dirLabel && (
              <>
                <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)', flexShrink: 0 }} />
                <span style={{ fontWeight: 800, fontSize: '0.9rem', color: dirColor }}>{arrow}</span>
                <span style={{ fontWeight: 700, fontSize: '0.73rem', color: dirColor, letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{dirLabel}</span>
              </>
            )}
            {chips.map((c, i) => (
              <span key={i} style={{
                fontSize: '0.66rem', fontWeight: 600, color: c.color,
                background: `${c.color}1a`, border: `1px solid ${c.color}38`,
                borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap',
              }}>{c.label}</span>
            ))}
            {conf != null && (
              <span style={{ fontSize: '0.71rem', fontWeight: 700, color: confColor(conf), whiteSpace: 'nowrap' }}>
                {Math.round(conf * 100)}% confidence
              </span>
            )}
            <button className="close-btn" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
          </div>
        );
      })()}

      <div className="detail-body" ref={bodyRef}>
        {/* ── chart column — width % draggable ── */}
        <div className="detail-chart-col" style={{ flex: `0 0 ${chartPct}%` }}>
          <CandlestickChart
            ticker={ticker}
            candles={state?.candles ?? []}
            indicators={ind}
            timeframe={tf}
          />
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={(e) => {
            divDrag.current = true;
            divStartX.current = e.clientX;
            divStartPct.current = chartPct;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
          }}
          style={{
            width: 4, flexShrink: 0, cursor: 'col-resize',
            background: 'transparent', transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent)')}
          onMouseLeave={(e) => { if (!divDrag.current) e.currentTarget.style.background = 'transparent'; }}
        />

        {/* ── sidebar column ── */}
        <div className="detail-sidebar-col" ref={sidebarColRef} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 0, padding: 6 }}>

          {/* Market Read card — merged AI Evaluation + Tape Read */}
          <div className="detail-card detail-card-scroll" style={{ flex: `0 0 calc(${aiPct}% - 3px)`, minHeight: 0, marginBottom: 0 }}>
            <h3>Market Read</h3>
            <MarketReadPanel ticker={ticker} indicators={ind} prediction={pred} />
          </div>

          {/* Vertical drag handle between AI and Indicators */}
          <div
            onMouseDown={(e) => {
              sidebarDivDrag.current = true;
              document.body.style.cursor = 'row-resize';
              document.body.style.userSelect = 'none';
              e.preventDefault();
            }}
            style={{
              height: 5, flexShrink: 0, cursor: 'row-resize',
              background: 'transparent', transition: 'background 0.15s',
              borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
              margin: '2px 0',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent)')}
            onMouseLeave={(e) => { if (!sidebarDivDrag.current) e.currentTarget.style.background = 'transparent'; }}
          />

          {/* Indicators card — 40% */}
          <div className="detail-card detail-card-scroll" style={{ flex: '1 1 0', minHeight: 0, marginTop: 0 }}>
            <h3>Indicators</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>

              {/* Left: EMA + VWAP */}
              <div>
                <div className="ind-section-hdr">EMA / Trend</div>
                <table className="detail-table"><tbody>
                  <tr><td>EMA 9</td><td>{formatPrice(ind?.ema9 ?? null)}</td></tr>
                  <tr><td>EMA 21</td><td>{formatPrice(ind?.ema21 ?? null)}</td></tr>
                  <tr><td>Spread</td><td style={{ color: (ind?.ema_spread_pct ?? 0) > 0 ? '#26a69a' : '#ef5350' }}>{ind?.ema_spread_pct != null ? `${ind.ema_spread_pct.toFixed(3)}%` : '—'}</td></tr>
                  <tr><td>State</td><td style={{ color: ind?.ema_state === 'BULLISH' ? '#26a69a' : '#ef5350' }}>{ind?.ema_state ?? '—'}</td></tr>
                  <tr><td>Daily</td><td>{ind?.daily_trend ?? '—'}</td></tr>
                  <tr><td>POC</td><td>{formatPrice(ind?.poc ?? null)}</td></tr>
                </tbody></table>
                <div className="ind-section-hdr" style={{ marginTop: 8 }}>VWAP</div>
                <table className="detail-table"><tbody>
                  <tr><td>Value</td><td>{formatPrice(ind?.vwap ?? null)}</td></tr>
                  <tr><td>Pos</td><td>{ind?.price_vs_vwap ?? '—'}</td></tr>
                  <tr><td>Dist%</td><td>{ind?.vwap_distance_pct?.toFixed(3) ?? '—'}%</td></tr>
                  <tr><td>Motion</td><td>{ind?.vwap_motion ?? '—'}</td></tr>
                </tbody></table>
                <div className="ind-section-hdr" style={{ marginTop: 8, color: '#f59e0b' }}>Momentum</div>
                <table className="detail-table"><tbody>
                  <tr>
                    <td>RSI 14</td>
                    <td style={{ color: ind?.rsi_state === 'OVERBOUGHT' ? '#ef5350' : ind?.rsi_state === 'OVERSOLD' ? '#26a69a' : '#e0e0e0' }}>
                      {ind?.rsi_14 != null ? ind.rsi_14.toFixed(1) : '—'}
                      {ind?.rsi_state ? <span style={{ fontSize: '0.62rem', color: '#9e9e9e', marginLeft: 4 }}>{ind.rsi_state}</span> : null}
                    </td>
                  </tr>
                  <tr>
                    <td>RVOL</td>
                    <td style={{ color: ind?.volume_state === 'HIGH' ? '#26a69a' : ind?.volume_state === 'LOW' ? '#ef5350' : '#e0e0e0' }}>
                      {ind?.rvol != null ? `${ind.rvol.toFixed(2)}×` : '—'}
                      {ind?.volume_state ? <span style={{ fontSize: '0.62rem', color: '#9e9e9e', marginLeft: 4 }}>{ind.volume_state}</span> : null}
                    </td>
                  </tr>
                </tbody></table>
                <div className="ind-section-hdr" style={{ marginTop: 8, color: '#818cf8' }}>Confluence</div>
                <table className="detail-table"><tbody>
                  <tr><td>Bull</td><td style={{ color: '#26a69a', fontWeight: 700 }}>{ind?.bull_score ?? '—'}</td></tr>
                  <tr><td>Bear</td><td style={{ color: '#ef5350', fontWeight: 700 }}>{ind?.bear_score ?? '—'}</td></tr>
                  <tr><td>Bias</td><td style={{ color: ind?.confluence_bias === 'BULL' ? '#26a69a' : ind?.confluence_bias === 'BEAR' ? '#ef5350' : '#60a5fa' }}>{ind?.confluence_bias ?? '—'}</td></tr>
                </tbody></table>
                {(() => {
                  const breakdown = computeConfluenceBreakdown(ind, state?.price ?? null);
                  if (!breakdown.length) return null;
                  return (
                    <div style={{ marginTop: 6 }}>
                      {breakdown.map((s, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, fontSize: '0.7rem' }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: s.side === 'bull' ? '#26a69a' : '#ef5350',
                          }} />
                          <span style={{ color: s.side === 'bull' ? '#26a69a' : '#ef5350' }}>{s.label}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>

              {/* Right: Levels */}
              <div>
                <div className="ind-section-hdr">S / R</div>
                <table className="detail-table"><tbody>
                  <tr><td>Supp</td><td style={{ color: '#26a69a' }}>{formatPrice(ind?.nearest_support ?? null)}</td></tr>
                  <tr><td>Res</td><td style={{ color: '#ef5350' }}>{formatPrice(ind?.nearest_resistance ?? null)}</td></tr>
                  <tr><td>Sw Hi</td><td>{formatPrice(ind?.swing_high ?? null)}</td></tr>
                  <tr><td>Sw Lo</td><td>{formatPrice(ind?.swing_low ?? null)}</td></tr>
                </tbody></table>
                <div className="ind-section-hdr" style={{ marginTop: 8, color: '#FF9800' }}>ORB 15m</div>
                <table className="detail-table"><tbody>
                  <tr><td>High</td><td style={{ color: '#FF9800' }}>{formatPrice(ind?.orb_high ?? null)}</td></tr>
                  <tr><td>Low</td><td style={{ color: '#FF9800' }}>{formatPrice(ind?.orb_low ?? null)}</td></tr>
                </tbody></table>
                <div className="ind-section-hdr" style={{ marginTop: 8, color: '#9c27b0' }}>Premarket</div>
                <table className="detail-table"><tbody>
                  <tr><td>High</td><td style={{ color: '#9c27b0' }}>{formatPrice(ind?.pm_high ?? null)}</td></tr>
                  <tr><td>Low</td><td style={{ color: '#9c27b0' }}>{formatPrice(ind?.pm_low ?? null)}</td></tr>
                </tbody></table>
                <div className="ind-section-hdr" style={{ marginTop: 8, color: '#78909C' }}>Prev Day</div>
                <table className="detail-table"><tbody>
                  <tr><td>High</td><td style={{ color: '#78909C' }}>{formatPrice(ind?.prev_day_high ?? null)}</td></tr>
                  <tr><td>Low</td><td style={{ color: '#78909C' }}>{formatPrice(ind?.prev_day_low ?? null)}</td></tr>
                </tbody></table>
              </div>

            </div>
          </div>

        </div>{/* end sidebar */}
      </div>{/* end detail-body */}
    </div>
  );
};

export default TickerDetail;

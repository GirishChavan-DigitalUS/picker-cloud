import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useMarketStore } from '../../stores/marketStore';
import { API_BASE, formatPrice } from '../../utils/formatters';
import { runPatternEngine } from '../../utils/patternEngine';
import type { RawPoint, PatternResult, SignalColor, TrafficLight } from '../../utils/patternEngine';

// ── Color constants ───────────────────────────────────────────────────────────
const STRUCT_HEX: Record<string, string> = {
  UPTREND:   '#00C896',
  DOWNTREND: '#FF4C4C',
  COILING:   '#FFD700',
  CHOPPY:    '#A0A0A0',
};

const STRUCT_SHORT: Record<string, string> = {
  UPTREND: '↑UPTR', DOWNTREND: '↓DN', COILING: '◆COIL', CHOPPY: '─CHOP',
};

const CHIP_HEX: Record<SignalColor, string> = {
  green:  '#00C896',
  red:    '#FF4C4C',
  yellow: '#FFD700',
  grey:   '#64748b',
};

const TRAFFIC_HEX: Record<TrafficLight, string> = {
  green:  '#00C896',
  red:    '#FF4C4C',
  yellow: '#FFD700',
  orange: '#fb923c',
  grey:   '#64748b',
};

const ACTION_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  bull:    { bg: 'rgba(0,200,150,0.08)',  border: 'rgba(0,200,150,0.28)',  color: '#00C896' },
  bear:    { bg: 'rgba(255,76,76,0.08)',  border: 'rgba(255,76,76,0.28)',  color: '#FF4C4C' },
  caution: { bg: 'rgba(251,146,60,0.10)', border: 'rgba(251,146,60,0.30)', color: '#fb923c' },
  neutral: { bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.22)', color: '#64748b' },
};

const VWAP_SIGNAL_TYPES = new Set(['vwap_reclaim', 'vwap_breakdown']);
const formatVwapSignalLabel = (signalType: string) =>
  signalType === 'vwap_reclaim' ? 'VWAP Reclaim'
  : signalType === 'vwap_breakdown' ? 'VWAP Breakdown'
  : '';
const formatVwapSignalColor = (signalType: string) =>
  signalType === 'vwap_reclaim' ? '#26a69a'
  : signalType === 'vwap_breakdown' ? '#ef5350'
  : '#64748b';

const HTF_HEX: Record<string, string> = { BULL: '#22c55e', BEAR: '#ef5350', NEUTRAL: '#64748b' };
const VOL_HEX: Record<string, string>  = { HIGH: '#00C896', LOW: '#ef5350',  NORMAL: '#64748b' };

// ── Tiny fill bar ─────────────────────────────────────────────────────────────
const FillBar: React.FC<{ pct: number; color: string; height?: number }> = ({ pct, color, height = 5 }) => (
  <div style={{ height, background: '#252538', borderRadius: 3, overflow: 'hidden', position: 'relative', flex: 1 }}>
    <div style={{
      position: 'absolute', left: 0, top: 0, bottom: 0,
      width: `${pct}%`, background: color, borderRadius: 3,
      transition: 'width 0.4s ease',
    }} />
  </div>
);

// ── History strip (shared by both layouts) ────────────────────────────────────
const HistoryStrip: React.FC<{ chips: PatternResult['chips']; scrollable: boolean }> = ({ chips, scrollable }) => (
  <div style={{
    display:    'flex',
    gap:        3,
    overflowX:  scrollable ? 'auto' : 'visible',
    flexWrap:   scrollable ? 'nowrap' : 'nowrap',
    scrollbarWidth: 'none',
    paddingBottom: scrollable ? 2 : 0,
  }}>
    {chips.map((chip, i) => {
      const isNow    = i === chips.length - 1;
      const chipHex  = CHIP_HEX[chip.color];
      const strHex   = chip.structure ? (STRUCT_HEX[chip.structure] ?? '#A0A0A0') : '#475569';
      const strShort = chip.structure ? (STRUCT_SHORT[chip.structure] ?? '—') : '—';
      return (
        <div key={i} style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flex: scrollable ? '0 0 auto' : 1 }}>
          <div style={{
            background:    `${chipHex}22`,
            border:        `1px solid ${isNow ? chipHex : chipHex + '55'}`,
            borderRadius:  4,
            padding:       '3px 4px',
            fontSize:      '0.5rem',
            fontWeight:    700,
            color:         chipHex,
            minWidth:      30,
            textAlign:     'center',
            outline:       isNow ? `1px solid ${chipHex}99` : 'none',
            outlineOffset: '1px',
          }}>
            {chip.chipLabel}
          </div>
          {chip.confLabel && (
            <span style={{ fontSize: '0.42rem', color: chipHex, fontWeight: 600 }}>{chip.confLabel}</span>
          )}
          <span style={{ fontSize: '0.42rem', color: strHex }}>{strShort}</span>
          <span style={{ fontSize: '0.4rem', color: isNow ? '#60a5fa' : '#334155', fontWeight: isNow ? 700 : 400 }}>
            {isNow ? 'NOW' : chip.timeLabel}
          </span>
        </div>
      );
    })}
  </div>
);

// ── Data-fetching hook ────────────────────────────────────────────────────────
function useInsightData(ticker: string, refreshKey: string | null): PatternResult | null {
  const [result, setResult] = useState<PatternResult | null>(null);
  const tf = useMarketStore((s) => s.selectedTimeframe);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [predRes, indRes] = await Promise.all([
          axios.get<{ predictions: Array<{ timestamp: string; prediction: string | null; confidence: number }> }>(
            `${API_BASE}/predictions/${ticker}?limit=20&timeframe=${tf}`
          ),
          axios.get<{ history: Array<{ timestamp: string; candle_structure: string | null }> }>(
            `${API_BASE}/indicators/${ticker}/history?limit=30&timeframe=${tf}`
          ),
        ]);
        if (cancelled) return;

        const preds = [...(predRes.data.predictions ?? [])].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp)
        );
        const inds = [...(indRes.data.history ?? [])];

        const points: RawPoint[] = inds.map((ind) => {
          const t = new Date(ind.timestamp.replace(' ', 'T')).getTime();
          let nearest = preds[0];
          let minDiff = Infinity;
          for (const p of preds) {
            const diff = Math.abs(new Date(p.timestamp.replace(' ', 'T')).getTime() - t);
            if (diff < minDiff) { minDiff = diff; nearest = p; }
          }
          return {
            ts:         ind.timestamp,
            trend:      (nearest?.prediction ?? null) as RawPoint['trend'],
            confidence: nearest?.confidence ?? 0,
            structure:  (ind.candle_structure ?? null) as RawPoint['structure'],
          };
        });

        setResult(runPatternEngine(points));
      } catch {
        // non-critical
      }
    }
    load();
    return () => { cancelled = true; };
  }, [ticker, refreshKey, tf]);

  return result;
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  ticker:       string;
  isMobile:     boolean;
  onOpenDetail: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
const TickerInsightCard: React.FC<Props> = ({ ticker, isMobile, onOpenDetail }) => {
  const state      = useMarketStore((s) => s.tickers[ticker]);
  const signals    = useMarketStore((s) => s.signals);
  const refreshKey = state?.indicators?.timestamp ?? null;
  const price      = state?.price ?? null;
  const changePct  = state?.changePct ?? null;
  const result     = useInsightData(ticker, refreshKey);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);

  const recentVwapSignal = [...signals]
    .filter((sig) => sig.ticker === ticker && VWAP_SIGNAL_TYPES.has(sig.signal_type))
    .filter((sig) => now > 0 && new Date(sig.timestamp).getTime() >= now - 20 * 60_000)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const vwapDist = state?.indicators?.vwap_distance_pct ?? null;
  const showVwapBadge = !!recentVwapSignal && Math.abs(vwapDist ?? 0) < 1.0;

  const vwapSignalLabel = showVwapBadge ? formatVwapSignalLabel(recentVwapSignal!.signal_type) : null;
  const vwapSignalColor = showVwapBadge ? formatVwapSignalColor(recentVwapSignal!.signal_type) : '#64748b';

  const isUp   = changePct != null && changePct > 0;
  const isDown = changePct != null && changePct < 0;

  const tlColor    = TRAFFIC_HEX[result?.trafficLight ?? 'grey'];
  const sHex       = result?.currentStructure ? (STRUCT_HEX[result.currentStructure] ?? '#A0A0A0') : '#64748b';
  const trendHex   = result?.currentTrend === 'UP'   ? '#22c55e'
                   : result?.currentTrend === 'DOWN' ? '#ef5350' : '#64748b';
  const fillPct    = result ? Math.round(result.currentConf * 100) : 0;
  const trendArrow = result?.currentTrend === 'UP' ? '↑' : result?.currentTrend === 'DOWN' ? '↓' : '→';
  const aStyle     = ACTION_STYLE[result?.actionTone ?? 'neutral'];

  const daily_trend  = state?.indicators?.daily_trend ?? null;
  const rvol         = state?.indicators?.rvol ?? null;
  const volState     = state?.indicators?.volume_state ?? null;
  const lastFlipMins = result?.lastFlipMins ?? 0;
  const isStale      = lastFlipMins > 8;
  const htfHex       = daily_trend ? (HTF_HEX[daily_trend] ?? '#64748b') : '#64748b';
  const volHex       = volState    ? (VOL_HEX[volState]    ?? '#64748b') : '#64748b';
  const ageColor     = lastFlipMins <= 3 ? '#22c55e' : lastFlipMins <= 7 ? '#FFD700' : '#ef5350';

  // ── MOBILE ──────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div
        onClick={onOpenDetail}
        style={{
          background:   'var(--surface)',
          border:       '1px solid var(--border)',
          borderLeft:   `3px solid ${tlColor}`,
          borderRadius: 8,
          padding:      '10px 12px',
          cursor:       'pointer',
          display:      'flex',
          flexDirection: 'column',
          gap:          6,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 9, height: 9, borderRadius: '50%',
            background: tlColor, flexShrink: 0,
            boxShadow: `0 0 6px ${tlColor}88`,
          }} />
          <span style={{ fontWeight: 800, fontSize: '0.9rem', color: '#e0e0e0' }}>{ticker}</span>
          <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: '#c0c0c0' }}>{formatPrice(price)}</span>
          {changePct != null && (
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: isUp ? '#22c55e' : isDown ? '#ef5350' : '#9e9e9e' }}>
              {isUp ? '▲' : isDown ? '▼' : ''}{isUp ? '+' : ''}{changePct.toFixed(2)}%
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            {daily_trend && (
              <span style={{
                fontSize: '0.52rem', fontWeight: 700, color: htfHex,
                background: `${htfHex}18`, border: `1px solid ${htfHex}44`,
                borderRadius: 3, padding: '1px 4px',
              }}>
                D{daily_trend === 'BULL' ? '\u2191' : daily_trend === 'BEAR' ? '\u2193' : '\u2014'}
              </span>
            )}
            {isStale && (
              <span style={{
                fontSize: '0.5rem', fontWeight: 700, color: '#ef5350',
                background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.35)',
                borderRadius: 3, padding: '1px 4px',
              }}>STALE</span>
            )}
            {result?.pattern && (
              <span style={{
                fontSize: '0.58rem', fontWeight: 700,
                color: tlColor, background: `${tlColor}1a`,
                border: `1px solid ${tlColor}44`, borderRadius: 3, padding: '1px 6px',
              }}>
                {result.pattern}
              </span>
            )}
            {vwapSignalLabel && (
              <span style={{
                fontSize: '0.58rem', fontWeight: 700,
                color: vwapSignalColor, background: `${vwapSignalColor}18`,
                border: `1px solid ${vwapSignalColor}44`, borderRadius: 3, padding: '1px 6px',
              }}>
                {vwapSignalLabel}
              </span>
            )}
          </div>
        </div>

        {/* Structure · trend · fill bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {result?.currentStructure && (
            <span style={{ fontSize: '0.62rem', fontWeight: 700, color: sHex, minWidth: 58, flexShrink: 0 }}>
              {result.currentStructure}
            </span>
          )}
          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: trendHex, flexShrink: 0 }}>
            {trendArrow} {result?.currentTrend ?? '—'} {fillPct}%
          </span>
          <FillBar pct={fillPct} color={trendHex} />
          <span style={{ fontSize: '0.52rem', color: ageColor, flexShrink: 0 }}>~{lastFlipMins}m</span>
        </div>

        {/* Volume (mobile) */}
        {(rvol != null || volState) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: '0.52rem', color: '#475569', letterSpacing: '0.06em' }}>VOL</span>
            {rvol != null && (
              <span style={{ fontSize: '0.62rem', fontWeight: 700, color: volHex }}>{rvol.toFixed(1)}×</span>
            )}
            {volState && (
              <span style={{
                fontSize: '0.5rem', fontWeight: 700, color: volHex,
                background: `${volHex}18`, border: `1px solid ${volHex}44`,
                borderRadius: 3, padding: '1px 4px',
              }}>{volState}</span>
            )}
          </div>
        )}

        {/* Action */}
        {result?.action && (
          <div style={{
            fontSize: '0.64rem', color: aStyle.color,
            background: aStyle.bg, border: `1px solid ${aStyle.border}`,
            borderRadius: 4, padding: '3px 8px', lineHeight: 1.35,
          }}>
            {result.action}
          </div>
        )}

        {/* History strip — scrollable */}
        {result && result.chips.length > 0 && (
          <HistoryStrip chips={result.chips} scrollable />
        )}
      </div>
    );
  }

  // ── DESKTOP ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background:    'var(--surface)',
      border:        '1px solid var(--border)',
      borderRadius:  10,
      overflow:      'hidden',
      display:       'flex',
      flexDirection: 'column',
    }}>
      {/* Top accent strip */}
      <div style={{ height: 3, background: tlColor, flexShrink: 0 }} />

      {/* Card header — clickable */}
      <div
        onClick={onOpenDetail}
        style={{
          display:       'flex',
          alignItems:    'center',
          gap:           8,
          padding:       '9px 12px 8px',
          borderBottom:  '1px solid var(--border)',
          cursor:        'pointer',
          flexShrink:    0,
        }}
      >
        <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#e0e0e0' }}>{ticker}</span>
        <span style={{ fontSize: '0.85rem', fontFamily: 'monospace', color: '#c0c0c0' }}>{formatPrice(price)}</span>
        {changePct != null && (
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: isUp ? '#22c55e' : isDown ? '#ef5350' : '#9e9e9e' }}>
            {isUp ? '▲' : isDown ? '▼' : ''}{isUp ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {daily_trend && (
            <span style={{
              fontSize: '0.58rem', fontWeight: 700, color: htfHex,
              background: `${htfHex}18`, border: `1px solid ${htfHex}44`,
              borderRadius: 3, padding: '1px 5px',
            }}>
              D{daily_trend === 'BULL' ? '\u2191' : daily_trend === 'BEAR' ? '\u2193' : '\u2014'}
            </span>
          )}
          {isStale && (
            <span style={{
              fontSize: '0.52rem', fontWeight: 700, color: '#ef5350',
              background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.35)',
              borderRadius: 3, padding: '1px 5px',
            }}>STALE</span>
          )}
          {result?.pattern && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700, color: tlColor,
              background: `${tlColor}22`, border: `1px solid ${tlColor}55`,
              borderRadius: 4, padding: '2px 8px',
            }}>
              {result.pattern}
            </span>
          )}
          {vwapSignalLabel && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700, color: vwapSignalColor,
              background: `${vwapSignalColor}22`, border: `1px solid ${vwapSignalColor}55`,
              borderRadius: 4, padding: '2px 8px',
            }}>
              {vwapSignalLabel}
            </span>
          )}
          <span style={{ fontSize: '0.62rem', color: '#475569', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>
            → Detail
          </span>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1 }}>
        {/* Traffic light column */}
        <div style={{
          width:          72,
          flexShrink:     0,
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          padding:        '14px 8px',
          borderRight:    '1px solid var(--border)',
          gap:            7,
        }}>
          <div style={{
            width:     38,
            height:    38,
            borderRadius: '50%',
            background: tlColor,
            boxShadow:  `0 0 18px ${tlColor}66, 0 0 5px ${tlColor}`,
            flexShrink: 0,
          }} />
          <span style={{
            fontSize:      '0.5rem',
            fontWeight:    700,
            color:         tlColor,
            letterSpacing: '0.06em',
            textAlign:     'center',
            lineHeight:    1.3,
          }}>
            {result?.shortLabel ?? '—'}
          </span>
        </div>

        {/* Info column */}
        <div style={{ flex: 1, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>

          {/* Market Read */}
          <div>
            <div style={{ fontSize: '0.5rem', color: '#475569', letterSpacing: '0.08em', marginBottom: 3 }}>MARKET READ</div>
            {result?.currentStructure ? (
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: sHex }}>
                {result.currentStructure === 'UPTREND' ? '▲' :
                 result.currentStructure === 'DOWNTREND' ? '▼' :
                 result.currentStructure === 'COILING' ? '◆' : '↔'}{' '}
                {result.currentStructure}
              </span>
            ) : <span style={{ color: '#475569', fontSize: '0.75rem' }}>—</span>}
            <span style={{ fontSize: '0.58rem', color: '#334155', marginLeft: 6 }}>last 30 min</span>
          </div>

          {/* Trend + confidence */}
          <div>
            <div style={{ fontSize: '0.5rem', color: '#475569', letterSpacing: '0.08em', marginBottom: 4 }}>TREND · CONFIDENCE</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: trendHex, flexShrink: 0 }}>
                {trendArrow} {result?.currentTrend ?? '—'} · {fillPct}% conf
              </span>
              <FillBar pct={fillPct} color={trendHex} height={6} />              <span style={{ fontSize: '0.55rem', color: ageColor, flexShrink: 0, whiteSpace: 'nowrap' }}>~{lastFlipMins}m</span>            </div>
          </div>

          {/* Volume */}
          {(rvol != null || volState) && (
            <div>
              <div style={{ fontSize: '0.5rem', color: '#475569', letterSpacing: '0.08em', marginBottom: 3 }}>VOLUME</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {rvol != null && (
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: volHex }}>{rvol.toFixed(1)}×</span>
                )}
                {volState && (
                  <span style={{
                    fontSize: '0.55rem', fontWeight: 700, color: volHex,
                    background: `${volHex}18`, border: `1px solid ${volHex}44`,
                    borderRadius: 3, padding: '1px 5px',
                  }}>{volState}</span>
                )}
              </div>
            </div>
          )}

          {/* Headline + action */}
          <div>
            <div style={{ fontSize: '0.5rem', color: '#475569', letterSpacing: '0.08em', marginBottom: 4 }}>SIGNAL REASON</div>
            {result?.headline && (
              <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#c0c0c0', marginBottom: 5 }}>
                {result.headline}
              </div>
            )}
            {result?.action && (
              <div style={{
                fontSize: '0.66rem', color: aStyle.color,
                background: aStyle.bg, border: `1px solid ${aStyle.border}`,
                borderRadius: 4, padding: '4px 9px', lineHeight: 1.4,
              }}>
                {result.action}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* History strip */}
      {result && result.chips.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '6px 10px 7px', flexShrink: 0 }}>
          <div style={{ fontSize: '0.47rem', color: '#334155', letterSpacing: '0.08em', marginBottom: 5 }}>
            10-MIN SIGNAL HISTORY
          </div>
          <HistoryStrip chips={result.chips} scrollable={true} />
          {/* Legend */}
          <div style={{ display: 'flex', gap: 10, marginTop: 5, flexWrap: 'wrap' }}>
            {([['green','#00C896','BUY'], ['yellow','#FFD700','WAIT'], ['red','#FF4C4C','SELL/OUT'], ['orange','#fb923c','COILING'], ['grey','#A0A0A0','CHOPPY']] as [string,string,string][]).map(([, hex, label]) => (
              <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.45rem', color: '#475569' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: hex, display: 'inline-block' }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TickerInsightCard;

import React, { useEffect, useState, useRef, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '../../utils/formatters';
import { useMarketStore } from '../../stores/marketStore';

type Trend = 'UP' | 'DOWN' | 'NEUTRAL' | 'ABSTAIN' | null;
type Structure = 'UPTREND' | 'DOWNTREND' | 'COILING' | 'CHOPPY' | null;

interface DataPoint {
  ts: string;
  label: string;
  trend: Trend;
  confidence: number;
  structure: Structure;
}

interface Props {
  ticker: string;
  /** Pass `indicatorTimestamp` so the timeline re-fetches on every backend cycle. */
  refreshKey: string | null;
}

// ── Color maps ────────────────────────────────────────────────────────────────
const TREND_HEX: Record<string, string> = {
  UP:      '#22c55e',
  DOWN:    '#ef5350',
  NEUTRAL: '#94a3b8',
  ABSTAIN: '#475569',
};

const STRUCT_HEX: Record<string, string> = {
  UPTREND:   '#00C896', // bright green  — momentum, go
  DOWNTREND: '#FF4C4C', // bright red    — danger, fall
  COILING:   '#FFD700', // amber/gold    — energy building
  CHOPPY:    '#A0A0A0', // grey          — no signal
};

const STRUCT_SHORT: Record<string, string> = {
  UPTREND:   'UP',
  DOWNTREND: 'DN',
  COILING:   'COIL',
  CHOPPY:    'CHOP',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Returns the agreement indicator bar color for a column. */
function agreementColor(trend: Trend, structure: Structure): string {
  if (!trend || !structure) return 'transparent';
  if (structure === 'COILING')                                         return '#FFD700'; // always gold  — watch
  if (trend === 'UP'   && structure === 'UPTREND')                     return '#00C896'; // aligned bull
  if (trend === 'DOWN' && structure === 'DOWNTREND')                   return '#FF4C4C'; // aligned bear
  if ((trend === 'UP' && structure === 'DOWNTREND') ||
      (trend === 'DOWN' && structure === 'UPTREND'))                   return '#fb923c'; // conflict — orange
  return 'transparent';
}

function normTs(ts: string): number {
  return new Date(ts.replace(' ', 'T')).getTime();
}

function formatLabel(ts: string): string {
  const d = new Date(ts.replace(' ', 'T'));
  if (isNaN(d.getTime())) return ts.slice(11, 16);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
const TrendStructureTimeline: React.FC<Props> = ({ ticker, refreshKey }) => {
  const [data, setData]       = useState<DataPoint[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tooltipX, setTooltipX] = useState(0); // already clamped; safe to use in render
  const containerRef = useRef<HTMLDivElement>(null);
  const tf = useMarketStore((s) => s.selectedTimeframe);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [predRes, indRes] = await Promise.all([
          axios.get(`${API_BASE}/predictions/${ticker}?limit=30&timeframe=${tf}`),
          axios.get(`${API_BASE}/indicators/${ticker}/history?limit=30&timeframe=${tf}`),
        ]);
        if (cancelled) return;

        // predictions → sort ascending (API returns newest-first)
        const preds: Array<{ timestamp: string; prediction: string; confidence: number }> =
          [...(predRes.data.predictions ?? [])]
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        // history → already oldest-first from API
        const inds: Array<{ timestamp: string; candle_structure: string | null }> =
          [...(indRes.data.history ?? [])];

        // Join: for each indicator snapshot find the nearest prediction in time
        const points: DataPoint[] = inds.map((ind) => {
          const t = normTs(ind.timestamp);
          let nearest = preds[0];
          let minDiff = Infinity;
          for (const p of preds) {
            const diff = Math.abs(normTs(p.timestamp) - t);
            if (diff < minDiff) { minDiff = diff; nearest = p; }
          }
          return {
            ts:         ind.timestamp,
            label:      formatLabel(ind.timestamp),
            trend:      (nearest?.prediction as Trend) ?? null,
            confidence: nearest?.confidence ?? 0,
            structure:  (ind.candle_structure as Structure) ?? null,
          };
        });

        setData(points);
      } catch {
        // non-critical — timeline degrades silently
      }
    }

    load();
    return () => { cancelled = true; };
  }, [ticker, refreshKey, tf]);

  const handleMouseEnter = useCallback((i: number, e: React.MouseEvent<HTMLDivElement>) => {
    setHovered(i);
    if (containerRef.current) {
      const contRect = containerRef.current.getBoundingClientRect();
      const colRect  = e.currentTarget.getBoundingClientRect();
      const raw = colRect.left - contRect.left;
      // Clamp here (ref is safe in event handlers)
      setTooltipX(Math.min(raw, containerRef.current.offsetWidth - 145));
    }
  }, []);

  // Skeleton while loading
  if (!data.length) {
    return (
      <div style={{
        height: 56,
        borderBottom: '1px solid var(--border)',
        background: 'rgba(0,0,0,0.15)',
      }} />
    );
  }

  const hovP = hovered !== null ? data[hovered] : null;

  return (
    <div
      ref={containerRef}
      style={{
        position:    'relative',
        height:      56,
        borderBottom: '1px solid var(--border)',
        background:  'rgba(0,0,0,0.18)',
        display:     'flex',
        alignItems:  'stretch',
        padding:     '4px 6px',
        boxSizing:   'border-box',
        overflow:    'visible',
        userSelect:  'none',
      }}
    >
      {/* ── Row labels ── */}
      <div style={{
        display:        'flex',
        flexDirection:  'column',
        justifyContent: 'space-around',
        width:          40,
        flexShrink:     0,
        paddingRight:   4,
        gap:            2,
      }}>
        <span style={{ fontSize: '0.52rem', color: '#64748b', textAlign: 'right', letterSpacing: '0.06em', fontWeight: 600 }}>TREND</span>
        <span style={{ fontSize: '0.52rem', color: '#64748b', textAlign: 'right', letterSpacing: '0.06em', fontWeight: 600 }}>STRUCT</span>
      </div>

      {/* ── Data columns ── */}
      <div style={{ flex: 1, display: 'flex', gap: 2, minWidth: 0 }}>
        {data.map((point, i) => {
          const isNow  = i === data.length - 1;
          const isHov  = hovered === i;
          const tHex   = point.trend      ? (TREND_HEX[point.trend]      ?? '#475569') : '#475569';
          const sHex   = point.structure  ? (STRUCT_HEX[point.structure] ?? '#A0A0A0') : '#A0A0A0';
          const fillPct = point.trend ? Math.round(point.confidence * 100) : 0;
          const agColor = agreementColor(point.trend, point.structure);
          const showLabel = isNow || isHov;

          return (
            <div
              key={i}
              onMouseEnter={(e) => handleMouseEnter(i, e)}
              onMouseLeave={() => setHovered(null)}
              style={{
                flex:           1,
                display:        'flex',
                flexDirection:  'column',
                gap:            2,
                cursor:         'default',
                minWidth:       0,
                position:       'relative',
              }}
            >
              {/* Agreement bar — top edge of column */}
              {agColor !== 'transparent' && (
                <div style={{
                  position:     'absolute',
                  top:          0,
                  left:         0,
                  right:        0,
                  height:       2,
                  background:   agColor,
                  borderRadius: 1,
                  opacity:      isNow ? 1 : 0.55,
                  zIndex:       1,
                }} />
              )}

              {/* Trend lane — fill bar (filled=confidence%, rest=grey) */}
              <div style={{
                flex:           '0 0 22px',
                marginTop:      2,
                background:     '#252538', // unfilled section — neutral grey
                borderRadius:   2,
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'center',
                border:         isHov  ? `1px solid ${tHex}99`
                               : isNow ? `1px solid ${tHex}66`
                               : '1px solid transparent',
                overflow:       'hidden',
                position:       'relative',
                transition:     'border 0.1s',
              }}>
                {/* Colored fill proportional to confidence */}
                {point.trend && (
                  <div style={{
                    position:   'absolute',
                    left: 0, top: 0, bottom: 0,
                    width:      `${fillPct}%`,
                    background: tHex,
                  }} />
                )}
                {/* Label — always on top, always white */}
                {showLabel && point.trend && (
                  <span style={{
                    position:   'relative',
                    zIndex:     1,
                    fontSize:   '0.5rem',
                    fontWeight: 700,
                    color:      '#ffffff',
                    whiteSpace: 'nowrap',
                    lineHeight: 1,
                    textShadow: '0 0 4px rgba(0,0,0,0.8)',
                  }}>
                    {point.trend === 'UP' ? '↑' : point.trend === 'DOWN' ? '↓' : point.trend}
                    {' '}{fillPct}%
                  </span>
                )}
              </div>

              {/* Structure lane — solid color block */}
              <div style={{
                flex:           '0 0 17px',
                background:     sHex + '55', // ~33% opacity base
                borderRadius:   2,
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'center',
                border:         isHov  ? `1px solid ${sHex}cc`
                               : isNow ? `1px solid ${sHex}88`
                               : `1px solid ${sHex}33`,
                overflow:       'hidden',
                transition:     'border 0.1s',
              }}>
                {showLabel && point.structure && (
                  <span style={{
                    fontSize:   '0.48rem',
                    fontWeight: 700,
                    color:      sHex,
                    whiteSpace: 'nowrap',
                    lineHeight: 1,
                  }}>
                    {STRUCT_SHORT[point.structure]}
                  </span>
                )}
              </div>

              {/* "now" dot below the column */}
              {isNow && (
                <div style={{
                  position:     'absolute',
                  bottom:       -1,
                  left:         '50%',
                  transform:    'translateX(-50%)',
                  width:        4,
                  height:       4,
                  borderRadius: '50%',
                  background:   '#fff',
                  opacity:      0.55,
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* "30m ago" / "now" edge labels */}
      <div style={{
        position:       'absolute',
        bottom:         3,
        left:           50,
        fontSize:       '0.48rem',
        color:          '#334155',
        pointerEvents:  'none',
        letterSpacing:  '0.04em',
      }}>
        30m ago
      </div>
      <div style={{
        position:       'absolute',
        bottom:         3,
        right:          8,
        fontSize:       '0.48rem',
        color:          '#64748b',
        fontWeight:     700,
        pointerEvents:  'none',
        letterSpacing:  '0.04em',
      }}>
        now
      </div>

      {/* ── Tooltip ── */}
      {hovP && (
        <div style={{
          position:     'absolute',
          top:          60,
          left:         tooltipX,
          background:   '#1e293b',
          border:       '1px solid #334155',
          borderRadius: 6,
          padding:      '6px 10px',
          fontSize:     '0.7rem',
          color:        '#e2e8f0',
          zIndex:       200,
          pointerEvents: 'none',
          minWidth:     138,
          boxShadow:    '0 4px 16px rgba(0,0,0,0.65)',
        }}>
          <div style={{ color: '#94a3b8', marginBottom: 5, fontSize: '0.6rem', fontWeight: 600 }}>
            {hovP.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ color: '#64748b', fontSize: '0.62rem', width: 38 }}>Trend</span>
            <span style={{ fontWeight: 700, color: hovP.trend ? (TREND_HEX[hovP.trend] ?? '#94a3b8') : '#475569' }}>
              {hovP.trend === 'UP' ? '↑ UP' : hovP.trend === 'DOWN' ? '↓ DOWN' : hovP.trend ?? '—'}
            </span>
            <span style={{ color: '#94a3b8', fontSize: '0.65rem' }}>
              {Math.round(hovP.confidence * 100)}%
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ color: '#64748b', fontSize: '0.62rem', width: 38 }}>Struct</span>
            <span style={{ fontWeight: 700, color: hovP.structure ? (STRUCT_HEX[hovP.structure] ?? '#94a3b8') : '#475569' }}>
              {hovP.structure ?? '—'}
            </span>
          </div>
          {/* Agreement badge */}
          {(() => {
            const ac = agreementColor(hovP.trend, hovP.structure);
            if (ac === 'transparent') return null;
            const label =
              hovP.structure === 'COILING'                                              ? 'Coiling — watch breakout'
              : (hovP.trend === 'UP'   && hovP.structure === 'UPTREND')                ? 'Aligned Bull'
              : (hovP.trend === 'DOWN' && hovP.structure === 'DOWNTREND')              ? 'Aligned Bear'
              : 'Conflicting — stay flat';
            return (
              <div style={{
                marginTop:    3,
                fontSize:     '0.6rem',
                fontWeight:   600,
                color:        ac,
                borderTop:    '1px solid #1e3a5f',
                paddingTop:   3,
              }}>
                {label}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default TrendStructureTimeline;

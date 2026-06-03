import React from 'react';
import { useMarketStore } from '../../stores/marketStore';

const INDEX_TICKERS = ['SPY', 'QQQ', 'SPX'] as const;

type DailyTrend = 'BULL' | 'BEAR' | 'NEUTRAL' | null;

const TREND_ARROW: Record<string, string> = { BULL: '↑', BEAR: '↓', NEUTRAL: '—' };
const TREND_HEX:   Record<string, string> = { BULL: '#22c55e', BEAR: '#ef5350', NEUTRAL: '#64748b' };

interface Alignment { label: string; color: string; bg: string; icon: string; }

function computeAlignment(trends: DailyTrend[]): Alignment {
  const valid = trends.filter((t): t is 'BULL' | 'BEAR' | 'NEUTRAL' => t != null);
  if (valid.length === 0) return { label: 'Awaiting data', color: '#64748b', bg: 'transparent', icon: '◌' };
  const bulls = valid.filter(t => t === 'BULL').length;
  const bears = valid.filter(t => t === 'BEAR').length;
  if (bulls === valid.length) return { label: 'Macro Tailwind',  color: '#22c55e', bg: 'rgba(34,197,94,0.06)',   icon: '↑' };
  if (bears === valid.length) return { label: 'Macro Headwind',  color: '#ef5350', bg: 'rgba(239,83,80,0.06)',   icon: '↓' };
  if (bulls > bears)          return { label: 'Lean Bullish',    color: '#FFD700', bg: 'rgba(255,215,0,0.05)',   icon: '↗' };
  if (bears > bulls)          return { label: 'Lean Bearish',    color: '#fb923c', bg: 'rgba(251,146,60,0.06)', icon: '↘' };
  return                             { label: 'Index Conflict',   color: '#fb923c', bg: 'rgba(251,146,60,0.06)', icon: '⚠' };
}

const MacroBanner: React.FC = () => {
  const storeTickers = useMarketStore((s) => s.tickers);
  const trends: DailyTrend[] = INDEX_TICKERS.map(t => storeTickers[t]?.indicators?.daily_trend ?? null);
  const align = computeAlignment(trends);

  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          12,
      padding:      '5px 14px',
      background:   align.bg,
      borderBottom: '1px solid var(--border)',
      flexShrink:   0,
      flexWrap:     'wrap',
    }}>
      <span style={{ fontSize: '0.5rem', color: '#475569', letterSpacing: '0.1em', flexShrink: 0 }}>
        MACRO INDEX
      </span>

      {/* Individual index pills */}
      {INDEX_TICKERS.map((t, i) => {
        const tr  = trends[i];
        const hex = tr ? (TREND_HEX[tr] ?? '#64748b') : '#475569';
        return (
          <span key={t} style={{ fontSize: '0.62rem', fontWeight: 700, color: hex, display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: '#6b7280', fontWeight: 400 }}>{t}</span>
            {tr ? TREND_ARROW[tr] : '?'}
          </span>
        );
      })}

      <span style={{ color: '#334155', fontSize: '0.6rem', flexShrink: 0 }}>·</span>

      {/* Overall alignment label */}
      <span style={{ fontSize: '0.62rem', fontWeight: 700, color: align.color, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: align.color, boxShadow: `0 0 6px ${align.color}88`,
          display: 'inline-block', flexShrink: 0,
        }} />
        {align.icon} {align.label}
      </span>

      {/* Conflict warning */}
      {(align.label === 'Index Conflict' || align.label === 'Lean Bearish') && (
        <span style={{
          fontSize: '0.5rem', color: '#fb923c',
          background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)',
          borderRadius: 3, padding: '1px 6px',
        }}>
          Check index alignment before trading
        </span>
      )}
    </div>
  );
};

export default MacroBanner;

import React from 'react';
import { useMarketStore, TIMEFRAMES } from '../stores/marketStore';
import type { Timeframe } from '../stores/marketStore';

interface Props {
  size?: 'sm' | 'md';
  title?: string;
}

/**
 * Segmented control for the global active timeframe (2m / 5m / 15m).
 * Switching TF resets per-ticker indicator/candle caches and triggers a
 * fresh dashboard fetch + WebSocket re-subscription.
 */
const TimeframeSelector: React.FC<Props> = ({ size = 'sm', title = 'Active timeframe' }) => {
  const tf = useMarketStore((s) => s.selectedTimeframe);
  const setTf = useMarketStore((s) => s.setSelectedTimeframe);

  const pad = size === 'sm' ? '3px 9px' : '5px 12px';
  const fontSize = size === 'sm' ? '0.68rem' : '0.78rem';

  return (
    <div
      role="group"
      aria-label={title}
      title={title}
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border)',
        borderRadius: 5,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {TIMEFRAMES.map((opt: Timeframe, idx) => {
        const active = tf === opt;
        return (
          <button
            key={opt}
            onClick={() => { if (!active) setTf(opt); }}
            aria-pressed={active}
            style={{
              padding: pad,
              fontSize,
              fontWeight: 700,
              lineHeight: 1,
              cursor: active ? 'default' : 'pointer',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--text)',
              border: 'none',
              borderRight: idx < TIMEFRAMES.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
};

export default TimeframeSelector;

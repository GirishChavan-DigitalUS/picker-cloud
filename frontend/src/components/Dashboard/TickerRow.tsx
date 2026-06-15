import React, { useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';
import { formatPrice } from '../../utils/formatters';
import ConfirmDialog from '../ConfirmDialog';

interface TickerRowProps {
  ticker: string;
  selected: boolean;
  onClick: () => void;
  onRemove: () => void;
  confluenceStrength?: string | null;
}

const TickerRow: React.FC<TickerRowProps> = ({ ticker, selected, onClick, onRemove, confluenceStrength }) => {
  const state = useMarketStore((s) => s.tickers[ticker]);
  const signals = useMarketStore((s) => s.signals);
  const ind = state?.indicators ?? null;
  const pred = state?.latestPrediction ?? null;
  const [hovering, setHovering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  React.useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);

  const recentVwapSignal = [...signals]
    .filter((sig) => sig.ticker === ticker && ['vwap_reclaim', 'vwap_breakdown'].includes(sig.signal_type))
    .filter((sig) => now > 0 && new Date(sig.timestamp).getTime() >= now - 20 * 60_000)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const vwapDist = ind?.vwap_distance_pct ?? null;
  const showVwapBadge = !!recentVwapSignal && Math.abs(vwapDist ?? 0) < 1.0;

  const vwapLabel = showVwapBadge
    ? (recentVwapSignal!.signal_type === 'vwap_reclaim' ? 'VWAP BUY' : 'VWAP SELL')
    : null;
  const vwapColor = showVwapBadge
    ? (recentVwapSignal!.signal_type === 'vwap_reclaim' ? '#26a69a' : '#ef5350')
    : undefined;

  const confluenceBias = ind?.confluence_bias ?? null;
  const confluenceLabel = confluenceBias === 'BULL' ? 'BUY'
    : confluenceBias === 'BEAR' ? 'SELL'
    : confluenceBias === 'MIXED' ? 'MIXED'
    : null;
  const confluenceColor = confluenceBias === 'BULL' ? '#26a69a'
    : confluenceBias === 'BEAR' ? '#ef5350'
    : '#64748b';
  const showConfluenceBadge = confluenceBias != null || confluenceStrength != null;

  const priceColor = ind?.ema_state === 'BULLISH' ? '#26a69a'
    : ind?.ema_state === 'BEARISH' ? '#ef5350'
    : '#e0e0e0';

  const aiDir = pred?.prediction as string | undefined;
  const aiConf = pred?.confidence as number | undefined;
  const aiColor = aiDir === 'UP' ? '#26a69a' : aiDir === 'DOWN' ? '#ef5350' : '#555';
  const aiLabel = aiDir && aiConf != null ? `${Math.round(aiConf * 100)}%` : '—';

  return (
    <tr
      className={`ticker-row${selected ? ' selected' : ''}`}
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ cursor: 'pointer' }}
    >
      <td style={{ fontWeight: 700, color: '#e0e0e0', letterSpacing: '0.03em', position: 'relative' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {ticker}
          {vwapLabel && (
            <span style={{
              fontSize: '0.62rem', fontWeight: 700,
              color: vwapColor,
              background: `${vwapColor}16`,
              border: `1px solid ${vwapColor}44`,
              borderRadius: 4,
              padding: '1px 5px',
              lineHeight: 1,
            }}>
              {vwapLabel}
            </span>
          )}
          {showConfluenceBadge && (
            <span style={{
              fontSize: '0.62rem', fontWeight: 700,
              color: confluenceColor,
              background: `${confluenceColor}16`,
              border: `1px solid ${confluenceColor}44`,
              borderRadius: 4,
              padding: '1px 5px',
              lineHeight: 1,
            }}>
              {confluenceLabel ?? 'MIXED'}
            </span>
          )}
        </span>
        {hovering && (
          <span
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
            title="Remove"
            style={{
              position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
              color: '#ef5350', fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer',
              lineHeight: 1, padding: '1px 3px',
            }}
          >×</span>
        )}
        {confirmDelete && (
          <ConfirmDialog
            message={`Remove ${ticker}?`}
            detail="It will be removed from your watchlist."
            confirmLabel="Remove"
            danger
            onConfirm={() => { setConfirmDelete(false); onRemove(); }}
            onCancel={() => setConfirmDelete(false)}
          />
        )}
      </td>
      <td style={{ fontFamily: 'monospace', color: priceColor, fontSize: '0.8rem' }}>
        {formatPrice(state?.price ?? null)}
      </td>
      <td style={{ fontWeight: 700, fontSize: '0.72rem', color: aiColor, textAlign: 'center' }}>
        {aiLabel}
      </td>
    </tr>
  );
};

export default TickerRow;

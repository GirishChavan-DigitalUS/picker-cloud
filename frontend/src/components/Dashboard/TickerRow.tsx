import React, { useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';
import { formatPrice } from '../../utils/formatters';
import ConfirmDialog from '../ConfirmDialog';

interface TickerRowProps {
  ticker: string;
  selected: boolean;
  onClick: () => void;
  onRemove: () => void;
}

const TickerRow: React.FC<TickerRowProps> = ({ ticker, selected, onClick, onRemove }) => {
  const state = useMarketStore((s) => s.tickers[ticker]);
  const ind = state?.indicators ?? null;
  const pred = state?.latestPrediction ?? null;
  const [hovering, setHovering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
        {ticker}
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

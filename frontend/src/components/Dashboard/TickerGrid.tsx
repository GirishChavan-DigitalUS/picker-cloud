import React, { useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';
import TickerRow from './TickerRow';
import ConfirmDialog from '../ConfirmDialog';

interface TickerGridProps {
  tickers: string[];
  onSelectTicker: (ticker: string) => void;
  selectedTicker: string | null;
  sortBy: 'ticker' | 'price' | 'ai' | null;
  onSortChange: (s: 'ticker' | 'price' | 'ai') => void;
  onAddTicker: (t: string) => Promise<string | null>;
  onRemoveTicker: (t: string) => void;
}

// Defined outside TickerGrid to prevent recreation on every render
const SortBtn: React.FC<{
  by: 'ticker' | 'price' | 'ai';
  label: string;
  sortBy: 'ticker' | 'price' | 'ai' | null;
  onSortChange: (s: 'ticker' | 'price' | 'ai') => void;
}> = ({ by, label, sortBy, onSortChange }) => (
  <button
    onClick={() => onSortChange(by)}
    style={{
      background: sortBy === by ? 'var(--accent)' : 'var(--surface2)',
      border: '1px solid var(--border)',
      color: sortBy === by ? '#fff' : 'var(--muted)',
      borderRadius: 3, padding: '2px 6px', fontSize: '0.62rem',
      cursor: 'pointer', fontWeight: 600,
    }}
  >{label}</button>
);

const TickerGrid: React.FC<TickerGridProps> = ({
  tickers, onSelectTicker, selectedTicker,
  sortBy, onSortChange, onAddTicker, onRemoveTicker,
}) => {
  const [adding, setAdding] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addLoading, setAddLoading] = useState(false);
  const [confirmAdd, setConfirmAdd] = useState<string | null>(null);
  const allPrices = useMarketStore((s) => s.tickers);

  // AI sort order: UP=0, null/unknown=1, DOWN=2
  const aiRank = (ticker: string) => {
    const p = allPrices[ticker]?.latestPrediction?.prediction as string | undefined;
    if (p === 'UP') return 0;
    if (p === 'DOWN') return 2;
    return 1;
  };

  const sorted = [...tickers].sort((a, b) => {
    if (sortBy === 'ticker') return a.localeCompare(b);
    if (sortBy === 'price') {
      const pa = allPrices[a]?.price ?? 0;
      const pb = allPrices[b]?.price ?? 0;
      return pb - pa;
    }
    if (sortBy === 'ai') return aiRank(a) - aiRank(b);
    return 0;
  });

  const handleAdd = async () => {
    const sym = inputVal.trim().toUpperCase();
    if (!sym) return;
    if (tickers.includes(sym)) { setInputVal(''); setAdding(false); return; }
    setConfirmAdd(sym);
  };

  const handleConfirmedAdd = async (sym: string) => {
    setConfirmAdd(null);
    setAddLoading(true);
    setAddError(null);
    const err = await onAddTicker(sym);
    setAddLoading(false);
    if (err) {
      setAddError(err);
    } else {
      setInputVal('');
      setAdding(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {confirmAdd && (
        <ConfirmDialog
          message={`Add ${confirmAdd}?`}
          detail="This ticker will be added to your watchlist."
          confirmLabel="Add"
          onConfirm={() => handleConfirmedAdd(confirmAdd)}
          onCancel={() => setConfirmAdd(null)}
        />
      )}
      {/* Controls */}
      <div style={{ padding: '6px 6px 4px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: '0.6rem', color: 'var(--muted)', fontWeight: 600 }}>SORT</span>
          <SortBtn by="ticker" label="A-Z" sortBy={sortBy} onSortChange={onSortChange} />
          <SortBtn by="price" label="$" sortBy={sortBy} onSortChange={onSortChange} />
          <SortBtn by="ai" label="AI" sortBy={sortBy} onSortChange={onSortChange} />
          <button
            onClick={() => { setAdding((v) => !v); setAddError(null); setInputVal(''); }}
            title="Add ticker"
            style={{
              marginLeft: 'auto', background: 'var(--surface2)', border: '1px solid var(--border)',
              color: 'var(--accent)', borderRadius: 3, padding: '2px 7px',
              fontSize: '0.75rem', cursor: 'pointer', fontWeight: 700, lineHeight: 1,
            }}
          >+</button>
        </div>
        {adding && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                autoFocus
                value={inputVal}
                onChange={(e) => { setInputVal(e.target.value.toUpperCase()); setAddError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setAdding(false); setAddError(null); } }}
                placeholder="TICKER"
                maxLength={6}
                disabled={addLoading}
                style={{
                  flex: 1, background: 'var(--bg)', border: `1px solid ${addError ? '#f44' : 'var(--accent)'}`,
                  color: 'var(--text)', borderRadius: 3, padding: '3px 5px',
                  fontSize: '0.75rem', fontFamily: 'monospace', textTransform: 'uppercase',
                }}
              />
              <button onClick={handleAdd} disabled={addLoading} style={{ background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 3, padding: '3px 7px', fontSize: '0.72rem', cursor: addLoading ? 'wait' : 'pointer' }}>
                {addLoading ? '…' : 'OK'}
              </button>
            </div>
            {addError && (
              <span style={{ fontSize: '0.6rem', color: '#f44', padding: '0 2px', lineHeight: 1.3 }}>{addError}</span>
            )}
          </div>
        )}
      </div>
      {/* Ticker list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <table className="ticker-grid">
          <thead>
            <tr><th>Ticker</th><th>Price</th><th>AI</th></tr>
          </thead>
          <tbody>
            {sorted.map((ticker) => (
              <TickerRow
                key={ticker}
                ticker={ticker}
                selected={selectedTicker === ticker}
                onClick={() => onSelectTicker(ticker)}
                onRemove={() => onRemoveTicker(ticker)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TickerGrid;

import React from 'react';
import TickerInsightCard from './TickerInsightCard';
import MacroBanner from './MacroBanner';
import { useMarketStore } from '../../stores/marketStore';

interface Props {
  tickers:        string[];
  isMobile:       boolean;
  onSelectTicker: (ticker: string) => void;
  sortBy?:        'ticker' | 'price' | 'ai' | null;
}

const InsightGrid: React.FC<Props> = ({ tickers, isMobile, onSelectTicker, sortBy }) => {
  const allPrices = useMarketStore((s) => s.tickers);

  const aiConfidence = (ticker: string) => {
    const conf = allPrices[ticker]?.latestPrediction?.confidence;
    return typeof conf === 'number' ? conf : -1;
  };

  const sorted = [...tickers].sort((a, b) => {
    if (sortBy === 'ticker') return a.localeCompare(b);
    if (sortBy === 'price') {
      const pa = allPrices[a]?.price ?? 0;
      const pb = allPrices[b]?.price ?? 0;
      return pb - pa;
    }
    if (sortBy === 'ai') {
      const ca = aiConfidence(a);
      const cb = aiConfidence(b);
      if (ca !== cb) return cb - ca;
      return a.localeCompare(b);
    }
    return 0;
  });
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <MacroBanner />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px' }}>
          {sorted.map((ticker) => (
            <TickerInsightCard
              key={ticker}
              ticker={ticker}
              isMobile
              onOpenDetail={() => onSelectTicker(ticker)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <MacroBanner />
      <div style={{
        display:       'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
        gap:           12,
        padding:       14,
        boxSizing:     'border-box',
        alignContent:  'start',
      }}>
      {sorted.map((ticker) => (
        <TickerInsightCard
          key={ticker}
          ticker={ticker}
          isMobile={false}
          onOpenDetail={() => onSelectTicker(ticker)}
        />
      ))}
      </div>
    </div>
  );
};

export default InsightGrid;

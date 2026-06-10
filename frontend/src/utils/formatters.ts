export const TICKERS = ['SPY', 'QQQ', 'SPX', 'AAPL', 'GOOGL', 'NVDA', 'TSLA', 'AMZN', 'MSFT', 'PLTR', 'META', 'AMD'] as const;
export type Ticker = typeof TICKERS[number];

export const API_BASE = '/api';

/** Unified data-refresh interval — 2 minutes in milliseconds. */
export const DATA_REFRESH_INTERVAL = 120_000;

export function formatPrice(p: number | null): string {
  if (p == null) return '—';
  return p >= 1000 ? p.toFixed(2) : p.toFixed(4);
}

export function formatPct(p: number | null): string {
  if (p == null) return '—';
  const sign = p >= 0 ? '+' : '';
  return `${sign}${(p * 100).toFixed(2)}%`;
}

export function formatConfidence(c: number | null): string {
  if (c == null) return '—';
  return `${Math.round(c * 100)}%`;
}

export function signalColor(direction: 'UP' | 'DOWN' | null | undefined): string {
  if (direction === 'UP') return '#26a69a';
  if (direction === 'DOWN') return '#ef5350';
  return '#9e9e9e';
}

export function predictionColor(pred: string | null | undefined): string {
  if (pred === 'UP') return '#26a69a';
  if (pred === 'DOWN') return '#ef5350';
  if (pred === 'NEUTRAL') return '#ffa726';
  return '#9e9e9e';
}

export function sessionLabel(s: string | null): string {
  const map: Record<string, string> = {
    pre: 'PRE',
    regular: 'REG',
    after: 'AH',
    closed: 'CLOSED',
  };
  return s ? (map[s] ?? s.toUpperCase()) : '—';
}

export function confColor(c: number): string {
  if (c >= 0.75) return '#26a69a';
  if (c >= 0.60) return '#FFB300';
  return '#ef5350';
}

export function confLabel(c: number, n: number): string {
  if (c >= 0.85) return `Very strong alignment: ${n} signals point the same way.`;
  if (c >= 0.75) return `Strong alignment: most signals support this direction.`;
  if (c >= 0.65) return `Moderate alignment: the majority leans this way, but not all signals agree.`;
  if (c >= 0.55) return `Weak alignment: there is some support, but the setup is still mixed.`;
  return `Very weak alignment: signals conflict or are too small to trust.`;
}

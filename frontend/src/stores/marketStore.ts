import { create } from 'zustand';

export type Session = 'pre' | 'regular' | 'after' | 'closed';
export type Timeframe = '2m' | '5m';
export const TIMEFRAMES: Timeframe[] = ['2m', '5m'];
export const TIMEFRAME_LABELS: Record<Timeframe, string> = { '2m': '2m', '5m': '5m' };
export const TIMEFRAME_REFRESH_MS: Record<Timeframe, number> = {
  '2m': 120_000,
  '5m': 300_000,
};
// Backend scheduler stagger (seconds after the clock-aligned boundary at which
// each fetch loop actually fires). Must mirror backend/config.py TIMEFRAMES.
export const TIMEFRAME_STAGGER_MS: Record<Timeframe, number> = {
  '2m': 15_000,
  '5m': 30_000,
};
const TF_STORAGE_KEY = 'picker:selectedTimeframe';
function loadTf(): Timeframe {
  if (typeof window === 'undefined') return '2m';
  const v = window.localStorage.getItem(TF_STORAGE_KEY);
  return (v === '2m' || v === '5m') ? v : '2m';
}
export type EmaState = 'BULLISH' | 'BEARISH' | null;
export type Trend = 'BULL' | 'BEAR' | 'NEUTRAL' | null;
export type VwapPosition = 'ABOVE' | 'BELOW' | null;
export type VwapMotion = 'TOWARD' | 'AWAY' | 'FLAT' | null;
export type Prediction = 'UP' | 'DOWN' | 'NEUTRAL' | 'ABSTAIN' | null;

export interface OHLCV {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  session: Session;
  timeframe: string;
}

export interface ConfluenceLevels {
  poc: number | null;
  val: number | null;
  vah: number | null;
  pivot: number | null;
  s1: number | null;
  s2: number | null;
  r1: number | null;
  r2: number | null;
  timestamp: string;
  timeframe: string;
}

export interface IndicatorSnapshot {
  ticker: string;
  timestamp: string;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema_state: EmaState;
  ema_cross_ts: string | null;
  vwap: number | null;
  vwap_distance_pct: number | null;
  vwap_motion: VwapMotion;
  vwap_slope: number | null;
  price_vs_vwap: VwapPosition;
  daily_trend: Trend;
  poc: number | null;
  nearest_support: number | null;
  nearest_resistance: number | null;
  swing_high: number | null;
  swing_high_ts: string | null;
  swing_low: number | null;
  swing_low_ts: string | null;
  recent_return_5m: number | null;
  recent_volatility: number | null;
  // Session levels (v2)
  pm_high: number | null;
  pm_low: number | null;
  orb_high: number | null;
  orb_low: number | null;
  prev_day_high: number | null;
  prev_day_low: number | null;
  poc_pre: number | null;
  poc_regular: number | null;
  poc_after: number | null;
  // v3 additions
  rsi_14: number | null;
  rsi_state: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' | null;
  rvol: number | null;
  volume_state: 'HIGH' | 'LOW' | 'NORMAL' | null;
  ema_spread_pct: number | null;
  bull_score: number | null;
  bear_score: number | null;
  confluence_bias: 'BULL' | 'BEAR' | 'MIXED' | null;
  // v4 — Candle context (Senior Trader engine)
  hod: number | null;
  lod: number | null;
  prev_day_close: number | null;
  atr_14: number | null;
  candle_structure: 'UPTREND' | 'DOWNTREND' | 'COILING' | 'CHOPPY' | null;
  candle_hh_hl: boolean | null;
  candle_lh_ll: boolean | null;
  candle_body_trend: 'EXPANDING' | 'CONTRACTING' | 'STEADY' | null;
  candle_pace: 'TRENDING' | 'CHOPPY' | null;
  candle_vol_char: 'INSTITUTIONAL' | 'CLIMAX' | 'THIN' | 'NORMAL' | null;
  candle_close_pos: 'UPPER' | 'MIDDLE' | 'LOWER' | null;
  candle_near_level: string | null;
  /** JSON array string when sourced from REST, string[] when from WebSocket. */
  candle_patterns: string[] | null;
  tape_read_narrative: string | null;
}

export interface Signal {
  id: number;
  ticker: string;
  timestamp: string;
  signal_type: string;
  direction: 'UP' | 'DOWN';
  details: string;
}

export interface CompositeAlert {
  id?: number;
  ticker: string;
  timestamp: string;
  signal: string;
  direction: 'UP' | 'DOWN' | 'WARNING';
  tier: 1 | 2 | 3;
  ai_confidence: number;
  components: string[];
  suppressed_by: string | null;
  timeframe: string;
  level_name?: string;
  level_price?: number;
  poc_level?: number;
}

export interface PredictionRow {
  id: number;
  ticker: string;
  timestamp: string;
  prediction: Prediction;
  confidence: number;
  evidence: string;
  rules_triggered: string;
  notes: string | null;
  outcome: string | null;
}

export interface TickerState {
  price: number | null;
  changePct: number | null;
  session: Session;
  candles: OHLCV[];
  indicators: IndicatorSnapshot | null;
  latestPrediction: PredictionRow | null;
}

interface MarketStore {
  tickers: Record<string, TickerState>;
  signals: Signal[];
  compositeAlerts: CompositeAlert[];
  initialized: boolean;
  selectedTimeframe: Timeframe;

  // Actions
  initTicker: (ticker: string) => void;
  setPrice: (ticker: string, price: number, session: Session, changePct?: number | null) => void;
  setCandles: (ticker: string, candles: OHLCV[]) => void;
  setIndicators: (ticker: string, snapshot: IndicatorSnapshot) => void;
  setPrediction: (ticker: string, prediction: PredictionRow) => void;
  addSignal: (signal: Signal) => void;
  addCompositeAlert: (alert: CompositeAlert) => void;
  setInitialized: (v: boolean) => void;
  setSelectedTimeframe: (tf: Timeframe) => void;
  handleWsMessage: (msg: WsMessage) => void;
}

export interface WsMessage {
  type: 'price_update' | 'signal' | 'prediction' | 'composite_alert';
  data: Record<string, unknown>;
}

const EMPTY_TICKER = (): TickerState => ({
  price: null,
  changePct: null,
  session: 'closed',
  candles: [],
  indicators: null,
  latestPrediction: null,
});

export const useMarketStore = create<MarketStore>((set, get) => ({
  tickers: {},
  signals: [],
  compositeAlerts: [],
  initialized: false,
  selectedTimeframe: loadTf(),

  initTicker: (ticker) =>
    set((s) => ({
      tickers: { ...s.tickers, [ticker]: s.tickers[ticker] ?? EMPTY_TICKER() },
    })),

  setPrice: (ticker, price, session, changePct) =>
    set((s) => ({
      tickers: {
        ...s.tickers,
        [ticker]: { ...(s.tickers[ticker] ?? EMPTY_TICKER()), price, session, ...(changePct !== undefined ? { changePct } : {}) },
      },
    })),

  setCandles: (ticker, candles) =>
    set((s) => ({
      tickers: { ...s.tickers, [ticker]: { ...(s.tickers[ticker] ?? EMPTY_TICKER()), candles } },
    })),

  setIndicators: (ticker, snapshot) =>
    set((s) => ({
      tickers: {
        ...s.tickers,
        [ticker]: { ...(s.tickers[ticker] ?? EMPTY_TICKER()), indicators: snapshot },
      },
    })),

  setPrediction: (ticker, prediction) =>
    set((s) => ({
      tickers: {
        ...s.tickers,
        [ticker]: { ...(s.tickers[ticker] ?? EMPTY_TICKER()), latestPrediction: prediction },
      },
    })),

  addSignal: (signal) =>
    set((s) => ({ signals: [signal, ...s.signals].slice(0, 200) })),

  addCompositeAlert: (alert) =>
    set((s) => ({ compositeAlerts: [alert, ...s.compositeAlerts].slice(0, 200) })),

  setInitialized: (v) => set({ initialized: v }),

  setSelectedTimeframe: (tf) => {
    try { window.localStorage.setItem(TF_STORAGE_KEY, tf); } catch { /* ignore */ }
    // Clear per-ticker derived state so stale (other-TF) data isn't shown
    // briefly before the new fetch completes.
    set((s) => {
      const reset: Record<string, TickerState> = {};
      for (const k of Object.keys(s.tickers)) {
        reset[k] = { ...s.tickers[k], candles: [], indicators: null, latestPrediction: null };
      }
      return {
        selectedTimeframe: tf,
        tickers: reset,
        signals: [],
        compositeAlerts: [],
        initialized: false,
      };
    });
  },

  handleWsMessage: (msg) => {
    const { setPrice, addSignal, addCompositeAlert, setPrediction, setIndicators, selectedTimeframe } = get();
    // Defensive client-side TF filter — the backend already routes per
    // subscription, but ignore stragglers that arrive during a TF switch.
    const data = msg.data as Record<string, unknown>;
    const msgTf = data?.timeframe as string | undefined;
    if (msgTf && msgTf !== selectedTimeframe) return;

    if (msg.type === 'price_update') {
      const ticker = data.ticker as string;
      setPrice(ticker, data.price as number, data.session as Session);
      const existing = get().tickers[ticker]?.indicators ?? {} as IndicatorSnapshot;
      setIndicators(ticker, { ...existing, ...data } as unknown as IndicatorSnapshot);
    } else if (msg.type === 'signal') {
      addSignal(data as unknown as Signal);
    } else if (msg.type === 'composite_alert') {
      const alert = data as unknown as CompositeAlert;
      if (alert.tier < 3) addCompositeAlert(alert);
    } else if (msg.type === 'prediction') {
      setPrediction(data.ticker as string, data as unknown as PredictionRow);
    }
  },
}));

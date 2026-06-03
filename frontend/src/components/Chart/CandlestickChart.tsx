import React, { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  createSeriesMarkers,
} from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { OHLCV, IndicatorSnapshot } from '../../stores/marketStore';

interface CandlestickChartProps {
  ticker: string;
  candles: OHLCV[];
  indicators: IndicatorSnapshot | null;
  height?: number;
  timeframe?: string;
}

function toChartTime(ts: string): number {
  const d = new Date(ts);
  // LW Charts treats timestamps as UTC; subtract local UTC offset so axis shows local time
  return Math.floor(d.getTime() / 1000) - d.getTimezoneOffset() * 60;
}

const CandlestickChart: React.FC<CandlestickChartProps> = ({
  ticker,
  candles,
  indicators,
  timeframe,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Stable ref so autoscaleInfoProvider always reads the latest candles
  // without needing the series to be recreated on every candles update.
  const candlesRef = useRef<OHLCV[]>([]);
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersPluginRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLinesRef = useRef<any[]>([]);

  // Session background overlay
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sessionRunsRef = useRef<Array<{ session: string; start: number; end: number }>>([]);

  const SESSION_COLORS: Record<string, string> = {
    pre:     'rgba(63,  81, 181, 0.13)',  // indigo — premarket
    regular: 'rgba(27, 94,  32, 0.18)',  // dark green — regular session
    after:   'rgba(230, 81,   0, 0.12)', // deep orange — after-hours
  };

  const drawSessionBg = () => {
    const chart = chartRef.current;
    const canvas = overlayRef.current;
    const container = containerRef.current;
    if (!chart || !canvas || !container || sessionRunsRef.current.length === 0) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width  = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const ts = chart.timeScale();
    for (const run of sessionRunsRef.current) {
      const color = SESSION_COLORS[run.session];
      if (!color) continue;
      const x1 = ts.timeToCoordinate(run.start as unknown as import('lightweight-charts').Time);
      const x2 = ts.timeToCoordinate(run.end   as unknown as import('lightweight-charts').Time);
      const left  = Math.max(0, x1 ?? 0);
      const right = Math.min(w, (x2 ?? w) + 8); // +8 covers the last bar width
      if (right <= 0 || left >= w) continue;
      ctx.fillStyle = color;
      ctx.fillRect(left, 0, right - left, h);
    }
  };

  // Keep a stable ref so the time-scale subscription always calls the latest version
  const drawBgRef = useRef(drawSessionBg);
  useEffect(() => { drawBgRef.current = drawSessionBg; });

  // Initialise chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#1a1a2e' },
        textColor: '#c8c8c8',
      },
      grid: {
        vertLines: { color: '#2a2a3e' },
        horzLines: { color: '#2a2a3e' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#3a3a5e' },
      timeScale: { borderColor: '#3a3a5e', timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 400,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      // Focus the price scale on regular-session candles so that extreme
      // pre/after-hours wicks (yfinance artifact) don't shrink the chart.
      // Falls back to full-range autoscale when no regular bars are present.
      autoscaleInfoProvider: () => {
        const regular = candlesRef.current.filter((c) => c.session === 'regular');
        if (regular.length < 2) return null; // null → LW charts default autoscale
        const maxVal = Math.max(...regular.map((c) => c.high));
        const minVal = Math.min(...regular.map((c) => c.low));
        const margin = (maxVal - minVal) * 0.1; // 10% padding above/below
        return {
          priceRange: { minValue: minVal - margin, maxValue: maxVal + margin },
        };
      },
    });

    const ema9 = chart.addSeries(LineSeries, {
      color: '#2962FF',
      lineWidth: 1,
      title: 'EMA9',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const ema21 = chart.addSeries(LineSeries, {
      color: '#FF6D00',
      lineWidth: 1,
      title: 'EMA21',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const vwap = chart.addSeries(LineSeries, {
      color: '#9c27b0',
      lineWidth: 2,
      title: 'VWAP',
      lineStyle: 1, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    ema9Ref.current = ema9;
    ema21Ref.current = ema21;
    vwapRef.current = vwap;

    // Redraw session backgrounds whenever the visible time range changes (scroll/zoom)
    chart.timeScale().subscribeVisibleTimeRangeChange(() => drawBgRef.current());

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
        drawBgRef.current();
      }
    };
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
        drawBgRef.current();
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);  

  // Update candle data + compute EMA9/21 + VWAP overlays
  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return;

    // Keep stable ref in sync so autoscaleInfoProvider always has latest data
    candlesRef.current = candles;

    // Candles
    const data = candles.map((c) => ({
      time: toChartTime(c.timestamp) as unknown as import('lightweight-charts').Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeriesRef.current.setData(data);

    // EMA helper (matches TradingView ewm adjust=False)
    const calcEma = (closes: number[], period: number): number[] => {
      const k = 2 / (period + 1);
      const result: number[] = [];
      let prev = closes[0];
      for (const c of closes) {
        prev = c * k + prev * (1 - k);
        result.push(prev);
      }
      return result;
    };

    const closes = candles.map((c) => c.close);
    const ema9vals = calcEma(closes, 9);
    const ema21vals = calcEma(closes, 21);

    const ema9Data = candles.map((c, i) => ({
      time: toChartTime(c.timestamp) as unknown as import('lightweight-charts').Time,
      value: ema9vals[i],
    }));
    const ema21Data = candles.map((c, i) => ({
      time: toChartTime(c.timestamp) as unknown as import('lightweight-charts').Time,
      value: ema21vals[i],
    }));
    ema9Ref.current?.setData(ema9Data);
    ema21Ref.current?.setData(ema21Data);

    // VWAP — resets at each session boundary
    const vwapData: { time: import('lightweight-charts').Time; value: number }[] = [];
    let cumTPV = 0, cumVol = 0, prevSession = '';
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.session !== prevSession) { cumTPV = 0; cumVol = 0; prevSession = c.session; }
      const tp = (c.high + c.low + c.close) / 3;
      cumTPV += tp * c.volume;
      cumVol += c.volume;
      vwapData.push({
        time: toChartTime(c.timestamp) as unknown as import('lightweight-charts').Time,
        value: cumVol > 0 ? cumTPV / cumVol : tp,
      });
    }
    vwapRef.current?.setData(vwapData);

    // Compute session background runs and draw
    const runs: Array<{ session: string; start: number; end: number }> = [];
    let si = 0;
    while (si < candles.length) {
      const sess = candles[si].session;
      let sj = si;
      while (sj < candles.length && candles[sj].session === sess) sj++;
      runs.push({
        session: sess,
        start: toChartTime(candles[si].timestamp),
        end:   toChartTime(candles[sj - 1].timestamp),
      });
      si = sj;
    }
    sessionRunsRef.current = runs;

    // Fit after data load, then draw backgrounds
    chartRef.current?.timeScale().fitContent();
    drawBgRef.current();
  }, [candles]);

  // Update S/R price lines and swing markers when indicators change
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !indicators) return;

    // Remove old price lines
    for (const pl of priceLinesRef.current) {
      try { series.removePriceLine(pl); } catch { /* ignore */ }
    }
    priceLinesRef.current = [];

    // Add updated price lines
    if (indicators.nearest_support != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.nearest_support,
        color: '#26a69a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'S',
      }));
    }
    if (indicators.nearest_resistance != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.nearest_resistance,
        color: '#ef5350',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'R',
      }));
    }
    if (indicators.poc != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.poc,
        color: '#ffa726',
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
        title: 'POC',
      }));
    }

    // --- Session level price lines (v2) ---
    // ORB high/low (orange, dashed)
    if (indicators.orb_high != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.orb_high, color: '#FF9800',
        lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'ORB H',
      }));
    }
    if (indicators.orb_low != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.orb_low, color: '#FF9800',
        lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'ORB L',
      }));
    }
    // PM high/low (purple)
    if (indicators.pm_high != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.pm_high, color: '#9c27b0',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'PM H',
      }));
    }
    if (indicators.pm_low != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.pm_low, color: '#9c27b0',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'PM L',
      }));
    }
    // Prev day high/low (steel blue)
    if (indicators.prev_day_high != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.prev_day_high, color: '#78909C',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'PD H',
      }));
    }
    if (indicators.prev_day_low != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.prev_day_low, color: '#78909C',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'PD L',
      }));
    }
    // Session POCs (regular=amber bold, premarket=indigo, after=teal)
    if (indicators.poc_regular != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.poc_regular, color: '#FFB300',
        lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'POC-R',
      }));
    }
    if (indicators.poc_pre != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.poc_pre, color: '#7E57C2',
        lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'POC-PM',
      }));
    }
    if (indicators.poc_after != null) {
      priceLinesRef.current.push(series.createPriceLine({
        price: indicators.poc_after, color: '#26A69A',
        lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'POC-AH',
      }));
    }

    // Swing markers via v5 createSeriesMarkers
    const markers: import('lightweight-charts').SeriesMarker<import('lightweight-charts').Time>[] = [];
    if (indicators.swing_high != null && indicators.swing_high_ts) {
      markers.push({
        time: toChartTime(indicators.swing_high_ts) as unknown as import('lightweight-charts').Time,
        position: 'aboveBar',
        color: '#ef5350',
        shape: 'arrowDown',
        text: `SH ${indicators.swing_high.toFixed(2)}`,
      });
    }
    if (indicators.swing_low != null && indicators.swing_low_ts) {
      markers.push({
        time: toChartTime(indicators.swing_low_ts) as unknown as import('lightweight-charts').Time,
        position: 'belowBar',
        color: '#26a69a',
        shape: 'arrowUp',
        text: `SL ${indicators.swing_low.toFixed(2)}`,
      });
    }
    if (markers.length > 0) {
      if (markersPluginRef.current) {
        markersPluginRef.current.setMarkers(markers);
      } else {
        markersPluginRef.current = createSeriesMarkers(series, markers);
      }
    } else if (markersPluginRef.current) {
      markersPluginRef.current.setMarkers([]);
    }
  }, [indicators, candles]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Session background canvas — sits above the chart canvas, semi-transparent */}
      <canvas
        ref={overlayRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          zIndex: 4,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 12,
          zIndex: 10,
          color: '#e0e0e0',
          fontWeight: 700,
          fontSize: '0.9rem',
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span>{ticker} · {timeframe ?? '2m'}</span>
        {(() => {
          const n = candles.length;
          if (n === 0) return null;
          const last = candles[n - 1];
          const prev = n > 1 ? candles[n - 2] : null;
          const price = last.close;
          const ref = prev ? prev.close : last.open;
          const diff = price - ref;
          const pct = ref ? (diff / ref) * 100 : 0;
          const up = diff >= 0;
          const color = up ? '#4caf50' : '#ef5350';
          const arrow = up ? '▲' : '▼';
          return (
            <>
              <span style={{ color, fontSize: '0.95rem' }}>
                ${price.toFixed(2)}
              </span>
              <span style={{ color, fontSize: '0.7rem', fontWeight: 600 }}>
                {arrow} {up ? '+' : ''}{diff.toFixed(2)} ({up ? '+' : ''}{pct.toFixed(2)}%)
              </span>
            </>
          );
        })()}
      </div>
      {/* Session legend */}
      <div style={{ position: 'absolute', top: 8, right: 60, zIndex: 10, display: 'flex', gap: 10, fontSize: '0.65rem', pointerEvents: 'none' }}>
        <span style={{ color: 'rgba(120,140,255,0.9)' }}>▌ Pre</span>
        <span style={{ color: 'rgba(76,175,80,0.9)'  }}>▌ Regular</span>
        <span style={{ color: 'rgba(255,138,80,0.9)' }}>▌ AH</span>
      </div>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};

export default CandlestickChart;

/**
 * MarketReadPanel — unified "Market Read" panel.
 *
 * Merges what used to be two separate panels:
 *   • AI Evaluation  (prediction, confidence, signals)
 *   • Tape Read      (candle context, patterns, LLM narrative)
 *
 * The LLM "Generate" button synthesises BOTH views into one narrative so the
 * user never sees a conflicting "DOWNTREND vs UP" without an explanation.
 */
import React from 'react';
import type { IndicatorSnapshot, PredictionRow } from '../../stores/marketStore';
import { predictionColor, confColor, confLabel } from '../../utils/formatters';

// ── Rule metadata ────────────────────────────────────────────────────────────
interface RuleMeta { direction: 'UP' | 'DOWN' | 'BOTH'; label: string; weight: number; explanation: string; }
const RULE_META: Record<string, RuleMeta> = {
  ema_bullish:                { direction: 'UP',   weight: 1.5, label: 'EMA Crossover — Bullish',           explanation: 'EMA 9 is above EMA 21. Short-term momentum outpaces the medium-term average (a "golden cross" setup). Buyers are in control of price action.' },
  ema_bearish:                { direction: 'DOWN', weight: 1.5, label: 'EMA Crossover — Bearish',           explanation: 'EMA 9 is below EMA 21. Short-term momentum has faded below the medium-term average (a "death cross" setup). Sellers dominate the near-term flow.' },
  ema_stack_bullish:          { direction: 'UP',   weight: 1.2, label: 'EMA Stack — Bullish',               explanation: 'EMA 9 > EMA 21 > EMA 50 — all three EMAs are in perfect bullish order. High-conviction trend alignment: short, medium, and longer-term momentum all point up.' },
  ema_stack_bearish:          { direction: 'DOWN', weight: 1.2, label: 'EMA Stack — Bearish',               explanation: 'EMA 9 < EMA 21 < EMA 50 — all three EMAs are in perfect bearish order. Short, medium, and longer-term momentum all point down.' },
  price_above_vwap:           { direction: 'UP',   weight: 1.0, label: 'Price Above VWAP',                  explanation: 'Price is trading above VWAP — the intraday fair value anchor. Being above VWAP signals bullish institutional flow.' },
  price_below_vwap:           { direction: 'DOWN', weight: 1.0, label: 'Price Below VWAP',                  explanation: 'Price is below VWAP. Sellers are willing to transact at a discount to fair value, signalling bearish institutional flow.' },
  vwap_moving_away_above:     { direction: 'UP',   weight: 1.0, label: 'Trending Away from VWAP (Above)',   explanation: 'Price is above VWAP and the gap is expanding — strong trend confirmation. Buyers are aggressively pushing price higher.' },
  vwap_moving_away_below:     { direction: 'DOWN', weight: 1.0, label: 'Trending Away from VWAP (Below)',   explanation: 'Price is below VWAP and the discount is growing. Sellers are in full control; bearish momentum is building.' },
  vwap_converging_from_above: { direction: 'DOWN', weight: 1.0, label: 'Pulling Back to VWAP (From Above)', explanation: 'Price was above VWAP but is now falling back toward it — mean reversion in progress.' },
  vwap_converging_from_below: { direction: 'UP',   weight: 1.0, label: 'Recovering to VWAP (From Below)',   explanation: 'Price was below VWAP and is now rising back toward it — discount buying in progress.' },
  vwap_reclaim_bullish:       { direction: 'UP',   weight: 1.3, label: 'VWAP Reclaim — Bullish',            explanation: 'Price crossed back above VWAP on this bar. A VWAP reclaim is a high-conviction intraday reversal signal.' },
  vwap_lose_bearish:          { direction: 'DOWN', weight: 1.3, label: 'VWAP Lost — Bearish',               explanation: 'Price broke below VWAP on this bar. Losing VWAP is a high-conviction bearish shift.' },
  daily_trend_bull:           { direction: 'UP',   weight: 1.2, label: 'Daily Trend — Bullish',             explanation: 'The higher-timeframe (daily) trend is up. Long setups have higher probability when the daily bias is bullish.' },
  daily_trend_bear:           { direction: 'DOWN', weight: 1.2, label: 'Daily Trend — Bearish',             explanation: 'The higher-timeframe (daily) trend is down. Rallies are likely distribution rather than accumulation.' },
  price_above_poc:            { direction: 'UP',   weight: 1.0, label: 'Price Above POC',                   explanation: 'Price is above the Point of Control — the price level with the most traded volume. A bullish structural signal.' },
  price_below_poc:            { direction: 'DOWN', weight: 1.0, label: 'Price Below POC',                   explanation: 'Price is below the Point of Control. Sellers are pushing below accepted value — a bearish structural signal.' },
  price_near_support:         { direction: 'UP',   weight: 1.0, label: 'Near Support Level',                explanation: 'Price is within 0.3% of the nearest support zone. A potential bounce zone — watch for a reaction.' },
  price_near_resistance:      { direction: 'DOWN', weight: 1.0, label: 'Near Resistance Level',             explanation: 'Price is within 0.3% of the nearest resistance zone. A potential rejection zone — watch for selling pressure.' },
  sr_support_bounce:          { direction: 'UP',   weight: 0.8, label: 'Support Bounce',                    explanation: 'Price is within 0.2% above a key support level and the most recent bar closed higher.' },
  positive_momentum:          { direction: 'UP',   weight: 1.0, label: 'Positive Short-Term Momentum',      explanation: 'The last 5-minute bar gained more than +0.3%. Short-term momentum tends to persist.' },
  negative_momentum:          { direction: 'DOWN', weight: 1.0, label: 'Negative Short-Term Momentum',      explanation: 'The last 5-minute bar fell more than -0.3%. Downside momentum tends to continue in the very short term.' },
  volume_surge_up:            { direction: 'UP',   weight: 1.1, label: 'Volume Surge — Bullish',            explanation: 'Current bar volume is 1.5× average while price is rising. High-volume up moves signal institutional participation.' },
  volume_surge_down:          { direction: 'DOWN', weight: 1.1, label: 'Volume Surge — Bearish',            explanation: 'Current bar volume is 1.5× average while price is falling. High-volume down moves signal institutional distribution.' },
  volume_dry_up:              { direction: 'BOTH', weight: 0.6, label: 'Dry Volume — Trend Likely Resumes', explanation: 'Volume is under 0.5× average on a counter-trend bar. Low-volume retracements suggest the primary trend will reassert.' },
  higher_low_formed:          { direction: 'UP',   weight: 0.9, label: 'Higher Low Formed',                 explanation: 'The current bar set a higher low than the previous bar during a pullback — structural definition of an uptrend.' },
  lower_high_formed:          { direction: 'DOWN', weight: 0.9, label: 'Lower High Formed',                 explanation: 'The current bar set a lower high during a bounce — each rally fails at a lower price, confirming supply.' },
  opening_range_hold:         { direction: 'UP',   weight: 0.7, label: 'Opening Range Hold (ORB)',           explanation: 'Price has pulled back to the ORB high and is holding. A successful ORB retest turns prior resistance into support.' },
  rsi_overbought:             { direction: 'DOWN', weight: 0.9, label: 'RSI Overbought (>70)',               explanation: 'RSI-14 is above 70 — overbought territory. Mean-reversion risk increases.' },
  rsi_oversold:               { direction: 'UP',   weight: 0.9, label: 'RSI Oversold (<30)',                 explanation: 'RSI-14 is below 30 — deeply oversold. A bounce or relief rally is likely.' },
  ema_cross_imminent_bull:    { direction: 'UP',   weight: 0.8, label: 'EMA Bullish Cross Imminent',         explanation: 'EMA 9 is below EMA 21 but the gap has narrowed to under 0.08% — bullish crossover about to occur.' },
  ema_cross_imminent_bear:    { direction: 'DOWN', weight: 0.8, label: 'EMA Bearish Cross Imminent',         explanation: 'EMA 9 is above EMA 21 but the gap has narrowed to under 0.08% — bearish crossover imminent.' },
  confluence_strong_bull:     { direction: 'UP',   weight: 1.8, label: 'Strong Bullish Confluence (6+)',     explanation: '6+ independent indicators aligned bullish simultaneously. Multi-signal agreement is the highest-conviction setup.' },
  confluence_strong_bear:     { direction: 'DOWN', weight: 1.8, label: 'Strong Bearish Confluence (6+)',     explanation: '6+ independent indicators aligned bearish simultaneously. The strongest signal the engine can produce.' },
  ml_agrees:                  { direction: 'BOTH', weight: 0.0, label: 'ML Model Agrees',                   explanation: 'The machine-learning model agrees with the rule engine direction. Confidence was boosted.' },
  ml_override:                { direction: 'BOTH', weight: 0.0, label: 'ML Override',                       explanation: 'The rule engine abstained but the ML model had sufficient confidence — ML direction used.' },
};

// ── Candle context colours ────────────────────────────────────────────────────
const STRUCTURE_COLOR: Record<string, string> = {
  UPTREND: '#00C896', DOWNTREND: '#FF4C4C', COILING: '#FFD700', CHOPPY: '#A0A0A0',
};
const STRUCTURE_ICON: Record<string, string> = {
  UPTREND: '▲', DOWNTREND: '▼', COILING: '◆', CHOPPY: '↔',
};
const PATTERN_COLOR: Record<string, string> = {
  BullishEngulfing: '#26a69a', BearishEngulfing: '#ef5350',
  Hammer: '#26a69a', InvertedHammer: '#ef5350', ShootingStar: '#ef5350',
  Doji: '#FFB300', InsideBar: '#60a5fa', NR7: '#60a5fa',
  UpperRejectionWick: '#ef5350', LowerRejectionWick: '#26a69a',
  ThreeGreen: '#26a69a', ThreeRed: '#ef5350',
};

function parsePatterns(raw: string[] | string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw as string) as string[]; } catch { return []; }
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface MarketReadPanelProps {
  ticker: string;
  currentPrice: number | null;
  indicators: IndicatorSnapshot | null;
  prediction: PredictionRow | null;
}

interface ConfluencePayload {
  levels?: unknown;
  patterns?: {
    confluence_strength?: string;
    bias_narrative?: string;
  };
  fusion_score?: {
    fusion_score: number;
    fusion_signal: string;
    reasoning: string;
  } | null;
}

const MarketReadPanel: React.FC<MarketReadPanelProps> = ({ ticker, currentPrice, indicators: ind, prediction: pred }) => {
  // ── On-demand LLM state (tape-read disabled for performance; read-side still rendered) ──
  const [loading] = React.useState(false);
  const [localResult] = React.useState<{ ticker: string; narrative: string } | null>(null);
  const [llmError] = React.useState<string | null>(null);
  const [signalsOpen, setSignalsOpen] = React.useState(true);
  const [confluenceData, setConfluenceData] = React.useState<ConfluencePayload | null>(null);
  const [confluenceLoading, setConfluenceLoading] = React.useState(false);
  const [confluenceError, setConfluenceError] = React.useState<string | null>(null);

  // Cache confluence data per ticker to avoid redundant fetches on quick switches
  const confluenceCacheRef = React.useRef<Record<string, { data: ConfluencePayload; ts: number }>>({});

  React.useEffect(() => {
    let cancelled = false;

    const loadConfluence = async () => {
      // Use cached data if it's less than 5 minutes old for this ticker
      const cached = confluenceCacheRef.current[ticker];
      if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        if (!cancelled) setConfluenceData(cached.data);
        if (!cancelled) setConfluenceLoading(false);
        return;
      }

      setConfluenceLoading(true);
      setConfluenceError(null);

      try {
        const params = new URLSearchParams();
        if (currentPrice !== null) params.append('current_price', currentPrice.toString());
        if (pred) {
          params.append('ai_prediction', pred.prediction || 'NEUTRAL');
          params.append('ai_confidence', (pred.confidence || 0).toString());
        }

        const res = await fetch(`/api/confluence/${ticker}?${params.toString()}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        const data = await res.json() as ConfluencePayload;
        if (!cancelled) {
          setConfluenceData(data);
          confluenceCacheRef.current[ticker] = { data, ts: Date.now() };
        }
      } catch (e) {
        if (!cancelled) setConfluenceError(e instanceof Error ? e.message : 'Unable to load confluence');
      } finally {
        if (!cancelled) setConfluenceLoading(false);
      }
    };

    loadConfluence();
    const interval = window.setInterval(loadConfluence, 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [ticker, currentPrice, pred]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const rules: string[] = pred?.rules_triggered
    ? (() => { try { return JSON.parse(pred.rules_triggered) as string[]; } catch { return []; } })()
    : [];

  const evidence = pred?.evidence
    ? (() => { try { return JSON.parse(pred.evidence); } catch { return null; } })()
    : null;

  // localResult (from button click) takes precedence, but only for current ticker
  const narrative = (localResult?.ticker === ticker ? localResult.narrative : null)
    ?? ind?.tape_read_narrative ?? null;
  const narrativeLines = narrative
    ? narrative.split('\n').map((l) => l.trim()).filter(Boolean)
    : null;

  const structure   = ind?.candle_structure ?? null;
  const structColor = structure ? (STRUCTURE_COLOR[structure] ?? '#9e9e9e') : '#9e9e9e';
  const structIcon  = structure ? (STRUCTURE_ICON[structure]  ?? '—')       : null;
  const patterns    = parsePatterns(ind?.candle_patterns);
  const confluenceBias = ind?.confluence_bias ?? null;
  const confluenceBiasLabel = confluenceBias === 'BULL' ? 'BUY'
    : confluenceBias === 'BEAR' ? 'SELL'
    : confluenceBias === 'MIXED' ? 'MIXED'
    : 'WAIT';
  const confluenceBiasColor = confluenceBias === 'BULL' ? '#26a69a'
    : confluenceBias === 'BEAR' ? '#ef5350'
    : '#60a5fa';
  const confluenceBiasText = confluenceBias === 'BULL'
    ? 'More of the active signals are pointing up. Buyers have the stronger hand.'
    : confluenceBias === 'BEAR'
    ? 'More of the active signals are pointing down. Sellers have the stronger hand.'
    : 'Signals are mixed, so this is a wait-and-see setup until one side gets clearer confirmation.';
  const confluenceStrength = confluenceData?.patterns?.confluence_strength ?? 'LOW';
  const fusionScore = confluenceData?.fusion_score ?? null;
  const fusionColor = fusionScore
    ? fusionScore.fusion_score >= 70
      ? '#26a69a'
      : fusionScore.fusion_score >= 50
      ? '#ff9800'
      : '#ef5350'
    : '#666';

  return (
    <div style={{ fontSize: '0.73rem' }}>

      {/* ══ 1. PREDICTION + CONFIDENCE ══════════════════════════════════════ */}
      {pred ? (
        <div style={{ marginBottom: 12 }}>
          {/* Direction + structure on one line */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: '1.6rem', fontWeight: 900, color: predictionColor(pred.prediction), lineHeight: 1 }}>
              {pred.prediction}
            </span>
            {structure && (
              <span style={{ fontSize: '0.78rem', fontWeight: 800, color: structColor }}>
                {structIcon} {structure}
              </span>
            )}
            {ind?.candle_hh_hl && (
              <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#26a69a',
                background: 'rgba(38,166,154,0.1)', border: '1px solid rgba(38,166,154,0.3)',
                borderRadius: 4, padding: '1px 5px' }}>HH/HL</span>
            )}
            {ind?.candle_lh_ll && (
              <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#ef5350',
                background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.3)',
                borderRadius: 4, padding: '1px 5px' }}>LH/LL</span>
            )}
            {ind?.candle_near_level && (
              <span style={{ fontSize: '0.6rem', fontWeight: 700, marginLeft: 'auto',
                background: 'rgba(255,183,0,0.1)', border: '1px solid rgba(255,183,0,0.35)',
                color: '#FFB300', borderRadius: 4, padding: '1px 6px' }}>
                ⚑ {ind.candle_near_level}
              </span>
            )}
          </div>

          {/* Confidence bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: '0.65rem', color: '#9e9e9e', letterSpacing: '0.04em' }}>CONFIDENCE</span>
            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: confColor(pred.confidence) }}>
              {Math.round(pred.confidence * 100)}%
            </span>
          </div>
          <div style={{ background: '#2a2a3e', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 4 }}>
            <div style={{
              width: `${Math.round(pred.confidence * 100)}%`,
              background: confColor(pred.confidence),
              height: '100%', borderRadius: 4, transition: 'width 0.4s ease',
            }} />
          </div>
          <p style={{ fontSize: '0.66rem', color: '#9e9e9e', margin: '0 0 10px', lineHeight: 1.4 }}>
            {confLabel(pred.confidence, rules.length)}
          </p>
        </div>
      ) : (
        <p style={{ color: '#9e9e9e', marginBottom: 12 }}>No prediction yet</p>
      )}

      {/* ══ 2. CANDLE CONTEXT ═══════════════════════════════════════════════ */}
      {ind && (
        <>
          {/* Pattern chips */}
          {patterns.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {patterns.map((p) => {
                const col = PATTERN_COLOR[p] ?? '#60a5fa';
                return (
                  <span key={p} style={{
                    fontSize: '0.63rem', fontWeight: 600, borderRadius: 4, padding: '2px 7px',
                    background: `${col}18`, border: `1px solid ${col}50`, color: col,
                  }}>{p}</span>
                );
              })}
            </div>
          )}

          {/* Metrics grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px', marginBottom: 10 }}>
            {ind.candle_body_trend && (<>
              <span style={{ color: '#9e9e9e' }}>Body Trend</span>
              <span style={{ fontWeight: 600, color:
                ind.candle_body_trend === 'EXPANDING'   ? '#26a69a' :
                ind.candle_body_trend === 'CONTRACTING' ? '#ef5350' : '#e0e0e0' }}>
                {ind.candle_body_trend}
              </span>
            </>)}
            {ind.candle_pace && (<>
              <span style={{ color: '#9e9e9e' }}>Pace</span>
              <span style={{ fontWeight: 600, color: ind.candle_pace === 'TRENDING' ? '#26a69a' : '#9e9e9e' }}>
                {ind.candle_pace}
              </span>
            </>)}
            {ind.candle_vol_char && (<>
              <span style={{ color: '#9e9e9e' }}>Volume</span>
              <span style={{ fontWeight: 600, color:
                ind.candle_vol_char === 'INSTITUTIONAL' ? '#26a69a' :
                ind.candle_vol_char === 'CLIMAX'        ? '#ef5350' :
                ind.candle_vol_char === 'THIN'          ? '#9e9e9e' : '#e0e0e0' }}>
                {ind.candle_vol_char}
              </span>
            </>)}
            {ind.candle_close_pos && (<>
              <span style={{ color: '#9e9e9e' }}>Close Pos</span>
              <span style={{ fontWeight: 600, color:
                ind.candle_close_pos === 'UPPER' ? '#26a69a' :
                ind.candle_close_pos === 'LOWER' ? '#ef5350' : '#e0e0e0' }}>
                {ind.candle_close_pos} THIRD
              </span>
            </>)}
            {ind.hod != null && (<>
              <span style={{ color: '#9e9e9e' }}>HOD / LOD</span>
              <span style={{ fontWeight: 600, color: '#e0e0e0' }}>
                {ind.hod.toFixed(2)} / {ind.lod != null ? ind.lod.toFixed(2) : '—'}
              </span>
            </>)}
            {ind.atr_14 != null && (<>
              <span style={{ color: '#9e9e9e' }}>ATR-14</span>
              <span style={{ fontWeight: 600, color: '#e0e0e0' }}>{ind.atr_14.toFixed(3)}</span>
            </>)}
          </div>
        </>
      )}

      {/* ══ 3. LLM MARKET READ (on-demand) ══════════════════════════════════ */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#10b981', letterSpacing: '0.09em' }}>
          📊 MARKET READ
        </span>
        <span style={{ fontSize: '0.55rem', color: '#9e9e9e', fontStyle: 'italic' }}>
          LLM disabled
        </span>
      </div>

      {llmError && (
        <div style={{ fontSize: '0.65rem', color: '#ef5350', marginBottom: 6 }}>⚠ {llmError}</div>
      )}

      {narrativeLines && narrativeLines.length > 0 ? (
        <div style={{
          background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.22)',
          borderRadius: 8, padding: '10px 12px', marginBottom: 12,
        }}>
          {narrativeLines[0] && (
            <div style={{ fontWeight: 800, fontSize: '0.82rem', color: '#d1fae5', marginBottom: 6 }}>
              {narrativeLines[0]}
            </div>
          )}
          {narrativeLines.slice(1).map((line, i) => (
            <p key={i} style={{
              fontSize: '0.73rem', color: '#a7f3d0',
              margin: i < narrativeLines.length - 2 ? '0 0 5px' : 0, lineHeight: 1.55,
            }}>{line}</p>
          ))}
        </div>
      ) : !loading && (
        <div style={{ color: '#9e9e9e', fontSize: '0.68rem', fontStyle: 'italic', marginBottom: 12 }}>
          {ind?.candle_structure
            ? 'Click Generate for a unified tape + indicator read.'
            : 'Awaiting data…'}
        </div>
      )}

      {/* ══ 4. SIGNALS (collapsible) ══════════════════════════════════════ */}
      {rules.length > 0 && (
        <div>
          <button
            onClick={() => setSignalsOpen((o) => !o)}
            style={{
              width: '100%', background: 'none', border: 'none',
              cursor: 'pointer', padding: '4px 0', textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: '0.70rem', fontWeight: 600, color: '#9e9e9e', letterSpacing: '0.08em' }}>
              SIGNALS FIRED ({rules.length})
            </span>
            <span style={{ fontSize: '0.7rem', color: '#9e9e9e', marginLeft: 'auto' }}>
              {signalsOpen ? '▲' : '▼'}
            </span>
          </button>

          {signalsOpen && rules.map((r) => {
            const meta = RULE_META[r];
            const dir = meta?.direction ?? (r.includes('bear') || r.includes('down') || r.includes('below') || r.includes('lose') ? 'DOWN' : 'UP');
            const color = dir === 'UP' ? '#26a69a' : dir === 'DOWN' ? '#ef5350' : '#60a5fa';
            const arrow = dir === 'UP' ? '▲' : dir === 'DOWN' ? '▼' : '▲▼';
            return (
              <div key={r} style={{
                marginBottom: 8, padding: '8px 10px',
                background: '#131325', borderRadius: 6,
                borderLeft: `3px solid ${color}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ color, fontSize: '0.7rem', fontWeight: 700 }}>{arrow}</span>
                  <span style={{ color, fontWeight: 600, fontSize: '0.77rem' }}>{meta?.label ?? r}</span>
                  {meta && meta.weight > 1 && (
                    <span style={{ fontSize: '0.62rem', background: '#2a2a3e', borderRadius: 3,
                      padding: '1px 5px', color: '#c8c8c8', marginLeft: 'auto' }}>
                      ×{meta.weight} weight
                    </span>
                  )}
                </div>
                <p style={{ fontSize: '0.71rem', color: '#a0a0b8', margin: 0, lineHeight: 1.5 }}>
                  {meta?.explanation ?? '—'}
                </p>
              </div>
            );
          })}

          {evidence && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: '#9e9e9e', fontSize: '0.72rem' }}>
                Raw evidence data
              </summary>
              <pre className="evidence-pre">{JSON.stringify(evidence, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {/* ══ 5. CONFLUENCE SUMMARY ═════════════════════════════════════════ */}
      {(confluenceLoading || confluenceData || confluenceError || ind?.confluence_bias) && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#818cf8', letterSpacing: '0.09em' }}>
              CONFLUENCE
            </span>
            <span style={{
              fontSize: '0.62rem', fontWeight: 700, color: confluenceBiasColor,
              background: `${confluenceBiasColor}16`, border: `1px solid ${confluenceBiasColor}44`,
              borderRadius: 4, padding: '1px 6px', lineHeight: 1,
            }}>
              {confluenceBiasLabel}
            </span>
          </div>

            <p style={{ fontSize: '0.68rem', color: '#d1d5db', margin: '0 0 8px', lineHeight: 1.5 }}>
              {confluenceBiasText}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px', marginBottom: 8 }}>
              <span style={{ color: '#9e9e9e' }}>Buy pressure</span>
              <span style={{ fontWeight: 700, color: '#26a69a' }}>{ind?.bull_score ?? '—'}</span>
              <span style={{ color: '#9e9e9e' }}>Sell pressure</span>
              <span style={{ fontWeight: 700, color: '#ef5350' }}>{ind?.bear_score ?? '—'}</span>
              <span style={{ color: '#9e9e9e' }}>Bias</span>
              <span style={{ fontWeight: 700, color: confluenceBiasColor }}>{ind?.confluence_bias ?? '—'}</span>
            </div>

            {fusionScore && (
              <div style={{
                fontSize: '0.75rem',
                marginBottom: 8,
                padding: 8,
                background: `${fusionColor}11`,
                border: `1px solid ${fusionColor}33`,
                borderRadius: 4,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ color: '#9e9e9e', textTransform: 'uppercase', fontSize: '0.65rem' }}>
                    Decision strength
                  </span>
                  <span style={{ color: fusionColor, fontWeight: 700, fontSize: '0.85rem' }}>
                    {fusionScore.fusion_score}
                  </span>
                </div>
                <div style={{ color: fusionColor, fontWeight: 600, fontSize: '0.7rem', marginBottom: 4 }}>
                  {fusionScore.fusion_signal}
                </div>
                <div style={{ color: '#9e9e9e', fontSize: '0.65rem', lineHeight: 1.45 }}>
                  {fusionScore.reasoning}
                </div>
              </div>
            )}

            {confluenceData?.patterns?.bias_narrative && (
              <div style={{ fontSize: '0.68rem', color: '#cbd5e1', lineHeight: 1.5 }}>
                {confluenceData.patterns.bias_narrative}
              </div>
            )}

            {confluenceError && (
              <div style={{ fontSize: '0.65rem', color: '#ef5350', marginTop: 6 }}>
                ⚠ {confluenceError}
              </div>
            )}

            {confluenceLoading && !confluenceData && (
              <div style={{ fontSize: '0.65rem', color: '#9e9e9e', marginTop: 6 }}>
                Loading confluence summary…
              </div>
            )}
            <div style={{ fontSize: '0.64rem', color: '#9e9e9e', marginTop: 6, lineHeight: 1.45 }}>
              Higher scores mean more evidence is pointing the same way; lower scores mean the setup is still mixed.
            </div>
          {confluenceStrength && (
            <div style={{ fontSize: '0.64rem', color: '#9e9e9e', marginTop: 4 }}>
              Strength bucket: {confluenceStrength}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MarketReadPanel;

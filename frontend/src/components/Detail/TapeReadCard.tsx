import React from 'react';
import type { IndicatorSnapshot } from '../../stores/marketStore';

interface TapeReadCardProps {
  ticker: string;
  indicators: IndicatorSnapshot | null;
}

const STRUCTURE_COLOR: Record<string, string> = {
  UPTREND:   '#26a69a',
  DOWNTREND: '#ef5350',
  COILING:   '#FFB300',
  CHOPPY:    '#9e9e9e',
};

const STRUCTURE_ICON: Record<string, string> = {
  UPTREND:   '▲',
  DOWNTREND: '▼',
  COILING:   '◆',
  CHOPPY:    '↔',
};

const PATTERN_COLOR: Record<string, string> = {
  BullishEngulfing:   '#26a69a',
  BearishEngulfing:   '#ef5350',
  Hammer:             '#26a69a',
  InvertedHammer:     '#ef5350',
  ShootingStar:       '#ef5350',
  Doji:               '#FFB300',
  InsideBar:          '#60a5fa',
  NR7:                '#60a5fa',
  UpperRejectionWick: '#ef5350',
  LowerRejectionWick: '#26a69a',
  ThreeGreen:         '#26a69a',
  ThreeRed:           '#ef5350',
};

function parsePatterns(raw: string[] | string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw as string) as string[]; } catch { return []; }
}

const TapeReadCard: React.FC<TapeReadCardProps> = ({ ticker, indicators: ind }) => {
  const [loading, setLoading] = React.useState(false);
  // Store narrative alongside the ticker it belongs to, so switching
  // tickers automatically discards the stale narrative without needing
  // a useEffect setState reset.
  const [localResult, setLocalResult] = React.useState<{ ticker: string; narrative: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleGenerate = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/indicators/${ticker}/tape-read`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json() as { tape_read_narrative?: string };
      if (data.tape_read_narrative) {
        setLocalResult({ ticker, narrative: data.tape_read_narrative });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  if (!ind) {
    return (
      <div style={{ color: '#9e9e9e', fontSize: '0.75rem', padding: 8 }}>
        Waiting for first refresh cycle…
      </div>
    );
  }

  const structure     = ind.candle_structure;
  const structColor   = structure ? (STRUCTURE_COLOR[structure] ?? '#9e9e9e') : '#9e9e9e';
  const structIcon    = structure ? (STRUCTURE_ICON[structure]  ?? '—')       : '—';
  const patterns      = parsePatterns(ind.candle_patterns);
  // localResult (from button click) takes precedence, but only for the current ticker
  const narrative     = (localResult?.ticker === ticker ? localResult.narrative : null) ?? ind.tape_read_narrative;
  const narrativeLines = narrative
    ? narrative.split('\n').map((l) => l.trim()).filter(Boolean)
    : null;

  return (
    <div style={{ padding: '4px 2px', fontSize: '0.73rem' }}>

      {/* ── Structure badge + near-level tag ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {structure ? (
          <span style={{ fontSize: '0.9rem', fontWeight: 800, color: structColor, letterSpacing: '0.03em' }}>
            {structIcon} {structure}
          </span>
        ) : (
          <span style={{ color: '#9e9e9e' }}>—</span>
        )}
        {ind.candle_hh_hl && (
          <span style={{ fontSize: '0.6rem', color: '#26a69a', fontWeight: 700,
            background: 'rgba(38,166,154,0.1)', border: '1px solid rgba(38,166,154,0.3)',
            borderRadius: 4, padding: '1px 5px' }}>HH/HL</span>
        )}
        {ind.candle_lh_ll && (
          <span style={{ fontSize: '0.6rem', color: '#ef5350', fontWeight: 700,
            background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.3)',
            borderRadius: 4, padding: '1px 5px' }}>LH/LL</span>
        )}
        {ind.candle_near_level && (
          <span style={{ fontSize: '0.6rem', fontWeight: 700, marginLeft: 'auto',
            background: 'rgba(255,183,0,0.1)', border: '1px solid rgba(255,183,0,0.35)',
            color: '#FFB300', borderRadius: 4, padding: '1px 6px' }}>
            ⚑ {ind.candle_near_level}
          </span>
        )}
      </div>

      {/* ── Detected patterns ── */}
      {patterns.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {patterns.map((p) => {
            const col = PATTERN_COLOR[p] ?? '#60a5fa';
            return (
              <span key={p} style={{
                fontSize: '0.63rem', fontWeight: 600, borderRadius: 4,
                padding: '2px 7px',
                background: `${col}18`, border: `1px solid ${col}50`, color: col,
              }}>{p}</span>
            );
          })}
        </div>
      )}

      {/* ── Metrics grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px', marginBottom: 8 }}>

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
          <span style={{ fontWeight: 600,
            color: ind.candle_pace === 'TRENDING' ? '#26a69a' : '#9e9e9e' }}>
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

      {/* ── LLM Narrative + Generate button ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#10b981', letterSpacing: '0.09em' }}>
          📊 SENIOR TRADER READ
        </span>
        <button
          onClick={handleGenerate}
          disabled={loading || !ind.candle_structure}
          style={{
            fontSize: '0.6rem', fontWeight: 700, padding: '3px 10px',
            borderRadius: 5, border: '1px solid rgba(16,185,129,0.4)',
            background: loading ? 'rgba(16,185,129,0.05)' : 'rgba(16,185,129,0.12)',
            color: loading ? '#9e9e9e' : '#10b981',
            cursor: loading || !ind.candle_structure ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {loading ? '⏳ Generating…' : narrativeLines ? '↻ Refresh' : '▶ Generate'}
        </button>
      </div>

      {error && (
        <div style={{ fontSize: '0.65rem', color: '#ef5350', marginBottom: 6 }}>⚠ {error}</div>
      )}

      {narrativeLines && narrativeLines.length > 0 ? (
        <div style={{
          background: 'rgba(16,185,129,0.06)',
          border: '1px solid rgba(16,185,129,0.22)',
          borderRadius: 8, padding: '10px 12px',
        }}>
          {/* Line 1: environment label */}
          {narrativeLines[0] && (
            <div style={{ fontWeight: 800, fontSize: '0.82rem', color: '#d1fae5', marginBottom: 6 }}>
              {narrativeLines[0]}
            </div>
          )}
          {/* Lines 2 & 3: analysis */}
          {narrativeLines.slice(1).map((line, i) => (
            <p key={i} style={{
              fontSize: '0.73rem', color: '#a7f3d0',
              margin: i < narrativeLines.length - 2 ? '0 0 5px' : 0,
              lineHeight: 1.55,
            }}>
              {line}
            </p>
          ))}
        </div>
      ) : !loading && (
        <div style={{ color: '#9e9e9e', fontSize: '0.68rem', fontStyle: 'italic' }}>
          {ind.candle_structure
            ? 'Click Generate for an LLM tape read.'
            : 'Awaiting data…'}
        </div>
      )}

    </div>
  );
};

export default TapeReadCard;

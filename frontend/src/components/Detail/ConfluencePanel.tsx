import React, { useEffect, useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';

interface ConfluencePanelProps {
  ticker: string;
  currentPrice: number | null;
}

interface LevelData {
  poc?: number | null;
  val?: number | null;
  vah?: number | null;
  pivot?: number | null;
  s1?: number | null;
  s2?: number | null;
  r1?: number | null;
  r2?: number | null;
  timestamp?: string;
}

interface PatternDetection {
  pattern?: string;
  level?: number;
  severity?: string;
  status?: string;
}

interface ZoneTouch {
  level: number;
  timeframe: string;
  name: string;
  distance_pct: number;
}

const ConfluencePanel: React.FC<ConfluencePanelProps> = ({ ticker, currentPrice }) => {
  const pred = useMarketStore((s) => s.tickers[ticker]?.latestPrediction ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<{ daily?: LevelData; weekly?: LevelData; monthly?: LevelData } | null>(null);
  const [patterns, setPatterns] = useState<{ daily?: PatternDetection; weekly?: PatternDetection; monthly?: PatternDetection; confluence_strength?: string; bias_narrative?: string; zone_touches?: Record<string, ZoneTouch> } | null>(null);
  const [fusionScore, setFusionScore] = useState<{ fusion_score: number; fusion_signal: string; reasoning: string } | null>(null);

  useEffect(() => {
    const fetchConfluence = async () => {
      if (!ticker) return;
      
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        if (currentPrice !== null) {
          params.append('current_price', currentPrice.toString());
        }
        
        // Add AI prediction for fusion score calculation
        if (pred) {
          params.append('ai_prediction', pred.prediction || 'NEUTRAL');
          params.append('ai_confidence', (pred.confidence || 0).toString());
        }

        const response = await fetch(`/api/confluence/${ticker}?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        setLevels(data.levels);
        setPatterns(data.patterns);
        setFusionScore(data.fusion_score);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchConfluence();
    // Refresh every 5 minutes
    const interval = setInterval(fetchConfluence, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [ticker, currentPrice, pred]);

  const renderLevelRow = (label: string, value: number | null | undefined, isZoneTouching: boolean = false) => {
    if (value === null || value === undefined) return null;

    const distFromPrice = currentPrice ? Math.abs(currentPrice - value) : null;
    const pctFromPrice = distFromPrice && currentPrice ? ((distFromPrice / currentPrice) * 100).toFixed(2) : null;

    const bgColor = isZoneTouching ? '#fbc02d22' : 'transparent';
    const borderColor = isZoneTouching ? '#fbc02d' : 'transparent';

    return (
      <tr key={label} style={{ background: bgColor, borderLeft: `2px solid ${borderColor}` }}>
        <td style={{ fontSize: '0.75rem', color: '#9e9e9e', fontWeight: 600, paddingLeft: 4 }}>{label}</td>
        <td style={{ fontSize: '0.85rem', color: '#e0e0e0', textAlign: 'right' }}>
          {value.toFixed(2)}
        </td>
        <td style={{ fontSize: '0.7rem', color: '#666', textAlign: 'right', paddingRight: 4 }}>
          {pctFromPrice ? `${pctFromPrice}%` : '—'}
        </td>
      </tr>
    );
  };

  const renderTimeframeSection = (timeframe: 'daily' | 'weekly' | 'monthly', tfLabel: string) => {
    const tfLevels = levels?.[timeframe];
    const tfPattern = patterns?.[timeframe] as PatternDetection | undefined;
    const zoneTouches = patterns?.zone_touches || {};

    if (!tfLevels) return null;

    const poc = tfLevels.poc;
    const val = tfLevels.val;
    const vah = tfLevels.vah;
    const pivot = tfLevels.pivot;
    const s1 = tfLevels.s1;
    const s2 = tfLevels.s2;
    const r1 = tfLevels.r1;
    const r2 = tfLevels.r2;

    if (!poc && !pivot) {
      return null;
    }

    const patternColor = tfPattern?.pattern
      ? tfPattern.severity === 'high'
        ? '#ef5350'
        : tfPattern.severity === 'medium'
        ? '#ff9800'
        : '#fbc02d'
      : '#666';

    const patternLabel = tfPattern?.pattern || 'No Pattern';

    // Check if any level is being touched
    const touchingLevels = Object.entries(zoneTouches)
      .filter(([key]) => key.startsWith(timeframe))
      .map(([, touch]) => touch.name);

    return (
      <div key={timeframe} style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: '0.9rem',
          fontWeight: 700,
          color: '#e0e0e0',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {tfLabel}
          {touchingLevels.length > 0 && (
            <span style={{ fontSize: '0.7rem', marginLeft: 8, color: '#fbc02d', fontWeight: 600 }}>
              ⚡ TOUCHING {touchingLevels.join(', ')}
            </span>
          )}
        </div>

        {/* Pattern indicator */}
        {tfPattern && (
          <div style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: patternColor,
            background: `${patternColor}16`,
            border: `1px solid ${patternColor}44`,
            borderRadius: 4,
            padding: '4px 8px',
            marginBottom: 8,
            textAlign: 'center',
          }}>
            {patternLabel}
          </div>
        )}

        {/* Volume Profile Levels */}
        {(poc || val || vah) && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.65rem', color: '#9e9e9e', marginBottom: 4, textTransform: 'uppercase' }}>
              Volume Profile
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {renderLevelRow('VAH', vah, touchingLevels.includes('VAH'))}
                {renderLevelRow('POC', poc, touchingLevels.includes('POC'))}
                {renderLevelRow('VAL', val, touchingLevels.includes('VAL'))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pivot Levels */}
        {pivot && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.65rem', color: '#9e9e9e', marginBottom: 4, textTransform: 'uppercase' }}>
              Pivots
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {renderLevelRow('R2', r2, touchingLevels.includes('R2'))}
                {renderLevelRow('R1', r1, touchingLevels.includes('R1'))}
                {renderLevelRow('Pivot', pivot, touchingLevels.includes('PIVOT'))}
                {renderLevelRow('S1', s1, touchingLevels.includes('S1'))}
                {renderLevelRow('S2', s2, touchingLevels.includes('S2'))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{
          borderBottom: '1px solid #333',
          marginTop: 8,
          marginBottom: 8,
        }} />
      </div>
    );
  };

  if (loading && !levels) {
    return (
      <div style={{
        padding: 12,
        color: '#666',
        textAlign: 'center',
        fontSize: '0.85rem',
      }}>
        Loading confluence levels...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: 12,
        color: '#ef5350',
        textAlign: 'center',
        fontSize: '0.85rem',
      }}>
        Error: {error}
      </div>
    );
  }

  if (!levels) {
    return (
      <div style={{
        padding: 12,
        color: '#666',
        textAlign: 'center',
        fontSize: '0.85rem',
      }}>
        No data available
      </div>
    );
  }

  const confluenceStrength = patterns?.confluence_strength || 'LOW';
  const confluenceColor = confluenceStrength === 'HIGH'
    ? '#26a69a'
    : confluenceStrength === 'MEDIUM'
    ? '#ff9800'
    : '#666';

  const biasNarrative = patterns?.bias_narrative || 'Neutral bias';

  // Fusion score display
  const fusionColor = fusionScore
    ? fusionScore.fusion_score >= 70
      ? '#26a69a'
      : fusionScore.fusion_score >= 50
      ? '#ff9800'
      : '#ef5350'
    : '#666';

  return (
    <div style={{
      padding: 12,
      fontSize: '0.8rem',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        paddingBottom: 8,
        borderBottom: '1px solid #333',
      }}>
        <div style={{
          fontSize: '0.9rem',
          fontWeight: 700,
          color: '#e0e0e0',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          Confluence Analysis
        </div>
        <div style={{
          fontSize: '0.7rem',
          fontWeight: 600,
          color: confluenceColor,
          background: `${confluenceColor}16`,
          border: `1px solid ${confluenceColor}44`,
          borderRadius: 4,
          padding: '2px 6px',
        }}>
          {confluenceStrength}
        </div>
      </div>

      {/* Bias Narrative */}
      <div style={{
        fontSize: '0.75rem',
        color: '#e0e0e0',
        marginBottom: 12,
        padding: 8,
        background: '#1e1e1e',
        borderRadius: 4,
        borderLeft: `2px solid ${confluenceColor}`,
      }}>
        <div style={{ fontSize: '0.65rem', color: '#9e9e9e', marginBottom: 4, textTransform: 'uppercase' }}>
          Market Bias
        </div>
        {biasNarrative}
      </div>

      {/* Fusion Score (if AI prediction present) */}
      {fusionScore && (
        <div style={{
          fontSize: '0.75rem',
          marginBottom: 12,
          padding: 8,
          background: `${fusionColor}11`,
          border: `1px solid ${fusionColor}33`,
          borderRadius: 4,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ color: '#9e9e9e', textTransform: 'uppercase', fontSize: '0.65rem' }}>Decipher Score</span>
            <span style={{ color: fusionColor, fontWeight: 700, fontSize: '0.85rem' }}>
              {fusionScore.fusion_score}
            </span>
          </div>
          <div style={{ color: fusionColor, fontWeight: 600, fontSize: '0.7rem', marginBottom: 4 }}>
            {fusionScore.fusion_signal}
          </div>
          <div style={{ color: '#9e9e9e', fontSize: '0.65rem' }}>
            {fusionScore.reasoning}
          </div>
        </div>
      )}

      {/* Timeframe sections */}
      {renderTimeframeSection('daily', 'Daily')}
      {renderTimeframeSection('weekly', 'Weekly')}
      {renderTimeframeSection('monthly', 'Monthly')}

      {/* Footer info */}
      <div style={{
        fontSize: '0.65rem',
        color: '#666',
        marginTop: 12,
        fontStyle: 'italic',
      }}>
        ℹ Levels refresh every 5min (daily), Monday (weekly), 1st (monthly)
      </div>
    </div>
  );
};

export default ConfluencePanel;

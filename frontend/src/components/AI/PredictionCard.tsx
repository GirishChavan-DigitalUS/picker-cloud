import React from 'react';
import { predictionColor, formatConfidence } from '../../utils/formatters';
import type { PredictionRow } from '../../stores/marketStore';

interface PredictionCardProps {
  ticker: string;
  prediction: PredictionRow | null;
}

const PredictionCard: React.FC<PredictionCardProps> = ({ prediction }) => {
  if (!prediction) {
    return (
      <div className="prediction-card empty">
        <span style={{ color: '#666' }}>—</span>
      </div>
    );
  }

  const rules = (() => {
    try { return JSON.parse(prediction.rules_triggered) as string[]; } catch { return []; }
  })();

  return (
    <div className="prediction-card">
      <div
        style={{
          fontSize: '1.1rem',
          fontWeight: 700,
          color: predictionColor(prediction.prediction),
        }}
      >
        {prediction.prediction}
      </div>
      <div style={{ fontSize: '0.75rem', color: '#9e9e9e' }}>
        {formatConfidence(prediction.confidence)}
      </div>
      {rules.length > 0 && (
        <div style={{ fontSize: '0.65rem', color: '#666', marginTop: 4 }}>
          {rules.slice(0, 3).join(' · ')}
        </div>
      )}
    </div>
  );
};

export default PredictionCard;

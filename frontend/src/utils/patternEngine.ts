// ── Types ─────────────────────────────────────────────────────────────────────
export type SignalColor  = 'green' | 'red' | 'yellow' | 'grey';
export type StructureVal = 'UPTREND' | 'DOWNTREND' | 'COILING' | 'CHOPPY' | null;
export type TrendVal     = 'UP' | 'DOWN' | 'NEUTRAL' | 'ABSTAIN' | null;
export type TrafficLight = 'green' | 'red' | 'yellow' | 'orange' | 'grey';
export type ActionTone   = 'bull' | 'bear' | 'caution' | 'neutral';
export type PatternName  =
  | 'Breakout' | 'Fakeout' | 'Reversal' | 'Rejection'
  | 'Bounce' | 'Continuation' | 'Chop Zone' | 'Buildup';

export interface RawPoint {
  ts:         string;
  trend:      TrendVal;
  confidence: number;
  structure:  StructureVal;
}

export interface SignalChip {
  color:     SignalColor;
  chipLabel: string;   // BUY / SELL / CAUT / STAY
  confLabel: string;   // e.g. "↑72%"
  structure: StructureVal;
  ts:        string;
  timeLabel: string;   // HH:MM
}

export interface PatternResult {
  pattern:          PatternName | null;
  trafficLight:     TrafficLight;
  shortLabel:       string;
  headline:         string;
  action:           string;
  actionTone:       ActionTone;
  chips:            SignalChip[];
  currentStructure: StructureVal;
  currentTrend:     TrendVal;
  currentConf:      number;
  lastFlipMins:     number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normTs(ts: string): number {
  return new Date(ts.replace(' ', 'T')).getTime();
}

function formatTimeLabel(ts: string): string {
  const d = new Date(ts.replace(' ', 'T'));
  if (isNaN(d.getTime())) return ts.slice(11, 16);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function classifySignal(trend: TrendVal, confidence: number): SignalColor {
  if (!trend || trend === 'ABSTAIN' || trend === 'NEUTRAL') {
    return confidence < 0.35 ? 'grey' : 'yellow';
  }
  if (confidence < 0.45) return 'yellow';
  if (trend === 'UP')   return 'green';
  if (trend === 'DOWN') return 'red';
  return 'yellow';
}

function toChipLabel(color: SignalColor, confidence: number, trend: TrendVal): Pick<SignalChip, 'chipLabel' | 'confLabel'> {
  if (color === 'green') return { chipLabel: 'BUY',  confLabel: `↑${Math.round(confidence * 100)}%` };
  if (color === 'red')   return { chipLabel: 'SELL', confLabel: `↓${Math.round(confidence * 100)}%` };
  if (color === 'yellow') {
    const pct = Math.round(confidence * 100);
    const arrow = trend === 'UP' ? '↑' : trend === 'DOWN' ? '↓' : '';
    return { chipLabel: 'CAUT', confLabel: pct > 0 ? `${arrow}${pct}%` : '' };
  }
  return { chipLabel: 'STAY', confLabel: '' };
}

// ── Main engine ───────────────────────────────────────────────────────────────
export function runPatternEngine(points: RawPoint[]): PatternResult {
  const EMPTY: PatternResult = {
    pattern:          null,
    trafficLight:     'grey',
    shortLabel:       '—',
    headline:         'No data',
    action:           'Awaiting market data…',
    actionTone:       'neutral',
    chips:            [],
    currentStructure: null,
    currentTrend:     null,
    currentConf:      0,
    lastFlipMins:     0,
  };
  if (!points.length) return EMPTY;

  // Sort ascending by timestamp
  const sorted = [...points].sort((a, b) => normTs(a.ts) - normTs(b.ts));

  // Current state
  const last           = sorted[sorted.length - 1];
  const currentStructure = last.structure;
  const currentTrend     = last.trend;
  const currentConf      = last.confidence;

  // Build flat signal + structure arrays (last 20)
  const src  = sorted.slice(-20);
  const sigs: SignalColor[]  = src.map(p => classifySignal(p.trend, p.confidence));
  const strs: StructureVal[] = src.map(p => p.structure);
  const confs: number[]      = src.map(p => p.confidence);

  // Last 10 chips for the history strip
  const last10 = sorted.slice(-10);
  const chips: SignalChip[] = last10.map((p) => {
    const color = classifySignal(p.trend, p.confidence);
    const { chipLabel, confLabel } = toChipLabel(color, p.confidence, p.trend);
    return { color, chipLabel, confLabel, structure: p.structure, ts: p.ts, timeLabel: formatTimeLabel(p.ts) };
  });

  // Signal age: minutes since current direction was last established (last color flip)
  let lastFlipMins = 0;
  if (chips.length > 0) {
    const nowColor = chips[chips.length - 1].color;
    let flipIdx = -1;
    for (let i = chips.length - 2; i >= 0; i--) {
      if (chips[i].color !== nowColor) { flipIdx = i; break; }
    }
    const refTs = flipIdx >= 0
      ? new Date(chips[flipIdx + 1].ts.replace(' ', 'T')).getTime()
      : new Date(chips[0].ts.replace(' ', 'T')).getTime();
    lastFlipMins = Math.max(0, Math.round((Date.now() - refTs) / 60000));
  }

  // ── Pattern signals ───────────────────────────────────────────────────────
  const n   = sigs.length;
  const cur = sigs[n - 1];
  const prv = n > 1 ? sigs[n - 2] : null;

  const last3Sig  = sigs.slice(-3);
  const last5Str  = strs.slice(-5);
  const last5Sig  = sigs.slice(-5);

  const coilCount   = last5Str.filter(x => x === 'COILING').length;
  const yellowCount = last5Sig.filter(x => x === 'yellow').length;
  const chopCount   = last5Str.filter(x => x === 'CHOPPY').length;

  // Trailing streak (from the end)
  function streak(color: SignalColor): number {
    let c = 0;
    for (let i = n - 1; i >= 0; i--) { if (sigs[i] === color) c++; else break; }
    return c;
  }

  const greenStreak = streak('green');
  const redStreak   = streak('red');

  // Prior 4-bar streak then flip ≥65%
  function reversalFlip(): { is: boolean; dir: 'bull' | 'bear' } {
    if (n < 5) return { is: false, dir: 'bull' };
    const prior = sigs.slice(-5, -1);
    const allG  = prior.every(x => x === 'green');
    const allR  = prior.every(x => x === 'red');
    if (allG && cur === 'red'   && currentConf >= 0.65) return { is: true,  dir: 'bear' };
    if (allR && cur === 'green' && currentConf >= 0.65) return { is: true,  dir: 'bull' };
    return { is: false, dir: 'bull' };
  }

  const prvConf     = confs.length > 1 ? confs[n - 2] : 0;
  const prvStr      = n > 1 ? strs[n - 2] : null;
  const strongPrv   = (prv === 'green' || prv === 'red') && prvConf >= 0.70;
  const curFlipped  = cur !== prv && (cur === 'green' || cur === 'red' || cur === 'yellow' || cur === 'grey');

  const isRejection   = strongPrv && curFlipped;
  const isFakeout     = prvStr === 'COILING' && (prv === 'green' || prv === 'red') && curFlipped;
  const isBreakout    = coilCount >= 1 && !isRejection && !isFakeout
                        && (cur === 'green' || cur === 'red') && currentConf >= 0.65;
  const revCheck      = reversalFlip();
  const isReversal    = revCheck.is;
  const isBounce      = last3Sig.length === 3 && (
    (last3Sig[0] === 'red'   && last3Sig[1] === 'yellow' && last3Sig[2] === 'green') ||
    (last3Sig[0] === 'green' && last3Sig[1] === 'yellow' && last3Sig[2] === 'red')
  );
  const isBuildup         = coilCount >= 2 && cur !== 'green' && cur !== 'red';
  const isChopZone        = yellowCount >= 3 || chopCount >= 3;
  const isContinuationBull = greenStreak >= 3 && currentStructure === 'UPTREND';
  const isContinuationBear = redStreak   >= 3 && currentStructure === 'DOWNTREND';
  const isContinuation     = isContinuationBull || isContinuationBear;

  // ── Build result (priority: Breakout > Fakeout > Rejection > Reversal > Bounce > Continuation > Buildup > Chop) ──
  let pattern:     PatternName | null = null;
  let trafficLight: TrafficLight;
  let shortLabel:  string;
  let headline:    string;
  let action:      string;
  let actionTone:  ActionTone;

  if (isBreakout) {
    pattern      = 'Breakout';
    trafficLight = cur === 'green' ? 'green' : 'red';
    shortLabel   = 'BRKOUT';
    headline     = cur === 'green' ? 'Breakout above compression' : 'Breakdown below compression';
    action       = cur === 'green' ? 'Trade the breakout long. Momentum confirmed.' : 'Trade the breakdown short. Momentum confirmed.';
    actionTone   = cur === 'green' ? 'bull' : 'bear';
  } else if (isFakeout) {
    pattern      = 'Fakeout';
    trafficLight = 'orange';
    shortLabel   = 'FAKE';
    headline     = 'Fakeout — signal reversed quickly';
    action       = 'Do not chase. Likely a trap. Wait for re-entry.';
    actionTone   = 'caution';
  } else if (isRejection) {
    pattern      = 'Rejection';
    trafficLight = 'orange';
    shortLabel   = 'REJCT';
    headline     = `${prv === 'green' ? 'Bullish' : 'Bearish'} Rejection`;
    action       = 'Do not chase. Potential trap or range boundary.';
    actionTone   = 'caution';
  } else if (isReversal) {
    pattern      = 'Reversal';
    trafficLight = revCheck.dir === 'bull' ? 'green' : 'red';
    shortLabel   = revCheck.dir === 'bull' ? 'REV↑' : 'REV↓';
    headline     = revCheck.dir === 'bull' ? 'Bullish reversal forming' : 'Bearish reversal forming';
    action       = revCheck.dir === 'bull' ? 'Consider long on confirmation.' : 'Consider short on confirmation.';
    actionTone   = revCheck.dir === 'bull' ? 'bull' : 'bear';
  } else if (isBounce) {
    const bounceDir = last3Sig[2] === 'green' ? 'bull' : 'bear';
    pattern      = 'Bounce';
    trafficLight = 'yellow';
    shortLabel   = 'BOUNCE';
    headline     = bounceDir === 'bull' ? 'Bullish bounce pattern' : 'Bearish bounce pattern';
    action       = 'Watch for follow-through confirmation.';
    actionTone   = 'caution';
  } else if (isContinuation) {
    pattern      = 'Continuation';
    trafficLight = isContinuationBull ? 'green' : 'red';
    shortLabel   = 'CONT.';
    headline     = `Continuation — ${isContinuationBull ? greenStreak : redStreak}+ aligned bars`;
    action       = isContinuationBull ? 'Trade with trend. Momentum favors longs.' : 'Trade with trend. Momentum favors shorts.';
    actionTone   = isContinuationBull ? 'bull' : 'bear';
  } else if (isBuildup) {
    pattern      = 'Buildup';
    trafficLight = 'yellow';
    shortLabel   = 'BUILD';
    headline     = `Buildup — ${coilCount} COILING bars`;
    action       = 'Energy building. Prepare for a breakout move.';
    actionTone   = 'caution';
  } else if (isChopZone) {
    pattern      = 'Chop Zone';
    trafficLight = 'grey';
    shortLabel   = 'CHOP';
    headline     = 'Chop Zone — no clear signal';
    action       = 'Stay flat. Wait for a clean directional setup.';
    actionTone   = 'neutral';
  } else {
    // Default: use current signal
    if (cur === 'green') {
      trafficLight = 'green'; shortLabel = 'BULL';
      headline     = 'Bullish bias'; actionTone = 'bull';
      action       = 'Trend favors longs. Monitor for continuation.';
    } else if (cur === 'red') {
      trafficLight = 'red'; shortLabel = 'BEAR';
      headline     = 'Bearish bias'; actionTone = 'bear';
      action       = 'Trend favors shorts. Monitor for continuation.';
    } else {
      trafficLight = 'grey'; shortLabel = 'WAIT';
      headline     = 'No clear pattern'; actionTone = 'neutral';
      action       = 'Monitoring for a setup…';
    }
  }

  return {
    pattern, trafficLight, shortLabel, headline, action, actionTone,
    chips, currentStructure, currentTrend, currentConf, lastFlipMins,
  };
}

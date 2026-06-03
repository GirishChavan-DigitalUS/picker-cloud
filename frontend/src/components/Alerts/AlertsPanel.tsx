import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useMarketStore } from '../../stores/marketStore';
import type { CompositeAlert } from '../../stores/marketStore';
import { API_BASE } from '../../utils/formatters';
import {
  isPushSupported,
  getPushPermission,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSubscribed,
} from '../../utils/pushNotifications';

// ── Signal display metadata ──────────────────────────────────────────────────
const SIGNAL_META: Record<string, { label: string; emoji: string }> = {
  POWER_TREND_BULL:    { label: 'Power Trend',         emoji: '⚡' },
  POWER_TREND_BEAR:    { label: 'Power Trend',         emoji: '⚡' },
  STRUCTURE_BREAK_UP:  { label: 'Structure Break',     emoji: '🔓' },
  STRUCTURE_BREAK_DOWN:{ label: 'Structure Break',     emoji: '🔓' },
  VWAP_RESET_BULL:     { label: 'VWAP Reset',          emoji: '↩' },
  VWAP_RESET_BEAR:     { label: 'VWAP Reset',          emoji: '↩' },
  EXHAUSTION_REV_BULL: { label: 'Exhaustion Reversal', emoji: '🔄' },
  EXHAUSTION_REV_BEAR: { label: 'Exhaustion Reversal', emoji: '🔄' },
  POC_MAGNET:          { label: 'POC Magnet',          emoji: '🧲' },
  CONFLICT_WARNING:    { label: 'Conflict Warning',    emoji: '⚠️' },  HIGH_CONF_BULL:      { label: 'High Confidence',     emoji: '🎯' },
  HIGH_CONF_BEAR:      { label: 'High Confidence',     emoji: '🎯' },};

const COMPONENT_LABELS: Record<string, string> = {
  daily_trend:       'Daily Trend',
  ema_state:         'EMA State',
  vwap_position:     'VWAP Pos',
  vwap_motion:       'VWAP Motion',
  vwap_reclaim:      'VWAP Reclaim',
  vwap_lost:         'VWAP Lost',
  rvol:              'RVOL',
  ema_compressing:   'EMA Compress',
  vwap_distance:     'VWAP Dist',
  vwap_motion_flip:  'Motion Flip',
  level_magnet:      'Level Magnet',
  rvol_drying:       'RVOL Drying',
  vwap_flat:         'VWAP Flat',
  poc_regular:       'POC Reg',
  poc_pre:           'POC Pre',
  orb_high:          'ORB High',
  orb_low:           'ORB Low',
  prev_day_high:     'PDH',
  prev_day_low:      'PDL',
  swing_high:        'Swing High',
  swing_low:         'Swing Low',
};

const TIER_STYLE: Record<number, { border: string; badge: string; badgeBg: string; label: string }> = {
  1: { border: '#26a69a', badge: 'ACT',     badgeBg: '#26a69a22', label: 'TIER 1' },
  2: { border: '#FFB300', badge: 'WATCH',   badgeBg: '#FFB30022', label: 'TIER 2' },
  3: { border: '#607D8B', badge: 'CONTEXT', badgeBg: '#607D8B22', label: 'TIER 3' },
};

const DIR_COLOR: Record<string, string> = {
  UP:      '#26a69a',
  DOWN:    '#ef5350',
  WARNING: '#FF9800',
};

// ── Alert card ───────────────────────────────────────────────────────────────
interface AlertCardProps {
  alert: CompositeAlert;
  onSelectTicker: (ticker: string) => void;
  isSelected: boolean;
}
const AlertCard: React.FC<AlertCardProps> = ({ alert, onSelectTicker, isSelected }) => {
  const meta   = SIGNAL_META[alert.signal] ?? { label: alert.signal, emoji: '●' };
  const tier   = TIER_STYLE[alert.tier] ?? TIER_STYLE[3];
  const dColor = DIR_COLOR[alert.direction] ?? '#9e9e9e';
  const isSuppressed = !!alert.suppressed_by;
  const time   = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const confPct = Math.round(alert.ai_confidence * 100);
  const selColor = isSelected ? dColor : undefined;

  return (
    <div
      onClick={() => onSelectTicker(alert.ticker)}
      style={{
        marginBottom: 6,
        borderRadius: 6,
        border: `1px solid ${isSelected ? dColor : (isSuppressed ? '#3a3a5e' : tier.border)}`,
        borderLeft: `3px solid ${isSuppressed ? '#607D8B' : (alert.direction === 'WARNING' ? '#FF9800' : dColor)}`,
        background: isSelected
          ? `${dColor}18`
          : (isSuppressed ? '#12121e' : tier.badgeBg),
        cursor: 'pointer',
        opacity: isSuppressed ? 0.65 : 1,
        transition: 'all 0.15s',
        boxShadow: isSelected ? `0 0 0 1px ${dColor}44` : 'none',
        outline: selColor ? `none` : undefined,
      }}
    >
      {/* ── Row 1: tier badge + emoji + label + ticker + time ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px 4px' }}>
        <span style={{
          fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.06em',
          color: isSuppressed ? '#607D8B' : tier.border,
          background: '#1a1a2e', border: `1px solid ${isSuppressed ? '#3a3a5e' : tier.border}`,
          borderRadius: 3, padding: '1px 5px', flexShrink: 0,
        }}>{tier.label}</span>
        <span style={{ fontSize: '0.85rem' }}>{meta.emoji}</span>
        <span style={{
          fontWeight: 700, fontSize: '0.8rem',
          color: isSuppressed ? '#9e9e9e' : (alert.direction === 'WARNING' ? '#FF9800' : dColor),
          textDecoration: isSuppressed ? 'line-through' : 'none',
        }}>{meta.label}</span>
        {alert.direction !== 'WARNING' && (
          <span style={{ fontSize: '0.72rem', color: dColor, fontWeight: 600 }}>
            {alert.direction === 'UP' ? '▲' : '▼'}
          </span>
        )}
        <span style={{
          marginLeft: 'auto', fontWeight: 700, fontSize: '0.78rem',
          background: '#1a1a2e', border: '1px solid #2a2a3e',
          borderRadius: 4, padding: '1px 7px', color: '#e0e0e0',
        }}>{alert.ticker}</span>
        <span style={{ fontSize: '0.68rem', color: '#9e9e9e', flexShrink: 0 }}>{time}</span>
      </div>

      {/* ── Row 2: confidence bar + component chips ── */}
      <div style={{ padding: '0 10px 7px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Confidence pill */}
        <span style={{
          fontSize: '0.65rem', fontWeight: 700,
          color: confPct >= 75 ? '#26a69a' : confPct >= 65 ? '#FFB300' : '#ef5350',
          background: '#1a1a2e', border: '1px solid #2a2a3e',
          borderRadius: 3, padding: '1px 6px', flexShrink: 0,
        }}>{confPct}% conf</span>

        {/* Component chips */}
        {alert.components.map((c) => (
          <span key={c} style={{
            fontSize: '0.61rem', color: '#a0a0c0',
            background: '#1a1a2e', border: '1px solid #2a2a3e',
            borderRadius: 3, padding: '1px 5px',
          }}>{COMPONENT_LABELS[c] ?? c}</span>
        ))}

        {/* Suppression reason */}
        {isSuppressed && (
          <span style={{ fontSize: '0.61rem', color: '#FF9800', marginLeft: 'auto' }}>
            ⊘ {alert.suppressed_by?.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* ── Level / POC info (always visible when present) ── */}
      {(alert.level_price || alert.poc_level) && (
        <div style={{
          margin: '0 10px 8px', padding: '6px 8px',
          background: '#1a1a2e', borderRadius: 4, fontSize: '0.72rem', color: '#c0c0e0',
        }}>
          {alert.level_name && <span style={{ color: '#9e9e9e', marginRight: 6 }}>{alert.level_name.replace(/_/g, ' ')}:</span>}
          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>
            {(alert.level_price ?? alert.poc_level)?.toFixed(2)}
          </span>
        </div>
      )}
      {/* Navigation hint */}
      <div style={{ padding: '0 10px 6px', display: 'flex', justifyContent: 'flex-end' }}>
        <span style={{ fontSize: '0.62rem', color: isSelected ? dColor : '#4a4a6a', fontWeight: 600 }}>
          {isSelected ? '▶ viewing chart' : '▶ click to view chart'}
        </span>
      </div>
    </div>
  );
};

// Lookback window and cycle gap for batch detection (1m refresh)
const LOOKBACK_MS = 300_000;   // 5 min — seed recent history on mount
const CYCLE_GAP_MS = 600_000;  // 10 min — gap that signals backend restart (clears batch)

// ── Main panel ───────────────────────────────────────────────────────────────
interface AlertsPanelProps {
  onSelectTicker?: (ticker: string) => void;
  selectedTicker?: string | null;
}
const AlertsPanel: React.FC<AlertsPanelProps> = ({ onSelectTicker, selectedTicker }) => {
  const [batchAlerts, setBatchAlerts] = useState<CompositeAlert[]>([]);
  const [filter, setFilter] = useState('');
  const [tierFilter, setTierFilter] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Push notification state ────────────────────────────────────────────────
  const [pushSupported] = useState(() => isPushSupported());
  const [pushPermission, setPushPermission] = useState<NotificationPermission>(() => getPushPermission());
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported) return;
    isPushSubscribed().then(setPushSubscribed);
  }, [pushSupported]);

  const batchNewestEpochRef = useRef<number>(0);
  const compositeAlerts = useMarketStore((s) => s.compositeAlerts);
  const selectedTimeframe = useMarketStore((s) => s.selectedTimeframe);
  const prevStoreCountRef = useRef<number>(-1);

  // Seed from last scheduler cycle on mount (and refresh on TF change)
  useEffect(() => {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    axios.get(`${API_BASE}/composite-alerts?limit=100&timeframe=${selectedTimeframe}`).then((r) => {
      const all: CompositeAlert[] = r.data.alerts ?? [];
      const recent = all.filter((a) => a.timestamp >= since);
      setBatchAlerts(recent);
      if (recent.length > 0) {
        batchNewestEpochRef.current = Math.max(...recent.map((a) => new Date(a.timestamp).getTime()));
      } else {
        batchNewestEpochRef.current = 0;
      }
    }).catch(() => {});
    prevStoreCountRef.current = compositeAlerts.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTimeframe]);

  // Detect new WS alerts
  useEffect(() => {
    if (prevStoreCountRef.current < 0) { prevStoreCountRef.current = compositeAlerts.length; return; }
    const newCount = compositeAlerts.length - prevStoreCountRef.current;
    if (newCount <= 0) { prevStoreCountRef.current = compositeAlerts.length; return; }
    const incoming = compositeAlerts.slice(0, newCount);
    incoming.forEach((alert) => {
      const epoch = new Date(alert.timestamp).getTime();
      const isNewCycle = batchNewestEpochRef.current > 0 && epoch - batchNewestEpochRef.current > CYCLE_GAP_MS;
      if (isNewCycle) {
        batchNewestEpochRef.current = epoch;
        setBatchAlerts([alert]);
      } else {
        if (epoch > batchNewestEpochRef.current) batchNewestEpochRef.current = epoch;
        setBatchAlerts((prev) => {
          if (prev.some((x) => x.ticker === alert.ticker && x.signal === alert.signal && x.timestamp === alert.timestamp)) return prev;
          return [alert, ...prev];
        });
      }
    });
    prevStoreCountRef.current = compositeAlerts.length;
  }, [compositeAlerts]);

  const handleRefreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setBatchAlerts([]);
    batchNewestEpochRef.current = Date.now();
    try {
      await axios.post(`${API_BASE}/refresh-all`);
      setLastRefresh(new Date());
    } catch (e) {
      console.error('Refresh failed', e);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [batchAlerts, autoScroll]);

  const filtered = batchAlerts.filter((a) => {
    if (tierFilter !== null && a.tier !== tierFilter) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return (
        a.ticker.toLowerCase().includes(q) ||
        a.signal.toLowerCase().includes(q) ||
        (SIGNAL_META[a.signal]?.label ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  }).slice(0, 10);

  return (
    <div className="alerts-panel">
      {/* Header */}
      <div className="alerts-header">
        <h3>Alerts</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="alerts-filter"
            placeholder="Filter ticker/type…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            title={lastRefresh ? `Last refreshed ${lastRefresh.toLocaleTimeString()}` : 'Refresh all tickers now'}
            style={{
              fontSize: '0.70rem', fontWeight: 700, padding: '3px 9px',
              borderRadius: 4, cursor: refreshing ? 'not-allowed' : 'pointer',
              border: '1px solid var(--border)',
              background: refreshing ? '#2a2a3e' : 'var(--surface2)',
              color: refreshing ? '#9e9e9e' : '#818cf8',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}
          >
            {refreshing ? '↻…' : '↻ Refresh'}
          </button>
          {/* Push notification toggle — only rendered when supported and not denied */}
          {pushSupported && pushPermission !== 'denied' && (
            <button
              onClick={async () => {
                if (pushBusy) return;
                setPushBusy(true);
                try {
                  if (pushSubscribed) {
                    await unsubscribeFromPush();
                    setPushSubscribed(false);
                    setPushPermission(getPushPermission());
                  } else {
                    const result = await subscribeToPush();
                    if (result === 'subscribed') setPushSubscribed(true);
                    setPushPermission(getPushPermission());
                  }
                } finally {
                  setPushBusy(false);
                }
              }}
              disabled={pushBusy}
              title={pushSubscribed ? 'Disable push notifications' : 'Enable push notifications for Tier 1 & 2 alerts'}
              style={{
                fontSize: '0.78rem', padding: '3px 7px',
                borderRadius: 4, cursor: pushBusy ? 'not-allowed' : 'pointer',
                border: `1px solid ${pushSubscribed ? '#26a69a' : 'var(--border)'}`,
                background: pushSubscribed ? '#26a69a22' : 'var(--surface2)',
                color: pushSubscribed ? '#26a69a' : '#9e9e9e',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
              }}
            >
              {pushBusy ? '…' : pushSubscribed ? '🔔' : '🔕'}
            </button>
          )}
          <label style={{ fontSize: '0.72rem', color: '#9e9e9e', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} style={{ marginRight: 4 }} />
            Auto-scroll
          </label>
        </div>
      </div>

      {/* TF / MTF tabs removed — app is 5m only */}

      {/* Tier filter buttons */}
      <div style={{ display: 'flex', gap: 5, padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        {([null, 1, 2, 3] as (number | null)[]).map((t) => (
          <button
            key={String(t)}
            onClick={() => setTierFilter(tierFilter === t ? null : t)}
            style={{
              fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.04em',
              padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${tierFilter === t ? (t ? TIER_STYLE[t].border : '#818cf8') : '#3a3a5e'}`,
              background: tierFilter === t ? (t ? `${TIER_STYLE[t].border}33` : '#818cf833') : 'transparent',
              color: tierFilter === t ? (t ? TIER_STYLE[t].border : '#818cf8') : '#9e9e9e',
              transition: 'all 0.15s',
            }}
          >
            {t === null ? 'ALL' : `T${t}`}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#9e9e9e', alignSelf: 'center' }}>
          {filtered.length} alert{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Alert list */}
      <div className="alerts-scroll" style={{ padding: '6px 8px' }}>
        {refreshing && (
          <div style={{ color: '#818cf8', padding: '10px 0', textAlign: 'center', fontSize: '0.78rem' }}>
            ↻ Refreshing… alerts will appear as they arrive
          </div>
        )}
        {!refreshing && filtered.length === 0 && (
          <div style={{ color: '#666', padding: '16px 0', textAlign: 'center', fontSize: '0.8rem' }}>
            No alerts from last refresh — click ↻ Refresh to run now
          </div>
        )}
        {filtered.map((alert, i) => (
          <AlertCard
            key={`${alert.ticker}-${alert.timestamp}-${alert.signal}-${i}`}
            alert={alert}
            onSelectTicker={onSelectTicker ?? (() => {})}
            isSelected={selectedTicker === alert.ticker}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default AlertsPanel;

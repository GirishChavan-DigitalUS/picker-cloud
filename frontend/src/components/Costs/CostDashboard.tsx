/**
 * CostDashboard — modal showing AWS spend for the EC2 deployment.
 * Fetches /api/costs/summary which calls Cost Explorer + Budgets via boto3.
 */
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../../utils/formatters';

interface ServiceLine { service: string; amount: number; }
interface AlertLine   { severity: 'info' | 'warning' | 'critical'; message: string; }
interface CostSummary {
  month: string;
  month_label: string;
  mtd_spend: number;
  vs_last_month_pct: number | null;
  last_month_total: number;
  daily_avg: number;
  daily_avg_7d: number;
  days_elapsed: number;
  days_in_month: number;
  projected_month: number;
  budget: number;
  budget_source: string;
  budget_name: string | null;
  budget_pct_used: number;
  projected_pct: number;
  alert_threshold_pct: number;
  currency: string;
  by_service: ServiceLine[];
  alerts: AlertLine[];
  last_updated: string;
  cached?: boolean;
  cache_age_seconds?: number;
}

interface Props { open: boolean; onClose: () => void; }

const SERVICE_COLORS = ['#3b82f6', '#10b981', '#a78bfa', '#f97316', '#facc15', '#06b6d4', '#ec4899', '#94a3b8'];

const fmt = (n: number, currency = 'USD'): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);

const CostDashboard: React.FC<Props> = ({ open, onClose }) => {
  const [data, setData] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    setLoading(true);
    setError(null);
    axios.get<CostSummary>(`${API_BASE}/costs/summary`, { params: refresh ? { refresh: true } : {} })
      .then((r) => setData(r.data))
      .catch((e) => {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setError(detail ?? 'Failed to load cost summary');
      })
      .finally(() => setLoading(false));
  }, []);

  const hasLoadedRef = React.useRef(false);
  useEffect(() => {
    if (open && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      load(false);
    }
  }, [open, load]);

  if (!open) return null;

  const cur = data?.currency ?? 'USD';
  const utilPct = Math.min(100, data?.budget_pct_used ?? 0);
  const utilColor = utilPct >= 100 ? '#ef4444' : utilPct >= (data?.alert_threshold_pct ?? 80) ? '#f97316' : '#10b981';
  const topServiceMax = data?.by_service?.[0]?.amount ?? 1;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 9999, padding: '5vh 16px', overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 10,
          width: 'min(800px, 100%)', padding: '20px 24px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}
      >
        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: '0.7rem', color: 'var(--muted, #94a3b8)', letterSpacing: 1, fontWeight: 700 }}>
              THIS MONTH · {data?.month_label ?? '—'}
            </div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: 2 }}>AWS Cost Dashboard</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => load(true)}
              disabled={loading}
              style={{
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 5, padding: '4px 10px', cursor: 'pointer',
                color: 'var(--text)', fontSize: '0.72rem', fontWeight: 600,
              }}
            >{loading ? '…' : '↻ Refresh'}</button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 5, padding: '4px 10px', cursor: 'pointer',
                color: 'var(--text)', fontSize: '0.72rem', fontWeight: 600,
              }}
            >✕ Close</button>
          </div>
        </div>

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5', padding: '10px 12px', borderRadius: 6, fontSize: '0.78rem', marginBottom: 14,
          }}>{error}</div>
        )}

        {!data && loading && (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted, #94a3b8)' }}>Loading cost data…</div>
        )}

        {data && (
          <>
            {/* ── KPI cards ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
              <KpiCard
                icon="$" iconBg="rgba(34,197,94,0.15)" iconColor="#22c55e"
                label="MTD spend" value={fmt(data.mtd_spend, cur)}
                sublabel={
                  data.vs_last_month_pct != null
                    ? `${data.vs_last_month_pct >= 0 ? '+' : ''}${data.vs_last_month_pct.toFixed(0)}% vs last month`
                    : '—'
                }
                sublabelColor={data.vs_last_month_pct != null && data.vs_last_month_pct > 0 ? '#f97316' : '#94a3b8'}
              />
              <KpiCard
                icon="📈" iconBg="rgba(59,130,246,0.15)" iconColor="#3b82f6"
                label="Projected" value={fmt(data.projected_month, cur)}
                sublabel="by end of month" sublabelColor="#94a3b8"
              />
              <KpiCard
                icon="🚩" iconBg="rgba(168,85,247,0.15)" iconColor="#a78bfa"
                label="Budget limit" value={fmt(data.budget, cur)}
                sublabel="monthly cap" sublabelColor="#94a3b8"
              />
              <KpiCard
                icon="" iconBg="transparent" iconColor="transparent"
                label="Daily avg" value={fmt(data.daily_avg_7d, cur)}
                sublabel="last 7 days" sublabelColor="#94a3b8"
              />
            </div>

            {/* ── Budget utilization ── */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Budget utilization</span>
                <span style={{ fontWeight: 700, fontSize: '0.85rem', color: utilColor }}>{utilPct.toFixed(0)}%</span>
              </div>
              <div style={{ position: 'relative', height: 14, background: 'rgba(148,163,184,0.18)', borderRadius: 7, overflow: 'hidden' }}>
                <div style={{
                  width: `${utilPct}%`, height: '100%',
                  background: utilColor, borderRadius: 7, transition: 'width 0.5s ease',
                }} />
                {/* Threshold marker */}
                <div style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: `${data.alert_threshold_pct}%`,
                  width: 2, background: 'rgba(255,255,255,0.5)',
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--muted, #94a3b8)', marginTop: 4 }}>
                <span>{fmt(0, cur)}</span>
                <span>Alert at {data.alert_threshold_pct.toFixed(0)}%</span>
                <span>{fmt(data.budget, cur)}</span>
              </div>
            </div>

            {/* ── Top services ── */}
            {data.by_service.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--muted, #94a3b8)', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
                  TOP SERVICES
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.by_service.slice(0, 6).map((s, i) => {
                    const pct = topServiceMax > 0 ? Math.max(4, (s.amount / topServiceMax) * 100) : 0;
                    return (
                      <div key={s.service} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 70px', gap: 10, alignItems: 'center', fontSize: '0.78rem' }}>
                        <span style={{ fontWeight: 600 }}>{s.service.replace(/^Amazon /, '').replace(/^AWS /, '')}</span>
                        <div style={{ height: 8, background: 'rgba(148,163,184,0.18)', borderRadius: 4 }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: SERVICE_COLORS[i % SERVICE_COLORS.length], borderRadius: 4 }} />
                        </div>
                        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.amount, cur)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Budget alerts ── */}
            {data.alerts.length > 0 && (
              <div>
                <div style={{ fontSize: '0.7rem', color: 'var(--muted, #94a3b8)', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
                  BUDGET ALERTS
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.alerts.map((a, i) => <AlertRow key={i} alert={a} />)}
                </div>
              </div>
            )}

            {/* ── Footer ── */}
            <div style={{ marginTop: 16, fontSize: '0.65rem', color: 'var(--muted, #94a3b8)', textAlign: 'right' }}>
              Source: {data.budget_source}{data.cached ? ` · cached ${Math.round((data.cache_age_seconds ?? 0) / 60)}m ago` : ''}
              {' · '}{new Date(data.last_updated).toLocaleString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const KpiCard: React.FC<{
  icon: string; iconBg: string; iconColor: string;
  label: string; value: string; sublabel: string; sublabelColor: string;
}> = ({ icon, iconBg, iconColor, label, value, sublabel, sublabelColor }) => (
  <div style={{
    border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
    background: 'rgba(255,255,255,0.02)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--muted, #94a3b8)', fontWeight: 600 }}>
      {icon && (
        <span style={{
          display: 'inline-flex', width: 18, height: 18, borderRadius: 4,
          alignItems: 'center', justifyContent: 'center',
          background: iconBg, color: iconColor, fontSize: '0.7rem',
        }}>{icon}</span>
      )}
      {label}
    </div>
    <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    <div style={{ fontSize: '0.68rem', color: sublabelColor, marginTop: 2 }}>{sublabel}</div>
  </div>
);

const AlertRow: React.FC<{ alert: AlertLine }> = ({ alert }) => {
  const palette = {
    critical: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.35)', color: '#fca5a5', icon: '⚠' },
    warning:  { bg: 'rgba(251,146,60,0.08)', border: 'rgba(251,146,60,0.35)', color: '#fdba74', icon: '⚠' },
    info:     { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.35)', color: '#86efac', icon: '✓' },
  }[alert.severity];
  return (
    <div style={{
      background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 6,
      padding: '8px 12px', fontSize: '0.78rem', color: palette.color,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ fontSize: '0.9rem' }}>{palette.icon}</span>
      <span>{alert.message}</span>
    </div>
  );
};

export default CostDashboard;

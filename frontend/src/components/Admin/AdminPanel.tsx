import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '../../utils/formatters';

interface SessionRow {
  id: string;
  username: string;
  ip_address: string;
  browser_os: string;
  created_at: string;
  last_seen: string;
  is_active: number;
}

interface LoginRow {
  username: string;
  ip_address: string;
  browser_os: string;
  success: number;
  ts: string;
}

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

const cell: React.CSSProperties = {
  padding: '4px 8px', fontSize: '0.65rem', color: '#cbd5e1',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};
const head: React.CSSProperties = {
  ...cell, color: '#64748b', fontWeight: 700, fontSize: '0.55rem',
  letterSpacing: '0.06em', textTransform: 'uppercase',
};

export default function AdminPanel({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [history, setHistory] = useState<LoginRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [killBusy, setKillBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'sessions' | 'history'>('sessions');

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        axios.get(`${API_BASE}/admin/sessions`),
        axios.get(`${API_BASE}/admin/login-history`),
      ]);
      setSessions(s.data.sessions);
      setHistory(h.data.history);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // auto-refresh every 30 s
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function killSession(id: string) {
    setKillBusy(id);
    try {
      await axios.delete(`${API_BASE}/admin/sessions/${id}`);
      setSessions(prev => prev.map(s => s.id === id ? { ...s, is_active: 0 } : s));
    } finally {
      setKillBusy(null);
    }
  }

  const activeSessions = sessions.filter(s => s.is_active === 1);
  const inactiveSessions = sessions.filter(s => s.is_active === 0);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.7)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        padding: '12px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#0f172a', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10, width: '100%', maxWidth: 820,
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e2e8f0', flexGrow: 1 }}>
            🔐 Admin Panel
          </span>
          <span style={{ fontSize: '0.55rem', color: '#475569' }}>auto-refresh 30s</span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: '#64748b',
              cursor: 'pointer', fontSize: '1rem', padding: '0 4px',
            }}
          >✕</button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 2, padding: '8px 16px 0',
          borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
        }}>
          {(['sessions', 'history'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: tab === t ? 'rgba(99,102,241,0.15)' : 'none',
                border: 'none', borderBottom: tab === t ? '2px solid #818cf8' : '2px solid transparent',
                color: tab === t ? '#818cf8' : '#475569', cursor: 'pointer',
                fontSize: '0.62rem', fontWeight: 600, padding: '4px 12px 6px',
                textTransform: 'capitalize',
              }}
            >
              {t === 'sessions' ? `Sessions (${activeSessions.length} active)` : 'Login History'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flexGrow: 1 }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: '0.7rem' }}>
              Loading…
            </div>
          ) : tab === 'sessions' ? (
            <>
              {/* Active */}
              <div style={{ padding: '8px 16px 2px' }}>
                <span style={{ fontSize: '0.55rem', color: '#22c55e', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  ● Active ({activeSessions.length})
                </span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['User', 'IP', 'Browser / OS', 'First Login', 'Last Active', ''].map(h => (
                      <th key={h} style={head}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeSessions.length === 0 && (
                    <tr><td colSpan={6} style={{ ...cell, color: '#475569', textAlign: 'center' }}>No active sessions</td></tr>
                  )}
                  {activeSessions.map(s => (
                    <tr key={s.id} style={{ background: 'rgba(34,197,94,0.03)' }}>
                      <td style={{ ...cell, color: '#e2e8f0', fontWeight: 600 }}>{s.username}</td>
                      <td style={cell}>{s.ip_address}</td>
                      <td style={cell}>{s.browser_os}</td>
                      <td style={cell}>{fmt(s.created_at)}</td>
                      <td style={cell}>{fmt(s.last_seen)}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>
                        <button
                          onClick={() => killSession(s.id)}
                          disabled={killBusy === s.id}
                          style={{
                            background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.3)',
                            borderRadius: 4, color: '#ef5350', fontSize: '0.55rem', fontWeight: 700,
                            padding: '2px 8px', cursor: 'pointer',
                          }}
                        >
                          {killBusy === s.id ? '…' : 'Kill'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Recent inactive */}
              {inactiveSessions.length > 0 && (
                <>
                  <div style={{ padding: '12px 16px 2px' }}>
                    <span style={{ fontSize: '0.55rem', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      ○ Recent Inactive ({inactiveSessions.length})
                    </span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {inactiveSessions.slice(0, 10).map(s => (
                        <tr key={s.id} style={{ opacity: 0.5 }}>
                          <td style={{ ...cell, color: '#e2e8f0' }}>{s.username}</td>
                          <td style={cell}>{s.ip_address}</td>
                          <td style={cell}>{s.browser_os}</td>
                          <td style={cell}>{fmt(s.created_at)}</td>
                          <td style={cell}>{fmt(s.last_seen)}</td>
                          <td style={cell} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            /* Login History */
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time', 'User', 'IP', 'Browser / OS', 'Result'].map(h => (
                    <th key={h} style={head}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.length === 0 && (
                  <tr><td colSpan={5} style={{ ...cell, color: '#475569', textAlign: 'center' }}>No login history</td></tr>
                )}
                {history.map((r, i) => (
                  <tr key={i}>
                    <td style={cell}>{fmt(r.ts)}</td>
                    <td style={{ ...cell, color: '#e2e8f0', fontWeight: 600 }}>{r.username}</td>
                    <td style={cell}>{r.ip_address}</td>
                    <td style={cell}>{r.browser_os}</td>
                    <td style={{ ...cell, color: r.success ? '#22c55e' : '#ef5350', fontWeight: 700 }}>
                      {r.success ? '✓ OK' : '✗ Fail'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

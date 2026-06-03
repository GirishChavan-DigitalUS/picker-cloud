import { useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../../utils/formatters';

interface Props {
  onSuccess: () => void;
}

const LoginPage: React.FC<Props> = ({ onSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/auth/login`, { username, password });
      onSuccess();
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string }; status?: number } })?.response;
      if (detail?.status === 401) {
        setError('Invalid username or password.');
      } else {
        setError(detail?.data?.detail ?? 'Login failed. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at top, #1a1f3a 0%, #0b0f1a 60%)',
      color: '#e2e8f0',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    }}>
      <form
        onSubmit={submit}
        style={{
          width: 'min(360px, calc(100vw - 32px))',
          background: 'rgba(15, 23, 42, 0.85)',
          border: '1px solid rgba(124, 77, 255, 0.35)',
          borderRadius: 12,
          padding: '28px 26px 24px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{
            fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-0.02em',
            color: '#a78bfa',
          }}>
            Picker 📈
          </div>
          <div style={{
            marginTop: 4, fontSize: '0.78rem', color: '#94a3b8',
            letterSpacing: '0.04em',
          }}>
            Sign in to continue
          </div>
        </div>

        <label style={{ display: 'block', fontSize: '0.72rem', color: '#94a3b8', marginBottom: 6, letterSpacing: '0.05em' }}>
          Username
        </label>
        <input
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
          required
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: '0.72rem', color: '#94a3b8', margin: '14px 0 6px', letterSpacing: '0.05em' }}>
          Password
        </label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          required
          style={inputStyle}
        />

        {error && (
          <div style={{
            marginTop: 14,
            background: 'rgba(239, 83, 80, 0.12)',
            border: '1px solid rgba(239, 83, 80, 0.45)',
            color: '#fca5a5',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: '0.75rem',
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          style={{
            marginTop: 20,
            width: '100%',
            background: busy ? 'rgba(124, 77, 255, 0.4)' : '#7c4dff',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '11px 14px',
            fontSize: '0.85rem',
            fontWeight: 700,
            letterSpacing: '0.03em',
            cursor: busy ? 'wait' : 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>

        <div style={{
          marginTop: 18, textAlign: 'center',
        }}>
          <a
            href="/landing.html"
            style={{
              display: 'inline-block',
              fontSize: '0.72rem', color: '#94a3b8',
              textDecoration: 'none',
              border: '1px solid rgba(148,163,184,0.2)',
              borderRadius: 6, padding: '7px 18px',
              transition: 'border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.color = '#e2e8f0'; (e.target as HTMLElement).style.borderColor = 'rgba(148,163,184,0.45)'; }}
            onMouseLeave={e => { (e.target as HTMLElement).style.color = '#94a3b8'; (e.target as HTMLElement).style.borderColor = 'rgba(148,163,184,0.2)'; }}
          >
            ← Back to landing page
          </a>
        </div>
      </form>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid rgba(148, 163, 184, 0.25)',
  borderRadius: 6,
  padding: '9px 11px',
  color: '#e2e8f0',
  fontSize: '0.85rem',
  outline: 'none',
  boxSizing: 'border-box',
};

export default LoginPage;

import { useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../../utils/formatters';
import LoginPage from './LoginPage';
import { AuthContext } from './authContext';

type AuthState = 'checking' | 'authed' | 'guest';

interface Props {
  children: React.ReactNode;
}

/**
 * Wraps the dashboard and gates it behind a login form.
 *
 *  - On mount, calls GET /api/auth/me.
 *      • 200  → render children (dashboard).
 *      • 401  → render <LoginPage/>; on success, re-check /me.
 *      • net  → keep "checking" spinner and retry once after 1s.
 *
 * Cookies are sent automatically (same-origin in production; Vite proxies
 * /api → :8000 in dev so it's same-origin from the browser's perspective).
 */
const AuthGate: React.FC<Props> = ({ children }) => {
  // Skip the /me check entirely if no session cookie exists — show login
  // form immediately instead of blocking on a round-trip to the backend.
  const hasCookie = document.cookie.includes('picker_session');
  const [state, setState] = useState<AuthState>(hasCookie ? 'checking' : 'guest');
  const [username, setUsername] = useState<string>('');

  const check = () => {
    axios
      .get<{ username: string }>(`${API_BASE}/auth/me`, { timeout: 5000 })
      .then((r) => {
        setUsername(r.data?.username ?? '');
        setState('authed');
      })
      .catch((err) => {
        if (err?.response?.status === 401) {
          setState('guest');
        } else {
          // Network / backend unreachable — retry once.
          setTimeout(check, 1000);
        }
      });
  };

  useEffect(() => {
    if (state === 'checking') check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = async () => {
    try {
      await axios.post(`${API_BASE}/auth/logout`);
    } catch {
      // ignore — navigate regardless
    }
    // Hard-navigate so any in-flight API requests can't race the state change.
    window.location.replace('/app');
  };

  if (state === 'checking') {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#0b0f1a', color: '#94a3b8',
        fontSize: '0.9rem', letterSpacing: '0.05em',
      }}>
        Loading…
      </div>
    );
  }

  if (state === 'guest') {
    return <LoginPage onSuccess={check} />;
  }

  return (
    <AuthContext.Provider value={{ username, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthGate;

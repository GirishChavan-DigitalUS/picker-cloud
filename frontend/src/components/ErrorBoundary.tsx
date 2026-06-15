import React from 'react';

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', background: '#0f0f1a',
          color: '#e0e0e0', fontFamily: 'Inter, system-ui, sans-serif',
          padding: 24, textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '1.4rem', marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: 20, maxWidth: 420 }}>
            The dashboard encountered an unexpected error. This is usually temporary.
          </p>
          <button
            onClick={this.handleReload}
            style={{
              background: '#6366f1', color: '#fff', border: 'none',
              borderRadius: 6, padding: '10px 24px', fontSize: '0.85rem',
              fontWeight: 600, cursor: 'pointer',
            }}
          >
            Reload Dashboard
          </button>
          {this.state.error && (
            <pre style={{
              marginTop: 20, fontSize: '0.65rem', color: '#64748b',
              maxWidth: 500, overflow: 'auto', whiteSpace: 'pre-wrap',
            }}>
              {this.state.error.message}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

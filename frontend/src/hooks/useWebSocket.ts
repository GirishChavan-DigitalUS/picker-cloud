import { useEffect } from 'react';
import { useWsStore } from '../stores/wsStore';
import { useMarketStore } from '../stores/marketStore';

export function useWebSocket(enabled = true) {
  const { connect, disconnect, connected, resubscribe } = useWsStore();
  const selectedTimeframe = useMarketStore((s) => s.selectedTimeframe);

  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }
    connect();
    return () => disconnect();
  }, [connect, disconnect, enabled]);

  // Re-subscribe (or hand-off) when the selected timeframe changes.
  useEffect(() => {
    if (!enabled) return;
    resubscribe(selectedTimeframe);
  }, [selectedTimeframe, enabled, resubscribe]);

  return { connected };
}

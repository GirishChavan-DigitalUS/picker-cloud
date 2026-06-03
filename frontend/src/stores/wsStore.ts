import { create } from 'zustand';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { useMarketStore } from './marketStore';
import type { WsMessage } from './marketStore';

function wsUrl(tf: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws?tf=${encodeURIComponent(tf)}`;
}

interface WsStore {
  connected: boolean;
  socket: ReconnectingWebSocket | null;
  currentTf: string | null;
  connect: () => void;
  disconnect: () => void;
  resubscribe: (tf: string) => void;
}

export const useWsStore = create<WsStore>((set, get) => ({
  connected: false,
  socket: null,
  currentTf: null,

  connect: () => {
    if (get().socket) return;
    const tf = useMarketStore.getState().selectedTimeframe;

    const ws = new ReconnectingWebSocket(wsUrl(tf), [], {
      minReconnectionDelay: 2000,
      maxRetries: Infinity,
    });

    ws.addEventListener('open', () => {
      set({ connected: true });
      // Re-affirm subscription after every (re)connect.
      const liveTf = useMarketStore.getState().selectedTimeframe;
      try { ws.send(JSON.stringify({ subscribe_tf: liveTf })); } catch { /* ignore */ }
      // Heartbeat
      const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, 20000);
      ws.addEventListener('close', () => clearInterval(interval));
    });

    ws.addEventListener('close', () => set({ connected: false }));

    ws.addEventListener('message', (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data as string);
        useMarketStore.getState().handleWsMessage(msg);
      } catch {
        // ignore non-JSON (e.g. "pong")
      }
    });

    set({ socket: ws, currentTf: tf });
  },

  disconnect: () => {
    get().socket?.close();
    set({ socket: null, connected: false, currentTf: null });
  },

  resubscribe: (tf) => {
    const { socket, currentTf } = get();
    if (!socket || currentTf === tf) return;
    try { socket.send(JSON.stringify({ subscribe_tf: tf })); } catch { /* ignore */ }
    set({ currentTf: tf });
  },
}));

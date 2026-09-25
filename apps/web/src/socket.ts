import type { AgentEvent, ClientMessage } from "@village/events";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface Handlers {
  onEvent: (event: AgentEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onOpen: () => void;
}

/** WebSocket with automatic reconnect. Returns a `send` function. */
export function connect(url: string, handlers: Handlers) {
  let ws: WebSocket | null = null;
  let retryMs = 500;

  const open = () => {
    handlers.onStatus("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      retryMs = 500;
      handlers.onOpen();
      handlers.onStatus("connected");
    };
    ws.onmessage = (msg) => {
      try {
        handlers.onEvent(JSON.parse(msg.data));
      } catch (err) {
        console.warn("Bad event", err);
      }
    };
    ws.onclose = () => {
      handlers.onStatus("disconnected");
      setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 5000);
    };
  };
  open();

  return (msg: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
}

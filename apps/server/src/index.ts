import { WebSocketServer, WebSocket } from "ws";
import type { AgentEvent, ClientMessage } from "@village/events";
import { MockVillage } from "./mock.js";

const PORT = Number(process.env.WS_PORT ?? 8787);
const wss = new WebSocketServer({ port: PORT });

function broadcast(event: AgentEvent) {
  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

const village = new MockVillage(broadcast);

wss.on("connection", (ws) => {
  // Late joiners get the repos plus every agent that's currently alive.
  for (const event of village.snapshot()) ws.send(JSON.stringify(event));

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "mock.trigger") village.startIssue(msg.repo);
  });
});

village.start();
console.log(`🏘️  agent-village mock server on ws://localhost:${PORT}`);

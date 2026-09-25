import type { AgentEvent } from "@village/events";
import type { ConnectionStatus } from "./socket";
import { ROLE_COLORS, toolEmoji } from "./character";

const MAX_LOG = 40;

export class Hud {
  private readonly logEl = document.getElementById("log")!;
  private readonly agents = new Map<string, { repo: string; role: string }>();

  constructor() {
    const legend = document.getElementById("legend")!;
    for (const [role, color] of Object.entries(ROLE_COLORS)) {
      const item = document.createElement("span");
      item.innerHTML = `<i style="background:#${color.toString(16).padStart(6, "0")}"></i>${role}`;
      legend.append(item);
    }
  }

  onSpawn(fn: () => void) {
    document.getElementById("spawn")!.addEventListener("click", fn);
  }

  onOverview(fn: () => void) {
    document.getElementById("overview")!.addEventListener("click", fn);
  }

  setStatus(status: ConnectionStatus) {
    document.getElementById("status-dot")!.className = `dot ${status}`;
    document.getElementById("status-text")!.textContent =
      status === "connected" ? "connected to mock server" : status === "connecting" ? "connecting…" : "disconnected — retrying";
  }

  log(e: AgentEvent) {
    if (e.type === "repo.added") return;
    if (e.type === "agent.spawned") this.agents.set(e.id, { repo: e.repo, role: e.role });
    const agent = this.agents.get(e.id);
    if (!agent) return;

    let text: string;
    switch (e.type) {
      case "agent.spawned":
        text = e.issue ? `🐣 picked up #${e.issue.number} ${e.issue.title}` : `🐣 spawned`;
        break;
      case "agent.thought":
        text = `💭 ${e.text}`;
        break;
      case "agent.tool":
        text = `${toolEmoji(e.tool)} ${e.summary}`;
        break;
      case "agent.done":
        text = `${e.result === "success" ? "🎉" : "😿"} ${e.summary ?? "done"}`;
        this.agents.delete(e.id);
        break;
    }

    const li = document.createElement("li");
    const color = (ROLE_COLORS[agent.role] ?? 0xcccccc).toString(16).padStart(6, "0");
    li.innerHTML = `<span class="meta"><i style="background:#${color}"></i>${agent.repo} · ${agent.role}</span>`;
    const body = document.createElement("span");
    body.textContent = text;
    li.append(body);
    this.logEl.prepend(li);
    while (this.logEl.children.length > MAX_LOG) this.logEl.lastElementChild!.remove();
  }
}

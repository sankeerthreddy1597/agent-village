// The contract between agent runners (mock, Claude Code, Ollama) and the UI.
// Every character, cloud and animation in the village is driven by these events.

export type AgentRole = "lead" | "investigator" | "test-writer" | "fixer" | "reviewer" | (string & {});

export interface IssueRef {
  number: number;
  title: string;
  url?: string;
}

export type AgentEvent =
  | { type: "repo.added"; repo: string }
  | { type: "agent.spawned"; id: string; parentId?: string; repo: string; role: AgentRole; issue?: IssueRef }
  | { type: "agent.thought"; id: string; text: string }
  | { type: "agent.tool"; id: string; tool: string; summary: string }
  | { type: "agent.done"; id: string; result: "success" | "error"; summary?: string };

/** Messages the browser can send back to the server. */
export type ClientMessage = { type: "mock.trigger"; repo?: string };

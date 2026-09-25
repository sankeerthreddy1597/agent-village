import type { AgentEvent, AgentRole, IssueRef } from "@village/events";

// Fake GitHub activity so the UI can be built without spending tokens.
// Swap this for a real AgentRunner later — the events stay the same.

const REPOS = ["web-frontend", "payments-api", "auth-service", "notifications", "data-pipeline", "mobile-app"];

const ISSUES = [
  "Login button does nothing on Safari",
  "Checkout total is off by one cent",
  "Flaky test in UserService",
  "Memory leak in websocket handler",
  "Add dark mode to settings page",
  "Timeouts calling the payments provider",
  "Welcome email sent twice on signup",
  "Crash when uploading large images",
  "Slow query on /orders endpoint",
  "Push notifications arrive late on Android",
];

const KEYWORDS = ["handleSubmit", "retry", "useEffect", "calculateTotal", "sendEmail", "timeout", "cache", "session"];

const FILES = [
  "src/api/client.ts",
  "src/components/LoginForm.tsx",
  "src/services/user.ts",
  "src/utils/money.ts",
  "src/workers/email.ts",
  "src/db/queries.ts",
  "src/routes/orders.ts",
  "src/ws/handler.ts",
];

const FINDINGS = [
  "Found it — looks like a race condition",
  "Hmm, the retry has no backoff",
  "The listener is never removed 🤔",
  "Rounding happens before the tax step",
  "This query is missing an index",
  "The event fires twice on re-render",
];

const PLANS = [
  "Let me get a feel for the codebase",
  "This smells like a concurrency bug",
  "I think this lives in the service layer",
  "Let me check recent changes first",
];

type Step = { think: string } | { tool: string; summary: string };

const SCRIPTS: Record<string, () => Step[]> = {
  investigator: () => [
    { think: "Let me find where this happens" },
    { tool: "Grep", summary: `searching for "${pick(KEYWORDS)}"` },
    { tool: "Read", summary: `reading ${pick(FILES)}` },
    { tool: "Read", summary: `reading ${pick(FILES)}` },
    { think: pick(FINDINGS) },
  ],
  "test-writer": () => [
    { think: "I'll write a test that reproduces it" },
    { tool: "Read", summary: `reading ${pick(FILES).replace("src/", "tests/").replace(/\.tsx?$/, ".test.ts")}` },
    { tool: "Write", summary: "writing a failing test" },
    { tool: "Bash", summary: "running npm test" },
    { think: "Test fails as expected — good!" },
  ],
  fixer: () => [
    { think: "Working on a fix" },
    { tool: "Read", summary: `reading ${pick(FILES)}` },
    { tool: "Edit", summary: `editing ${pick(FILES)}` },
    { tool: "Edit", summary: `editing ${pick(FILES)}` },
    { tool: "Bash", summary: "running npm test" },
    { think: "All green! 🌱" },
  ],
  reviewer: () => [
    { think: "Reviewing the proposed changes" },
    { tool: "Bash", summary: "running git diff" },
    { tool: "Read", summary: `reading ${pick(FILES)}` },
    { think: "Looks good, one nit about naming" },
  ],
};

const SUB_ROLES: AgentRole[] = ["investigator", "test-writer", "fixer", "reviewer"];
const MAX_CONCURRENT_RUNS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (a: number, b: number) => a + Math.random() * (b - a);
function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}
function shuffle<T>(xs: readonly T[]): T[] {
  return [...xs].sort(() => Math.random() - 0.5);
}

export class MockVillage {
  private nextIssue = 101;
  private nextAgent = 1;
  private activeRuns = 0;
  /** Live agents, in spawn order, with their latest status — replayed to new clients. */
  private live = new Map<string, { spawned: AgentEvent; last?: AgentEvent }>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  snapshot(): AgentEvent[] {
    const repos: AgentEvent[] = REPOS.map((repo) => ({ type: "repo.added", repo }));
    const agents = [...this.live.values()].flatMap(({ spawned, last }) => (last ? [spawned, last] : [spawned]));
    return [...repos, ...agents];
  }

  start() {
    const tick = () => {
      if (this.activeRuns < MAX_CONCURRENT_RUNS) this.startIssue();
      setTimeout(tick, between(8000, 15000));
    };
    setTimeout(tick, 1500);
  }

  startIssue(repo = pick(REPOS)) {
    void this.runIssue(repo);
  }

  private send(event: AgentEvent) {
    if (event.type === "agent.spawned") this.live.set(event.id, { spawned: event });
    else if (event.type === "agent.done") this.live.delete(event.id);
    else if (event.type !== "repo.added") {
      const entry = this.live.get(event.id);
      if (entry) entry.last = event;
    }
    this.emit(event);
  }

  private async think(id: string, text: string) {
    this.send({ type: "agent.thought", id, text });
    await sleep(between(1800, 3200));
  }

  private async tool(id: string, tool: string, summary: string) {
    this.send({ type: "agent.tool", id, tool, summary });
    await sleep(between(2200, 3800));
  }

  private async runIssue(repo: string) {
    this.activeRuns++;
    const issue: IssueRef = { number: this.nextIssue++, title: pick(ISSUES) };
    const lead = `agent-${this.nextAgent++}`;

    this.send({ type: "agent.spawned", id: lead, repo, role: "lead", issue });
    await sleep(900);
    await this.think(lead, `Issue #${issue.number}: "${issue.title}"`);
    await this.think(lead, pick(PLANS));
    await this.tool(lead, "Grep", `searching for "${pick(KEYWORDS)}"`);
    await this.think(lead, "I'll split this up between some helpers");

    const roles = shuffle(SUB_ROLES).slice(0, 1 + Math.floor(Math.random() * 3));
    const helpers: Promise<void>[] = [];
    for (const role of roles) {
      helpers.push(this.runSubagent(repo, lead, role));
      await sleep(between(600, 1400));
    }
    this.send({ type: "agent.thought", id: lead, text: "Waiting on my helpers…" });
    await Promise.all(helpers);

    await this.think(lead, "Putting the findings together");
    await this.tool(lead, "Write", `drafting a comment on #${issue.number}`);
    const ok = Math.random() > 0.15;
    this.send({
      type: "agent.done",
      id: lead,
      result: ok ? "success" : "error",
      summary: ok ? `Posted analysis on #${issue.number}` : "Couldn't reproduce it 😿",
    });
    this.activeRuns--;
  }

  private async runSubagent(repo: string, parentId: string, role: AgentRole) {
    const id = `agent-${this.nextAgent++}`;
    this.send({ type: "agent.spawned", id, parentId, repo, role });
    await sleep(800);
    for (const step of SCRIPTS[role]()) {
      if ("think" in step) await this.think(id, step.think);
      else await this.tool(id, step.tool, step.summary);
    }
    this.send({ type: "agent.done", id, result: "success", summary: "Done!" });
  }
}

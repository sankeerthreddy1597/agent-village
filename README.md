# 🏘️ Agent Village

A three.js village where each floating island is a repository and each little person is an AI agent working on a GitHub issue. Lead agents spawn helper sub-agents, and every agent shows what it's doing in a thought cloud.

Right now it runs on a **mock event stream**. No GitHub or LLM needed.

## Run

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173. The mock server (ws://localhost:8787) starts a fake issue every ~10s, or click **✨ New mock issue**.

## Layout

```
packages/events   Shared AgentEvent types, the contract between runners and the UI
apps/server       WebSocket server + MockVillage (fake issues, leads, sub-agents)
apps/web          Vite + three.js world
  world.ts        scene, camera, island layout, event → character wiring, lead separation
  island.ts       rounded-square island, props (bookshelf / terminal / workbench) and helper desks
  character.ts    procedural cute agent + animations + thought cloud
  hud.ts          status, legend, activity log
```

## The event contract

```ts
{ type: "repo.added", repo }
{ type: "agent.spawned", id, parentId?, repo, role, issue? }
{ type: "agent.thought", id, text }
{ type: "agent.tool", id, tool, summary }   // leads walk to a prop (Read/Grep → bookshelf, Edit/Write → workbench, Bash → terminal); helpers work at their desk
{ type: "agent.done", id, result, summary? }
```

Anything that emits these events can drive the village.

## Next steps

1. **Claude Code runner**: use the Claude Agent SDK and map its streamed messages to `AgentEvent`s. Use `parent_tool_use_id` to link each sub-agent to its parent.
2. **GitHub webhook**: on `issues.opened`, verify the signature, create a worktree and start a run. Use `gh webhook forward` for local dev.
3. **Ollama runner**: same interface, backed by a local model.
4. **Safety**: only react to trusted authors or labels, sandbox the runs, and start with read-only tools.

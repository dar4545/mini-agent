# mini-agent

A minimal full-screen agentic chat webapp (dev/demo grade). The browser runs
the agent loop against any OpenAI-compatible endpoint; a thin stateless
Node.js backend (bare `node:http`, zero framework) proxies SSE chat streams
and bridges MCP servers (stdio + streamable HTTP).

## Run

Requires [Node.js](https://nodejs.org) 18+. Same commands on Windows, macOS,
and Linux:

```bash
npm install
npm start
```

Open http://localhost:8000, click the gear icon, and create a model profile
(base URL like `http://localhost:11434/v1` or `https://api.openai.com/v1`,
API key, model id). Profiles, sessions, and MCP server configs persist in
browser localStorage; the backend keeps no state besides live MCP connections.

## Features

- Agentic loop: streaming, function calling, tool results fed back until a
  final text answer (max 10 steps per turn, Stop button aborts)
- Built-in demo tools: `get_current_time`, `calculate`
- MCP servers via settings (stdio command or streamable HTTP URL); their tools
  are exposed to the model as `mcp__<serverId>__<tool>`
- File upload: images sent as base64 `image_url` parts, text files inlined
- Rendering: markdown (incl. tables), images, highlighted code with copy button,
  collapsible tool-call cards

## Extending

- How to add tools: `extending-tools.md`

## Legacy Python backend (Deprecated)

The original Python/FastAPI backend is archived in `backend_py/` and is no
longer maintained. Run it only if you know what you're doing:
`pip install -r backend_py/requirements.txt`, then
`uvicorn backend_py.main:app --port 8000`.

## Design docs

- Spec: `docs/superpowers/specs/2026-06-10-mini-agent-webapp-design.md`
- Plan (original, Python backend): `docs/superpowers/plans/2026-06-10-mini-agent-webapp.md`
- Plan (JS backend port): `docs/superpowers/plans/2026-06-10-js-backend-port.md`
- Background: `agentic-runtime-handbook.md`

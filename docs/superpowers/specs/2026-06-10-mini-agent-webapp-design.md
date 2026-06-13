# mini-agent: Agentic Chat Webapp — Design Spec

Date: 2026-06-10
Status: Approved by user
Scope: Dev/demo grade. Not production. No tests (no API keys available for live testing).

## 1. Purpose

A full-screen webapp with an agentic chat interface, built as a minimal demonstration
of the agentic runtime workflow described in `agentic-runtime-handbook.md`:
the browser runs an agent loop that streams model output from an OpenAI-compatible
endpoint, detects structured tool calls, executes tools (built-in or MCP), feeds
results back, and repeats until the model produces a plain final answer.

## 2. Requirements (user-stated)

1. Handling of OpenAI-compatible API requests
2. Function calling support
3. MCP support (stdio + streamable HTTP)
4. Session management
5. Agentic runtime
6. Settings menu to input endpoint information
7. Model profiles for easy switching between configured models
8. File upload, sent as base64-encoded data
9. Rendering: text, image, forms (markdown tables/lists), code blocks

Constraints: minimal implementation, no TDD/smoke tests, simple modern Gradio-like
UI, dev version only.

## 3. Decisions made with user

| Decision | Choice |
|---|---|
| Architecture | SPA + thin local backend |
| Stack | Python FastAPI backend + vanilla JS frontend (no build step) |
| Persistence | Browser localStorage only (backend stateless except live MCP connections) |
| "Form" rendering | Markdown tables/lists only — no interactive forms |
| MCP transports | stdio (spawn subprocess) + streamable HTTP |
| Streaming | Yes — SSE relayed through the backend proxy |
| Demo tools | 2 built-ins (`get_current_time`, `calculate`) so function calling works with zero MCP setup |
| Agent loop owner | Frontend drives the loop; backend is a dumb proxy + tool executor |

## 4. Architecture

```
Browser (owns all state + agent loop)          FastAPI backend (stateless bridge)
┌─────────────────────────────────┐            ┌──────────────────────────────┐
│ UI (Gradio-like, vanilla JS)    │            │ POST /api/chat   ── SSE ──▶  │──▶ OpenAI-compatible endpoint
│ Agent loop                      │ ──fetch──▶ │ POST /api/tools/call         │──▶ built-in tools
│ Session store (localStorage)    │            │ /api/mcp/servers (CRUD)      │──▶ MCP servers (stdio + HTTP)
└─────────────────────────────────┘            └──────────────────────────────┘
```

Principles (from the handbook):

- The renderer is an observer, not the loop. Turn completion is decided by the
  loop from finish reason / tool calls / step budget / abort signal.
- Tool calls are structured protocol fields (`delta.tool_calls`), never parsed
  from natural-language text.
- Streaming tool-call arguments are fragments; aggregate by `index` and parse
  JSON only when the step finishes.
- Every tool result is paired to its `tool_call_id`.

## 5. Components

### 5.1 Backend (Python, FastAPI) — stateless bridge

Files: `backend/main.py`, `backend/llm_proxy.py`, `backend/mcp_manager.py`,
`backend/builtin_tools.py`.

Endpoints:

- `POST /api/chat` — body: `{ base_url, api_key, model, messages, tools, params }`.
  Opens a streaming request to `{base_url}/chat/completions` via `httpx` with
  `stream: true` and relays the SSE bytes back to the browser unmodified.
  No conversation state is kept; the API key is passed per-request from the
  browser (it lives in localStorage, never on the backend).
- `POST /api/tools/call` — body: `{ source, server_id?, name, arguments }`.
  `source` is `"builtin"` or `"mcp"`. Returns `{ ok, result }` or `{ ok: false,
  error }`. Tool errors are returned as data (not HTTP errors) so the loop can
  feed them back to the model as tool results.
- `GET /api/mcp/servers` — list registered servers with connection status and
  their tool lists.
- `POST /api/mcp/servers` — body: `{ id, name, transport: "stdio"|"http",
  command?, args?, env?, url? }`. Connects and returns the discovered tools.
- `DELETE /api/mcp/servers/{id}` — disconnect and remove.
- Static file serving for `frontend/` at `/`.

MCP manager: holds live `ClientSession` connections in memory (process lifetime).
Each session runs in its own asyncio task (per official `mcp` SDK patterns —
verified via research subagent during planning). MCP server *configs* persist in
localStorage; on page load the frontend re-registers each one.

Built-in tools: `get_current_time` (no args) and `calculate` (one `expression`
arg, evaluated with a safe arithmetic-only evaluator — `ast.parse` whitelist,
not `eval`).

### 5.2 Frontend agent loop (`frontend/js/agent.js`)

Per turn:

1. Build the request: session messages + merged tool definitions (built-ins +
   all connected MCP tools, namespaced `mcp__{server}__{tool}` to avoid clashes)
   + active profile (base URL, key, model, params).
2. POST to `/api/chat`, read the SSE stream: append `delta.content` to the live
   message bubble; accumulate `delta.tool_calls[]` by `index` (id, name,
   argument string fragments); record `finish_reason`.
3. If `finish_reason == "tool_calls"` (or aggregated tool calls exist): parse
   each argument string with `JSON.parse` (parse failure → error tool result),
   render a tool-call card, call `POST /api/tools/call` sequentially, append the
   assistant message (with `tool_calls`) and one `role:"tool"` message per call
   (with matching `tool_call_id`) to the session, then loop to step 2.
4. Stop when: a step ends with no tool calls (final text), 10 steps are reached
   (error bubble), or the user presses Stop (AbortController cancels the fetch).
5. Persist the session to localStorage after every appended message.

### 5.3 Session store (`frontend/js/store.js`)

localStorage keys:

- `ma_sessions` — `[{ id, title, created_at, profile_id, messages: [...] }]`.
  Messages are stored in OpenAI Chat Completions wire format (including
  `tool_calls` and `role:"tool"` entries) so a session replays directly into
  the next request.
- `ma_profiles` — `[{ id, name, base_url, api_key, model, temperature, max_tokens }]`
- `ma_mcp_servers` — `[{ id, name, transport, command, args, env, url }]`
- `ma_active` — `{ session_id, profile_id }`

### 5.4 UI (`frontend/index.html`, `style.css`, `js/{app,render,settings,api}.js`)

Gradio-like full-screen layout:

- **Left sidebar:** "New chat" button, session list (switch / delete), active
  profile dropdown, gear icon for settings.
- **Main pane:** message thread; input bar with textarea, file-attach button,
  send button that becomes Stop while a turn is running.
- **Settings modal:** two tabs — *Profiles* (CRUD on model profiles) and
  *MCP Servers* (CRUD + connect status + discovered tool list).
- **Message rendering** (`render.js`): markdown via `marked` + `DOMPurify`
  (tables/lists cover "forms"); code blocks via `highlight.js` with a copy
  button; images rendered from uploaded previews and from data-URL/`http(s)`
  image URLs in content; tool calls as collapsible cards (name → pretty-printed
  args → result). CDN-loaded libraries, no build step.
- **File upload:** images → base64 data-URL `image_url` content parts; other
  text-like files → inlined as a text content part with a filename header.
  Soft cap ~10 MB per file.

## 6. Error handling (minimal by design)

- Proxy/network/HTTP errors → red error bubble in the thread; turn ends.
- Tool execution errors → returned as the tool result string so the model can
  react (per handbook §10).
- Malformed tool-call argument JSON → error tool result, not a crash.
- Max 10 steps per turn → error bubble noting the cap.

## 7. Out of scope

Auth, multi-user, database, streaming resume, context compaction, permission
gates, parallel tool execution, OpenAI Responses API support, Anthropic-native
protocol support, tests.

## 8. File layout

```
backend/
  main.py            # FastAPI app, routes, static serving
  llm_proxy.py       # /api/chat SSE relay
  mcp_manager.py     # MCP connection lifecycle + tool calls
  builtin_tools.py   # get_current_time, calculate
frontend/
  index.html
  style.css
  js/
    app.js           # bootstrapping, layout wiring, sidebar
    agent.js         # agent loop + SSE aggregation
    api.js           # fetch helpers for backend endpoints
    store.js         # localStorage persistence
    render.js        # message/markdown/code/image/tool-card rendering
    settings.js      # settings modal (profiles, MCP servers)
requirements.txt     # fastapi, uvicorn, httpx, mcp
README.md            # run instructions
```

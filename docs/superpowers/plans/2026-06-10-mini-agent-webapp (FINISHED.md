# mini-agent Webapp Implementation Plan (FINISHED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen agentic chat webapp — frontend-driven agent loop over an OpenAI-compatible API, with function calling, MCP (stdio + streamable HTTP), localStorage sessions/profiles, file upload as base64, and markdown/image/code rendering.

**Architecture:** Vanilla-JS SPA (no build step) owns all state and the agent loop; a stateless FastAPI backend relays SSE chat streams (`/api/chat`), executes tools (`/api/tools/call`), and manages live MCP connections (`/api/mcp/servers`). See spec: `docs/superpowers/specs/2026-06-10-mini-agent-webapp-design.md`.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, httpx, `mcp` SDK (verified against v1.27.2); frontend uses CDN-loaded `marked`, `DOMPurify`, `highlight.js`.

**Constraints (user-mandated):** NO tests, NO TDD, NO smoke tests (no API keys available). Verification is limited to syntax checks (`python3 -m py_compile`, `node --check`) and an import check. Dev/demo grade — keep everything minimal.

**Verified `mcp` SDK facts (v1.27.2, inspected from PyPI):**
- `from mcp import ClientSession, StdioServerParameters`; `from mcp.client.stdio import stdio_client`; `from mcp.client.streamable_http import streamablehttp_client`
- `StdioServerParameters(command, args, env, cwd, ...)`; `stdio_client(params)` yields `(read, write)`; `streamablehttp_client(url, headers=None, ...)` yields `(read, write, get_session_id)`
- `ClientSession(read, write)` → `await initialize()`; `list_tools()` → `.tools: [Tool(name, description, inputSchema, ...)]`; `call_tool(name, arguments)` → `CallToolResult(content, structuredContent, isError)`
- Transport context managers use anyio cancel scopes: they MUST be entered and exited in the SAME asyncio task. Hence the per-connection-task pattern in Task 3.

---

### Task 1: Scaffold

**Files:**
- Create: `requirements.txt`
- Create: `.gitignore`
- Create: `backend/__init__.py`

- [ ] **Step 1: Write `requirements.txt`**

```
fastapi
uvicorn[standard]
httpx
mcp
```

- [ ] **Step 2: Write `.gitignore`**

```
__pycache__/
*.pyc
.venv/
```

- [ ] **Step 3: Create empty `backend/__init__.py`**

```python
```

- [ ] **Step 4: Commit**

```bash
git add requirements.txt .gitignore backend/__init__.py
git commit -m "chore: scaffold project skeleton"
```

---

### Task 2: Built-in demo tools

**Files:**
- Create: `backend/builtin_tools.py`

- [ ] **Step 1: Write `backend/builtin_tools.py`**

Two zero-setup tools so function calling demos work without any MCP server.
`calculate` uses an `ast` whitelist evaluator — never `eval`.

```python
import ast
import datetime
import operator

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current date and time of the server, including timezone.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a basic arithmetic expression. Supports + - * / // % ** and parentheses.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Arithmetic expression, e.g. (2 + 3) * 4",
                    }
                },
                "required": ["expression"],
            },
        },
    },
]

_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _eval_node(node: ast.expr):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError("Only numbers and arithmetic operators are supported")


def calculate(expression: str):
    tree = ast.parse(expression, mode="eval")
    return _eval_node(tree.body)


def get_current_time() -> str:
    return datetime.datetime.now().astimezone().isoformat()


async def call_builtin(name: str, arguments: dict) -> str:
    if name == "get_current_time":
        return get_current_time()
    if name == "calculate":
        return str(calculate(str(arguments.get("expression", ""))))
    raise ValueError(f"Unknown builtin tool: {name}")
```

- [ ] **Step 2: Syntax check**

Run: `python3 -m py_compile backend/builtin_tools.py`
Expected: no output, exit 0

- [ ] **Step 3: Commit**

```bash
git add backend/builtin_tools.py
git commit -m "feat: built-in demo tools (get_current_time, calculate)"
```

---

### Task 3: MCP manager

**Files:**
- Create: `backend/mcp_manager.py`

- [ ] **Step 1: Write `backend/mcp_manager.py`**

Each connection lives in its own asyncio task because the mcp transports use
anyio cancel scopes that must be entered and exited in the same task. Calling
`session.call_tool(...)` from a different task (a FastAPI handler) is safe —
the session communicates over memory streams.

```python
import asyncio
from contextlib import AsyncExitStack
from datetime import timedelta

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client


class MCPConnection:
    def __init__(self, config: dict):
        self.config = config
        self.session: ClientSession | None = None
        self.tools: list[dict] = []
        self.error: str | None = None
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self):
        self._task = asyncio.create_task(self._run())
        await self._ready.wait()
        if self.error:
            raise RuntimeError(self.error)

    async def _run(self):
        try:
            async with AsyncExitStack() as stack:
                if self.config["transport"] == "stdio":
                    params = StdioServerParameters(
                        command=self.config["command"],
                        args=self.config.get("args") or [],
                        env=self.config.get("env") or None,
                    )
                    read, write = await stack.enter_async_context(stdio_client(params))
                else:
                    read, write, _ = await stack.enter_async_context(
                        streamablehttp_client(self.config["url"])
                    )
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                listed = await session.list_tools()
                self.tools = [
                    {
                        "name": t.name,
                        "description": t.description or "",
                        "inputSchema": t.inputSchema,
                    }
                    for t in listed.tools
                ]
                self.session = session
                self._ready.set()
                await self._stop.wait()
        except BaseException as e:  # noqa: BLE001 - report any startup failure to caller
            self.error = f"{type(e).__name__}: {e}"
        finally:
            self.session = None
            self._ready.set()

    async def stop(self):
        self._stop.set()
        if self._task:
            await asyncio.wait([self._task], timeout=10)


class MCPManager:
    def __init__(self):
        self.connections: dict[str, MCPConnection] = {}

    async def connect(self, config: dict) -> list[dict]:
        await self.disconnect(config["id"])
        conn = MCPConnection(config)
        await conn.start()
        self.connections[config["id"]] = conn
        return conn.tools

    async def disconnect(self, server_id: str):
        conn = self.connections.pop(server_id, None)
        if conn:
            await conn.stop()

    def list_servers(self) -> list[dict]:
        return [
            {
                "id": sid,
                "name": c.config.get("name", sid),
                "transport": c.config["transport"],
                "connected": c.session is not None,
                "tools": c.tools,
            }
            for sid, c in self.connections.items()
        ]

    async def call_tool(self, server_id: str, name: str, arguments: dict) -> str:
        conn = self.connections.get(server_id)
        if not conn or not conn.session:
            raise RuntimeError(f"MCP server not connected: {server_id}")
        result = await conn.session.call_tool(
            name, arguments, read_timeout_seconds=timedelta(seconds=60)
        )
        parts = []
        for block in result.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
            else:
                parts.append(block.model_dump_json())
        text = "\n".join(parts) or "(empty result)"
        if result.isError:
            raise RuntimeError(text)
        return text

    async def shutdown(self):
        for sid in list(self.connections):
            await self.disconnect(sid)
```

- [ ] **Step 2: Syntax check**

Run: `python3 -m py_compile backend/mcp_manager.py`
Expected: no output, exit 0

- [ ] **Step 3: Commit**

```bash
git add backend/mcp_manager.py
git commit -m "feat: MCP manager with per-connection-task lifecycle"
```

---

### Task 4: LLM proxy + FastAPI app

**Files:**
- Create: `backend/llm_proxy.py`
- Create: `backend/main.py`

- [ ] **Step 1: Write `backend/llm_proxy.py`**

Relays the upstream SSE byte stream verbatim. Upstream/connection errors are
emitted as a `proxy_error` SSE event so the frontend can render them.

```python
import json

import httpx
from fastapi.responses import StreamingResponse


def _error_event(message: str) -> bytes:
    return f"data: {json.dumps({'proxy_error': message})}\n\n".encode()


async def stream_chat(payload: dict) -> StreamingResponse:
    base_url = payload["base_url"].rstrip("/")
    headers = {"Content-Type": "application/json"}
    if payload.get("api_key"):
        headers["Authorization"] = f"Bearer {payload['api_key']}"

    body = {
        "model": payload["model"],
        "messages": payload["messages"],
        "stream": True,
    }
    if payload.get("tools"):
        body["tools"] = payload["tools"]
    for key in ("temperature", "max_tokens"):
        if payload.get(key) is not None:
            body[key] = payload[key]

    async def relay():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30)) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions", json=body, headers=headers
                ) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")
                        yield _error_event(f"Upstream {resp.status_code}: {detail[:2000]}")
                        return
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        except httpx.HTTPError as e:
            yield _error_event(f"Connection error: {e}")

    return StreamingResponse(relay(), media_type="text/event-stream")
```

- [ ] **Step 2: Write `backend/main.py`**

Tool and MCP-connect errors return `{"ok": false, "error": ...}` as data (HTTP
200) so the agent loop can feed them back to the model as tool results.

```python
import contextlib
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from . import builtin_tools
from .llm_proxy import stream_chat
from .mcp_manager import MCPManager

mcp_manager = MCPManager()


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await mcp_manager.shutdown()


app = FastAPI(lifespan=lifespan)


@app.post("/api/chat")
async def chat(request: Request):
    return await stream_chat(await request.json())


@app.get("/api/tools/builtin")
async def list_builtin_tools():
    return builtin_tools.TOOL_DEFINITIONS


@app.post("/api/tools/call")
async def call_tool(request: Request):
    payload = await request.json()
    try:
        if payload["source"] == "builtin":
            result = await builtin_tools.call_builtin(
                payload["name"], payload.get("arguments") or {}
            )
        else:
            result = await mcp_manager.call_tool(
                payload["server_id"], payload["name"], payload.get("arguments") or {}
            )
        return {"ok": True, "result": result}
    except Exception as e:  # noqa: BLE001 - tool errors go back to the model as data
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.get("/api/mcp/servers")
async def list_mcp_servers():
    return mcp_manager.list_servers()


@app.post("/api/mcp/servers")
async def connect_mcp_server(request: Request):
    config = await request.json()
    try:
        tools = await mcp_manager.connect(config)
        return {"ok": True, "tools": tools}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.delete("/api/mcp/servers/{server_id}")
async def disconnect_mcp_server(server_id: str):
    await mcp_manager.disconnect(server_id)
    return {"ok": True}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend", html=True),
    name="frontend",
)
```

- [ ] **Step 3: Syntax check**

Run: `python3 -m py_compile backend/llm_proxy.py backend/main.py`
Expected: no output, exit 0

- [ ] **Step 4: Commit**

```bash
git add backend/llm_proxy.py backend/main.py
git commit -m "feat: FastAPI app with SSE chat proxy, tool and MCP endpoints"
```

---

### Task 5: HTML shell + stylesheet

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/style.css`

- [ ] **Step 1: Write `frontend/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mini-agent</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <button id="new-chat-btn">+ New chat</button>
    <nav id="session-list"></nav>
    <footer id="sidebar-footer">
      <select id="profile-select" title="Active model profile"></select>
      <button id="settings-btn" title="Settings">&#9881;</button>
    </footer>
  </aside>
  <main id="chat">
    <div id="thread"></div>
    <div id="composer">
      <div id="attachments"></div>
      <div id="input-row">
        <button id="attach-btn" title="Attach files">&#128206;</button>
        <textarea id="input" rows="1" placeholder="Message&hellip;"></textarea>
        <button id="send-btn">Send</button>
      </div>
    </div>
  </main>
</div>

<dialog id="settings-modal">
  <header>
    <button class="tab active" data-tab="profiles">Profiles</button>
    <button class="tab" data-tab="mcp">MCP Servers</button>
    <button id="settings-close">&#10005;</button>
  </header>
  <section id="tab-profiles" class="tab-panel"></section>
  <section id="tab-mcp" class="tab-panel" hidden></section>
</dialog>

<input type="file" id="file-input" multiple hidden>

<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/highlight.min.js"></script>
<script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `frontend/style.css`**

Gradio-like: light neutral background, white rounded panels, orange accent.

```css
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 15px; color: #1f2937; background: #f7f7f8;
}

#app { display: flex; height: 100vh; }

/* ---- sidebar ---- */
#sidebar {
  width: 260px; flex-shrink: 0; display: flex; flex-direction: column;
  background: #ffffff; border-right: 1px solid #e5e7eb; padding: 12px;
}
#new-chat-btn {
  padding: 10px; border: 1px solid #e5e7eb; border-radius: 10px;
  background: #fff; cursor: pointer; font-weight: 600;
}
#new-chat-btn:hover { border-color: #ff7c00; color: #ff7c00; }
#session-list { flex: 1; overflow-y: auto; margin-top: 12px; }
.session-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 10px; border-radius: 8px; cursor: pointer;
  white-space: nowrap; overflow: hidden;
}
.session-item:hover { background: #f3f4f6; }
.session-item.active { background: #fff3e8; color: #c2410c; }
.session-item .del { border: none; background: none; cursor: pointer; color: #9ca3af; }
.session-item .del:hover { color: #dc2626; }
#sidebar-footer { display: flex; gap: 8px; }
#profile-select {
  flex: 1; padding: 8px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff;
}
#settings-btn {
  width: 38px; border: 1px solid #e5e7eb; border-radius: 8px;
  background: #fff; cursor: pointer; font-size: 16px;
}

/* ---- chat ---- */
#chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#thread { flex: 1; overflow-y: auto; padding: 24px 0; }
.msg { max-width: 760px; margin: 0 auto 16px; padding: 0 24px; }
.msg.user .md {
  background: #fff3e8; border-radius: 14px 14px 4px 14px;
  padding: 10px 14px; margin-left: auto; width: fit-content; max-width: 85%;
}
.msg.user img { display: block; max-width: 320px; border-radius: 10px; margin: 6px 0 6px auto; }
.msg.assistant .md {
  background: #ffffff; border: 1px solid #e5e7eb;
  border-radius: 14px 14px 14px 4px; padding: 10px 14px;
}
.msg.error .md { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
  border-radius: 10px; padding: 10px 14px; }
.md p:first-child { margin-top: 0; }
.md p:last-child { margin-bottom: 0; }
.md pre { position: relative; border-radius: 10px; overflow: hidden; }
.md pre code { display: block; padding: 12px; overflow-x: auto; }
.md table { border-collapse: collapse; }
.md th, .md td { border: 1px solid #e5e7eb; padding: 6px 10px; }
.md img { max-width: 100%; border-radius: 10px; }
.copy-btn {
  position: absolute; top: 6px; right: 6px; padding: 2px 8px; font-size: 12px;
  border: none; border-radius: 6px; background: rgba(255,255,255,.15);
  color: #e5e7eb; cursor: pointer;
}
.copy-btn:hover { background: rgba(255,255,255,.3); }

/* ---- tool cards ---- */
.tool-card, .tool-result {
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px;
  padding: 8px 12px; margin-top: 8px; font-size: 13px;
}
.tool-card summary, .tool-result summary { cursor: pointer; user-select: none; }
.tool-card pre, .tool-result pre {
  background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
  padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}
.tool-status { color: #6b7280; font-style: italic; }
.tool-card[data-status="running"] .tool-status { color: #d97706; }
.tool-card[data-status="error"] .tool-status { color: #dc2626; }

/* ---- composer ---- */
#composer {
  border-top: 1px solid #e5e7eb; background: #fff; padding: 12px 24px 16px;
}
#attachments { display: flex; gap: 8px; flex-wrap: wrap; max-width: 760px; margin: 0 auto; }
.attachment-chip {
  display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  background: #f3f4f6; border-radius: 999px; font-size: 13px; margin-bottom: 8px;
}
.attachment-chip button { border: none; background: none; cursor: pointer; color: #9ca3af; }
#input-row {
  display: flex; gap: 8px; align-items: flex-end; max-width: 760px; margin: 0 auto;
}
#input {
  flex: 1; resize: none; max-height: 180px; padding: 10px 14px; font: inherit;
  border: 1px solid #e5e7eb; border-radius: 12px; outline: none;
}
#input:focus { border-color: #ff7c00; }
#attach-btn, #send-btn {
  padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 12px;
  background: #fff; cursor: pointer; font-size: 15px;
}
#send-btn { background: #ff7c00; border-color: #ff7c00; color: #fff; font-weight: 600; }
#send-btn:hover { background: #ea580c; }

/* ---- settings modal ---- */
#settings-modal {
  width: 560px; max-width: 90vw; max-height: 85vh; border: none;
  border-radius: 14px; padding: 0; box-shadow: 0 20px 60px rgba(0,0,0,.2);
}
#settings-modal::backdrop { background: rgba(0,0,0,.35); }
#settings-modal header {
  display: flex; gap: 4px; padding: 12px 16px; border-bottom: 1px solid #e5e7eb;
}
#settings-modal .tab {
  padding: 8px 14px; border: none; border-radius: 8px; background: none;
  cursor: pointer; font-weight: 600; color: #6b7280;
}
#settings-modal .tab.active { background: #fff3e8; color: #c2410c; }
#settings-close { margin-left: auto; border: none; background: none; cursor: pointer; }
.tab-panel { padding: 16px; overflow-y: auto; }
.item-list { list-style: none; padding: 0; margin: 0 0 16px; }
.item-list li {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 8px;
  font-size: 13px;
}
.item-list button {
  padding: 4px 10px; border: 1px solid #e5e7eb; border-radius: 8px;
  background: #fff; cursor: pointer; font-size: 12px;
}
.tab-panel form { display: flex; flex-direction: column; gap: 10px; }
.tab-panel label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #6b7280; }
.tab-panel input, .tab-panel select {
  padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px; font: inherit;
}
.tab-panel form button[type="submit"] {
  padding: 10px; border: none; border-radius: 10px; background: #ff7c00;
  color: #fff; font-weight: 600; cursor: pointer;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: HTML shell and Gradio-like stylesheet"
```

---

### Task 6: localStorage store + backend API client

**Files:**
- Create: `frontend/js/store.js`
- Create: `frontend/js/api.js`

- [ ] **Step 1: Write `frontend/js/store.js`**

```js
const KEYS = {
  sessions: 'ma_sessions',
  profiles: 'ma_profiles',
  mcp: 'ma_mcp_servers',
  active: 'ma_active',
};

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function upsert(key, item) {
  const items = read(key, []);
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) items.unshift(item); else items[i] = item;
  write(key, items);
}
function remove(key, id) { write(key, read(key, []).filter((x) => x.id !== id)); }

export const store = {
  uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),

  getSessions: () => read(KEYS.sessions, []),
  getSession(id) { return this.getSessions().find((s) => s.id === id) ?? null; },
  saveSession: (session) => upsert(KEYS.sessions, session),
  deleteSession: (id) => remove(KEYS.sessions, id),

  getProfiles: () => read(KEYS.profiles, []),
  saveProfile: (profile) => upsert(KEYS.profiles, profile),
  deleteProfile: (id) => remove(KEYS.profiles, id),

  getMcpServers: () => read(KEYS.mcp, []),
  saveMcpServer: (cfg) => upsert(KEYS.mcp, cfg),
  deleteMcpServer: (id) => remove(KEYS.mcp, id),

  getActive: () => read(KEYS.active, {}),
  setActive(patch) { write(KEYS.active, { ...this.getActive(), ...patch }); },
};
```

- [ ] **Step 2: Write `frontend/js/api.js`**

`chatStream` parses the relayed SSE stream: splits on blank lines, handles
`[DONE]`, surfaces `proxy_error` / upstream `error` payloads as exceptions,
and forwards each `choices[0].delta` to the caller.

```js
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function postJson(url, body) {
  const resp = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`${url} failed: HTTP ${resp.status}`);
  return resp.json();
}

export const api = {
  callTool: (body) => postJson('/api/tools/call', body),
  listBuiltinTools: async () => (await fetch('/api/tools/builtin')).json(),
  listMcpServers: async () => (await fetch('/api/mcp/servers')).json(),
  connectMcpServer: (cfg) => postJson('/api/mcp/servers', cfg),
  disconnectMcpServer: async (id) =>
    (await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })).json(),
};

// Streams one chat-completion step. Calls onDelta(delta) per chunk.
// Resolves with the final finish_reason (string or null).
export async function chatStream(payload, onDelta, signal) {
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload), signal,
  });
  if (!resp.ok) throw new Error(`Chat request failed: HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return finishReason;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.proxy_error) throw new Error(parsed.proxy_error);
        if (parsed.error) {
          throw new Error(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta) onDelta(choice.delta);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }
  return finishReason;
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check frontend/js/store.js && node --check frontend/js/api.js`
Expected: exit 0 (skip silently if `node` is not installed)

- [ ] **Step 4: Commit**

```bash
git add frontend/js/store.js frontend/js/api.js
git commit -m "feat: localStorage store and backend API client with SSE parsing"
```

---

### Task 7: Agent loop

**Files:**
- Create: `frontend/js/agent.js`

- [ ] **Step 1: Write `frontend/js/agent.js`**

The handbook's loop: stream a step, aggregate `delta.tool_calls[]` by index
(arguments are string fragments — parse only after the step ends), execute
sequentially, append `role:"tool"` results paired by `tool_call_id`, repeat.
Tool presence is trusted over the `finish_reason` label, since some
OpenAI-compatible servers mislabel it.

```js
import { chatStream, api } from './api.js';

const MAX_STEPS = 10;

// Merges builtin tool definitions with tools from connected MCP servers.
// MCP tools are exposed to the model as "mcp__<serverId>__<tool>" (sanitized,
// max 64 chars per OpenAI naming rules); `index` routes a call back to its source.
export function buildToolset(builtinDefs, mcpServers) {
  const defs = [...builtinDefs];
  const index = {};
  for (const def of builtinDefs) {
    index[def.function.name] = { source: 'builtin', name: def.function.name };
  }
  for (const server of mcpServers) {
    if (!server.connected) continue;
    for (const tool of server.tools) {
      const exposed = `mcp__${server.id}__${tool.name}`
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      index[exposed] = { source: 'mcp', server_id: server.id, name: tool.name };
      defs.push({
        type: 'function',
        function: {
          name: exposed,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return { defs, index };
}

// Runs one agentic turn, mutating `messages` in place.
// ui: { onAssistantStart(), onTextDelta(text), onMessage(msg), onToolUpdate(call) }
export async function runTurn({ messages, profile, toolset, ui, signal }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const state = { text: '', toolCalls: [] };
    ui.onAssistantStart();

    await chatStream({
      base_url: profile.base_url,
      api_key: profile.api_key || null,
      model: profile.model,
      temperature: profile.temperature ?? null,
      max_tokens: profile.max_tokens ?? null,
      messages,
      tools: toolset.defs.length ? toolset.defs : null,
    }, (delta) => accumulate(state, delta, ui), signal);

    const toolCalls = state.toolCalls.filter(Boolean); // delta indexes can be sparse
    const assistantMsg = { role: 'assistant', content: state.text || null };

    if (toolCalls.length === 0) {
      messages.push(assistantMsg);
      ui.onMessage(assistantMsg);
      return;
    }

    assistantMsg.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }));
    messages.push(assistantMsg);
    ui.onMessage(assistantMsg);

    for (const call of toolCalls) {
      const content = await executeCall(call, toolset.index, ui);
      const toolMsg = { role: 'tool', tool_call_id: call.id, content };
      messages.push(toolMsg);
      ui.onMessage(toolMsg);
    }
  }
  throw new Error(`Stopped: reached the ${MAX_STEPS}-step limit for one turn.`);
}

function accumulate(state, delta, ui) {
  if (delta.content) {
    state.text += delta.content;
    ui.onTextDelta(delta.content);
  }
  for (const tc of delta.tool_calls ?? []) {
    const slot = (state.toolCalls[tc.index] ??= { id: '', name: '', arguments: '' });
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name = tc.function.name;
    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
  }
}

// Always resolves to a result string — errors become tool results so the
// model can react to them (handbook §10).
async function executeCall(call, index, ui) {
  ui.onToolUpdate({ ...call, status: 'running' });

  let args;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch (e) {
    return fail(call, ui, `Invalid tool arguments JSON: ${e.message}`);
  }

  const route = index[call.name];
  if (!route) return fail(call, ui, `Unknown tool: ${call.name}`);

  try {
    const resp = await api.callTool({ ...route, arguments: args });
    if (!resp.ok) return fail(call, ui, `Tool error: ${resp.error}`);
    ui.onToolUpdate({ ...call, status: 'done', result: resp.result });
    return resp.result;
  } catch (e) {
    return fail(call, ui, `Tool call failed: ${e.message}`);
  }
}

function fail(call, ui, message) {
  ui.onToolUpdate({ ...call, status: 'error', result: message });
  return message;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check frontend/js/agent.js`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add frontend/js/agent.js
git commit -m "feat: frontend agent loop with streaming tool-call aggregation"
```

---

### Task 8: Message rendering

**Files:**
- Create: `frontend/js/render.js`

- [ ] **Step 1: Write `frontend/js/render.js`**

`marked`, `DOMPurify`, and `hljs` are globals from the CDN scripts in
`index.html`. All model/markdown HTML passes through DOMPurify.

```js
marked.setOptions({ breaks: true });

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMarkdown(text) {
  const div = document.createElement('div');
  div.className = 'md';
  div.innerHTML = DOMPurify.sanitize(marked.parse(text ?? ''));
  for (const code of div.querySelectorAll('pre code')) {
    hljs.highlightElement(code);
    addCopyButton(code.parentElement);
  }
  return div;
}

function addCopyButton(pre) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.onclick = async () => {
    await navigator.clipboard.writeText(pre.querySelector('code').textContent);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  pre.appendChild(btn);
}

// Renders a stored message (also used when replaying a session from localStorage).
export function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;

  if (msg.role === 'user') {
    const parts = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : (msg.content ?? []);
    for (const part of parts) {
      if (part.type === 'text') div.appendChild(renderMarkdown(part.text));
      if (part.type === 'image_url') {
        const img = document.createElement('img');
        img.src = part.image_url.url;
        div.appendChild(img);
      }
    }
  } else if (msg.role === 'assistant') {
    if (msg.content) div.appendChild(renderMarkdown(msg.content));
    for (const tc of msg.tool_calls ?? []) {
      div.appendChild(toolCard({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    }
  } else if (msg.role === 'tool') {
    const details = document.createElement('details');
    details.className = 'tool-result';
    const summary = document.createElement('summary');
    summary.textContent = 'Tool result';
    const pre = document.createElement('pre');
    pre.textContent = msg.content;
    details.append(summary, pre);
    div.appendChild(details);
  }
  return div;
}

export function renderError(message) {
  const div = document.createElement('div');
  div.className = 'msg error';
  const inner = document.createElement('div');
  inner.className = 'md';
  inner.textContent = message;
  div.appendChild(inner);
  return div;
}

function toolCard(call) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  details.dataset.callId = call.id;
  details.dataset.status = call.status ?? '';

  const summary = document.createElement('summary');
  const name = document.createElement('code');
  name.textContent = call.name;
  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = call.status ?? '';
  summary.append(name, ' ', status);

  const args = document.createElement('pre');
  args.className = 'tool-args-pre';
  args.textContent = prettyJson(call.arguments);

  const result = document.createElement('pre');
  result.className = 'tool-result-pre';
  result.textContent = call.result ?? '';
  result.hidden = call.result == null;

  details.append(summary, args, result);
  return details;
}

// Creates or updates the live card for a tool call during a running turn.
export function updateToolCard(thread, call) {
  let card = thread.querySelector(`[data-call-id="${CSS.escape(call.id)}"]`);
  if (!card) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    card = toolCard(call);
    wrap.appendChild(card);
    thread.appendChild(wrap);
  }
  card.dataset.status = call.status ?? '';
  card.querySelector('.tool-status').textContent = call.status ?? '';
  if (call.result != null) {
    const pre = card.querySelector('.tool-result-pre');
    pre.textContent = call.result;
    pre.hidden = false;
  }
}

function prettyJson(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw ?? ''; }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check frontend/js/render.js`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add frontend/js/render.js
git commit -m "feat: markdown/image/code/tool-card message rendering"
```

---

### Task 9: Settings modal

**Files:**
- Create: `frontend/js/settings.js`

- [ ] **Step 1: Write `frontend/js/settings.js`**

```js
import { store } from './store.js';
import { api } from './api.js';
import { esc } from './render.js';

export function initSettings({ onProfilesChanged }) {
  const modal = document.getElementById('settings-modal');

  document.getElementById('settings-btn').onclick = () => {
    renderProfiles();
    renderMcp();
    modal.showModal();
  };
  document.getElementById('settings-close').onclick = () => modal.close();

  for (const tab of modal.querySelectorAll('.tab')) {
    tab.onclick = () => {
      modal.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.getElementById('tab-profiles').hidden = tab.dataset.tab !== 'profiles';
      document.getElementById('tab-mcp').hidden = tab.dataset.tab !== 'mcp';
    };
  }

  function renderProfiles() {
    const panel = document.getElementById('tab-profiles');
    const profiles = store.getProfiles();
    panel.innerHTML = `
      <ul class="item-list">${profiles.map((p) => `
        <li data-id="${esc(p.id)}">
          <span><strong>${esc(p.name)}</strong> &mdash; ${esc(p.model)} @ ${esc(p.base_url)}</span>
          <span>
            <button class="edit-profile">Edit</button>
            <button class="del-profile">Delete</button>
          </span>
        </li>`).join('')}
      </ul>
      <form id="profile-form">
        <input type="hidden" name="id">
        <label>Name <input name="name" required placeholder="local-llama"></label>
        <label>Base URL <input name="base_url" required placeholder="http://localhost:11434/v1"></label>
        <label>API key <input name="api_key" type="password" placeholder="sk-... (optional)"></label>
        <label>Model <input name="model" required placeholder="llama3.1"></label>
        <label>Temperature <input name="temperature" type="number" step="0.1" min="0" max="2"></label>
        <label>Max tokens <input name="max_tokens" type="number" min="1"></label>
        <button type="submit">Save profile</button>
      </form>`;

    panel.querySelector('#profile-form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      store.saveProfile({
        id: f.get('id') || store.uid(),
        name: f.get('name'),
        base_url: f.get('base_url'),
        api_key: f.get('api_key'),
        model: f.get('model'),
        temperature: f.get('temperature') ? Number(f.get('temperature')) : null,
        max_tokens: f.get('max_tokens') ? Number(f.get('max_tokens')) : null,
      });
      renderProfiles();
      onProfilesChanged();
    };

    for (const btn of panel.querySelectorAll('.edit-profile')) {
      btn.onclick = () => {
        const p = profiles.find((x) => x.id === btn.closest('li').dataset.id);
        const form = panel.querySelector('#profile-form');
        for (const k of ['id', 'name', 'base_url', 'api_key', 'model', 'temperature', 'max_tokens']) {
          form.elements[k].value = p[k] ?? '';
        }
      };
    }
    for (const btn of panel.querySelectorAll('.del-profile')) {
      btn.onclick = () => {
        store.deleteProfile(btn.closest('li').dataset.id);
        renderProfiles();
        onProfilesChanged();
      };
    }
  }

  async function renderMcp() {
    const panel = document.getElementById('tab-mcp');
    const stored = store.getMcpServers();
    const live = await api.listMcpServers().catch(() => []);
    const liveById = Object.fromEntries(live.map((s) => [s.id, s]));

    panel.innerHTML = `
      <ul class="item-list">${stored.map((s) => {
        const conn = liveById[s.id];
        const status = conn?.connected ? `connected, ${conn.tools.length} tools` : 'disconnected';
        return `
        <li data-id="${esc(s.id)}">
          <span><strong>${esc(s.name)}</strong> (${esc(s.transport)}) &mdash; ${status}</span>
          <span>
            <button class="connect-mcp">Connect</button>
            <button class="del-mcp">Delete</button>
          </span>
        </li>`;
      }).join('')}
      </ul>
      <form id="mcp-form">
        <label>Name <input name="name" required placeholder="filesystem"></label>
        <label>Transport
          <select name="transport">
            <option value="stdio">stdio</option>
            <option value="http">streamable HTTP</option>
          </select>
        </label>
        <label>Command (stdio) <input name="command" placeholder="npx"></label>
        <label>Args (stdio, space-separated)
          <input name="args" placeholder="-y @modelcontextprotocol/server-filesystem /tmp"></label>
        <label>URL (HTTP) <input name="url" placeholder="http://localhost:8931/mcp"></label>
        <button type="submit">Add &amp; connect</button>
        <p id="mcp-status"></p>
      </form>`;

    panel.querySelector('#mcp-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const cfg = {
        id: store.uid(),
        name: f.get('name'),
        transport: f.get('transport'),
        command: f.get('command') || null,
        args: (f.get('args') || '').split(/\s+/).filter(Boolean),
        url: f.get('url') || null,
      };
      store.saveMcpServer(cfg);
      const status = panel.querySelector('#mcp-status');
      status.textContent = 'Connecting…';
      const resp = await api.connectMcpServer(cfg).catch((err) => ({ ok: false, error: err.message }));
      if (!resp.ok) {
        status.textContent = `Failed: ${resp.error}`;
        return;
      }
      renderMcp();
    };

    for (const btn of panel.querySelectorAll('.connect-mcp')) {
      btn.onclick = async () => {
        const cfg = stored.find((x) => x.id === btn.closest('li').dataset.id);
        await api.connectMcpServer(cfg).catch(() => {});
        renderMcp();
      };
    }
    for (const btn of panel.querySelectorAll('.del-mcp')) {
      btn.onclick = async () => {
        const id = btn.closest('li').dataset.id;
        await api.disconnectMcpServer(id).catch(() => {});
        store.deleteMcpServer(id);
        renderMcp();
      };
    }
  }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check frontend/js/settings.js`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add frontend/js/settings.js
git commit -m "feat: settings modal for model profiles and MCP servers"
```

---

### Task 10: App bootstrap

**Files:**
- Create: `frontend/js/app.js`

- [ ] **Step 1: Write `frontend/js/app.js`**

Wires everything: sidebar, composer, attachments (images → base64 data URLs,
other files → inlined text), Send/Stop toggle, live streaming bubble, and
re-registration of stored MCP servers with the stateless backend on load.

```js
import { store } from './store.js';
import { api } from './api.js';
import { buildToolset, runTurn } from './agent.js';
import { renderMessage, renderMarkdown, renderError, updateToolCard } from './render.js';
import { initSettings } from './settings.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const el = (id) => document.getElementById(id);

let builtinDefs = [];
let attachments = []; // { name, dataUrl? (images), text? (other files) }
let abortController = null;

async function boot() {
  builtinDefs = await api.listBuiltinTools().catch(() => []);
  initSettings({ onProfilesChanged: renderProfileSelect });
  renderProfileSelect();
  renderSessionList();
  renderThread();

  // The backend is stateless across restarts; re-register stored MCP servers.
  for (const cfg of store.getMcpServers()) {
    api.connectMcpServer(cfg).catch(() => {});
  }

  el('new-chat-btn').onclick = () => {
    store.setActive({ session_id: null });
    renderSessionList();
    renderThread();
  };
  el('send-btn').onclick = onSend;
  el('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  el('attach-btn').onclick = () => el('file-input').click();
  el('file-input').onchange = onFilesPicked;
  el('profile-select').onchange = () => store.setActive({ profile_id: el('profile-select').value });
}

function renderProfileSelect() {
  const select = el('profile-select');
  const profiles = store.getProfiles();
  const active = store.getActive().profile_id;
  select.innerHTML = profiles.length
    ? profiles.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')
    : '<option value="">No profiles — open settings</option>';
  if (profiles.some((p) => p.id === active)) select.value = active;
  else if (profiles.length) store.setActive({ profile_id: profiles[0].id });
}

function renderSessionList() {
  const nav = el('session-list');
  const active = store.getActive().session_id;
  nav.replaceChildren(...store.getSessions().map((s) => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === active ? ' active' : '');
    const title = document.createElement('span');
    title.textContent = s.title;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.onclick = (e) => {
      e.stopPropagation();
      store.deleteSession(s.id);
      if (store.getActive().session_id === s.id) store.setActive({ session_id: null });
      renderSessionList();
      renderThread();
    };
    item.onclick = () => {
      store.setActive({ session_id: s.id });
      renderSessionList();
      renderThread();
    };
    item.append(title, del);
    return item;
  }));
}

function renderThread() {
  const thread = el('thread');
  const session = store.getSession(store.getActive().session_id);
  thread.replaceChildren(...(session?.messages ?? []).map(renderMessage));
  scrollDown();
}

function scrollDown() {
  const thread = el('thread');
  thread.scrollTop = thread.scrollHeight;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function onFilesPicked(e) {
  for (const file of e.target.files) {
    if (file.size > MAX_FILE_BYTES) {
      alert(`${file.name} is over 10 MB, skipped.`);
      continue;
    }
    if (file.type.startsWith('image/')) {
      attachments.push({ name: file.name, dataUrl: await readAsDataUrl(file) });
    } else {
      attachments.push({ name: file.name, text: await file.text() });
    }
  }
  e.target.value = '';
  renderAttachments();
}

function renderAttachments() {
  el('attachments').replaceChildren(...attachments.map((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = a.name;
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    chip.append(label, remove);
    return chip;
  }));
}

function buildUserMessage(text, files) {
  if (files.length === 0) return { role: 'user', content: text };
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const f of files) {
    if (f.dataUrl) parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
    else parts.push({ type: 'text', text: `[file: ${f.name}]\n${f.text}` });
  }
  return { role: 'user', content: parts };
}

async function onSend() {
  if (abortController) { abortController.abort(); return; }

  const text = el('input').value.trim();
  if (!text && attachments.length === 0) return;

  const profile = store.getProfiles().find((p) => p.id === store.getActive().profile_id);
  if (!profile) { alert('Configure a model profile in Settings first.'); return; }

  let session = store.getSession(store.getActive().session_id);
  if (!session) {
    session = {
      id: store.uid(),
      title: (text || attachments[0]?.name || 'New chat').slice(0, 40),
      created_at: new Date().toISOString(),
      messages: [],
    };
    store.setActive({ session_id: session.id });
  }

  session.messages.push(buildUserMessage(text, attachments));
  store.saveSession(session);
  attachments = [];
  renderAttachments();
  el('input').value = '';
  renderSessionList();
  renderThread();

  const mcpServers = await api.listMcpServers().catch(() => []);
  const toolset = buildToolset(builtinDefs, mcpServers);

  abortController = new AbortController();
  el('send-btn').textContent = 'Stop';

  const thread = el('thread');
  let liveBubble = null;
  let liveText = '';

  const ui = {
    onAssistantStart() {
      liveText = '';
      liveBubble = document.createElement('div');
      liveBubble.className = 'msg assistant';
      thread.appendChild(liveBubble);
      scrollDown();
    },
    onTextDelta(textDelta) {
      liveText += textDelta;
      liveBubble.replaceChildren(renderMarkdown(liveText));
      scrollDown();
    },
    onMessage(msg) {
      store.saveSession(session);
      if (msg.role === 'assistant') {
        liveBubble?.remove();
        liveBubble = null;
        thread.appendChild(renderMessage(msg));
      }
      // role:"tool" results are already shown live via onToolUpdate.
      scrollDown();
    },
    onToolUpdate(call) {
      updateToolCard(thread, call);
      scrollDown();
    },
  };

  try {
    await runTurn({ messages: session.messages, profile, toolset, ui, signal: abortController.signal });
  } catch (e) {
    liveBubble?.remove();
    thread.appendChild(renderError(e.name === 'AbortError' ? 'Stopped by user.' : e.message));
    scrollDown();
  } finally {
    abortController = null;
    el('send-btn').textContent = 'Send';
    store.saveSession(session);
  }
}

boot();
```

- [ ] **Step 2: Syntax check**

Run: `node --check frontend/js/app.js`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat: app bootstrap wiring sidebar, composer, attachments, agent turn"
```

---

### Task 11: README + import verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# mini-agent

A minimal full-screen agentic chat webapp (dev/demo grade). The browser runs
the agent loop against any OpenAI-compatible endpoint; a thin stateless
FastAPI backend proxies SSE chat streams and bridges MCP servers
(stdio + streamable HTTP).

## Run

​```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn backend.main:app --port 8000
​```

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

## Design docs

- Spec: `docs/superpowers/specs/2026-06-10-mini-agent-webapp-design.md`
- Plan: `docs/superpowers/plans/2026-06-10-mini-agent-webapp.md`
- Background: `agentic-runtime-handbook.md`
```

(Remove the zero-width characters before the code fences — they are only there to nest the fence in this plan.)

- [ ] **Step 2: Verify the backend imports cleanly**

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -c "import backend.main; print('imports OK')"
```

Expected: `imports OK`. This is a syntax/wiring check only — no server is
started and no network calls are made (per the no-smoke-test constraint).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with run instructions"
```

---

## Execution notes

- Execute tasks in order; Tasks 5–10 depend on the HTML element ids defined in Task 5 and the module exports defined in Tasks 6–9.
- Cross-module contract summary (keep consistent if anything is renamed):
  - `store`: `uid, getSessions, getSession, saveSession, deleteSession, getProfiles, saveProfile, deleteProfile, getMcpServers, saveMcpServer, deleteMcpServer, getActive, setActive`
  - `api`: `callTool, listBuiltinTools, listMcpServers, connectMcpServer, disconnectMcpServer` + `chatStream(payload, onDelta, signal)`
  - `agent`: `buildToolset(builtinDefs, mcpServers) -> {defs, index}`, `runTurn({messages, profile, toolset, ui, signal})`
  - `render`: `esc, renderMarkdown, renderMessage, renderError, updateToolCard`
  - `settings`: `initSettings({onProfilesChanged})`
  - Backend tool-call request shape: `{source: "builtin"|"mcp", server_id?, name, arguments}` → `{ok, result|error}`
- No tests anywhere, per user constraint. Do not add them.

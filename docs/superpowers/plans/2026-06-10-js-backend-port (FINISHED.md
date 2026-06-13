# JS Backend Port Implementation Plan (FINISHED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python/FastAPI backend with an equivalent JavaScript backend (bare `node:http`, zero framework), archiving the Python code as `backend_py/` and updating all docs.

**Architecture:** The frontend talks to the backend only through 6 same-origin HTTP endpoints (`frontend/js/api.js`), so the port preserves the exact API contract — request/response shapes, SSE relay format, and the `{ok, result|error}` tool-call envelope — and the frontend needs **zero code changes**. New `backend_js/` mirrors the four Python modules one-to-one: `server.js` (routing + static + lifecycle ⇔ `main.py`), `llm_proxy.js` (SSE passthrough ⇔ `llm_proxy.py`), `mcp_manager.js` (MCP client ⇔ `mcp_manager.py`), `builtin_tools.js` (tools ⇔ `builtin_tools.py`). The only non-mechanical port is `calculate`: Python used an `ast` whitelist; JS has no equivalent, so it gets a hand-written tokenizer + recursive-descent parser with the same defenses (char whitelist, length cap, pow caps, Python operator semantics).

**Tech Stack:** Node.js ≥ 18 (native `fetch` with streaming bodies), bare `node:http`, ESM modules, single dependency `@modelcontextprotocol/sdk`. No TypeScript, no build step.

**Project constraints (override skill defaults):**
- **NO test suite / TDD** — this project has no tests by explicit user instruction (no API keys available). Verify with `node --check`, targeted `node -e` snippets, and local `curl` against endpoints that need no LLM key.
- **No Co-Authored-By trailers** in commits.
- User runs on **Windows**; docs must use Windows-first commands (`npm` commands are identical cross-platform, which simplifies the README).

**API contract being preserved (from `backend_py`):**

| Endpoint | Method | Behavior |
|---|---|---|
| `/api/chat` | POST | SSE relay to `{base_url}/chat/completions`; upstream/connection errors emitted as `data: {"proxy_error": "..."}` events, always HTTP 200 |
| `/api/tools/builtin` | GET | JSON array `TOOL_DEFINITIONS` |
| `/api/tools/call` | POST | `{source, name, arguments, server_id?}` → `{ok:true, result}` or `{ok:false, error:"Name: msg"}`, always HTTP 200 |
| `/api/mcp/servers` | GET | `[{id, name, transport, connected, tools}]` |
| `/api/mcp/servers` | POST | config `{id, name, transport, command/args/env or url}` → `{ok:true, tools}` or `{ok:false, error}` |
| `/api/mcp/servers/{id}` | DELETE | `{ok:true}` |
| `/` (everything else) | GET | static files from `frontend/`, `/` → `index.html`, 404 otherwise |

---

### Task 0: Feature branch

**Files:** none

- [ ] **Step 1: Create branch**

```bash
git checkout -b port-backend-js
```

### Task 1: Archive Python backend as `backend_py/`

**Files:**
- Move: `backend/` → `backend_py/` (all four `.py` files + `__init__.py`)
- Move: `requirements.txt` → `backend_py/requirements.txt`

- [ ] **Step 1: Move with git so history follows**

```bash
git mv backend backend_py
git mv requirements.txt backend_py/requirements.txt
rm -rf backend_py/__pycache__
```

The package uses only relative imports (`from . import builtin_tools`), so it stays runnable as `uvicorn backend_py.main:app` with no source edits.

- [ ] **Step 2: Verify it still compiles**

```bash
python3 -m py_compile backend_py/main.py backend_py/llm_proxy.py backend_py/mcp_manager.py backend_py/builtin_tools.py
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: archive Python backend as backend_py"
```

### Task 2: Scaffold Node project

**Files:**
- Create: `package.json` (repo root)
- Create: `.gitignore` (repo root)
- Create: `backend_js/` directory

- [ ] **Step 1: Check Node availability**

```bash
node --version && npm --version
```

Expected: Node ≥ 18. If missing in WSL, stop and ask the user.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "mini-agent",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Minimal agentic chat webapp: vanilla JS frontend + bare node:http backend",
  "scripts": {
    "start": "node backend_js/server.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```gitignore
node_modules/
__pycache__/
.venv/
```

- [ ] **Step 4: Install dependency**

```bash
npm install
```

Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold Node project for JS backend"
```

### Task 3: `backend_js/builtin_tools.js`

**Files:**
- Create: `backend_js/builtin_tools.js`

Port of `backend_py/builtin_tools.py`. `TOOL_DEFINITIONS` is byte-identical JSON. `calculate` keeps all four defenses (raw-string char whitelist → reject before parse; 200-char cap; pow base/exponent caps; numbers-only grammar) but swaps Python's `ast` whitelist for a hand-written tokenizer + recursive-descent parser with Python's grammar and operator semantics (`//` = floor div, `%` = sign-of-divisor modulo, `**` right-assoc with `-2**2 === -4`). Division/mod by zero throws (JS would silently give `Infinity`/`NaN`).

- [ ] **Step 1: Write the file**

```js
const ALLOWED_CHARS = /^[\d\s.+\-*/%()]+$/;
const MAX_EXPR_LEN = 200;
// Cap exponentiation: even pure-arithmetic input like 9**9**9 can exhaust CPU/memory.
const MAX_POW_BASE = 1_000_000;
const MAX_POW_EXP = 100;

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time of the server, including timezone.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a basic arithmetic expression. Supports + - * / // % ** and parentheses.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Arithmetic expression, e.g. (2 + 3) * 4',
          },
        },
        required: ['expression'],
      },
    },
  },
];

function tokenize(expression) {
  const tokens = [];
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < expression.length && ((expression[j] >= '0' && expression[j] <= '9') || expression[j] === '.')) j += 1;
      const text = expression.slice(i, j);
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) throw new Error(`Invalid number: ${text}`);
      tokens.push({ type: 'number', value: Number(text) });
      i = j;
      continue;
    }
    if (c === '*' && expression[i + 1] === '*') {
      tokens.push({ type: '**' });
      i += 2;
      continue;
    }
    if (c === '/' && expression[i + 1] === '/') {
      tokens.push({ type: '//' });
      i += 2;
      continue;
    }
    if ('+-*/%()'.includes(c)) {
      tokens.push({ type: c });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character: ${c}`);
  }
  return tokens;
}

// Grammar (matches Python precedence and associativity):
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/' | '//' | '%') factor)*
//   factor := ('+' | '-') factor | power          -- so -2**2 === -(2**2) === -4
//   power  := atom ('**' factor)?                 -- right-assoc; exponent may be signed
//   atom   := number | '(' expr ')'
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  take(type) {
    const tok = this.tokens[this.pos];
    if (!tok || (type && tok.type !== type)) {
      throw new Error('Only numbers and arithmetic operators are supported');
    }
    this.pos += 1;
    return tok;
  }

  parseExpr() {
    let value = this.parseTerm();
    while (this.peek() && (this.peek().type === '+' || this.peek().type === '-')) {
      const op = this.take().type;
      const rhs = this.parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  parseTerm() {
    let value = this.parseFactor();
    while (this.peek() && ['*', '/', '//', '%'].includes(this.peek().type)) {
      const op = this.take().type;
      const rhs = this.parseFactor();
      if (rhs === 0 && op !== '*') throw new Error('Division by zero');
      if (op === '*') value *= rhs;
      else if (op === '/') value /= rhs;
      else if (op === '//') value = Math.floor(value / rhs);
      else value = value - Math.floor(value / rhs) * rhs; // Python-style modulo: sign of divisor
    }
    return value;
  }

  parseFactor() {
    if (this.peek() && (this.peek().type === '+' || this.peek().type === '-')) {
      const op = this.take().type;
      const value = this.parseFactor();
      return op === '-' ? -value : value;
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parseAtom();
    if (this.peek() && this.peek().type === '**') {
      this.take();
      const exponent = this.parseFactor();
      if (Math.abs(exponent) > MAX_POW_EXP || Math.abs(base) > MAX_POW_BASE) {
        throw new Error('Exponent or base too large');
      }
      return base ** exponent;
    }
    return base;
  }

  parseAtom() {
    const tok = this.peek();
    if (tok && tok.type === 'number') {
      this.take();
      return tok.value;
    }
    if (tok && tok.type === '(') {
      this.take();
      const value = this.parseExpr();
      this.take(')');
      return value;
    }
    throw new Error('Only numbers and arithmetic operators are supported');
  }
}

export function calculate(expression) {
  expression = String(expression).trim();
  if (!expression) throw new Error('Empty expression');
  if (expression.length > MAX_EXPR_LEN) throw new Error('Expression too long');
  if (!ALLOWED_CHARS.test(expression)) {
    throw new Error('Only numbers and the operators + - * / // % ** ( ) are allowed');
  }
  const parser = new Parser(tokenize(expression));
  const value = parser.parseExpr();
  if (parser.pos !== parser.tokens.length) {
    throw new Error('Only numbers and arithmetic operators are supported');
  }
  if (!Number.isFinite(value)) throw new Error('Result is not a finite number');
  return value;
}

export function getCurrentTime() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export async function callBuiltin(name, args) {
  if (name === 'get_current_time') return getCurrentTime();
  if (name === 'calculate') return String(calculate(String(args.expression ?? '')));
  throw new Error(`Unknown builtin tool: ${name}`);
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check backend_js/builtin_tools.js
```

Expected: no output.

- [ ] **Step 3: Behavior check (good and hostile inputs)**

```bash
node -e "
import('./backend_js/builtin_tools.js').then(({ calculate }) => {
  const ok = (e) => { try { return calculate(e); } catch (err) { return 'REJECTED: ' + err.message; } };
  console.log('(2+3)*4 =', ok('(2+3)*4'));        // 20
  console.log('2**10 =', ok('2**10'));            // 1024
  console.log('-2**2 =', ok('-2**2'));            // -4 (Python semantics)
  console.log('7//2 =', ok('7//2'));              // 3
  console.log('-7%3 =', ok('-7%3'));              // 2 (Python semantics)
  console.log('9**9**9 =', ok('9**9**9'));        // REJECTED (pow cap)
  console.log('1/0 =', ok('1/0'));                // REJECTED (div by zero)
  console.log('__import__ =', ok('__import__(\"os\")')); // REJECTED (chars)
  console.log('a+1 =', ok('a+1'));                // REJECTED (chars)
  console.log('()() =', ok('()()'));              // REJECTED (grammar)
});
"
```

Expected: first five compute, last five all `REJECTED`.

- [ ] **Step 4: Commit**

```bash
git add backend_js/builtin_tools.js
git commit -m "feat: JS built-in tools with safe arithmetic parser"
```

### Task 4: `backend_js/llm_proxy.js`

**Files:**
- Create: `backend_js/llm_proxy.js`

Port of `backend_py/llm_proxy.py`. Same behavior: always responds 200 `text/event-stream`; non-200 upstream → single `proxy_error` event with first 2000 chars of detail; connection failure → `proxy_error` event. Client disconnect aborts the upstream fetch. Node ≥ 18 `fetch` bodies are async-iterable web streams, so the relay is a `for await` loop.

- [ ] **Step 1: Write the file**

```js
function errorEvent(message) {
  return `data: ${JSON.stringify({ proxy_error: message })}\n\n`;
}

export async function streamChat(payload, res) {
  const baseUrl = String(payload.base_url || '').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (payload.api_key) headers.Authorization = `Bearer ${payload.api_key}`;

  const body = {
    model: payload.model,
    messages: payload.messages,
    stream: true,
  };
  if (payload.tools) body.tools = payload.tools;
  for (const key of ['temperature', 'max_tokens']) {
    if (payload[key] !== undefined && payload[key] !== null) body[key] = payload[key];
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const timeout = setTimeout(() => controller.abort(), 300_000);

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (resp.status !== 200) {
      const detail = await resp.text();
      res.end(errorEvent(`Upstream ${resp.status}: ${detail.slice(0, 2000)}`));
      return;
    }
    for await (const chunk of resp.body) {
      res.write(chunk);
    }
    res.end();
  } catch (e) {
    if (!res.writableEnded) {
      res.end(errorEvent(`Connection error: ${e.message || e}`));
    }
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check backend_js/llm_proxy.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend_js/llm_proxy.js
git commit -m "feat: JS SSE chat proxy"
```

### Task 5: `backend_js/mcp_manager.js`

**Files:**
- Create: `backend_js/mcp_manager.js`

Port of `backend_py/mcp_manager.py` using the official JS SDK. The Python version needed a background task + events because the Python SDK is context-manager-based; the JS SDK is plain async objects, so the manager is much simpler — no task juggling. Same surface: `connect(config)` (replaces an existing connection with the same id), `disconnect(id)`, `listServers()`, `callTool(serverId, name, args)` (60s timeout, text blocks joined with `\n`, `(empty result)` fallback, `isError` → throw), `shutdown()`.

- [ ] **Step 1: Write the file**

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class MCPManager {
  constructor() {
    this.connections = new Map(); // id -> { config, client, tools }
  }

  async connect(config) {
    await this.disconnect(config.id);
    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args || [],
            env: config.env || undefined,
          })
        : new StreamableHTTPClientTransport(new URL(config.url));
    const client = new Client({ name: 'mini-agent', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema,
    }));
    this.connections.set(config.id, { config, client, tools });
    return tools;
  }

  async disconnect(serverId) {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.connections.delete(serverId);
    try {
      await conn.client.close();
    } catch {
      // already dead; nothing to clean up
    }
  }

  listServers() {
    return [...this.connections.entries()].map(([id, c]) => ({
      id,
      name: c.config.name || id,
      transport: c.config.transport,
      connected: true,
      tools: c.tools,
    }));
  }

  async callTool(serverId, name, args) {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server not connected: ${serverId}`);
    const result = await conn.client.callTool({ name, arguments: args }, undefined, {
      timeout: 60_000,
    });
    const parts = (result.content || []).map((block) =>
      block.type === 'text' ? block.text : JSON.stringify(block)
    );
    const text = parts.join('\n') || '(empty result)';
    if (result.isError) throw new Error(text);
    return text;
  }

  async shutdown() {
    for (const id of [...this.connections.keys()]) {
      await this.disconnect(id);
    }
  }
}
```

- [ ] **Step 2: Syntax check + import check (verifies SDK paths resolve)**

```bash
node --check backend_js/mcp_manager.js
node -e "import('./backend_js/mcp_manager.js').then(m => console.log('MCPManager ok:', typeof m.MCPManager))"
```

Expected: `MCPManager ok: function`.

- [ ] **Step 3: Commit**

```bash
git add backend_js/mcp_manager.js
git commit -m "feat: JS MCP manager (stdio + streamable HTTP)"
```

### Task 6: `backend_js/server.js`

**Files:**
- Create: `backend_js/server.js`

Port of `backend_py/main.py`: 6 API routes, static frontend serving (`/` → `index.html`, traversal-safe), tool/MCP errors returned as `{ok:false, error:"Name: msg"}` with HTTP 200, MCP shutdown on SIGINT/SIGTERM. Port 8000 (override with `PORT` env var).

- [ ] **Step 1: Write the file**

```js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_DEFINITIONS, callBuiltin } from './builtin_tools.js';
import { streamChat } from './llm_proxy.js';
import { MCPManager } from './mcp_manager.js';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const PORT = Number(process.env.PORT || 8000);

const mcpManager = new MCPManager();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function describeError(e) {
  return e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(FRONTEND_DIR, decodeURIComponent(pathname)));
  if (!filePath.startsWith(FRONTEND_DIR + path.sep)) {
    return sendJson(res, 404, { detail: 'Not Found' });
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return sendJson(res, 404, { detail: 'Not Found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function route(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && pathname === '/api/chat') {
    return streamChat(await readJson(req), res);
  }

  if (req.method === 'GET' && pathname === '/api/tools/builtin') {
    return sendJson(res, 200, TOOL_DEFINITIONS);
  }

  if (req.method === 'POST' && pathname === '/api/tools/call') {
    const payload = await readJson(req);
    try {
      const result =
        payload.source === 'builtin'
          ? await callBuiltin(payload.name, payload.arguments || {})
          : await mcpManager.callTool(payload.server_id, payload.name, payload.arguments || {});
      return sendJson(res, 200, { ok: true, result });
    } catch (e) {
      // tool errors go back to the model as data
      return sendJson(res, 200, { ok: false, error: describeError(e) });
    }
  }

  if (req.method === 'GET' && pathname === '/api/mcp/servers') {
    return sendJson(res, 200, mcpManager.listServers());
  }

  if (req.method === 'POST' && pathname === '/api/mcp/servers') {
    const config = await readJson(req);
    try {
      const tools = await mcpManager.connect(config);
      return sendJson(res, 200, { ok: true, tools });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: describeError(e) });
    }
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/mcp/servers/')) {
    const serverId = decodeURIComponent(pathname.slice('/api/mcp/servers/'.length));
    await mcpManager.disconnect(serverId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(pathname, res);
  }

  return sendJson(res, 405, { detail: 'Method Not Allowed' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: describeError(e) });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`mini-agent backend listening on http://localhost:${PORT}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await mcpManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Syntax check**

```bash
node --check backend_js/server.js
```

Expected: no output.

- [ ] **Step 3: End-to-end check (no LLM key needed)**

Start the server in the background, exercise every keyless endpoint, then stop it:

```bash
node backend_js/server.js &  # background
sleep 1
curl -s http://localhost:8000/api/tools/builtin
# expect: JSON array with get_current_time and calculate
curl -s -X POST http://localhost:8000/api/tools/call -H 'Content-Type: application/json' \
  -d '{"source":"builtin","name":"calculate","arguments":{"expression":"(2+3)*4"}}'
# expect: {"ok":true,"result":"20"}
curl -s -X POST http://localhost:8000/api/tools/call -H 'Content-Type: application/json' \
  -d '{"source":"builtin","name":"calculate","arguments":{"expression":"__import__(\"os\")"}}'
# expect: {"ok":false,"error":"Error: Only numbers and the operators + - * / // % ** ( ) are allowed"}
curl -s -X POST http://localhost:8000/api/tools/call -H 'Content-Type: application/json' \
  -d '{"source":"builtin","name":"get_current_time","arguments":{}}'
# expect: {"ok":true,"result":"<ISO timestamp with offset>"}
curl -s http://localhost:8000/api/mcp/servers
# expect: []
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:8000/
# expect: 200 text/html; charset=utf-8
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/../backend_py/main.py
# expect: 404 (traversal blocked; note curl normalizes — also test with --path-as-is)
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is http://localhost:8000/../README.md
# expect: 404
curl -s -X POST http://localhost:8000/api/chat -H 'Content-Type: application/json' \
  -d '{"base_url":"http://localhost:9","model":"x","messages":[]}'
# expect: data: {"proxy_error":"Connection error: ..."} (unreachable upstream → SSE error event)
```

Then kill the background server.

- [ ] **Step 4: Commit**

```bash
git add backend_js/server.js
git commit -m "feat: JS HTTP server with API routes and static frontend"
```

### Task 7: Update docs

**Files:**
- Modify: `README.md` (Run section → Node; note archived Python backend)
- Modify: `docs/extending-tools.md` (rewrite built-in-tool guide for JS)

- [ ] **Step 1: Rewrite README Run section**

Replace the `## Run` section (both platform blocks) with:

````markdown
## Run

Requires [Node.js](https://nodejs.org) 18+ (same commands on Windows, macOS, and Linux):

```bash
npm install
npm start
```
````

Update the intro paragraph: "a thin stateless FastAPI backend" → "a thin stateless Node.js backend (bare `node:http`, zero framework)". Add to the Design docs section (or a new note near it):

```markdown
> The original Python/FastAPI backend is archived in `backend_py/` and is no
> longer maintained; the design docs below describe it. Run it with
> `pip install -r backend_py/requirements.txt` then `uvicorn backend_py.main:app --port 8000`.
```

- [ ] **Step 2: Rewrite `docs/extending-tools.md` for JS**

Keep the same structure (flow diagram, 3-step template, return values & errors, security, checklist) but:
- `backend/builtin_tools.py` → `backend_js/builtin_tools.js`, `main.py` → `server.js`
- Schema/implementation/routing examples in JS (export const in `TOOL_DEFINITIONS`, async function, `callBuiltin` routing with `String()`/`Number()` coercion, `JSON.stringify` for structured returns)
- Security section: "never `eval`/`exec`/`os.system`" → "never `eval`/`new Function`/`child_process.exec`"; the `calculate` worked example now cites the tokenizer + recursive-descent parser instead of the `ast` whitelist
- Checklist verify line: `python -m py_compile ...` → `node --check backend_js/builtin_tools.js`

- [ ] **Step 3: Commit**

```bash
git add README.md docs/extending-tools.md
git commit -m "docs: update README and tool guide for JS backend"
```

### Task 8: Finish the branch

- [ ] **Step 1:** Use superpowers:finishing-a-development-branch — verify (`node --check` on all three files + the Task 6 curl suite if the server isn't running), then present merge/PR/keep/discard options to the user.

---

## Self-review notes

- **Spec coverage:** archive → Task 1; equivalent backend → Tasks 2–6 (all 6 endpoints + static + lifecycle in the contract table are routed in Task 6 code); frontend shift → no code change needed (same-origin contract preserved; verified `frontend/js/api.js` uses relative URLs only); docs → Task 7.
- **Known acceptable divergences from Python:** big-int exactness (`2**100` is approximate in JS doubles — within the pow caps this is cosmetic); float formatting (`8/2` → `"4"` in JS vs `"4.0"` in Python); error-name prefixes (`Error:` vs `ValueError:`) — the frontend treats the error string as opaque text fed back to the model.
- **Type consistency:** `callBuiltin(name, args)` exported in Task 3, imported and called in Task 6; `streamChat(payload, res)` Task 4 ↔ Task 6; `MCPManager` methods `connect/disconnect/listServers/callTool/shutdown` Task 5 ↔ Task 6. All match.

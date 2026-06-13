# Extending Tools

How to add a new tool the agent can call. Two ways to give the model a tool:

1. **Built-in tool** — a JavaScript function in the backend. Use this for logic
   you control and want to ship with the app (math, time, HTTP fetches, DB
   lookups).
2. **MCP server** — an external [Model Context Protocol](https://modelcontextprotocol.io)
   server, added at runtime from the settings UI (gear icon → MCP tab). No code
   changes needed; see [the README](../README.md). The rest of this guide covers
   **built-in tools**.

## How a tool call flows

```
model emits tool_call ── agent.js executeCall() ── POST /api/tools/call
        │                                                   │
        │                                         server.js route()
        │                                                   │
        └──── tool result fed back to model ◄── builtin_tools.js callBuiltin()
```

The model only knows a tool exists because its JSON schema is in
`TOOL_DEFINITIONS`, which the frontend fetches from `GET /api/tools/builtin` and
merges into the toolset (`buildToolset` in `frontend/js/agent.js`). Everything
the model needs to call your tool correctly lives in that schema — name,
description, and parameter types. **No frontend changes are required** to add a
built-in tool; the loop discovers it automatically.

## Adding a built-in tool

Everything happens in `backend_js/builtin_tools.js`. Three edits:

### 1. Declare the schema in `TOOL_DEFINITIONS`

This is the contract the model sees. Be precise: the `description` is the only
hint the model gets about *when* to call it, and `parameters` is a JSON Schema
object describing the arguments.

```js
{
  type: 'function',
  function: {
    name: 'my_tool',                       // unique, [a-zA-Z0-9_-], max 64 chars
    description: 'One clear sentence on what it does and when to use it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up.' },
        limit: { type: 'integer', description: 'Max results.', default: 5 },
      },
      required: ['query'],
    },
  },
},
```

### 2. Implement the function

A plain function (sync or `async`). Keep it pure where possible and **validate
input** — the model can and will pass malformed or hostile arguments. Treat
arguments as untrusted (see [Security](#security)).

```js
export async function myTool(query, limit = 5) {
  if (!query.trim()) throw new Error('query must not be empty');
  // ... do the work ...
  return { results: [/* ... */] }; // string, or anything JSON-serializable
}
```

### 3. Route it in `callBuiltin`

Map the schema `name` to your function. Pull each argument out of the `args`
object and coerce its type — don't blindly spread it, so unexpected keys can't
reach your function.

```js
export async function callBuiltin(name, args) {
  if (name === 'get_current_time') return getCurrentTime();
  if (name === 'calculate') return String(calculate(String(args.expression ?? '')));
  if (name === 'my_tool') {
    return JSON.stringify(
      await myTool(String(args.query ?? ''), Number(args.limit ?? 5))
    );
  }
  throw new Error(`Unknown builtin tool: ${name}`);
}
```

That's it. Restart the server (`npm start`), open a chat, and the model can
call `my_tool`.

## Return values & errors

- **Return type:** `callBuiltin` returns a **string** — it becomes the `tool`
  message content fed back to the model. Return plain text directly; for
  structured data, `JSON.stringify(...)` it so the model can read fields
  reliably.
- **Errors are data, not crashes.** If your function throws, `server.js` catches
  it and returns `{"ok": false, "error": "..."}`; the frontend feeds that error
  string back to the model as the tool result so it can recover or apologize.
  So: throw a clear `Error('...')` with a message the *model* can act on
  (e.g. `'query must not be empty'`), rather than letting an opaque
  `TypeError` leak.

## Security

Tool arguments come from the model, which can be steered by user input or
prompt injection. Apply the same discipline used for the `calculate` tool:

- **Whitelist, don't blacklist.** Validate that input matches an allowed shape;
  reject everything else. (`calculate` regex-checks the raw string for only
  digits and arithmetic operators before parsing.)
- **Never `eval`/`new Function`/`child_process.exec` model-supplied strings.**
  If you must interpret an expression, parse it into a restricted form
  (`calculate` uses a hand-written tokenizer + recursive-descent parser that
  only knows numbers and arithmetic) and cap anything unbounded (it limits
  exponent/base size to prevent CPU/memory DoS).
- **Bound the work.** Cap input length, result size, recursion, and any
  network/file access. A tool that can be made to hang or fetch arbitrary URLs
  is a liability.
- **Pull named args explicitly** in `callBuiltin` and coerce types
  (`String(...)`, `Number(...)`); don't pass the raw `args` object straight
  through.

See `calculate` in `backend_js/builtin_tools.js` for a worked example of all
four.

## Checklist

- [ ] Schema added to `TOOL_DEFINITIONS` with a precise `description` and typed `parameters`
- [ ] Function implemented; input validated against a whitelist
- [ ] Routed in `callBuiltin` with explicit, type-coerced arguments
- [ ] Returns a string (`JSON.stringify` structured data)
- [ ] Throws `Error` with a model-actionable message on bad input
- [ ] No unbounded compute / arbitrary network / `eval` on model input
- [ ] Verify: `node --check backend_js/builtin_tools.js`, then restart the
      server and confirm the model can call it

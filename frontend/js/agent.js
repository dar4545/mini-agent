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

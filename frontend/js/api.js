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

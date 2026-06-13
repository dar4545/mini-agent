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

  // Abort upstream when the browser disconnects (Stop button) or after 300s overall.
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

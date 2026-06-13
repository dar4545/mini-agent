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

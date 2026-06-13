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

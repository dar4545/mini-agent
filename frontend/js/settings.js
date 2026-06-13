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

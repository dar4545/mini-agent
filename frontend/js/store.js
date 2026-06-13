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

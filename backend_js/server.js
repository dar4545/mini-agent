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

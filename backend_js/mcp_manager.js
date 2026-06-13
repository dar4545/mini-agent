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

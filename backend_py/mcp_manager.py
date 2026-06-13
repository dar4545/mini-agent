import asyncio
from contextlib import AsyncExitStack
from datetime import timedelta

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client


class MCPConnection:
    def __init__(self, config: dict):
        self.config = config
        self.session: ClientSession | None = None
        self.tools: list[dict] = []
        self.error: str | None = None
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self):
        self._task = asyncio.create_task(self._run())
        await self._ready.wait()
        if self.error:
            raise RuntimeError(self.error)

    async def _run(self):
        try:
            async with AsyncExitStack() as stack:
                if self.config["transport"] == "stdio":
                    params = StdioServerParameters(
                        command=self.config["command"],
                        args=self.config.get("args") or [],
                        env=self.config.get("env") or None,
                    )
                    read, write = await stack.enter_async_context(stdio_client(params))
                else:
                    read, write, _ = await stack.enter_async_context(
                        streamablehttp_client(self.config["url"])
                    )
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                listed = await session.list_tools()
                self.tools = [
                    {
                        "name": t.name,
                        "description": t.description or "",
                        "inputSchema": t.inputSchema,
                    }
                    for t in listed.tools
                ]
                self.session = session
                self._ready.set()
                await self._stop.wait()
        except BaseException as e:  # noqa: BLE001 - report any startup failure to caller
            self.error = f"{type(e).__name__}: {e}"
        finally:
            self.session = None
            self._ready.set()

    async def stop(self):
        self._stop.set()
        if self._task:
            await asyncio.wait([self._task], timeout=10)


class MCPManager:
    def __init__(self):
        self.connections: dict[str, MCPConnection] = {}

    async def connect(self, config: dict) -> list[dict]:
        await self.disconnect(config["id"])
        conn = MCPConnection(config)
        await conn.start()
        self.connections[config["id"]] = conn
        return conn.tools

    async def disconnect(self, server_id: str):
        conn = self.connections.pop(server_id, None)
        if conn:
            await conn.stop()

    def list_servers(self) -> list[dict]:
        return [
            {
                "id": sid,
                "name": c.config.get("name", sid),
                "transport": c.config["transport"],
                "connected": c.session is not None,
                "tools": c.tools,
            }
            for sid, c in self.connections.items()
        ]

    async def call_tool(self, server_id: str, name: str, arguments: dict) -> str:
        conn = self.connections.get(server_id)
        if not conn or not conn.session:
            raise RuntimeError(f"MCP server not connected: {server_id}")
        result = await conn.session.call_tool(
            name, arguments, read_timeout_seconds=timedelta(seconds=60)
        )
        parts = []
        for block in result.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
            else:
                parts.append(block.model_dump_json())
        text = "\n".join(parts) or "(empty result)"
        if result.isError:
            raise RuntimeError(text)
        return text

    async def shutdown(self):
        for sid in list(self.connections):
            await self.disconnect(sid)

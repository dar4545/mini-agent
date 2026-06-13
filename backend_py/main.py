import contextlib
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from . import builtin_tools
from .llm_proxy import stream_chat
from .mcp_manager import MCPManager

mcp_manager = MCPManager()


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await mcp_manager.shutdown()


app = FastAPI(lifespan=lifespan)


@app.post("/api/chat")
async def chat(request: Request):
    return await stream_chat(await request.json())


@app.get("/api/tools/builtin")
async def list_builtin_tools():
    return builtin_tools.TOOL_DEFINITIONS


@app.post("/api/tools/call")
async def call_tool(request: Request):
    payload = await request.json()
    try:
        if payload["source"] == "builtin":
            result = await builtin_tools.call_builtin(
                payload["name"], payload.get("arguments") or {}
            )
        else:
            result = await mcp_manager.call_tool(
                payload["server_id"], payload["name"], payload.get("arguments") or {}
            )
        return {"ok": True, "result": result}
    except Exception as e:  # noqa: BLE001 - tool errors go back to the model as data
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.get("/api/mcp/servers")
async def list_mcp_servers():
    return mcp_manager.list_servers()


@app.post("/api/mcp/servers")
async def connect_mcp_server(request: Request):
    config = await request.json()
    try:
        tools = await mcp_manager.connect(config)
        return {"ok": True, "tools": tools}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.delete("/api/mcp/servers/{server_id}")
async def disconnect_mcp_server(server_id: str):
    await mcp_manager.disconnect(server_id)
    return {"ok": True}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend", html=True),
    name="frontend",
)

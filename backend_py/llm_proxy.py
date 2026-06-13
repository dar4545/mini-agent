import json

import httpx
from fastapi.responses import StreamingResponse


def _error_event(message: str) -> bytes:
    return f"data: {json.dumps({'proxy_error': message})}\n\n".encode()


async def stream_chat(payload: dict) -> StreamingResponse:
    base_url = payload["base_url"].rstrip("/")
    headers = {"Content-Type": "application/json"}
    if payload.get("api_key"):
        headers["Authorization"] = f"Bearer {payload['api_key']}"

    body = {
        "model": payload["model"],
        "messages": payload["messages"],
        "stream": True,
    }
    if payload.get("tools"):
        body["tools"] = payload["tools"]
    for key in ("temperature", "max_tokens"):
        if payload.get(key) is not None:
            body[key] = payload[key]

    async def relay():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30)) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions", json=body, headers=headers
                ) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")
                        yield _error_event(f"Upstream {resp.status_code}: {detail[:2000]}")
                        return
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        except httpx.HTTPError as e:
            yield _error_event(f"Connection error: {e}")

    return StreamingResponse(relay(), media_type="text/event-stream")

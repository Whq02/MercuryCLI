from __future__ import annotations
import asyncio
import inspect
import json
import secrets
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, NotRequired, TypedDict
from .parse import validate
from .generated import PermissionMode, EffortLevel


class AgentDefinition(TypedDict):
    description: str
    prompt: str
    model: NotRequired[str]
    effort: NotRequired[EffortLevel | int]
    tools: NotRequired[list[str]]
    disallowedTools: NotRequired[list[str]]
    permissionMode: NotRequired[PermissionMode]
    instructionProfile: NotRequired[str]
    mcpServers: NotRequired[list[Any]]
    hooks: NotRequired[Any]
    maxTurns: NotRequired[int]
    skills: NotRequired[list[str]]
    initialPrompt: NotRequired[str]
    standingRule: NotRequired[str]
    memory: NotRequired[str]
    background: NotRequired[bool]
    isolation: NotRequired[str]


def define_agent(definition: AgentDefinition) -> AgentDefinition:
    if not definition['description'].strip() or not definition['prompt'].strip(): raise ValueError('an agent needs description and prompt')
    return definition.copy()


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict
    execute: Callable


def define_tool(name: str, description: str, input_schema: dict, execute: Callable) -> ToolDefinition:
    if not name.strip(): raise ValueError('a tool needs a name')
    return ToolDefinition(name, description, input_schema, execute)


@dataclass
class ToolServer:
    config: dict
    mcp: str
    _server: ThreadingHTTPServer
    _thread: threading.Thread

    async def close(self) -> None:
        await asyncio.to_thread(self._server.shutdown)
        self._server.server_close()
        self._thread.join()

    async def __aenter__(self) -> ToolServer: return self
    async def __aexit__(self, *exc: Any) -> None: await self.close()


async def serve_tools(tools: list[ToolDefinition], name: str = 'sdk-tools') -> ToolServer:
    if len({t.name for t in tools}) != len(tools): raise ValueError('duplicate tool name')
    token = secrets.token_hex(32)
    loop = asyncio.get_running_loop()

    async def execute(tool: ToolDefinition, params: dict) -> Any:
        try:
            value = tool.execute(params)
            if inspect.isawaitable(value): value = await value
            return {'content': [{'type': 'text', 'text': value}]} if isinstance(value, str) else value
        except Exception as error:
            return {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None: pass
        def do_GET(self) -> None: self.send_error(405)
        def do_DELETE(self) -> None:
            if self.headers.get('Authorization') != f'Bearer {token}': self.send_error(403); return
            self.send_response(200); self.end_headers()
        def do_POST(self) -> None:
            if self.headers.get('Authorization') != f'Bearer {token}' or self.headers.get('Origin'): self.send_error(403); return
            id = None
            try:
                message = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                id = message.get('id')
                if id is None:
                    self.send_response(202); self.end_headers(); return
                method, params = message['method'], message.get('params', {})
                if method == 'initialize': result = {'protocolVersion': params['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': name, 'version': '0.1.0'}}
                elif method == 'ping': result = {}
                elif method == 'tools/list': result = {'tools': [{'name': t.name, 'description': t.description, 'inputSchema': t.input_schema} for t in tools]}
                elif method == 'tools/call':
                    tool = next(t for t in tools if t.name == params['name'])
                    args = params.get('arguments', {})
                    issues = validate(tool.input_schema, args)
                    if issues: raise ValueError(str(issues))
                    result = asyncio.run_coroutine_threadsafe(execute(tool, args), loop).result()
                else:
                    self.reply({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': 'unknown method'}}); return
                self.reply({'jsonrpc': '2.0', 'id': id, 'result': result})
            except Exception as error:
                self.reply({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32602, 'message': str(error)}})
        def reply(self, value: dict) -> None:
            data = json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = {'type': 'http', 'url': f'http://127.0.0.1:{server.server_port}', 'headers': {'Authorization': f'Bearer {token}'}}
    return ToolServer(config, json.dumps({'mcpServers': {name: config}}), server, thread)

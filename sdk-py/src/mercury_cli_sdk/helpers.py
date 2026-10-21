from __future__ import annotations
import asyncio
import base64
from pathlib import Path
import inspect
import json
import secrets
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Annotated, Any, Awaitable, Callable, Literal, Mapping, NotRequired, Required, TypedDict, Union, get_args, get_origin, get_type_hints, is_typeddict, cast
from types import UnionType
from .parse import validate
from .generated import InputBlock, PermissionMode, EffortLevel
from .version import __version__


class AgentDefinition(TypedDict):
    """An inline agent for ``agent_defs``: the same keys as an agent definition file."""
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
    """Check an inline agent definition has a description and a prompt and return a copy."""
    if not definition['description'].strip() or not definition['prompt'].strip(): raise ValueError('an agent needs description and prompt')
    return definition.copy()


class ToolResult(TypedDict):
    """What an inline tool returns when it needs more than a string: MCP text content and an optional error flag."""
    content: list[dict[str, Any]]
    isError: NotRequired[bool]


@dataclass
class ToolContext:
    cancelled: asyncio.Event


ToolExecute = Callable[[dict[str, Any]], str | ToolResult | Awaitable[str | ToolResult]] | Callable[[dict[str, Any], ToolContext], str | ToolResult | Awaitable[str | ToolResult]]


def _schema(annotation: Any) -> dict[str, Any]:
    origin, args = get_origin(annotation), get_args(annotation)
    if origin in (Required, NotRequired): return _schema(args[0])
    if origin is Annotated:
        return {**_schema(args[0]), **({'description': next(x for x in args[1:] if isinstance(x, str))} if any(isinstance(x, str) for x in args[1:]) else {})}
    if annotation is Any: return {}
    primitives = {str: 'string', int: 'integer', float: 'number', bool: 'boolean', type(None): 'null'}
    if annotation in primitives: return {'type': primitives[annotation]}
    if origin in (Union, UnionType): return {'anyOf': [_schema(x) for x in args]}
    if origin is Literal: return {'enum': list(args)}
    if origin is list: return {'type': 'array', 'items': _schema(args[0])}
    if origin is dict and args[0] is str: return {'type': 'object', 'additionalProperties': _schema(args[1])}
    if is_typeddict(annotation):
        hints = get_type_hints(annotation, include_extras=True)
        def required(key: str, value: Any) -> bool:
            if get_origin(value) is Annotated: value = get_args(value)[0]
            if get_origin(value) is NotRequired: return False
            if get_origin(value) is Required: return True
            return key in annotation.__required_keys__
        return {'type': 'object', 'properties': {key: _schema(value) for key, value in hints.items()}, 'required': [key for key, value in hints.items() if required(key, value)], 'additionalProperties': False}
    raise ValueError(f'unsupported tool annotation: {annotation}')


def tool_schema(value: Mapping[str, Any] | type) -> dict[str, Any]:
    if isinstance(value, Mapping):
        if value and not all(isinstance(item, type) or get_origin(item) is not None or item is Any for item in value.values()): return dict(value)
        return {'type': 'object', 'properties': {key: _schema(item) for key, item in value.items()}, 'required': list(value), 'additionalProperties': False}
    return _schema(value)


@dataclass(frozen=True)
class ToolDefinition:
    """An inline tool: its MCP name, description, JSON Schema for the input, and the function that runs it."""
    name: str
    description: str
    input_schema: dict[str, Any]
    execute: ToolExecute


def define_tool(name: str, description: str, input_schema: Mapping[str, Any] | type, execute: ToolExecute) -> ToolDefinition:
    """Build a ``ToolDefinition``; ``execute`` may be sync or async and return a string or a ``ToolResult``."""
    if not name.strip(): raise ValueError('a tool needs a name')
    return ToolDefinition(name, description, tool_schema(input_schema), execute)


@dataclass
class ToolServer:
    """A loopback MCP server for inline tools; pass ``mcp`` to ``run(mcp=[...])`` and ``close()`` it when done."""
    config: dict[str, Any]
    mcp: str
    _server: ThreadingHTTPServer
    _thread: threading.Thread
    _pending: dict[Any, ToolContext]
    _loop: asyncio.AbstractEventLoop | None = None
    _closed: bool = False

    def cancel(self) -> None:
        def _set() -> None:
            for context in list(self._pending.values()): context.cancelled.set()
        try: same_loop = asyncio.get_running_loop() is self._loop
        except RuntimeError: same_loop = False
        if not same_loop and self._loop is not None and self._loop.is_running(): self._loop.call_soon_threadsafe(_set)
        else: _set()

    async def close(self) -> None:
        if self._closed: return
        self._closed = True
        self.cancel()
        await asyncio.to_thread(self._server.shutdown)
        self._server.server_close()
        self._thread.join()

    async def __aenter__(self) -> ToolServer: return self
    async def __aexit__(self, *exc: Any) -> None: await self.close()


async def serve_tools(tools: list[ToolDefinition], name: str = 'sdk-tools') -> ToolServer:
    """Serve inline tools over bearer-authenticated loopback MCP HTTP; the event loop must keep running while tools execute."""
    if len({t.name for t in tools}) != len(tools): raise ValueError('duplicate tool name')
    token = secrets.token_hex(32)
    loop = asyncio.get_running_loop()

    pending: dict[Any, ToolContext] = {}

    async def execute(tool: ToolDefinition, params: dict[str, Any], id: Any) -> Any:
        context = ToolContext(asyncio.Event())
        pending[id] = context
        try:
            try: inspect.signature(tool.execute).bind(params, context)
            except TypeError: value = cast(Callable[[dict[str, Any]], Any], tool.execute)(params)
            else: value = cast(Callable[[dict[str, Any], ToolContext], Any], tool.execute)(params, context)
            if inspect.isawaitable(value): value = await value
            return {'content': [{'type': 'text', 'text': value}]} if isinstance(value, str) else value
        except Exception as error:
            return {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
        finally: pending.pop(id, None)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None: pass
        def do_GET(self) -> None: self.send_error(405)
        def do_DELETE(self) -> None:
            if self.headers.get('Authorization') != f'Bearer {token}' or self.headers.get('Origin'): self.send_error(403); return
            loop.call_soon_threadsafe(lambda: [context.cancelled.set() for context in list(pending.values())])
            self.send_response(200); self.end_headers()
        def do_POST(self) -> None:
            if self.headers.get('Authorization') != f'Bearer {token}' or self.headers.get('Origin'): self.send_error(403); return
            id = None
            try:
                message = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                id = message.get('id')
                if message.get('method') == 'notifications/cancelled':
                    request_id = message.get('params', {}).get('requestId')
                    loop.call_soon_threadsafe(lambda: context.cancelled.set() if (context := pending.get(request_id)) else None)
                if id is None:
                    self.send_response(202); self.end_headers(); return
                method, params = message['method'], message.get('params', {})
                if method == 'initialize': result = {'protocolVersion': params['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': name, 'version': __version__}}
                elif method == 'ping': result = {}
                elif method == 'tools/list': result = {'tools': [{'name': t.name, 'description': t.description, 'inputSchema': t.input_schema} for t in tools]}
                elif method == 'tools/call':
                    tool = next((t for t in tools if t.name == params.get('name')), None)
                    if tool is None: raise ValueError('unknown tool')
                    args = params.get('arguments')
                    if args is None: args = {}
                    issues = validate(tool.input_schema, args)
                    if issues: raise ValueError(str(issues))
                    result = asyncio.run_coroutine_threadsafe(execute(tool, args, id), loop).result()
                else:
                    self.reply({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': 'unknown method'}}); return
                self.reply({'jsonrpc': '2.0', 'id': id, 'result': result})
            except Exception as error:
                self.reply({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32602, 'message': str(error)}})
        def reply(self, value: Mapping[str, Any]) -> None:
            data = json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        def handle_error(self, request: Any, client_address: Any) -> None: pass

    server = Server(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config: dict[str, Any] = {'type': 'http', 'url': f'http://127.0.0.1:{server.server_port}', 'headers': {'Authorization': f'Bearer {token}'}}
    return ToolServer(config, json.dumps({'mcpServers': {name: config}}), server, thread, pending, loop)


def text_block(text: str) -> InputBlock:
    return {'type': 'text', 'text': text}


def image_block(data: bytes | Path | str, media_type: str) -> InputBlock:
    return {'type': 'image', 'media_type': media_type, 'data': data if isinstance(data, str) else base64.b64encode(data.read_bytes() if isinstance(data, Path) else data).decode('ascii')}

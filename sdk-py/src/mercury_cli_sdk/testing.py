from __future__ import annotations
import asyncio
import json
import secrets
import sys
from dataclasses import dataclass, field
from typing import Any, Mapping, NotRequired, Sequence, TypedDict
from .generated import OUTCOME_EXIT_CODES


class FixtureReply(TypedDict):
    """One recorded answer to a host request: its ``result`` or ``error``, with messages sent ``before`` and ``after`` it."""
    result: NotRequired[Any]
    error: NotRequired[Mapping[str, Any]]
    before: NotRequired[Sequence[Mapping[str, Any]]]
    after: NotRequired[Sequence[Mapping[str, Any]]]


class Fixture(TypedDict):
    """A recording to replay: run-door ``rows`` (after ``inputCount`` stdin rows), and runner-door ``methods`` and ``answers``."""
    rows: NotRequired[Sequence[Mapping[str, Any]]]
    inputCount: NotRequired[int]
    methods: NotRequired[Mapping[str, Sequence[FixtureReply]]]
    answers: NotRequired[Mapping[str, Sequence[Mapping[str, Any]]]]


@dataclass
class FixtureServer:
    """A loopback replay server; ``mercury`` is the executable array to pass to ``run()`` or ``connect()``."""
    mercury: list[str]
    received: list[dict[str, Any]]
    _server: asyncio.Server
    _writers: set[asyncio.StreamWriter] = field(repr=False)

    async def close(self) -> None:
        for writer in tuple(self._writers): writer.close()
        self._server.close()
        await self._server.wait_closed()
        for writer in tuple(self._writers): await writer.wait_closed()

    async def __aenter__(self) -> FixtureServer: return self
    async def __aexit__(self, *exc: Any) -> None: await self.close()


async def start_fixture_server(fixture: Fixture) -> FixtureServer:
    """Replay recorded rows and RPC responses on loopback, without a model or CLI."""
    received: list[dict[str, Any]] = []
    writers: set[asyncio.StreamWriter] = set()
    token = secrets.token_hex(32)

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writers.add(writer)
        def send(message: Any) -> None: writer.write((json.dumps(message) + '\n').encode())
        try:
            hello = json.loads(await reader.readline())
            if hello.get('token') != token: return
            door = hello['door']
            if door == 'run':
                for _ in range(fixture.get('inputCount', 0)):
                    line = await reader.readline()
                    if not line: return
                    received.append(json.loads(line))
                for row in fixture.get('rows', []): send(row)
                await writer.drain()
                return
            cursors: dict[str, int] = {}
            async for line in reader:
                message = json.loads(line)
                received.append(message)
                method, id = message.get('method'), message.get('id')
                if method is None:
                    for row in fixture.get('answers', {}).get(str(id), []): send(row)
                    await writer.drain()
                    continue
                if id is None: continue
                replies = fixture.get('methods', {}).get(method, [])
                i = cursors.get(method, 0)
                cursors[method] = i + 1
                if i >= len(replies):
                    send({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': f'no recorded response for {method}'}})
                    await writer.drain()
                    continue
                reply = replies[i]
                for row in reply.get('before', []): send(row)
                send({'jsonrpc': '2.0', 'id': id, **({'error': reply['error']} if 'error' in reply else {'result': reply.get('result', {})})})
                for row in reply.get('after', []): send(row)
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            writers.discard(writer)

    server = await asyncio.start_server(serve, '127.0.0.1', 0, limit=32 * 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    bridge = f'''import socket,sys,threading,json
s=socket.create_connection(('127.0.0.1',{port}))
args=sys.argv[1:]
head=args[:next((i for i,a in enumerate(args) if a in ('--','--format')),len(args))]
door='runner' if any(a=='runner' and (i==0 or head[i-1]!='--project') for i,a in enumerate(head)) else 'run'
s.sendall((json.dumps({{'token':{token!r},'door':door}})+'\\n').encode())
def feed():
    try:
        for line in sys.stdin.buffer: s.sendall(line)
        s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=feed,daemon=True).start()
code=0
try:
    for data in s.makefile('rb'):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        if door=='run':
            row=json.loads(data)
            if row.get('type')=='outcome': code={OUTCOME_EXIT_CODES!r}.get(row.get('status'),1)
finally: s.close()
sys.exit(code)
'''
    return FixtureServer([sys.executable, '-u', '-c', bridge], received, server, writers)

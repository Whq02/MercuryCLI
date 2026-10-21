from __future__ import annotations
import asyncio
import json
import secrets
import sys
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Mapping, NotRequired, Sequence, TypedDict
from .generated import METHODS, ROW_SCHEMAS, OUTCOME_EXIT_CODES, OutcomeRow, SessionRow, TurnRow
from .parse import row_of, validate
from typing import cast


class FixtureReply(TypedDict):
    """One recorded answer to a host request: its ``result`` or ``error``, with messages sent ``before`` and ``after`` it."""
    result: NotRequired[Any]
    error: NotRequired[Mapping[str, Any]]
    before: NotRequired[Sequence[Mapping[str, Any]]]
    after: NotRequired[Sequence[Mapping[str, Any]]]


class Fixture(TypedDict):
    """A recording to replay: run-door ``rows`` (after ``inputCount`` stdin rows), and runner-door ``methods`` and ``answers``."""
    validate: NotRequired[bool]
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
    _handlers: set[asyncio.Task[None]] = field(repr=False)

    async def close(self) -> None:
        """Stop listening and end every connection at once: a handler still parked on a peer that neither reads nor writes is cancelled and its socket aborted, so ``close`` never waits on the peer."""
        self._server.close()
        for handler in tuple(self._handlers): handler.cancel()
        for writer in tuple(self._writers): writer.transport.abort()
        await asyncio.gather(*self._handlers, return_exceptions=True)
        await self._server.wait_closed()

    async def __aenter__(self) -> FixtureServer: return self
    async def __aexit__(self, *exc: Any) -> None: await self.close()


async def start_fixture_server(fixture: Fixture) -> FixtureServer:
    """Replay recorded rows and RPC responses on loopback, without a model or CLI."""
    if fixture.get('validate', True): _validate_fixture(fixture)
    received: list[dict[str, Any]] = []
    writers: set[asyncio.StreamWriter] = set()
    handlers: set[asyncio.Task[None]] = set()
    token = secrets.token_hex(32)

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        handler = asyncio.current_task()
        if handler is not None: handlers.add(handler)
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
            with suppress(Exception): await writer.wait_closed()
            writers.discard(writer)
            if handler is not None: handlers.discard(handler)

    server = await asyncio.start_server(serve, '127.0.0.1', 0, limit=32 * 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    bridge = f'''import os,socket,sys,threading,json
s=socket.create_connection(('127.0.0.1',{port}))
args=sys.argv[1:]
head=args[:next((i for i,a in enumerate(args) if a in ('--','--format')),len(args))]
door='runner' if any(a=='runner' and (i==0 or head[i-1]!='--project') for i,a in enumerate(head)) else 'run'
s.sendall((json.dumps({{'token':{token!r},'door':door}})+'\\n').encode())
def feed():
    try:
        while True:
            data=os.read(0,65536)
            if not data: break
            s.sendall(data)
        s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=feed,daemon=True).start()
code=0
out=sys.stdout.buffer
try:
    for data in s.makefile('rb'):
        out.write(data)
        out.flush()
        if door=='run':
            row=json.loads(data)
            if row.get('type')=='outcome': code={OUTCOME_EXIT_CODES!r}.get(row.get('status'),1)
finally: s.close()
out.flush()
os._exit(code)
'''
    return FixtureServer([sys.executable, '-u', '-c', bridge], received, server, writers, handlers)


def _defaults(schema: dict[str, Any]) -> Any:
    if 'const' in schema: return schema['const']
    if 'enum' in schema: return schema['enum'][0]
    if 'anyOf' in schema or 'oneOf' in schema: return _defaults((schema.get('anyOf') or schema['oneOf'])[0])
    type = schema.get('type')
    if type == 'object': return {key: _defaults(schema['properties'][key]) for key in schema.get('required', [])}
    if type == 'array': return []
    if type == 'string': return 'fixture'
    if type == 'boolean': return False
    if type in ('number', 'integer'): return max(0, schema.get('minimum', 0), schema.get('exclusiveMinimum', -1) + 1)
    return None


_ENVELOPE = {'seq': 1, 'timestamp': '2000-01-01T00:00:00.000Z', 'session_id': 'fixture-session'}


def fixture_session_row(overrides: Mapping[str, Any] | None = None, **fields: Any) -> SessionRow:
    return cast(SessionRow, {**_defaults(ROW_SCHEMAS['session']), **_ENVELOPE, **(overrides or {}), **fields})


def fixture_outcome_row(overrides: Mapping[str, Any] | None = None, **fields: Any) -> OutcomeRow:
    return cast(OutcomeRow, {**_defaults(ROW_SCHEMAS['outcome']), **_ENVELOPE, 'seq': 3, 'turn_id': 'fixture-turn', 'status': 'completed', **(overrides or {}), **fields})


def fixture_turn(overrides: Mapping[str, Any] | None = None, prompt_id: str = 'fixture-prompt') -> tuple[TurnRow, OutcomeRow]:
    outcome = fixture_outcome_row(overrides)
    turn = cast(TurnRow, {**_defaults(ROW_SCHEMAS['turn']), **_ENVELOPE, 'seq': outcome['seq'] - 1, 'turn_id': outcome['turn_id'], 'message_ids': [prompt_id]})
    return turn, outcome


def _validate_fixture(fixture: Fixture) -> None:
    def message(value: Mapping[str, Any]) -> None:
        if not isinstance(value, Mapping): raise ValueError('invalid fixture message')
        if 'type' in value:
            read = row_of(dict(value))
            if not read.ok: raise ValueError(f'invalid fixture row: {read.issues}')
            return
        method = value.get('method')
        spec = METHODS.get(method) if isinstance(method, str) else None
        if value.get('jsonrpc') != '2.0' or not spec: raise ValueError('invalid fixture message')
        if method == 'row': message(value['params']); return
        issues = validate(spec['params'], value.get('params'))
        if issues: raise ValueError(f'invalid fixture params: {issues}')
    for row in fixture.get('rows', []): message(row)
    for name, replies in fixture.get('methods', {}).items():
        spec = METHODS.get(name)
        if not spec or spec['kind'] != 'request': raise ValueError('invalid fixture method: ' + name)
        for reply in replies:
            if 'error' in reply:
                error = reply['error']
                if type(error.get('code')) is not int or not isinstance(error.get('message'), str): raise ValueError('invalid fixture error')
            else:
                issues = validate(spec['result'], reply.get('result', {}))
                if issues: raise ValueError(f'invalid fixture result: {issues}')
            for row in [*reply.get('before', []), *reply.get('after', [])]: message(row)
    for messages in fixture.get('answers', {}).values():
        for row in messages: message(row)

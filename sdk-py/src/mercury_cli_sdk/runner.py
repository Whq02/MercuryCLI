from __future__ import annotations
import asyncio
import inspect
import json
import signal
import uuid
from dataclasses import dataclass
from typing import Any, Callable, AsyncIterator
from .client import RunOptions, argv_of
from .errors import MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryWireError, RunExit
from .generated import METHODS, RUNNER_PROTOCOL, RPC_REFUSED, MAX_LINE_BYTES, InputRow, OutcomeRow
from .parse import StreamRow, row_of, validate


@dataclass
class RequestContext:
    id: int
    cancelled: asyncio.Event


class MercurySession:
    def __init__(self, child: asyncio.subprocess.Process, handlers: dict[str, Callable]):
        self.child = child
        self.handlers = handlers
        self.initialized: dict = {}
        self.rows: list[StreamRow] = []
        self.stderr = ''
        self.exit = asyncio.get_running_loop().create_future()
        self._closed: Exception | None = None
        self._pending: dict[int, tuple[str, asyncio.Future]] = {}
        self._asks: dict[int, tuple[RequestContext, asyncio.Task]] = {}
        self._listeners: dict[str, list[Callable]] = {}
        self._queue: asyncio.Queue = asyncio.Queue()
        self._next = 0
        self._prompting = False
        self._reader = asyncio.create_task(self._read())

    def on(self, type: str, listener: Callable) -> MercurySession:
        self._listeners.setdefault(type, []).append(listener)
        return self

    def off(self, type: str, listener: Callable) -> MercurySession:
        if listener in self._listeners.get(type, []): self._listeners[type].remove(listener)
        return self

    def _emit(self, type: str, value: Any) -> None:
        for fn in tuple(self._listeners.get(type, [])): fn(value)

    async def _write(self, value: Any) -> None:
        if self._closed: raise self._closed
        self.child.stdin.write((json.dumps(value) + '\n').encode())
        await self.child.stdin.drain()

    async def request(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        spec = METHODS.get(method)
        if not spec or spec['kind'] != 'request' or spec['from'] == 'runner': raise MercuryError(f'not a host request: {method}')
        if self._closed: raise self._closed
        params = {} if params is None else params
        issues = validate(spec['params'], params)
        if issues: raise MercuryWireError(json.dumps(params), 'invalid', method, issues)
        self._next += 1
        id = self._next
        future = asyncio.get_running_loop().create_future()
        self._pending[id] = (method, future)
        try:
            await self._write({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params})
            limit = timeout if timeout is not None else None if spec['deadlineMs'] is None else spec['deadlineMs'] / 1000
            return await asyncio.wait_for(future, limit)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if not self._closed:
                await self.notify('$/cancel_request', {'request_id': id, 'reason': 'host request cancelled'})
            raise
        finally:
            self._pending.pop(id, None)

    async def notify(self, method: str, params: Any = None) -> None:
        spec = METHODS.get(method)
        if not spec or spec['kind'] != 'notification' or spec['from'] == 'runner': raise MercuryError(f'not a host notification: {method}')
        params = {} if params is None else params
        issues = validate(spec['params'], params)
        if issues: raise MercuryWireError(json.dumps(params), 'invalid', method, issues)
        await self._write({'jsonrpc': '2.0', 'method': method, 'params': params})

    async def _answer(self, message: dict, context: RequestContext) -> None:
        id, method = message['id'], message['method']
        try:
            spec = METHODS.get(method)
            if not spec or spec['kind'] != 'request' or spec['from'] == 'host':
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': 'unknown host method'}})
                return
            issues = validate(spec['params'], message.get('params', {}))
            if issues:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32602, 'message': 'invalid request params'}})
                return
            handler = self.handlers.get(method)
            if handler:
                value = handler(message.get('params', {}), context)
                if inspect.isawaitable(value): value = await value
            elif method == 'permission/request': value = {'outcome': 'deny', 'message': 'No permission handler installed'}
            elif method == 'elicitation/request': value = {'action': 'decline'}
            else:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': 'no host handler installed'}})
                return
            issues = validate(spec['result'], value)
            if issues: raise MercuryWireError(json.dumps(value), 'invalid', method, issues)
            if not context.cancelled.is_set(): await self._write({'jsonrpc': '2.0', 'id': id, 'result': value})
        except Exception as error:
            if not context.cancelled.is_set() and not self._closed:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32603, 'message': str(error)}})
        finally:
            self._asks.pop(id, None)

    async def _read(self) -> None:
        stderr = asyncio.create_task(self.child.stderr.read())
        try:
            async for data in self.child.stdout:
                line = data.decode('utf-8')
                message = json.loads(line)
                if not isinstance(message, dict) or message.get('jsonrpc') != '2.0': raise MercuryWireError(line, 'invalid')
                method, id = message.get('method'), message.get('id')
                if method is None:
                    entry = self._pending.get(id)
                    if entry is None: continue
                    sent, future = entry
                    if future.done(): continue
                    if 'error' in message:
                        e = message['error']
                        future.set_exception(MercuryRefusal(None, rpc=e) if e['code'] == RPC_REFUSED else MercuryError(e['message'], code=e['code'], data=e.get('data')))
                    else:
                        result = message.get('result')
                        issues = validate(METHODS[sent]['result'], result)
                        if issues: future.set_exception(MercuryWireError(line, 'invalid', sent, issues))
                        else: future.set_result(result)
                elif method == '$/cancel_request':
                    ask = self._asks.get(message.get('params', {}).get('request_id'))
                    if ask:
                        ask[0].cancelled.set()
                        ask[1].cancel()
                elif id is not None:
                    context = RequestContext(id, asyncio.Event())
                    task = asyncio.create_task(self._answer(message, context))
                    self._asks[id] = (context, task)
                elif method == 'row':
                    read = row_of(message.get('params'))
                    if not read.ok: raise MercuryWireError(line, read.reason, read.type, read.issues)
                    row = read.row
                    self.rows.append(row)
                    self._queue.put_nowait(row)
                    self._emit('row', row)
                    self._emit(row['type'], row)
                else: self._emit('notification', message)
        except Exception as error:
            self._fail(error if isinstance(error, MercuryError) else MercuryWireError('', 'invalid', issues=[str(error)]))
            if self.child.returncode is None: self.child.terminate()
        code = await self.child.wait()
        self.stderr = (await stderr).decode('utf-8', errors='replace')
        exit = RunExit(code if code >= 0 else None, signal.Signals(-code).name if code < 0 else None, self.stderr)
        self._fail(MercuryExitError(exit))
        self.exit.set_result(exit)

    def _fail(self, error: Exception) -> None:
        if self._closed: return
        self._closed = error
        for _, future in self._pending.values():
            if not future.done(): future.set_exception(error)
        for context, task in tuple(self._asks.values()):
            context.cancelled.set()
            task.cancel()
        self._queue.put_nowait(None)
        self._emit('error', error)

    async def send(self, row: InputRow) -> dict:
        return await self.request('queue/add', row)

    async def send_prompt(self, content: Any, **options: Any) -> dict:
        return await self.send({**options, 'type': 'prompt', 'content': content})

    async def send_shell(self, command: str) -> dict:
        return await self.send({'type': 'shell', 'command': command})

    async def send_note(self, to: str, content: str) -> dict:
        return await self.send({'type': 'note', 'to': to, 'content': content})

    async def prompt(self, content: Any) -> OutcomeRow:
        if self._prompting: raise MercuryError('prompt already pending; use send_prompt for mid-turn input')
        self._prompting = True
        future = asyncio.get_running_loop().create_future()
        def done(row: OutcomeRow) -> None:
            if not future.done(): future.set_result(row)
        def fail(error: Exception) -> None:
            if not future.done(): future.set_exception(error)
        self.on('outcome', done).on('error', fail)
        try:
            receipt = await self.send_prompt(content)
            if not receipt['accepted']: raise MercuryError('prompt was not accepted')
            row = await future
            if row['status'] == 'refused': raise MercuryRefusal(row)
            return row
        finally:
            if future.done() and not future.cancelled(): future.exception()
            self.off('outcome', done).off('error', fail)
            self._prompting = False

    async def facts(self) -> dict: return await self.request('session/facts')
    async def interrupt(self, **options: Any) -> dict: return await self.request('turn/interrupt', options)
    async def withdraw(self, id: str) -> dict: return await self.request('queue/withdraw', {'id': id})
    async def set_model(self, model: str) -> dict: return await self.request('session/set_model', {'model': model})
    async def set_effort(self, effort: str) -> dict: return await self.request('session/set_effort', {'effort': effort})
    async def set_mode(self, mode: str) -> dict: return await self.request('session/set_mode', {'mode': mode})
    async def set_kit(self, kit: Any) -> dict: return await self.request('session/set_kit', {'kit': kit})
    async def rewind(self, user_message_id: str, mode: str, dry_run: bool = False) -> dict: return await self.request('session/rewind', {'user_message_id': user_message_id, 'mode': mode, 'dry_run': dry_run})
    async def stop_agent(self, agent_id: str, note: str = '') -> dict: return await self.request('agent/stop', {'agent_id': agent_id, 'note': note})
    async def resume_agent(self, agent_id: str, note: str = '') -> dict: return await self.request('agent/resume', {'agent_id': agent_id, 'note': note})
    async def claim(self, **params: Any) -> dict: return await self.request('session/claim', params)

    async def close(self) -> None:
        if not self._closed: self.child.stdin.close()
        try: await asyncio.wait_for(asyncio.shield(self.exit), 5)
        except asyncio.TimeoutError:
            if self.child.returncode is None: self.child.terminate()
            await self.exit

    async def __aenter__(self) -> MercurySession: return self
    async def __aexit__(self, *exc: Any) -> None: await self.close()
    def __aiter__(self) -> AsyncIterator[StreamRow]: return self
    async def __anext__(self) -> StreamRow:
        if self._closed and self._queue.empty(): raise self._closed
        row = await self._queue.get()
        if row is None: raise self._closed or StopAsyncIteration()
        return row


async def connect(*, on_permission_request: Callable | None = None, on_elicitation: Callable | None = None, handlers: dict[str, Callable] | None = None, capabilities: dict | None = None, host: dict | None = None, options: RunOptions | None = None, **kwargs: Any) -> MercurySession:
    opts = options or RunOptions(**kwargs)
    if opts.session_id is None: opts.session_id = str(uuid.uuid4())
    args = argv_of(opts)
    i = args.index('run')
    args[i:i + 3] = ['runner']
    callbacks = dict(handlers or {})
    if on_permission_request: callbacks['permission/request'] = on_permission_request
    if on_elicitation: callbacks['elicitation/request'] = on_elicitation
    try:
        child = await asyncio.create_subprocess_exec(*args, cwd=opts.cwd, env=opts.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=MAX_LINE_BYTES)
    except OSError as error: raise MercurySpawnError(args[0], error) from error
    session = MercurySession(child, callbacks)
    try:
        session.initialized = await session.request('initialize', {'protocol': RUNNER_PROTOCOL, 'host': host or {'name': 'mercury-cli-sdk', 'version': '0.1.0'}, 'capabilities': {'holds_asks': 'permission/request' in callbacks, 'elicitation': 'elicitation/request' in callbacks, 'partial_rows': opts.partial, **(capabilities or {})}})
        return session
    except BaseException:
        await session.close()
        raise

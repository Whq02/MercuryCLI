from __future__ import annotations
import asyncio
import inspect
import json
import uuid
from contextlib import suppress
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, AsyncIterator, Literal, Mapping, TypeVar, Unpack, cast, overload
from .client import ConnectKwargs, Listener, RunOptions, argv_of, end_child, exit_of, prepare_tools, send_signal, spawn, untrack, warm_options
from .errors import MercuryError, MercuryExitError, MercuryRefusal, MercuryUsageError, MercuryWireError, RunExit
from .generated import InitializeResultFile_checkpoints, TypedOutcome, FsReadTextFileParams, FsReadTextFileResult, FsWriteTextFileParams, FsWriteTextFileResult, DEFAULT_TIMEOUT, METHODS, RUNNER_PROTOCOL, RPC_REFUSED, DefaultTimeout, TypedRequests, ElicitationRequestParams, ElicitationRequestResult, InitializeParamsCapabilities, InitializeParamsHost, InputRow, OutcomeRow, InitializeResult, PermissionRequestParams, PermissionRequestResult, QueueAddResult, SessionFactsResult, TurnInterruptResult, QueueWithdrawResult, SessionSetModelResult, SessionSetEffortResult, SessionSetModeResult, SessionSetKitResult, SessionRewindResult, AgentStopResult, AgentResumeResult, SessionClaimParams, SessionClaimResult, McpToolsResult, McpActionResult, SessionPauseGateResult, SessionQuiesceResult, SessionLeaveResult, SessionSetSpawnSwitchResult, ShellBackgroundResult
from .framing import read_lines
from .structured import MercurySchemaError, StructuredSchema, schema_object, schema_refusal, validate_outcome

T = TypeVar('T')
from .helpers import ToolServer
from .parse import Issue, StreamRow, cap_queue, cap_rows, clear_queue, row_of, input_row_of, validate
from .version import __version__


@dataclass
class RequestContext:
    """Handed to every host handler: the request id, an event set when the runner cancels the ask, and its reason."""
    id: int
    cancelled: asyncio.Event
    reason: str | None = None


HostHandler = Callable[[Any, RequestContext], Any]
PermissionHandler = Callable[[PermissionRequestParams, RequestContext], PermissionRequestResult | Awaitable[PermissionRequestResult]]
ElicitationHandler = Callable[[ElicitationRequestParams, RequestContext], ElicitationRequestResult | Awaitable[ElicitationRequestResult]]


ReadTextFileHandler = Callable[[FsReadTextFileParams, RequestContext], FsReadTextFileResult | Awaitable[FsReadTextFileResult]]
WriteTextFileHandler = Callable[[FsWriteTextFileParams, RequestContext], FsWriteTextFileResult | None | Awaitable[FsWriteTextFileResult | None]]


class MercurySession(TypedRequests):
    """One ``mercury runner`` process hosted over JSON-RPC: prompts go in, rows stream out, asks are answered by your handlers.

    ``request(method, params, timeout=...)`` and ``notify(method, params)`` are typed per method by the generated overloads."""
    def __init__(self, child: asyncio.subprocess.Process, handlers: Mapping[str, HostHandler], tools: ToolServer | None = None, options: RunOptions | None = None):
        self.options = options or RunOptions()
        self._tools = tools
        self.child = child
        assert child.stdin is not None and child.stdout is not None and child.stderr is not None
        self._stdin = child.stdin
        self._stdout = child.stdout
        self._stderr = child.stderr
        self.handlers: dict[str, HostHandler] = dict(handlers)
        self.initialized: InitializeResult
        self.rows: list[StreamRow] = []
        self.stderr = ''
        self.last_prompt_id: str | None = None
        self.exit: asyncio.Future[RunExit] = asyncio.get_running_loop().create_future()
        self._closed: Exception | None = None
        self._pending: dict[int, tuple[str, asyncio.Future[Any]]] = {}
        self._asks: dict[int, tuple[RequestContext, asyncio.Task[None]]] = {}
        self._listeners: dict[str, list[Listener]] = {}
        self._queue: asyncio.Queue[StreamRow | None] = asyncio.Queue()
        self._next = 0
        self._prompting = False
        self._prompt_turns: dict[str, str | None] = {}
        self._correlated_turns = False
        self._closing = False
        self._normal_end = False
        self._prompt_error: Callable[[Exception], None] | None = None
        self._reader = asyncio.create_task(self._read())

    def on(self, type: str, listener: Listener) -> MercurySession:
        """Listen for one row type, ``'row'`` (every row), ``'notification'`` or ``'error'``."""
        self._listeners.setdefault(type, []).append(listener)
        return self

    def off(self, type: str, listener: Listener) -> MercurySession:
        if listener in self._listeners.get(type, []): self._listeners[type].remove(listener)
        return self

    def _emit(self, type: str, value: Any) -> None:
        for fn in tuple(self._listeners.get(type, [])): fn(value)

    async def _write(self, value: Any) -> None:
        if self._closed: raise self._closed
        if self.child.returncode is not None or self._stdin.is_closing(): raise MercuryError('runner input is not open', self.exit.result() if self.exit.done() else None)
        try:
            self._stdin.write((json.dumps(value) + '\n').encode())
            await self._stdin.drain()
        except OSError as error: raise MercuryError(str(error), self.exit.result() if self.exit.done() else None) from error

    async def _request(self, method: str, params: Any = None, *, timeout: float | None | DefaultTimeout = DEFAULT_TIMEOUT) -> Any:
        spec = METHODS.get(method)
        if not spec or spec['kind'] != 'request' or spec['from'] == 'runner': raise MercuryError(f'not a host request: {method}')
        if self._closed: raise self._closed
        params = {} if params is None else params
        if method == 'queue/add':
            read = input_row_of(params)
            if not read.ok: raise MercuryWireError(json.dumps(params), read.reason or 'invalid', read.type, read.issues)
        issues = validate(spec['params'], params)
        if issues: raise MercuryWireError(json.dumps(params), 'invalid', method, issues)
        self._next += 1
        id = self._next
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[id] = (method, future)
        limit = (None if spec['deadlineMs'] is None else spec['deadlineMs'] / 1000) if isinstance(timeout, DefaultTimeout) else timeout
        try:
            await self._write({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params})
            return await asyncio.wait_for(future, limit)
        except (asyncio.TimeoutError, asyncio.CancelledError) as error:
            with suppress(Exception):
                await self.notify('$/cancel_request', {'request_id': id, 'reason': 'host request cancelled'})
            if isinstance(error, asyncio.TimeoutError): raise MercuryError(f'{method}: no answer within {limit} seconds') from error
            raise
        finally:
            self._pending.pop(id, None)

    async def _notify(self, method: str, params: Any = None) -> None:
        spec = METHODS.get(method)
        if not spec or spec['kind'] != 'notification' or spec['from'] == 'runner': raise MercuryError(f'not a host notification: {method}')
        params = {} if params is None else params
        issues = validate(spec['params'], params)
        if issues: raise MercuryWireError(json.dumps(params), 'invalid', method, issues)
        await self._write({'jsonrpc': '2.0', 'method': method, 'params': params})

    async def _answer(self, message: dict[str, Any], context: RequestContext) -> None:
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
            if value is None and not validate(spec['result'], {}): value = {}
            issues = validate(spec['result'], value)
            if issues: raise MercuryWireError(json.dumps(value), 'invalid', method, issues)
            if not context.cancelled.is_set(): await self._write({'jsonrpc': '2.0', 'id': id, 'result': value})
        except Exception as error:
            if not context.cancelled.is_set() and not self._closed:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32603, 'message': str(error)}})
        finally:
            self._asks.pop(id, None)

    async def _read(self) -> None:
        stderr = asyncio.create_task(self._stderr.read())
        try:
            async for line in read_lines(self._stdout):
                if not line.strip(): continue
                try: message = json.loads(line)
                except json.JSONDecodeError as error: raise MercuryWireError(line, 'not_json') from error
                if not isinstance(message, dict) or message.get('jsonrpc') != '2.0': raise MercuryWireError(line, 'invalid')
                method, id = message.get('method'), message.get('id')
                if 'method' in message and not isinstance(method, str): raise MercuryWireError(line, 'invalid')
                params: dict[str, Any] = message['params'] if isinstance(message.get('params'), dict) else {}
                if method is None:
                    if id is None and 'id' in message and 'result' not in message and isinstance(message.get('error'), dict):
                        error = message['error']
                        if type(error.get('code')) is int and isinstance(error.get('message'), str):
                            raise MercuryError(error['message'], code=error['code'], data=error.get('data'))
                    if not isinstance(id, int) or isinstance(id, bool) or id <= 0: raise MercuryWireError(line, 'invalid')
                    if ('result' in message) == ('error' in message): raise MercuryWireError(line, 'invalid')
                    if 'error' in message:
                        error = message['error']
                        if not isinstance(error, dict) or type(error.get('code')) is not int or not isinstance(error.get('message'), str): raise MercuryWireError(line, 'invalid')
                    entry = self._pending.get(id)
                    if entry is None: continue
                    sent, future = entry
                    if future.done(): continue
                    if 'error' in message:
                        e = message['error']
                        future.set_exception(MercuryRefusal(None, rpc=e) if e['code'] == RPC_REFUSED else schema_refusal(e) or MercuryError(e['message'], code=e['code'], data=e.get('data')))
                    else:
                        result = message.get('result')
                        issues = validate(METHODS[sent]['result'], result)
                        if issues: future.set_exception(MercuryWireError(line, 'invalid', sent, issues))
                        else: future.set_result(result)
                elif method == '$/cancel_request':
                    request_id = params.get('request_id')
                    ask = self._asks.get(request_id) if type(request_id) is int else None
                    if ask:
                        ask[0].reason = params.get('reason')
                        ask[0].cancelled.set()
                        ask[1].cancel()
                elif id is not None:
                    if type(id) is not int or id <= 0: raise MercuryWireError(line, 'invalid')
                    context = RequestContext(id, asyncio.Event())
                    task = asyncio.create_task(self._answer(message, context))
                    self._asks[id] = (context, task)
                elif method == 'row':
                    read = row_of(message.get('params'))
                    if not read.ok: raise MercuryWireError(line, read.reason or 'invalid', read.type, read.issues)
                    row = read.row
                    assert row is not None
                    self.rows.append(row)
                    cap_rows(self.rows, self.options.max_rows)
                    self._queue.put_nowait(row)
                    cap_queue(self._queue, self.options.max_rows)
                    if row['type'] == 'turn' and 'parent_call_id' not in row and 'message_ids' in row:
                        self._correlated_turns = True
                        for id in row['message_ids']:
                            if id in self._prompt_turns: self._prompt_turns[id] = row['turn_id']
                    self._emit('row', row)
                    self._emit(row['type'], row)
                    if row['type'] == 'outcome' and 'parent_call_id' not in row:
                        ids = [id for id, turn in self._prompt_turns.items() if turn == row['turn_id']] if self._correlated_turns else list(self._prompt_turns)[:1]
                        for id in ids: self._prompt_turns.pop(id, None)
                else: self._emit('notification', {'method': method, 'params': message.get('params')})
        except Exception as error:
            self._fail(error if isinstance(error, MercuryError) else MercuryWireError('', 'invalid', issues=[Issue('', str(error))]))
            self._stdin.close()
            await end_child(self.child)
        code = await self.child.wait()
        untrack(self.child)
        if self._tools: await self._tools.close()
        self.stderr = (await stderr).decode('utf-8', errors='replace')
        exit = exit_of(self.child, code, self.stderr)
        self._fail(MercuryUsageError(exit, 'runner') if code == 2 and not hasattr(self, 'initialized') else MercuryExitError(exit, 'runner'), self._closing)
        self.exit.set_result(exit)

    def _fail(self, error: Exception, graceful: bool = False) -> None:
        if self._closed: return
        self._closed = error
        self._normal_end = graceful
        if self._prompt_error: self._prompt_error(error)
        for _, future in self._pending.values():
            if not future.done(): future.set_exception(error)
        for context, task in tuple(self._asks.values()):
            context.cancelled.set()
            task.cancel()
        self._queue.put_nowait(None)
        if not graceful: self._emit('error', error)

    async def send(self, row: InputRow) -> QueueAddResult:
        """Queue one input row (``queue/add``); a prompt row is given an id so its outcome can be matched."""
        if row['type'] != 'prompt': return await self.request('queue/add', row)
        if self.session_id is None: raise MercuryError('session is unclaimed; call claim() before prompting')
        id = row.get('id') or str(uuid.uuid4())
        self._prompt_turns[id] = None
        try:
            receipt = await self.request('queue/add', {**row, 'id': id})
            if receipt['accepted']: self.last_prompt_id = id
            else: self._prompt_turns.pop(id, None)
            return receipt
        except (MercuryRefusal, MercuryWireError, MercurySchemaError):
            self._prompt_turns.pop(id, None)
            raise

    async def send_prompt(self, content: Any, **options: Any) -> QueueAddResult:
        return await self.send(cast(InputRow, {**options, 'type': 'prompt', 'content': content}))

    async def steer(self, content: Any, *, id: str | None = None, schema: dict[str, Any] | None = None) -> QueueAddResult:
        return await self.send_prompt(content, priority='now', **({} if id is None else {'id': id}), **({} if schema is None else {'schema': schema}))
    async def follow_up(self, content: Any, *, id: str | None = None, schema: dict[str, Any] | None = None) -> QueueAddResult:
        return await self.send_prompt(content, priority='later', **({} if id is None else {'id': id}), **({} if schema is None else {'schema': schema}))

    async def send_shell(self, command: str, **options: Any) -> QueueAddResult:
        return await self.send(cast(InputRow, {**options, 'type': 'shell', 'command': command}))

    async def send_note(self, to: str, content: str, **options: Any) -> QueueAddResult:
        return await self.send(cast(InputRow, {**options, 'type': 'note', 'to': to, 'content': content}))

    @overload
    async def prompt(self, content: Any, *, schema: StructuredSchema[T], timeout: float | None = None, cancel: asyncio.Event | None = None, interrupt_on_cancel: bool = False) -> TypedOutcome[T]: ...
    @overload
    async def prompt(self, content: Any, *, schema: str | dict[str, Any] | None = None, timeout: float | None = None, cancel: asyncio.Event | None = None, interrupt_on_cancel: bool = False) -> OutcomeRow: ...
    async def prompt(self, content: Any, *, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, timeout: float | None = None, cancel: asyncio.Event | None = None, interrupt_on_cancel: bool = False) -> OutcomeRow:
        """Queue a prompt and await the outcome of the turn it starts; cancelling the await stops waiting, not the turn."""
        if self._prompting: raise MercuryError('prompt already pending; use send_prompt for mid-turn input')
        if cancel is not None and cancel.is_set(): raise MercuryError('prompt: cancelled')
        self._prompting = True
        id = str(uuid.uuid4())
        accepted = False
        future: asyncio.Future[OutcomeRow] = asyncio.get_running_loop().create_future()
        def done(row: OutcomeRow) -> None:
            matches = self._prompt_turns.get(id) == row['turn_id'] if self._correlated_turns else next(iter(self._prompt_turns), None) == id
            if matches and 'parent_call_id' not in row and not future.done(): future.set_result(row)
        def fail(error: Exception) -> None:
            if not future.done(): future.set_exception(error)
        async def watch_cancel() -> None:
            assert cancel is not None
            await cancel.wait()
            if self._prompt_turns.get(id) is None: self._prompt_turns.pop(id, None)
            fail(MercuryError('prompt: cancelled'))
        cancel_task = asyncio.create_task(watch_cancel()) if cancel is not None else None
        self._prompt_error = fail
        self.on('outcome', done)
        turn_schema = None if schema is None else schema_object(schema, self.options.cwd)
        try:
            receipt = await self.send_prompt(content, id=id, **({} if turn_schema is None else {'schema': turn_schema}))
            if not receipt['accepted']: raise MercuryError('prompt was not accepted')
            accepted = True
            try:
                row = await (future if timeout is None else asyncio.wait_for(future, timeout))
            except asyncio.TimeoutError as error:
                raise MercuryError(f'prompt: no answer within {timeout} seconds') from error
            if row['status'] == 'refused': raise MercuryRefusal(row)
            return validate_outcome(row, schema if schema is not None else self.options.schema, self.options.cwd)
        except BaseException:
            if accepted and interrupt_on_cancel and not self._closed:
                with suppress(Exception): await asyncio.shield(self.interrupt())
            raise
        finally:
            if cancel_task is not None: cancel_task.cancel()
            if self._prompt_turns.get(id) is None: self._prompt_turns.pop(id, None)
            if future.done() and not future.cancelled(): future.exception()
            self.off('outcome', done)
            self._prompt_error = None
            self._prompting = False

    @property
    def session_id(self) -> str | None: return self.initialized['session_id'] if hasattr(self, 'initialized') else None

    @property
    def file_checkpoints(self) -> InitializeResultFile_checkpoints | None:
        """What the CLI answered on ``initialize``: whether file checkpoints are captured and why (``source``)."""
        return getattr(self, 'initialized', {}).get('file_checkpoints')

    async def facts(self) -> SessionFactsResult: return await self.request('session/facts')
    async def interrupt(self, **options: Any) -> TurnInterruptResult:
        if self._tools: self._tools.cancel()
        return await self.request('turn/interrupt', options)
    async def withdraw(self, id: str) -> QueueWithdrawResult:
        receipt = await self.request('queue/withdraw', {'id': id})
        if receipt['withdrawn']: self._prompt_turns.pop(id, None)
        return receipt
    async def set_model(self, model: str) -> SessionSetModelResult: return await self.request('session/set_model', {'model': model})
    async def set_effort(self, effort: str) -> SessionSetEffortResult: return await self.request('session/set_effort', {'effort': effort})
    async def set_mode(self, mode: str) -> SessionSetModeResult: return await self.request('session/set_mode', {'mode': mode})
    async def set_kit(self, kit: Any) -> SessionSetKitResult: return await self.request('session/set_kit', {'kit': kit})
    async def rewind(self, user_message_id: str, mode: str, dry_run: bool = False) -> SessionRewindResult: return await self.request('session/rewind', {'user_message_id': user_message_id, 'mode': mode, 'dry_run': dry_run})
    async def stop_agent(self, agent_id: str, note: str | None = None) -> AgentStopResult: return await self.request('agent/stop', {'agent_id': agent_id, **({'note': note} if note is not None else {})})
    async def resume_agent(self, agent_id: str, note: str | None = None) -> AgentResumeResult: return await self.request('agent/resume', {'agent_id': agent_id, **({'note': note} if note is not None else {})})
    async def mcp_tools(self, name: str) -> McpToolsResult: return await self.request('mcp/tools', {'name': name})
    async def mcp_action(self, name: str, action: Literal['authenticate', 'reconnect', 'cancel-auth']) -> McpActionResult: return await self.request('mcp/action', {'name': name, 'action': action})
    async def pause_gate(self, paused: bool) -> SessionPauseGateResult: return await self.request('session/pause_gate', {'paused': paused})
    async def quiesce(self, action: Literal['prepare', 'commit', 'cancel'], token: str) -> SessionQuiesceResult: return await self.request('session/quiesce', {'action': action, 'token': token})
    async def leave(self) -> SessionLeaveResult: return await self.request('session/leave')
    async def set_spawn_switch(self, switch: Literal['subagents', 'workflows'], on: bool) -> SessionSetSpawnSwitchResult: return await self.request('session/set_spawn_switch', {'switch': switch, 'on': on})
    async def background_shell(self) -> ShellBackgroundResult: return await self.request('shell/background')
    async def notify_credentials_changed(self, params: dict[str, Any] | None = None) -> None: await self.notify('credentials/changed', params)
    async def claim(self, *, session_id: str, model: str | None = None, mode: str | None = None, effort: str | None = None, resume: bool | None = None, restart_reason: str | None = None, openai_catalogue: Any = None) -> SessionClaimResult:
        params: SessionClaimParams = {'session_id': session_id}
        if model is not None: params['model'] = model
        if mode is not None: params['mode'] = mode
        if effort is not None: params['effort'] = effort
        if resume is not None: params['resume'] = resume
        if restart_reason is not None: params['restart_reason'] = restart_reason
        if openai_catalogue is not None: params['openai_catalogue'] = openai_catalogue
        receipt = await self.request('session/claim', params)
        self.initialized['session_id'] = receipt['session_id']
        return receipt

    def clear_rows(self) -> None:
        self.rows.clear()
        clear_queue(self._queue)

    async def close(self) -> None:
        """End stdin and wait for the runner to exit; SIGTERM after five seconds, SIGKILL after ten."""
        self._closing = True
        if self._tools: self._tools.cancel()
        self._stdin.close()
        try: await asyncio.wait_for(asyncio.shield(self.exit), 5)
        except asyncio.TimeoutError:
            send_signal(self.child, 'SIGTERM')
            try: await asyncio.wait_for(asyncio.shield(self.exit), 5)
            except asyncio.TimeoutError:
                send_signal(self.child, 'SIGKILL')
                await self.exit

    async def __aenter__(self) -> MercurySession: return self
    async def __aexit__(self, *exc: Any) -> None: await self.close()
    def __aiter__(self) -> AsyncIterator[StreamRow]: return self
    async def __anext__(self) -> StreamRow:
        if self._closed and self._queue.empty():
            if self._normal_end: raise StopAsyncIteration
            raise self._closed
        row = await self._queue.get()
        if row is None:
            if self._normal_end: raise StopAsyncIteration
            raise self._closed or StopAsyncIteration()
        return row


async def connect(*, warm: bool = False, checkpoints: bool = True, timeout: float | None = None, on_read_text_file: ReadTextFileHandler | None = None, on_write_text_file: WriteTextFileHandler | None = None, on_permission_request: PermissionHandler | None = None, on_elicitation: ElicitationHandler | None = None, handlers: Mapping[str, HostHandler] | None = None, capabilities: Mapping[str, Any] | None = None, host: InitializeParamsHost | None = None, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, options: RunOptions | None = None, **kwargs: Unpack[ConnectKwargs]) -> MercurySession:
    """Start ``mercury runner`` and complete ``initialize`` (within ``timeout`` seconds when given), asking for file checkpoints unless ``checkpoints=False``; the keyword arguments are ``RunOptions`` fields."""
    overrides: dict[str, Any] = dict(kwargs)
    if schema is not None: overrides['schema'] = schema
    opts = replace(options, **overrides) if options is not None else RunOptions(**overrides)
    if warm and (opts.session_id or opts.resume or opts.continue_ or opts.fork): raise MercuryError('warm cannot be combined with session identity options')
    if warm: opts = warm_options(opts)
    if opts.schema is not None and not isinstance(opts.schema, StructuredSchema): opts = replace(opts, schema=schema_object(opts.schema, opts.cwd))
    opts, tools = await prepare_tools(opts)
    args = argv_of(replace(opts, partial=False, prompt=None, input=None, stdin=None), 'runner')
    callbacks: dict[str, HostHandler] = dict(handlers or {})
    if on_permission_request: callbacks['permission/request'] = on_permission_request
    if on_elicitation: callbacks['elicitation/request'] = on_elicitation
    if on_read_text_file: callbacks['fs/read_text_file'] = on_read_text_file
    if on_write_text_file: callbacks['fs/write_text_file'] = on_write_text_file
    try: child = await spawn(args, opts)
    except BaseException:
        if tools: await tools.close()
        raise
    session = MercurySession(child, callbacks, tools, opts)
    try:
        declared: InitializeParamsCapabilities = {'holds_asks': 'permission/request' in callbacks, 'elicitation': 'elicitation/request' in callbacks, 'partial_rows': opts.partial, 'fs_read_text_file': 'fs/read_text_file' in callbacks, 'fs_write_text_file': 'fs/write_text_file' in callbacks, 'terminal': all(name in callbacks for name in ('terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release'))}
        boot: dict[str, Any] = {'protocol': RUNNER_PROTOCOL, 'host': host or {'name': 'mercury-cli-sdk', 'version': __version__}, 'capabilities': {**declared, **(capabilities or {})}, 'file_checkpoints': checkpoints}
        if opts.schema is not None: boot['schema'] = schema_object(opts.schema, opts.cwd)
        session.initialized = await session.request('initialize', boot, timeout=timeout)
        return session
    except BaseException:
        await session.close()
        raise


async def prewarm(*, checkpoints: bool = True, timeout: float | None = None, on_read_text_file: ReadTextFileHandler | None = None, on_write_text_file: WriteTextFileHandler | None = None, on_permission_request: PermissionHandler | None = None, on_elicitation: ElicitationHandler | None = None, handlers: Mapping[str, HostHandler] | None = None, capabilities: Mapping[str, Any] | None = None, host: InitializeParamsHost | None = None, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, options: RunOptions | None = None, **kwargs: Unpack[ConnectKwargs]) -> MercurySession:
    """``connect(warm=True)``: an unclaimed runner to ``claim`` before prompting."""
    return await connect(warm=True, checkpoints=checkpoints, timeout=timeout, on_read_text_file=on_read_text_file, on_write_text_file=on_write_text_file, on_permission_request=on_permission_request, on_elicitation=on_elicitation, handlers=handlers, capabilities=capabilities, host=host, schema=schema, options=options, **kwargs)

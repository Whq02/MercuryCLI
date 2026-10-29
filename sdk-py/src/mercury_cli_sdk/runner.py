from __future__ import annotations
import asyncio
import inspect
import json
import uuid
from contextlib import suppress
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, AsyncIterator, Literal, Mapping, TypeVar, Unpack, cast, overload
from .client import ConnectKwargs, Listener, RunOptions, argv_of, end_child, exit_of, prepare_tools, read_stderr, send_signal, spawn, untrack, warm_options
from .errors import MercuryConnectionError, MercuryError, MercuryExitError, MercuryRefusal, MercuryTimeoutError, MercuryUsageError, MercuryWireError, RunExit
from .generated import InitializeResultFile_checkpoints, TypedOutcome, FsReadTextFileParams, FsReadTextFileResult, FsWriteTextFileParams, FsWriteTextFileResult, DEFAULT_TIMEOUT, METHODS, RUNNER_PROTOCOL, RPC_REFUSED, DefaultTimeout, TypedRequests, ElicitationRequestParams, ElicitationRequestResult, InitializeParamsCapabilities, InitializeParamsHost, InputRow, OutcomeRow, InitializeResult, PermissionRequestParams, PermissionRequestResult, QueueAddResult, SessionFactsResult, TurnInterruptResult, QueueWithdrawResult, SessionSetModelResult, SessionSetEffortResult, SessionSetModeResult, SessionSetKitResult, SessionRewindResult, AgentStopResult, AgentResumeResult, SessionClaimParams, SessionClaimResult, McpToolsResult, McpActionResult, SessionPauseGateResult, SessionQuiesceResult, SessionLeaveResult, SessionSetSpawnSwitchResult, ShellBackgroundResult, SessionSendNowResult
from .framing import read_lines
from .structured import MercurySchemaError, StructuredSchema, schema_object, schema_problem, schema_refusal, validate_outcome
from .support import RunnerSupport, runner_support, unsupported_feature

T = TypeVar('T')
from .helpers import ToolServer
from .parse import Issue, PromptContent, StreamRow, cap_queue, cap_rows, clear_queue, row_of, input_row_of, validate
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


@dataclass
class _PromptWait:
    id: str
    fail: Callable[[Exception], None]
    handles: list[asyncio.TimerHandle] = field(default_factory=list)
    tasks: list[asyncio.Task[None]] = field(default_factory=list)


FOLD_GRACE_SECONDS = 5.0


def folded_prompt_words(turn: int | None, status: str) -> str:
    return f'prompt: turn {"?" if turn is None else turn} ended {status} and the runner holds this prompt neither queued nor in a turn; a prompt sent while a turn runs can be folded into that turn, so interrupt() it or await its outcome before prompting again'


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
        self._queue: asyncio.Queue[StreamRow] = asyncio.Queue()
        self._waiters: dict[asyncio.Future[StreamRow], None] = {}
        self._submissions: set[asyncio.Task[None]] = set()
        self._next = 0
        self._prompting = False
        self._prompt_turns: dict[str, str | None] = {}
        self._correlated_turns = False
        self._closing = False
        self._normal_end = False
        self._prompt_wait: _PromptWait | None = None
        self._active_turn: str | None = None
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
        if self._closing: raise MercuryConnectionError('session is closing or closed; connect a new session before sending requests')
        if self._closed: raise self._closed
        if self.child.returncode is not None or self._stdin.is_closing(): raise MercuryConnectionError('runner input is not open; reconnect before sending more requests', self.exit.result() if self.exit.done() else None)
        try:
            self._stdin.write((json.dumps(value) + '\n').encode())
            await self._stdin.drain()
        except OSError as error: raise MercuryConnectionError(f'runner input failed: {error}; reconnect before sending more requests', self.exit.result() if self.exit.done() else None) from error

    async def _request(self, method: str, params: Any = None, *, timeout: float | None | DefaultTimeout = DEFAULT_TIMEOUT) -> Any:
        spec = METHODS.get(method)
        if not spec or spec['kind'] != 'request' or spec['from'] == 'runner': raise MercuryError(f'not a host request: {method}')
        if self._closing: raise MercuryConnectionError('session is closing or closed; connect a new session before sending requests')
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
        async def exchange() -> Any:
            await self._write({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params})
            return await future
        try:
            return await asyncio.wait_for(exchange(), limit)
        except (asyncio.TimeoutError, asyncio.CancelledError) as error:
            with suppress(Exception):
                if not self._closing and not self._closed:
                    self._stdin.write((json.dumps({'jsonrpc': '2.0', 'method': '$/cancel_request', 'params': {'request_id': id, 'reason': 'host request cancelled'}}) + '\n').encode())
            if isinstance(error, asyncio.TimeoutError): raise MercuryTimeoutError(method, cast(float, limit)) from error
            raise
        finally:
            self._pending.pop(id, None)
            if not future.done(): future.cancel()
            elif not future.cancelled(): future.exception()

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
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': f'unknown host method {method}'}})
                return
            issues = validate(spec['params'], message.get('params', {}))
            if issues:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32602, 'message': 'invalid request params', 'data': [{'path': i.path, 'message': i.message} for i in issues]}})
                return
            handler = self.handlers.get(method)
            if handler:
                value = handler(message.get('params', {}), context)
                if inspect.isawaitable(value): value = await value
            elif method == 'permission/request': value = {'outcome': 'deny', 'message': 'No permission handler installed'}
            elif method == 'elicitation/request': value = {'action': 'decline'}
            else:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': f'no handler for {method}'}})
                return
            if value is None and not validate(spec['result'], {}): value = {}
            issues = validate(spec['result'], value)
            if issues: raise MercuryError(f"invalid host answer: {json.dumps([{'path': i.path, 'message': i.message} for i in issues])}")
            if not context.cancelled.is_set(): await self._write({'jsonrpc': '2.0', 'id': id, 'result': value})
        except Exception as error:
            if not context.cancelled.is_set() and not self._closed and not self._closing:
                await self._write({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32603, 'message': str(error)}})
        finally:
            self._asks.pop(id, None)

    async def _read(self) -> None:
        stderr = asyncio.create_task(read_stderr(self))
        try:
            async for line in read_lines(self._stdout):
                if not line.strip(): continue
                try: message = json.loads(line)
                except json.JSONDecodeError as error: raise MercuryWireError(line, 'not_json') from error
                if not isinstance(message, dict) or message.get('jsonrpc') != '2.0': raise MercuryWireError(line, 'invalid')
                method, id = message.get('method'), message.get('id')
                if 'method' in message and not isinstance(method, str): raise MercuryWireError(line, 'invalid')
                if isinstance(method, str) and 'id' not in message and method != 'row':
                    spec = METHODS.get(method)
                    if spec:
                        issues = validate(spec['params'], message.get('params', {}))
                        if spec['kind'] != 'notification' or spec['from'] == 'host' or issues: raise MercuryWireError(line, 'invalid', method, issues)
                if 'method' in message and 'id' in message and (type(id) is not int or id <= 0): raise MercuryWireError(line, 'invalid', method)
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
                elif method == '$/cancel_request' and 'id' not in message:
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
                    waiter = next((future for future in self._waiters if not future.done()), None)
                    if waiter is not None: waiter.set_result(row)
                    else:
                        self._queue.put_nowait(row)
                        cap_queue(self._queue, self.options.max_rows)
                    if row['type'] == 'turn' and 'parent_call_id' not in row and row.get('state') == 'started': self._active_turn = row['turn_id']
                    if row['type'] == 'turn' and 'parent_call_id' not in row and 'message_ids' in row:
                        self._correlated_turns = True
                        for id in row['message_ids']:
                            if id in self._prompt_turns: self._prompt_turns[id] = row['turn_id']
                    if row['type'] == 'text' and 'parent_call_id' not in row and row.get('in_reply_to') and self._correlated_turns and self._active_turn is not None:
                        for mark in row.get('in_reply_to') or []:
                            if self._uncorrelated(mark['id']): self._prompt_turns[mark['id']] = self._active_turn
                    self._emit('row', row)
                    self._emit(row['type'], row)
                    if row['type'] == 'outcome' and 'parent_call_id' not in row:
                        ids = [id for id, turn in self._prompt_turns.items() if turn == row['turn_id']] if self._correlated_turns else list(self._prompt_turns)[:1]
                        for id in ids: self._prompt_turns.pop(id, None)
                        if self._active_turn == row['turn_id']: self._active_turn = None
                        wait = self._prompt_wait
                        if self._correlated_turns and wait is not None and self._uncorrelated(wait.id): self._reconcile(wait, row)
                else: self._emit('notification', {'method': method, 'params': message.get('params')})
            if not self._closing:
                try: await asyncio.wait_for(self.child.wait(), 0.1)
                except asyncio.TimeoutError as error: raise MercuryConnectionError('runner output closed while the process was still running; reconnect before sending more requests') from error
        except Exception as error:
            self._fail(error if isinstance(error, MercuryError) else MercuryWireError('', 'invalid', issues=[Issue('', str(error))]))
            self._stdin.close()
            send_signal(self.child, 'SIGTERM')
            await end_child(self.child)
        code = await self.child.wait()
        with suppress(OSError): await self._stdin.wait_closed()
        untrack(self.child)
        if self._tools: await self._tools.close()
        await stderr
        exit = exit_of(self.child, code, self.stderr)
        self._fail(MercuryUsageError(exit, 'runner') if code == 2 and not hasattr(self, 'initialized') else MercuryExitError(exit, 'runner'), self._closing)
        if self._submissions: await asyncio.gather(*self._submissions, return_exceptions=True)
        self.exit.set_result(exit)

    def _uncorrelated(self, id: str) -> bool: return id in self._prompt_turns and self._prompt_turns[id] is None

    def _reconcile(self, wait: _PromptWait, outcome: OutcomeRow) -> None:
        loop = asyncio.get_running_loop()
        def unsettled() -> bool: return self._prompt_wait is wait and self._uncorrelated(wait.id) and not self._closed
        def give_up() -> None:
            if unsettled(): wait.fail(MercuryError(folded_prompt_words(outcome.get('turn'), outcome['status'])))
        async def probe() -> None:
            if not unsettled(): return
            try: facts = await self.request('session/facts')
            except Exception: return
            if not unsettled() or any(item.get('uuid') == wait.id for item in facts['queue']): return
            wait.handles.append(loop.call_later(FOLD_GRACE_SECONDS, give_up))
        wait.handles.append(loop.call_later(0, lambda: wait.tasks.append(asyncio.create_task(probe()))))

    def _fail(self, error: Exception, graceful: bool = False) -> None:
        if self._closed: return
        self._closed = error
        self._normal_end = graceful
        if self._prompt_wait is not None: self._prompt_wait.fail(error)
        for _, future in self._pending.values():
            if not future.done(): future.set_exception(error)
        for context, task in tuple(self._asks.values()):
            context.cancelled.set()
            task.cancel()
        for task in tuple(self._submissions): task.cancel()
        for waiter in self._waiters:
            if not waiter.done(): waiter.set_exception(StopAsyncIteration() if graceful else error)
        if not graceful: self._emit('error', error)

    async def send(self, row: InputRow) -> QueueAddResult:
        """Queue one input row (``queue/add``); a prompt row is given an id so its outcome can be matched."""
        if row['type'] != 'prompt': return await self.request('queue/add', row)
        if self.session_id is None: raise MercuryError('session is unclaimed; call claim() before prompting')
        if row.get('schema') is not None and not self.supports['per_turn_schema']: raise unsupported_feature('per_turn_schema', self.runner_version or 'unknown')
        turn_schema = row.get('schema')
        problem = None if turn_schema is None else schema_problem(turn_schema)
        if problem is not None: raise MercurySchemaError([Issue('schema', problem)], None, problem)
        id = row.get('id') or str(uuid.uuid4())
        self._prompt_turns[id] = None
        try:
            receipt = await self.request('queue/add', {**row, 'id': id})
            if receipt['accepted']: self.last_prompt_id = id
            else: self._prompt_turns.pop(id, None)
            return receipt
        except MercuryError as error:
            if isinstance(error, (MercuryRefusal, MercuryWireError, MercurySchemaError)) or error.code is not None: self._prompt_turns.pop(id, None)
            raise

    async def send_prompt(self, content: PromptContent, **options: Any) -> QueueAddResult:
        return await self.send(cast(InputRow, {**options, 'type': 'prompt', 'content': content if isinstance(content, str) else list(content)}))

    async def steer(self, content: PromptContent, *, id: str | None = None, schema: dict[str, Any] | None = None) -> QueueAddResult:
        return await self.send_prompt(content, priority='now', **({} if id is None else {'id': id}), **({} if schema is None else {'schema': schema}))
    async def follow_up(self, content: PromptContent, *, id: str | None = None, schema: dict[str, Any] | None = None) -> QueueAddResult:
        return await self.send_prompt(content, priority='later', **({} if id is None else {'id': id}), **({} if schema is None else {'schema': schema}))

    async def send_shell(self, command: str, **options: Any) -> QueueAddResult:
        return await self.send(cast(InputRow, {**options, 'type': 'shell', 'command': command}))

    async def send_note(self, to: str, content: str, **options: Any) -> QueueAddResult:
        return await self.send(cast(InputRow, {**options, 'type': 'note', 'to': to, 'content': content}))

    @overload
    async def prompt(self, content: PromptContent, *, schema: StructuredSchema[T], timeout: float | None = None, cancel: asyncio.Event | None = None, interrupt_on_cancel: bool = False) -> TypedOutcome[T]: ...
    @overload
    async def prompt(self, content: PromptContent, *, schema: str | dict[str, Any] | None = None, timeout: float | None = None, cancel: asyncio.Event | None = None, interrupt_on_cancel: bool = False) -> OutcomeRow: ...
    async def prompt(self, content: PromptContent, *, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, timeout: float | None = None, cancel: asyncio.Event | None = None, interrupt_on_cancel: bool = False) -> OutcomeRow:
        """Queue a prompt and await the outcome of the turn it starts; cancelling the await stops waiting, not the turn."""
        if self._prompting: raise MercuryError('prompt already pending; use send_prompt for mid-turn input')
        if cancel is not None and cancel.is_set(): raise MercuryError('prompt: cancelled')
        turn_schema = None if schema is None else schema_object(schema, self.options.cwd)
        if turn_schema is not None and not self.supports['per_turn_schema']: raise unsupported_feature('per_turn_schema', self.runner_version or 'unknown')
        self._prompting = True
        id = str(uuid.uuid4())
        accepted = False
        abandoned = False
        completed: OutcomeRow | None = None
        future: asyncio.Future[OutcomeRow] = asyncio.get_running_loop().create_future()
        def done(row: OutcomeRow) -> None:
            nonlocal completed
            matches = self._prompt_turns.get(id) == row['turn_id'] if self._correlated_turns else next(iter(self._prompt_turns), None) == id
            if matches and 'parent_call_id' not in row and not future.done():
                completed = row
                if accepted: future.set_result(row)
        def fail(error: Exception) -> None:
            if not future.done(): future.set_exception(error)
        async def watch_cancel() -> None:
            assert cancel is not None
            await cancel.wait()
            fail(MercuryError('prompt: cancelled'))
        cancel_task = asyncio.create_task(watch_cancel()) if cancel is not None else None
        timer = asyncio.get_running_loop().call_later(timeout, lambda: fail(MercuryTimeoutError('prompt', timeout))) if timeout is not None else None
        wait = _PromptWait(id, fail)
        self._prompt_wait = wait
        self.on('outcome', done)
        async def submit() -> None:
            nonlocal accepted
            try:
                receipt = await self.send_prompt(content, id=id, **({} if turn_schema is None else {'schema': turn_schema}))
                if not receipt['accepted']: raise MercuryError('prompt was not accepted')
                accepted = True
                if completed is not None and not future.done(): future.set_result(completed)
                if abandoned and interrupt_on_cancel and not self._closed: await self.interrupt()
            except Exception as error: fail(error)
        submission = asyncio.create_task(submit())
        self._submissions.add(submission)
        submission.add_done_callback(self._submissions.discard)
        try:
            row = await future
            if row['status'] == 'refused': raise MercuryRefusal(row)
            return validate_outcome(row, schema if schema is not None else self.options.schema, self.options.cwd)
        except BaseException:
            abandoned = True
            if accepted and interrupt_on_cancel and not self._closed:
                with suppress(Exception): await asyncio.shield(self.interrupt())
            raise
        finally:
            if timer is not None: timer.cancel()
            if cancel_task is not None: cancel_task.cancel()
            if self._prompt_turns.get(id) is None and ((not accepted and not abandoned) or self._correlated_turns): self._prompt_turns.pop(id, None)
            if future.done() and not future.cancelled(): future.exception()
            for handle in wait.handles: handle.cancel()
            for task in wait.tasks: task.cancel()
            self.off('outcome', done)
            self._prompt_wait = None
            self._prompting = False

    @property
    def session_id(self) -> str | None: return self.initialized['session_id'] if hasattr(self, 'initialized') else None

    @property
    def file_checkpoints(self) -> InitializeResultFile_checkpoints | None:
        """What the CLI answered on ``initialize``: whether file checkpoints are captured and why (``source``)."""
        return getattr(self, 'initialized', {}).get('file_checkpoints')

    @property
    def runner_version(self) -> str | None:
        """The connected Mercury's version, from the ``initialize`` answer."""
        return getattr(self, 'initialized', {}).get('runner', {}).get('version')

    @property
    def supports(self) -> RunnerSupport:
        """Which version-gated requests this runner honours (``FEATURE_FLOORS``); a request it cannot honour is refused before it is sent."""
        return runner_support(getattr(self, 'initialized', None))

    async def facts(self) -> SessionFactsResult: return await self.request('session/facts')
    async def interrupt(self, **options: Any) -> TurnInterruptResult:
        if self._tools: self._tools.cancel()
        return await self.request('turn/interrupt', options)
    async def withdraw(self, id: str) -> QueueWithdrawResult:
        receipt = await self.request('queue/withdraw', {'id': id})
        if receipt['withdrawn']:
            self._prompt_turns.pop(id, None)
            if self._prompt_wait is not None and id == self._prompt_wait.id: self._prompt_wait.fail(MercuryError('prompt: withdrawn'))
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
    async def send_now(self) -> SessionSendNowResult: return await self.request('session/send_now')
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
        """End stdin and wait for the runner to exit; SIGTERM after five seconds, SIGKILL after ten. Asks still in flight are cancelled, so nothing is written to the closed input."""
        self._closing = True
        if self._tools: self._tools.cancel()
        for context, task in tuple(self._asks.values()):
            context.cancelled.set()
            task.cancel()
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
        if not self._queue.empty(): return self._queue.get_nowait()
        if self._closed:
            if self._normal_end: raise StopAsyncIteration
            raise self._closed
        future: asyncio.Future[StreamRow] = asyncio.get_running_loop().create_future()
        self._waiters[future] = None
        try: return await future
        finally: self._waiters.pop(future, None)


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

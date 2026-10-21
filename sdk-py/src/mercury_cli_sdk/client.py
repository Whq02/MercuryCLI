from __future__ import annotations
import asyncio
import atexit
from datetime import datetime, timezone
import json
import os
import signal
import uuid
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, AsyncIterable, AsyncIterator, Literal, Generic, TypedDict, TypeVar, Unpack, cast, overload
from .errors import MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryUsageError, MercuryWireError, RunExit
from .generated import InputRow, OutcomeRow, SessionRow, TypedOutcome, MAX_LINE_BYTES, PermissionMode, EffortLevel, InputBlock
from .framing import read_lines
from .executable import executable_of
from .structured import StructuredSchema, schema_object, validate_outcome
from .helpers import ToolDefinition, ToolServer, serve_tools
from .parse import Issue, StreamRow, parse_row, input_row_of

Listener = Callable[[Any], object]


@dataclass
class RunOptions:
    """Everything ``run()`` and ``connect()`` accept; each field is one ``mercury run`` option (``continue_`` is ``--continue``)."""
    worktree: bool | str = False
    reasoning_mode: Literal['enabled', 'adaptive', 'disabled'] | None = None
    brief_file: str | None = None
    brief_add_file: str | None = None
    debug: bool | str = False
    checkpoint_files: bool = False
    replay_to: str | None = None
    restore_files: str | None = None
    tools: list[ToolDefinition] = field(default_factory=list)
    auto_allow_tools: bool = True
    prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None
    cancel: asyncio.Event | None = None
    mercury: str | list[str] | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    input: Literal['rows'] | None = None
    stdin: str | None = None
    project: str | None = None
    model: str | None = None
    effort: EffortLevel | None = None
    mode: PermissionMode | None = None
    agent: str | None = None
    agent_defs: dict[str, Any] | None = None
    backup_model: str | None = None
    sovereign: bool = False
    allow_sovereign: bool = False
    allowed_tools: list[str] = field(default_factory=list)
    block_tools: list[str] = field(default_factory=list)
    toolset: list[str] = field(default_factory=list)
    mcp: list[str] = field(default_factory=list)
    only_mcp: bool = False
    brief: str | None = None
    brief_add: str | None = None
    schema: str | dict[str, Any] | StructuredSchema[Any] | None = None
    max_turns: int | None = None
    max_time: str | None = None
    budget_usd: float | None = None
    partial: bool = False
    config: str | dict[str, Any] | None = None
    config_layers: list[str] | None = None
    extensions: list[str] = field(default_factory=list)
    session_id: str | None = None
    title: str | None = None
    resume: str | None = None
    continue_: bool = False
    fork: bool = False
    ephemeral: bool = False
    lean: bool = False
    advise: bool = False
    no_commands: bool = False
    provider_preview: list[str] = field(default_factory=list)
    log_file: str | None = None
    extra_args: list[str] = field(default_factory=list)


class ConnectKwargs(TypedDict, total=False):
    """The ``RunOptions`` fields ``connect``, ``connect_sync`` and ``prewarm`` accept as keywords; ``schema`` is a named parameter."""
    worktree: bool | str
    reasoning_mode: Literal['enabled', 'adaptive', 'disabled'] | None
    brief_file: str | None
    brief_add_file: str | None
    debug: bool | str
    checkpoint_files: bool
    replay_to: str | None
    restore_files: str | None
    tools: list[ToolDefinition]
    auto_allow_tools: bool
    mercury: str | list[str] | None
    cwd: str | None
    env: dict[str, str] | None
    project: str | None
    model: str | None
    effort: EffortLevel | None
    mode: PermissionMode | None
    agent: str | None
    agent_defs: dict[str, Any] | None
    backup_model: str | None
    sovereign: bool
    allow_sovereign: bool
    allowed_tools: list[str]
    block_tools: list[str]
    toolset: list[str]
    mcp: list[str]
    only_mcp: bool
    brief: str | None
    brief_add: str | None
    max_turns: int | None
    max_time: str | None
    budget_usd: float | None
    partial: bool
    config: str | dict[str, Any] | None
    config_layers: list[str] | None
    extensions: list[str]
    session_id: str | None
    title: str | None
    resume: str | None
    continue_: bool
    fork: bool
    ephemeral: bool
    lean: bool
    advise: bool
    no_commands: bool
    provider_preview: list[str]
    log_file: str | None
    extra_args: list[str]


class RunKwargs(ConnectKwargs, total=False):
    """The ``RunOptions`` fields ``run`` and ``run_sync`` accept as keywords beside ``prompt`` and ``schema``."""
    cancel: asyncio.Event | None
    input: Literal['rows'] | None
    stdin: str | None


def argv_of(options: RunOptions, door: Literal['run', 'runner'] = 'run') -> list[str]:
    """The exact command line ``run()`` would start for these options."""
    if options.prompt is not None and not isinstance(options.prompt, str): options = replace(options, input='rows')
    args = executable_of(options.mercury, options.env, options.cwd)
    if options.project is not None: args += ['--project', options.project]
    args += ['run', '--format', 'rows'] if door == 'run' else ['runner']
    values = ['model', 'effort', 'mode', 'agent', 'backup_model', 'brief', 'brief_add', 'max_turns', 'max_time', 'session_id', 'title', 'resume', 'log_file', 'input', 'replay_to', 'restore_files', 'reasoning_mode', 'brief_file', 'brief_add_file']
    for name in values:
        value = getattr(options, name)
        if value is not None: args += ['--' + name.replace('_', '-'), str(value)]
    if options.budget_usd is not None: args += ['--budget', str(options.budget_usd)]
    for name in ['sovereign', 'allow_sovereign', 'only_mcp', 'partial', 'continue_', 'fork', 'ephemeral', 'lean', 'advise', 'no_commands']:
        if getattr(options, name): args.append('--' + name.rstrip('_').replace('_', '-'))
    for name in ['allowed_tools', 'block_tools', 'toolset', 'mcp', 'provider_preview']:
        if getattr(options, name): args += ['--' + name.replace('_', '-'), *getattr(options, name)]
    for name in ['schema', 'config', 'agent_defs']:
        value = getattr(options, name)
        if name == 'schema' and door == 'runner': continue
        if name == 'schema' and value is not None: value = schema_object(value, options.cwd)
        if value is not None: args += ['--' + name.replace('_', '-'), value if isinstance(value, str) else json.dumps(value)]
    if options.config_layers is not None: args += ['--config-layers', ','.join(options.config_layers)]
    for extension in options.extensions: args += ['--extension', extension]
    for name in ['worktree', 'debug']:
        value = getattr(options, name)
        if value is True: args.append('--' + name)
        elif isinstance(value, str): args += ['--' + name, value]
    args += options.extra_args
    if isinstance(options.prompt, str): args += ['--', options.prompt]
    return args


_live: dict[int, asyncio.subprocess.Process] = {}
_sent: dict[int, str] = {}
WINDOWS = os.name == 'nt'


def _end_live_children() -> None:
    for pid, child in list(_live.items()):
        if child.returncode is None:
            try: os.kill(pid, signal.SIGTERM)
            except OSError: pass


atexit.register(_end_live_children)


def track(child: asyncio.subprocess.Process) -> None:
    if child.pid is not None:
        _live[child.pid] = child
        _sent.pop(child.pid, None)


def untrack(child: asyncio.subprocess.Process) -> None:
    _live.pop(child.pid, None)


def send_signal(child: asyncio.subprocess.Process, name: Literal['SIGINT', 'SIGTERM', 'SIGKILL']) -> None:
    """Send the named signal; on Windows, which delivers none, end the process as Node's child_process does and report the name in the exit receipt."""
    if child.returncode is not None: return
    try:
        if not WINDOWS: child.send_signal(getattr(signal, name))
        elif name == 'SIGKILL': child.kill()
        else: child.terminate()
    except ProcessLookupError: return
    if child.pid is not None: _sent[child.pid] = name


def exit_of(child: asyncio.subprocess.Process, code: int, stderr: str) -> RunExit:
    """The exit receipt: the signal that ended the child, or its code; on Windows a child the package ended reports the signal it sent."""
    sent = _sent.pop(child.pid, None) if child.pid is not None else None
    if code < 0 and not WINDOWS: return RunExit(None, signal.Signals(-code).name, stderr)
    if WINDOWS and sent is not None and code == 1: return RunExit(None, sent, stderr)
    return RunExit(code, None, stderr)


_USAGE_KEYS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens')


def interrupted_outcome(rows: list[StreamRow], started_at: float, now: float | None = None) -> OutcomeRow:
    """The outcome row of a turn the package interrupted when the child ended by the signal before writing its own."""
    at = time.time() if now is None else now
    opened = [row for row in rows if row['type'] == 'turn' and row.get('state') == 'started' and 'parent_call_id' not in row]
    turn = opened[-1] if opened else None
    steps = [row for row in rows if row['type'] == 'step' and 'parent_call_id' not in row and (turn is None or row.get('seq', 0) > turn.get('seq', 0))]
    usage: dict[str, int] = dict.fromkeys(_USAGE_KEYS, 0)
    models: dict[str, dict[str, int]] = {}
    for step in steps:
        model = models.setdefault(str(step.get('model')), {**dict.fromkeys(_USAGE_KEYS, 0), 'web_searches': 0})
        for key in _USAGE_KEYS:
            usage[key] += int(step['usage'][key])
            model[key] += int(step['usage'][key])
    last = rows[-1] if rows else None
    started = datetime.fromisoformat(str(turn['timestamp']).replace('Z', '+00:00')).timestamp() if turn else started_at
    row = {'type': 'outcome', 'seq': int(last.get('seq', 0) if last else 0) + 1, 'timestamp': datetime.fromtimestamp(at, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'session_id': str(last.get('session_id', '')) if last else '', 'turn': int(turn.get('turn', max(1, len(opened)))) if turn else max(1, len(opened)), 'schema': 1, 'turn_id': str(turn['turn_id']) if turn else '', 'status': 'interrupted', 'error': {'message': 'Interrupted', 'class': 'interrupt'}, 'steps': len(steps), 'wall_ms': max(0, int((at - started) * 1000)), 'usage': usage, 'models': models, 'denials': []}
    return cast(OutcomeRow, row)


async def end_child(child: asyncio.subprocess.Process) -> int:
    """Terminate a child that must not go on, escalating to SIGKILL after a second, and return its exit code."""
    send_signal(child, 'SIGTERM')
    try: return await asyncio.wait_for(asyncio.shield(child.wait()), 1)
    except asyncio.TimeoutError:
        send_signal(child, 'SIGKILL')
        return await child.wait()


async def spawn(args: list[str], options: RunOptions) -> asyncio.subprocess.Process:
    if options.cwd is not None and not os.path.isdir(options.cwd): raise MercurySpawnError(args[0], f'the working directory does not exist: {options.cwd}')
    try:
        child = await asyncio.create_subprocess_exec(*args, cwd=options.cwd, env=options.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=MAX_LINE_BYTES)
    except OSError as error:
        raise MercurySpawnError(args[0], error) from error
    track(child)
    return child


class MercuryRun:
    """One ``mercury run`` process: an async iterator of its rows, with ``outcome``, ``session`` and ``exit`` awaitable."""
    def __init__(self, child: asyncio.subprocess.Process, options: RunOptions, tools: ToolServer | None = None):
        self._tools = tools
        self.child = child
        assert child.stdin is not None and child.stdout is not None and child.stderr is not None
        self._stdin = child.stdin
        self._stdout = child.stdout
        self._stderr = child.stderr
        self.options = options
        self.rows: list[StreamRow] = []
        self.stderr = ''
        self.error: MercuryError | None = None
        loop = asyncio.get_running_loop()
        self.outcome: asyncio.Future[OutcomeRow] = loop.create_future()
        self.session: asyncio.Future[SessionRow] = loop.create_future()
        self.exit: asyncio.Future[RunExit] = loop.create_future()
        for future in (self.outcome, self.session): future.add_done_callback(lambda f: None if f.cancelled() else f.exception())
        self._listeners: dict[str, list[Listener]] = {}
        self._queue: asyncio.Queue[StreamRow | None] = asyncio.Queue()
        self._input_task: asyncio.Task[None] | None = None
        self._interrupt_requested = False
        self._interrupt_sent = False
        self._started_at = time.time()
        self._sent = 0
        self._reader = asyncio.create_task(self._read())
        self._cancel_task = asyncio.create_task(self._watch_cancel(options.cancel)) if options.cancel is not None else None

    def on(self, type: str, listener: Listener) -> MercuryRun:
        """Listen for one row type, ``'row'`` (every row), ``'error'`` or ``'end'``."""
        self._listeners.setdefault(type, []).append(listener)
        return self

    def off(self, type: str, listener: Listener) -> MercuryRun:
        if listener in self._listeners.get(type, []): self._listeners[type].remove(listener)
        return self

    def _emit(self, type: str, value: Any) -> None:
        for listener in tuple(self._listeners.get(type, [])): listener(value)

    async def _watch_cancel(self, event: asyncio.Event) -> None:
        try:
            await event.wait()
            self.interrupt()
        except asyncio.CancelledError: pass

    async def _read(self) -> None:
        stderr = asyncio.create_task(self._stderr.read())
        last: OutcomeRow | None = None
        try:
            async for line in read_lines(self._stdout):
                if not line.strip(): continue
                read = parse_row(line)
                if not read.ok:
                    raise MercuryWireError(line, read.reason or 'invalid', read.type, read.issues)
                row = read.row
                assert row is not None
                self.rows.append(row)
                if row['type'] == 'session' and not self.session.done():
                    self.session.set_result(row)
                    if self._interrupt_requested: self.interrupt()
                if row['type'] == 'outcome': last = row
                self._queue.put_nowait(row)
                self._emit('row', row)
                self._emit(row['type'], row)
        except Exception as error:
            self.error = error if isinstance(error, MercuryError) else MercuryWireError('', 'invalid', issues=[Issue('', str(error))])
            self._stdin.close()
            await end_child(self.child)
        code = await self.child.wait()
        untrack(self.child)
        if self._tools: await self._tools.close()
        self.stderr = (await stderr).decode('utf-8', errors='replace')
        exit = exit_of(self.child, code, self.stderr)
        if self.error is None and last is None and self._interrupt_sent and (exit.signal == 'SIGINT' or exit.code == 130):
            last = interrupted_outcome(self.rows, self._started_at)
            self.rows.append(last)
            self._queue.put_nowait(last)
            self._emit('row', last)
            self._emit('outcome', last)
        if self.error is None:
            if last and last['status'] == 'refused': self.error = MercuryRefusal(last, exit)
            elif last is None: self.error = MercuryUsageError(exit) if code == 2 else MercuryExitError(exit, 'run', 'no input row was sent before stdin was closed' if self.options.input == 'rows' and self._sent == 0 and not self.rows else None)
        if self.error is None and last is not None:
            try: last = validate_outcome(last, self.options.schema, self.options.cwd)
            except Exception as error: self.error = error if isinstance(error, MercuryError) else MercuryError(str(error), exit)
        if self.error:
            self.error.exit = exit
            self.outcome.set_exception(self.error)
            if not self.session.done(): self.session.set_exception(self.error)
            self._emit('error', self.error)
        else:
            assert last is not None
            self.outcome.set_result(last)
            if not self.session.done(): self.session.set_exception(MercuryExitError(exit))
        self.exit.set_result(exit)
        if self._cancel_task: self._cancel_task.cancel()
        if self._input_task: self._input_task.cancel()
        self._queue.put_nowait(None)
        self._emit('end', exit)

    async def _feed(self, prompt: list[InputBlock] | AsyncIterable[str | InputRow]) -> None:
        try:
            if isinstance(prompt, list): await self.send_prompt(prompt)
            else:
                async for row in prompt:
                    if self.exit.done(): break
                    await self.send({'type': 'prompt', 'content': row} if isinstance(row, str) else row)
            self.close_input()
        except asyncio.CancelledError: raise
        except Exception as error:
            if not self.exit.done():
                self.error = error if isinstance(error, MercuryError) else MercuryError(str(error))
                await end_child(self.child)
        finally:
            close = getattr(prompt, 'aclose', None)
            if close is not None: await close()

    async def send(self, row: InputRow) -> None:
        """Write one input row to a run started with ``input='rows'``."""
        if self.exit.done() or self.child.returncode is not None or self.options.input != 'rows' or self._stdin.is_closing(): raise MercuryError('input rows is not open')
        read = input_row_of(row)
        if not read.ok: raise MercuryWireError(json.dumps(row), read.reason or 'invalid', read.type, read.issues)
        try:
            self._stdin.write((json.dumps(row) + '\n').encode())
            await self._stdin.drain()
            self._sent += 1
        except OSError as error: raise MercuryError(str(error), self.exit.result() if self.exit.done() else None) from error

    async def send_prompt(self, content: str | list[InputBlock], **options: Any) -> None:
        await self.send(cast(InputRow, {**options, 'type': 'prompt', 'content': content}))

    async def send_shell(self, command: str, **options: Any) -> None:
        await self.send(cast(InputRow, {**options, 'type': 'shell', 'command': command}))

    async def send_note(self, to: str, content: str, **options: Any) -> None:
        await self.send(cast(InputRow, {**options, 'type': 'note', 'to': to, 'content': content}))

    def close_input(self) -> None:
        """End stdin; the run finishes its queued work and exits."""
        self._stdin.close()

    def interrupt(self) -> None:
        """End the running turn with SIGINT; before the session row arrives the signal waits for it, so the turn ends as ``interrupted`` rather than killing a booting CLI."""
        if self._tools: self._tools.cancel()
        if self.exit.done(): return
        if not self.session.done():
            self._interrupt_requested = True
            return
        if self.child.returncode is None:
            send_signal(self.child, 'SIGINT')
            self._interrupt_sent = True

    def terminate(self) -> None:
        """End the process with SIGTERM (on Windows, terminate it); returns at once, the exit is awaited through ``exit``."""
        send_signal(self.child, 'SIGTERM')

    def kill(self) -> None:
        """End the process with SIGKILL (on Windows, terminate it); returns at once, the exit is awaited through ``exit``."""
        send_signal(self.child, 'SIGKILL')

    async def close(self) -> None:
        """End stdin and wait for the exit; SIGTERM after five seconds, SIGKILL after ten."""
        self.close_input()
        try: await asyncio.wait_for(asyncio.shield(self.exit), 5)
        except asyncio.TimeoutError:
            self.terminate()
            try: await asyncio.wait_for(asyncio.shield(self.exit), 5)
            except asyncio.TimeoutError:
                self.kill()
                await self.exit

    async def __aenter__(self) -> MercuryRun:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def __aiter__(self) -> AsyncIterator[StreamRow]:
        return self

    async def __anext__(self) -> StreamRow:
        if self.exit.done() and self._queue.empty():
            if self.error: raise self.error
            raise StopAsyncIteration
        row = await self._queue.get()
        if row is None:
            if self.error: raise self.error
            raise StopAsyncIteration
        return row


T = TypeVar('T')


class TypedRun(MercuryRun, Generic[T]):
    outcome: asyncio.Future[TypedOutcome[T]]

    async def __aenter__(self) -> TypedRun[T]: return self


@overload
async def run(prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None, *, schema: StructuredSchema[T], options: RunOptions | None = None, **kwargs: Unpack[RunKwargs]) -> TypedRun[T]: ...
@overload
async def run(prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None, *, schema: str | dict[str, Any] | None = None, options: RunOptions | None = None, **kwargs: Unpack[RunKwargs]) -> MercuryRun: ...
async def run(prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None, *, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, options: RunOptions | None = None, **kwargs: Unpack[RunKwargs]) -> MercuryRun:
    """Start ``mercury run`` for a prompt (or ``input='rows'`` for streamed input) and return its handle once the process has started."""
    overrides: dict[str, Any] = dict(kwargs)
    if prompt is not None: overrides['prompt'] = prompt
    if schema is not None: overrides['schema'] = schema
    opts = replace(options, **overrides) if options is not None else RunOptions(**overrides)
    if opts.prompt is not None and not isinstance(opts.prompt, str): opts = replace(opts, input='rows')
    if opts.input not in (None, 'rows'): raise MercuryError('input must be rows')
    if opts.input == 'rows' and opts.stdin is not None: raise MercuryError('stdin text cannot be combined with input rows')
    opts = checkpoint_options(opts)
    if opts.schema is not None and not isinstance(opts.schema, StructuredSchema): opts = replace(opts, schema=schema_object(opts.schema, opts.cwd))
    opts, tools = await prepare_tools(opts)
    try: child = await spawn(argv_of(opts), opts)
    except BaseException:
        if tools: await tools.close()
        raise
    assert child.stdin is not None
    handle = TypedRun[Any](child, opts, tools)
    if opts.stdin is not None:
        child.stdin.write(opts.stdin.encode())
        await child.stdin.drain()
    if opts.input != 'rows': child.stdin.close()
    if opts.prompt is not None and not isinstance(opts.prompt, str): handle._input_task = asyncio.create_task(handle._feed(opts.prompt))
    return handle


async def prepare_tools(options: RunOptions) -> tuple[RunOptions, ToolServer | None]:
    if not options.tools: return options, None
    server = await serve_tools(options.tools)
    names = [f'mcp__sdk-tools__{tool.name}' for tool in options.tools]
    agents = options.agent_defs
    if options.auto_allow_tools and agents is not None:
        agents = {name: {**agent, 'tools': list(dict.fromkeys([*agent.get('tools', []), *names]))} if isinstance(agent, dict) and isinstance(agent.get('tools'), list) else agent for name, agent in agents.items()}
    return replace(options, mcp=[*options.mcp, server.mcp], allowed_tools=list(dict.fromkeys([*options.allowed_tools, *names])) if options.auto_allow_tools else list(options.allowed_tools), agent_defs=agents), server


def checkpoint_options(options: RunOptions, warm: bool = False) -> RunOptions:
    if not options.checkpoint_files and not warm: return options
    id = options.session_id
    if not warm and not id and not options.resume and not options.continue_: id = str(uuid.uuid4())
    return replace(options, session_id=id, env={**(options.env if options.env is not None else os.environ), 'MERCURY_CONCOURSE_WORKER': '1'})

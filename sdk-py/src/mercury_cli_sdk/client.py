from __future__ import annotations
import asyncio
import atexit
import json
import os
import signal
from dataclasses import dataclass, field, replace
from typing import Any, Callable, AsyncIterator, Literal, cast
from .errors import MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryUsageError, MercuryWireError, RunExit
from .generated import InputRow, OutcomeRow, SessionRow, MAX_LINE_BYTES, PermissionMode, EffortLevel, InputBlock
from .framing import read_lines
from .parse import Issue, StreamRow, parse_row, input_row_of

Listener = Callable[[Any], object]


@dataclass
class RunOptions:
    """Everything ``run()`` and ``connect()`` accept; each field is one ``mercury run`` option (``continue_`` is ``--continue``)."""
    prompt: str | None = None
    cancel: asyncio.Event | None = None
    mercury: str | list[str] = 'mercury'
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
    schema: str | dict[str, Any] | None = None
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


def argv_of(options: RunOptions) -> list[str]:
    """The exact command line ``run()`` would start for these options."""
    args = [options.mercury] if isinstance(options.mercury, str) else list(options.mercury)
    if not args or not args[0]: raise MercuryError('the mercury executable is empty')
    if options.project is not None: args += ['--project', options.project]
    args += ['run', '--format', 'rows']
    values = ['model', 'effort', 'mode', 'agent', 'backup_model', 'brief', 'brief_add', 'max_turns', 'max_time', 'session_id', 'title', 'resume', 'log_file', 'input']
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
        if value is not None: args += ['--' + name.replace('_', '-'), value if isinstance(value, str) else json.dumps(value)]
    if options.config_layers is not None: args += ['--config-layers', ','.join(options.config_layers)]
    for extension in options.extensions: args += ['--extension', extension]
    args += options.extra_args
    if options.prompt is not None: args += ['--', options.prompt]
    return args


_live: dict[int, asyncio.subprocess.Process] = {}


def _end_live_children() -> None:
    for pid, child in list(_live.items()):
        if child.returncode is None:
            try: os.kill(pid, signal.SIGTERM)
            except OSError: pass


atexit.register(_end_live_children)


def track(child: asyncio.subprocess.Process) -> None:
    if child.pid is not None: _live[child.pid] = child


def untrack(child: asyncio.subprocess.Process) -> None:
    _live.pop(child.pid, None)


async def end_child(child: asyncio.subprocess.Process) -> int:
    """Terminate a child that must not go on, escalating to SIGKILL after a second, and return its exit code."""
    if child.returncode is None: child.terminate()
    try: return await asyncio.wait_for(asyncio.shield(child.wait()), 1)
    except asyncio.TimeoutError:
        if child.returncode is None: child.kill()
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
    def __init__(self, child: asyncio.subprocess.Process, options: RunOptions):
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
            await asyncio.shield(self.session)
            self.interrupt()
        except (MercuryError, asyncio.CancelledError): pass

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
                if row['type'] == 'session' and not self.session.done(): self.session.set_result(row)
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
        self.stderr = (await stderr).decode('utf-8', errors='replace')
        exit = RunExit(code if code >= 0 else None, signal.Signals(-code).name if code < 0 else None, self.stderr)
        if self.error is None:
            if last and last['status'] == 'refused': self.error = MercuryRefusal(last, exit)
            elif last is None: self.error = MercuryUsageError(exit) if code == 2 else MercuryExitError(exit)
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
        self._queue.put_nowait(None)
        self._emit('end', exit)

    async def send(self, row: InputRow) -> None:
        """Write one input row to a run started with ``input='rows'``."""
        if self.exit.done() or self.child.returncode is not None or self.options.input != 'rows' or self._stdin.is_closing(): raise MercuryError('input rows is not open')
        read = input_row_of(row)
        if not read.ok: raise MercuryWireError(json.dumps(row), read.reason or 'invalid', read.type, read.issues)
        try:
            self._stdin.write((json.dumps(row) + '\n').encode())
            await self._stdin.drain()
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
        if self.child.returncode is None: self.child.send_signal(signal.SIGINT)

    def terminate(self) -> None:
        if self.child.returncode is None: self.child.terminate()

    def kill(self) -> None:
        if self.child.returncode is None: self.child.kill()

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


async def run(prompt: str | None = None, *, options: RunOptions | None = None, **kwargs: Any) -> MercuryRun:
    """Start ``mercury run`` for a prompt (or ``input='rows'`` for streamed input) and return its handle once the process has started."""
    overrides = dict(kwargs)
    if prompt is not None: overrides['prompt'] = prompt
    opts = replace(options, **overrides) if options is not None else RunOptions(**overrides)
    if opts.input not in (None, 'rows'): raise MercuryError('input must be rows')
    if opts.input == 'rows' and opts.stdin is not None: raise MercuryError('stdin text cannot be combined with input rows')
    child = await spawn(argv_of(opts), opts)
    assert child.stdin is not None
    handle = MercuryRun(child, opts)
    if opts.stdin is not None:
        child.stdin.write(opts.stdin.encode())
        await child.stdin.drain()
    if opts.input != 'rows': child.stdin.close()
    return handle

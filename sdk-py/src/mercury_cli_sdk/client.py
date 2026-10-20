from __future__ import annotations
import asyncio
import json
import os
import signal
from dataclasses import dataclass, field
from typing import Any, Callable, AsyncIterator
from .errors import MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryUsageError, MercuryWireError, RunExit
from .generated import InputRow, OutcomeRow, MAX_LINE_BYTES
from .parse import StreamRow, parse_row, input_row_of


@dataclass
class RunOptions:
    prompt: str | None = None
    mercury: str | list[str] = 'mercury'
    cwd: str | None = None
    env: dict[str, str] | None = None
    input: str | None = None
    stdin: str | None = None
    project: str | None = None
    model: str | None = None
    effort: str | None = None
    mode: str | None = None
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
    schema: str | dict | None = None
    max_turns: int | None = None
    max_time: str | None = None
    budget_usd: float | None = None
    partial: bool = False
    config: str | dict | None = None
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


class MercuryRun:
    def __init__(self, child: asyncio.subprocess.Process, options: RunOptions):
        self.child = child
        self.options = options
        self.rows: list[StreamRow] = []
        self.stderr = ''
        self.error: MercuryError | None = None
        loop = asyncio.get_running_loop()
        self.outcome: asyncio.Future[OutcomeRow] = loop.create_future()
        self.session: asyncio.Future = loop.create_future()
        self.exit: asyncio.Future[RunExit] = loop.create_future()
        for future in (self.outcome, self.session): future.add_done_callback(lambda f: None if f.cancelled() else f.exception())
        self._listeners: dict[str, list[Callable]] = {}
        self._queue: asyncio.Queue = asyncio.Queue()
        self._reader = asyncio.create_task(self._read())

    def on(self, type: str, listener: Callable) -> MercuryRun:
        self._listeners.setdefault(type, []).append(listener)
        return self

    def off(self, type: str, listener: Callable) -> MercuryRun:
        if listener in self._listeners.get(type, []): self._listeners[type].remove(listener)
        return self

    def _emit(self, type: str, value: Any) -> None:
        for listener in tuple(self._listeners.get(type, [])): listener(value)

    async def _read(self) -> None:
        stderr = asyncio.create_task(self.child.stderr.read())
        last = None
        try:
            async for data in self.child.stdout:
                line = data.decode('utf-8')
                if not line.strip(): continue
                read = parse_row(line)
                if not read.ok:
                    self.error = self.error or MercuryWireError(line, read.reason, read.type, read.issues)
                    continue
                row = read.row
                self.rows.append(row)
                if row['type'] == 'session' and not self.session.done(): self.session.set_result(row)
                if row['type'] == 'outcome': last = row
                self._queue.put_nowait(row)
                self._emit('row', row)
                self._emit(row['type'], row)
        except Exception as error:
            self.error = MercuryWireError('', 'invalid', issues=[str(error)])
            self.terminate()
        code = await self.child.wait()
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
            self.outcome.set_result(last)
            if not self.session.done(): self.session.set_exception(MercuryExitError(exit))
        self.exit.set_result(exit)
        self._queue.put_nowait(None)
        self._emit('end', exit)

    async def send(self, row: InputRow) -> None:
        if self.options.input != 'rows' or self.child.stdin.is_closing(): raise MercuryError('input rows is not open')
        read = input_row_of(row)
        if not read.ok: raise MercuryWireError(json.dumps(row), read.reason, read.type, read.issues)
        self.child.stdin.write((json.dumps(row) + '\n').encode())
        await self.child.stdin.drain()

    async def send_prompt(self, content: Any, **options: Any) -> None:
        await self.send({**options, 'type': 'prompt', 'content': content})

    async def send_shell(self, command: str, **options: Any) -> None:
        await self.send({**options, 'type': 'shell', 'command': command})

    async def send_note(self, to: str, content: str, **options: Any) -> None:
        await self.send({**options, 'type': 'note', 'to': to, 'content': content})

    def close_input(self) -> None:
        self.child.stdin.close()

    def interrupt(self) -> None:
        if self.child.returncode is None: self.child.send_signal(signal.SIGINT)

    def terminate(self) -> None:
        if self.child.returncode is None: self.child.terminate()

    def kill(self) -> None:
        if self.child.returncode is None: self.child.kill()

    async def close(self) -> None:
        self.close_input()
        try: await asyncio.wait_for(asyncio.shield(self.exit), 5)
        except asyncio.TimeoutError:
            self.terminate()
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
    opts = options or RunOptions(prompt=prompt, **kwargs)
    if opts.input not in (None, 'rows'): raise MercuryError('input must be rows')
    if opts.input == 'rows' and opts.stdin is not None: raise MercuryError('stdin text cannot be combined with input rows')
    args = argv_of(opts)
    try:
        child = await asyncio.create_subprocess_exec(*args, cwd=opts.cwd, env=opts.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=MAX_LINE_BYTES)
    except OSError as error:
        raise MercurySpawnError(args[0], error) from error
    handle = MercuryRun(child, opts)
    if opts.stdin is not None:
        child.stdin.write(opts.stdin.encode())
        await child.stdin.drain()
    if opts.input != 'rows': child.stdin.close()
    return handle

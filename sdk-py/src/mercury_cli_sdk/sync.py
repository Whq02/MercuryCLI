from __future__ import annotations
import asyncio
import atexit
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, AsyncIterable, Coroutine, Iterator, Literal, Mapping, TypeVar, Unpack, overload
from .client import ConnectKwargs, Listener, RunKwargs, RunOptions, run
from .generated import InitializeParamsHost, InputBlock
from .runner import ElicitationHandler, HostHandler, PermissionHandler, ReadTextFileHandler, WriteTextFileHandler, connect, MercurySession
from .generated import InitializeResultFile_checkpoints, TypedSyncRequests, DEFAULT_TIMEOUT, DefaultTimeout, OutcomeRow, TypedOutcome, InputRow, InitializeResult, QueueAddResult, QueueWithdrawResult, TurnInterruptResult, SessionFactsResult, SessionSetModelResult, SessionSetEffortResult, SessionSetModeResult, SessionSetKitResult, SessionRewindResult, AgentStopResult, AgentResumeResult, SessionClaimResult, McpToolsResult, McpActionResult, SessionPauseGateResult, SessionQuiesceResult, SessionLeaveResult, SessionSetSpawnSwitchResult, ShellBackgroundResult, SessionSendNowResult
from .parse import PromptContent, StreamRow
from .errors import MercuryConnectionError, MercuryTimeoutError, RunExit
from .structured import RunResult as RunResult, StructuredSchema, TypedRunResult as TypedRunResult
from .support import RunnerSupport

T = TypeVar('T')


@overload
def run_sync(prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None, *, schema: StructuredSchema[T], timeout: float | None = None, interrupt_on_timeout: bool = False, options: RunOptions | None = None, **kwargs: Unpack[RunKwargs]) -> TypedRunResult[T]: ...
@overload
def run_sync(prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None, *, schema: str | dict[str, Any] | None = None, timeout: float | None = None, interrupt_on_timeout: bool = False, options: RunOptions | None = None, **kwargs: Unpack[RunKwargs]) -> RunResult: ...
def run_sync(prompt: str | list[InputBlock] | AsyncIterable[str | InputRow] | None = None, *, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, timeout: float | None = None, interrupt_on_timeout: bool = False, options: RunOptions | None = None, **kwargs: Unpack[RunKwargs]) -> RunResult:
    """Collect one run, using a worker when the caller has an active event loop."""
    async def collect() -> RunResult:
        async with await run(prompt, schema=schema, options=options, **kwargs) as handle:
            if timeout is None:
                outcome = await handle.outcome
            else:
                try:
                    outcome = await asyncio.wait_for(asyncio.shield(handle.outcome), timeout)
                except asyncio.TimeoutError as error:
                    if interrupt_on_timeout:
                        handle.interrupt()
                        outcome = await handle.outcome
                    else:
                        handle.terminate()
                        raise MercuryTimeoutError('run', timeout) from error
            return RunResult(outcome, handle.rows, await handle.exit)
    try: asyncio.get_running_loop()
    except RuntimeError: return asyncio.run(collect())
    with ThreadPoolExecutor(max_workers=1) as worker:
        return worker.submit(lambda: asyncio.run(collect())).result()


class SyncSession(TypedSyncRequests):
    """A typed synchronous session, including blocking row iteration, driven by a background loop."""
    def __init__(self, *, warm: bool = False, checkpoints: bool = True, timeout: float | None = None, on_read_text_file: ReadTextFileHandler | None = None, on_write_text_file: WriteTextFileHandler | None = None, on_permission_request: PermissionHandler | None = None, on_elicitation: ElicitationHandler | None = None, handlers: Mapping[str, HostHandler] | None = None, capabilities: Mapping[str, Any] | None = None, host: InitializeParamsHost | None = None, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, options: RunOptions | None = None, **kwargs: Unpack[ConnectKwargs]):
        super().__init__(self._request, self._notify)
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        self._closed = False
        atexit.register(self.close)
        try: self.session: MercurySession = self._wait(connect(warm=warm, checkpoints=checkpoints, timeout=timeout, on_read_text_file=on_read_text_file, on_write_text_file=on_write_text_file, on_permission_request=on_permission_request, on_elicitation=on_elicitation, handlers=handlers, capabilities=capabilities, host=host, schema=schema, options=options, **kwargs))
        except BaseException:
            self._stop()
            raise

    def _wait(self, awaitable: Coroutine[Any, Any, T]) -> T:
        if threading.current_thread() is self._thread:
            awaitable.close()
            raise RuntimeError('a host callback must await the async session, not call the sync wrapper')
        if self._closed or not self._thread.is_alive():
            awaitable.close()
            raise MercuryConnectionError('session is closed; connect a new session before sending requests')
        future = asyncio.run_coroutine_threadsafe(awaitable, self._loop)
        try: return future.result()
        except BaseException:
            future.cancel()
            raise

    @property
    def session_id(self) -> str | None: return self.session.session_id
    @property
    def initialized(self) -> InitializeResult: return self.session.initialized
    @property
    def file_checkpoints(self) -> InitializeResultFile_checkpoints | None: return self.session.file_checkpoints
    @property
    def runner_version(self) -> str | None: return self.session.runner_version
    @property
    def supports(self) -> RunnerSupport: return self.session.supports
    @property
    def rows(self) -> list[StreamRow]: return self.session.rows
    @property
    def stderr(self) -> str: return self.session.stderr
    @property
    def last_prompt_id(self) -> str | None: return self.session.last_prompt_id
    @property
    def exit(self) -> RunExit:
        async def wait() -> RunExit: return await self.session.exit
        return self.session.exit.result() if self.session.exit.done() else self._wait(wait())

    @overload
    def prompt(self, content: PromptContent, *, schema: StructuredSchema[T], timeout: float | None = None, interrupt_on_timeout: bool = False) -> TypedOutcome[T]: ...
    @overload
    def prompt(self, content: PromptContent, *, schema: str | dict[str, Any] | None = None, timeout: float | None = None, interrupt_on_timeout: bool = False) -> OutcomeRow: ...
    def prompt(self, content: PromptContent, *, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, timeout: float | None = None, interrupt_on_timeout: bool = False) -> OutcomeRow:
        return self._wait(self.session.prompt(content, schema=schema, timeout=timeout, interrupt_on_cancel=interrupt_on_timeout))

    def send(self, row: InputRow) -> QueueAddResult: return self._wait(self.session.send(row))
    def send_prompt(self, content: PromptContent, **options: Any) -> QueueAddResult: return self._wait(self.session.send_prompt(content, **options))
    def send_shell(self, command: str, **options: Any) -> QueueAddResult: return self._wait(self.session.send_shell(command, **options))
    def send_note(self, to: str, content: str, **options: Any) -> QueueAddResult: return self._wait(self.session.send_note(to, content, **options))
    def steer(self, content: PromptContent, *, id: str | None = None, schema: dict[str, Any] | None = None) -> QueueAddResult: return self._wait(self.session.steer(content, id=id, schema=schema))
    def follow_up(self, content: PromptContent, *, id: str | None = None, schema: dict[str, Any] | None = None) -> QueueAddResult: return self._wait(self.session.follow_up(content, id=id, schema=schema))
    def facts(self) -> SessionFactsResult: return self._wait(self.session.facts())
    def interrupt(self, **options: Any) -> TurnInterruptResult: return self._wait(self.session.interrupt(**options))
    def withdraw(self, id: str) -> QueueWithdrawResult: return self._wait(self.session.withdraw(id))
    def set_model(self, model: str) -> SessionSetModelResult: return self._wait(self.session.set_model(model))
    def set_effort(self, effort: str) -> SessionSetEffortResult: return self._wait(self.session.set_effort(effort))
    def set_mode(self, mode: str) -> SessionSetModeResult: return self._wait(self.session.set_mode(mode))
    def set_kit(self, kit: Any) -> SessionSetKitResult: return self._wait(self.session.set_kit(kit))
    def rewind(self, user_message_id: str, mode: str, dry_run: bool = False) -> SessionRewindResult: return self._wait(self.session.rewind(user_message_id, mode, dry_run))
    def stop_agent(self, agent_id: str, note: str | None = None) -> AgentStopResult: return self._wait(self.session.stop_agent(agent_id, note))
    def resume_agent(self, agent_id: str, note: str | None = None) -> AgentResumeResult: return self._wait(self.session.resume_agent(agent_id, note))
    def mcp_tools(self, name: str) -> McpToolsResult: return self._wait(self.session.mcp_tools(name))
    def mcp_action(self, name: str, action: Literal['authenticate', 'reconnect', 'cancel-auth']) -> McpActionResult: return self._wait(self.session.mcp_action(name, action))
    def pause_gate(self, paused: bool) -> SessionPauseGateResult: return self._wait(self.session.pause_gate(paused))
    def quiesce(self, action: Literal['prepare', 'commit', 'cancel'], token: str) -> SessionQuiesceResult: return self._wait(self.session.quiesce(action, token))
    def leave(self) -> SessionLeaveResult: return self._wait(self.session.leave())
    def set_spawn_switch(self, switch: Literal['subagents', 'workflows'], on: bool) -> SessionSetSpawnSwitchResult: return self._wait(self.session.set_spawn_switch(switch, on))
    def background_shell(self) -> ShellBackgroundResult: return self._wait(self.session.background_shell())
    def send_now(self) -> SessionSendNowResult: return self._wait(self.session.send_now())
    def notify_credentials_changed(self, params: dict[str, Any] | None = None) -> None: self._wait(self.session.notify_credentials_changed(params))
    def claim(self, *, session_id: str, model: str | None = None, mode: str | None = None, effort: str | None = None, resume: bool | None = None, restart_reason: str | None = None, openai_catalogue: Any = None) -> SessionClaimResult:
        return self._wait(self.session.claim(session_id=session_id, model=model, mode=mode, effort=effort, resume=resume, restart_reason=restart_reason, openai_catalogue=openai_catalogue))
    def _request(self, method: str, params: Any = None, *, timeout: float | None | DefaultTimeout = DEFAULT_TIMEOUT) -> Any: return self._wait(self.session.request(method, params, timeout=timeout))
    def _notify(self, method: str, params: Any = None) -> None: self._wait(self.session.notify(method, params))

    def __iter__(self) -> Iterator[StreamRow]: return self
    def __next__(self) -> StreamRow:
        if self._closed: raise StopIteration
        try: return self._wait(self.session.__anext__())
        except StopAsyncIteration: raise StopIteration from None

    def on(self, type: str, listener: Listener) -> SyncSession:
        if self._closed: raise MercuryConnectionError('session is closed; connect a new session before adding listeners')
        self._loop.call_soon_threadsafe(self.session.on, type, listener)
        return self

    def off(self, type: str, listener: Listener) -> SyncSession:
        if self._closed: raise MercuryConnectionError('session is closed; connect a new session before changing listeners')
        self._loop.call_soon_threadsafe(self.session.off, type, listener)
        return self

    def clear_rows(self) -> None:
        async def _clear() -> None: self.session.clear_rows()
        self._wait(_clear())

    def _stop(self) -> None:
        if self._closed: return
        self._closed = True
        atexit.unregister(self.close)
        if not self._thread.is_alive(): return
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._loop.close()

    def close(self) -> None:
        """Close the session and stop its loop thread; registered with atexit so a forgotten close still ends cleanly."""
        if threading.current_thread() is self._thread: raise RuntimeError('a host callback must await the async session, not call the sync wrapper')
        if self._closed: return
        if not self._thread.is_alive():
            self._stop()
            return
        try: self._wait(self.session.close())
        finally: self._stop()

    def __enter__(self) -> SyncSession: return self
    def __exit__(self, *exc: Any) -> None: self.close()


def connect_sync(*, warm: bool = False, checkpoints: bool = True, timeout: float | None = None, on_read_text_file: ReadTextFileHandler | None = None, on_write_text_file: WriteTextFileHandler | None = None, on_permission_request: PermissionHandler | None = None, on_elicitation: ElicitationHandler | None = None, handlers: Mapping[str, HostHandler] | None = None, capabilities: Mapping[str, Any] | None = None, host: InitializeParamsHost | None = None, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None, options: RunOptions | None = None, **kwargs: Unpack[ConnectKwargs]) -> SyncSession:
    """Connect from synchronous code; use a context manager to close the session."""
    return SyncSession(warm=warm, checkpoints=checkpoints, timeout=timeout, on_read_text_file=on_read_text_file, on_write_text_file=on_write_text_file, on_permission_request=on_permission_request, on_elicitation=on_elicitation, handlers=handlers, capabilities=capabilities, host=host, schema=schema, options=options, **kwargs)

from __future__ import annotations
import asyncio
import atexit
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Coroutine, Iterator, TypeVar, overload
from .client import Listener, run
from .runner import connect, MercurySession
from .generated import TypedSyncRequests, DEFAULT_TIMEOUT, DefaultTimeout, OutcomeRow, TypedOutcome, InputRow, InitializeResult, QueueAddResult, QueueWithdrawResult, TurnInterruptResult, SessionFactsResult, SessionSetModelResult, SessionSetEffortResult, SessionSetModeResult, SessionSetKitResult, SessionRewindResult, AgentStopResult, AgentResumeResult, SessionClaimResult
from .parse import StreamRow
from .errors import RunExit
from .structured import StructuredSchema

T = TypeVar('T')


@dataclass(frozen=True)
class RunResult:
    """What run_sync returns: the outcome, received rows and exit receipt."""
    outcome: OutcomeRow
    rows: list[StreamRow]
    exit: RunExit


def run_sync(prompt: str | None = None, **options: Any) -> RunResult:
    """Collect one run, using a worker when the caller has an active event loop."""
    async def collect() -> RunResult:
        async with await run(prompt, **options) as handle:
            outcome = await handle.outcome
            return RunResult(outcome, handle.rows, await handle.exit)
    try: asyncio.get_running_loop()
    except RuntimeError: return asyncio.run(collect())
    with ThreadPoolExecutor(max_workers=1) as worker:
        return worker.submit(lambda: asyncio.run(collect())).result()


class SyncSession(TypedSyncRequests):
    """A typed synchronous session, including blocking row iteration, driven by a background loop."""
    def __init__(self, **options: Any):
        super().__init__(self._request, self._notify)
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        self._closed = False
        atexit.register(self.close)
        try: self.session: MercurySession = self._wait(connect(**options))
        except BaseException:
            self._stop()
            raise

    def _wait(self, awaitable: Coroutine[Any, Any, T]) -> T:
        if threading.current_thread() is self._thread:
            awaitable.close()
            raise RuntimeError('a host callback must await the async session, not call the sync wrapper')
        future = asyncio.run_coroutine_threadsafe(awaitable, self._loop)
        try: return future.result()
        except BaseException:
            future.cancel()
            raise

    @property
    def initialized(self) -> InitializeResult: return self.session.initialized
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
    def prompt(self, content: Any, *, schema: StructuredSchema[T]) -> TypedOutcome[T]: ...
    @overload
    def prompt(self, content: Any, *, schema: str | dict[str, Any] | None = None) -> OutcomeRow: ...
    def prompt(self, content: Any, *, schema: StructuredSchema[Any] | str | dict[str, Any] | None = None) -> OutcomeRow:
        return self._wait(self.session.prompt(content, schema=schema))

    def send(self, row: InputRow) -> QueueAddResult: return self._wait(self.session.send(row))
    def send_prompt(self, content: Any, **options: Any) -> QueueAddResult: return self._wait(self.session.send_prompt(content, **options))
    def send_shell(self, command: str, **options: Any) -> QueueAddResult: return self._wait(self.session.send_shell(command, **options))
    def send_note(self, to: str, content: str, **options: Any) -> QueueAddResult: return self._wait(self.session.send_note(to, content, **options))
    def steer(self, content: Any) -> QueueAddResult: return self._wait(self.session.steer(content))
    def follow_up(self, content: Any) -> QueueAddResult: return self._wait(self.session.follow_up(content))
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
    def claim(self, **params: Any) -> SessionClaimResult: return self._wait(self.session.claim(**params))
    def _request(self, method: str, params: Any = None, *, timeout: float | None | DefaultTimeout = DEFAULT_TIMEOUT) -> Any: return self._wait(self.session.request(method, params, timeout=timeout))
    def _notify(self, method: str, params: Any = None) -> None: self._wait(self.session.notify(method, params))

    def __iter__(self) -> Iterator[StreamRow]: return self
    def __next__(self) -> StreamRow:
        try: return self._wait(self.session.__anext__())
        except StopAsyncIteration: raise StopIteration from None

    def on(self, type: str, listener: Listener) -> SyncSession:
        self._loop.call_soon_threadsafe(self.session.on, type, listener)
        return self

    def off(self, type: str, listener: Listener) -> SyncSession:
        self._loop.call_soon_threadsafe(self.session.off, type, listener)
        return self

    def _stop(self) -> None:
        if self._closed: return
        self._closed = True
        atexit.unregister(self.close)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._loop.close()

    def close(self) -> None:
        """Close the session and stop its loop thread; registered with atexit so a forgotten close still ends cleanly."""
        if self._closed: return
        try: self._wait(self.session.close())
        finally: self._stop()

    def __enter__(self) -> SyncSession: return self
    def __exit__(self, *exc: Any) -> None: self.close()


def connect_sync(**options: Any) -> SyncSession:
    """Connect from synchronous code; use a context manager to close the session."""
    return SyncSession(**options)

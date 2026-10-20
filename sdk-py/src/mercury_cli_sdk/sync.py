from __future__ import annotations
import asyncio
import inspect
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any
from .client import run
from .runner import connect, MercurySession
from .generated import OutcomeRow
from .parse import StreamRow
from .errors import RunExit


@dataclass(frozen=True)
class RunResult:
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


class SyncSession:
    def __init__(self, **options: Any):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        self._closed = False
        try: self.session: MercurySession = self._wait(connect(**options))
        except BaseException:
            self._stop()
            raise

    def _wait(self, awaitable: Any) -> Any:
        if threading.current_thread() is self._thread:
            awaitable.close()
            raise RuntimeError('a host callback must await the async session, not call the sync wrapper')
        future = asyncio.run_coroutine_threadsafe(awaitable, self._loop)
        try: return future.result()
        except BaseException:
            future.cancel()
            raise

    def __getattr__(self, name: str) -> Any:
        value = getattr(self.session, name)
        if inspect.iscoroutinefunction(value): return lambda *args, **kwargs: self._wait(value(*args, **kwargs))
        return value

    def on(self, type: str, listener: Any) -> SyncSession:
        self._loop.call_soon_threadsafe(self.session.on, type, listener)
        return self

    def off(self, type: str, listener: Any) -> SyncSession:
        self._loop.call_soon_threadsafe(self.session.off, type, listener)
        return self

    def _stop(self) -> None:
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._loop.close()
        self._closed = True

    def close(self) -> None:
        if self._closed: return
        try: self._wait(self.session.close())
        finally: self._stop()

    def __enter__(self) -> SyncSession: return self
    def __exit__(self, *exc: Any) -> None: self.close()


def connect_sync(**options: Any) -> SyncSession:
    return SyncSession(**options)

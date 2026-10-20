from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Literal, Mapping
from .generated import ErrorClass, OutcomeRow
from .parse import Issue

Door = Literal['run', 'runner']


@dataclass(frozen=True)
class RunExit:
    """How the mercury process ended: its exit code or the signal that ended it, and everything it wrote to stderr."""
    code: int | None
    signal: str | None
    stderr: str


def _stderr_lines(exit: RunExit) -> list[str]:
    return [line.strip() for line in exit.stderr.split('\n') if line.strip()]


class MercuryError(Exception):
    """The base of every error the package raises; RPC errors carry the runner's code and data."""
    def __init__(self, message: str, exit: RunExit | None = None, *, code: int | None = None, data: Any = None):
        super().__init__(message)
        self.exit = exit
        self.code = code
        self.data = data


class MercuryRefusal(MercuryError):
    """Mercury refused the request: a refused outcome row (``outcome`` set) or an RPC refusal (``outcome`` is None)."""
    def __init__(self, outcome: OutcomeRow | None, exit: RunExit | None = None, *, rpc: Mapping[str, Any] | None = None):
        error: Mapping[str, Any] = rpc or (outcome.get('error', {}) if outcome is not None else {})
        super().__init__(error.get('message', 'The request was refused'), exit, code=error.get('code'), data=error.get('data'))
        self.outcome = outcome
        self.error_class: ErrorClass | str = error.get('class', 'option')
        self.detail: list[str] = list(error.get('detail', []))


class MercuryUsageError(MercuryError):
    """The command line was refused (exit 2) before any row or answer; the message is the CLI's own first stderr line."""
    def __init__(self, exit: RunExit, door: Door = 'run'):
        lines = _stderr_lines(exit)
        super().__init__(lines[0] if lines else f'mercury {door} refused the command line (exit 2) and wrote no reason', exit)
        self.door = door


class MercuryExitError(MercuryError):
    """The process ended before a run produced its outcome row or before a session was closed; the last stderr line is quoted."""
    def __init__(self, exit: RunExit, door: Door = 'run'):
        why = f'ended by {exit.signal}' if exit.signal is not None else f'exited {exit.code if exit.code is not None else "without a code"}'
        lines = _stderr_lines(exit)
        tail = f': {lines[-1]}' if lines else ''
        super().__init__(f'mercury {door} {why} before {"an outcome row" if door == "run" else "the session was closed"}{tail}', exit)
        self.door = door


class MercurySpawnError(MercuryError):
    """The mercury process could not be started: no such executable, or no such working directory."""
    def __init__(self, command: str, cause: Exception | str):
        hint = ' (install Mercury CLI from https://mercury-cli.ai or pass the executable path in the mercury option)' if isinstance(cause, FileNotFoundError) else ''
        super().__init__(f'could not start {command!r}: {cause}{hint}')
        self.command = command
        if isinstance(cause, Exception): self.__cause__ = cause


class MercuryWireError(MercuryError):
    """A line on the wire was not a row or message the package knows; ``line``, ``reason`` and ``issues`` say what was wrong."""
    def __init__(self, line: str, reason: str, row_type: str | None = None, issues: list[Issue] | None = None, exit: RunExit | None = None):
        detail = '; '.join(f'{issue.path or "row"}: {issue.message}' for issue in (issues or [])[:3])
        super().__init__(f'a stdout line is not a row or message the package knows ({reason}{f" {row_type}" if row_type else ""}){f": {detail}" if detail else ""}', exit)
        self.line = line
        self.reason = reason
        self.row_type = row_type
        self.issues: list[Issue] = issues or []

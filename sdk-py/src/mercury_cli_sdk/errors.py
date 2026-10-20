from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Mapping
from .generated import OutcomeRow


@dataclass(frozen=True)
class RunExit:
    code: int | None
    signal: str | None
    stderr: str


class MercuryError(Exception):
    def __init__(self, message: str, exit: RunExit | None = None, *, code: int | None = None, data: Any = None):
        super().__init__(message)
        self.exit = exit
        self.code = code
        self.data = data


class MercuryRefusal(MercuryError):
    def __init__(self, outcome: OutcomeRow | None, exit: RunExit | None = None, *, rpc: dict | None = None):
        error: Mapping[str, Any] = rpc or (outcome.get('error', {}) if outcome is not None else {})
        super().__init__(error.get('message', 'The request was refused'), exit, code=error.get('code'), data=error.get('data'))
        self.outcome = outcome
        self.error_class = error.get('class', 'option')
        self.detail = error.get('detail', [])


class MercuryUsageError(MercuryError):
    def __init__(self, exit: RunExit):
        super().__init__(exit.stderr.strip().split('\n')[0] or 'the run door refused the command line (exit 2)', exit)


class MercuryExitError(MercuryError):
    def __init__(self, exit: RunExit):
        super().__init__(f'the door ended before completion: {exit.signal or exit.code}; {exit.stderr.strip()}', exit)


class MercurySpawnError(MercuryError):
    def __init__(self, command: str, cause: Exception):
        super().__init__(f'could not start {command!r}: {cause}')
        self.command = command
        self.__cause__ = cause


class MercuryWireError(MercuryError):
    def __init__(self, line: str, reason: str, row_type: str | None = None, issues: list | None = None, exit: RunExit | None = None):
        super().__init__(f'invalid wire frame ({reason}, {row_type}): {issues or []}', exit)
        self.line = line
        self.reason = reason
        self.row_type = row_type
        self.issues = issues or []

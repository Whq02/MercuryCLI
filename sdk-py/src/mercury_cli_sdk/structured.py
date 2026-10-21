from __future__ import annotations
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Generic, Mapping, TypeVar, cast, overload
from .errors import MercuryError, RunExit
from .generated import OutcomeRow, TypedOutcome
from .parse import Issue, StreamRow, validate

T = TypeVar('T')


@dataclass(frozen=True)
class TypedRunResult(Generic[T]):
    outcome: TypedOutcome[T]
    rows: list[StreamRow]
    exit: RunExit


@dataclass(frozen=True)
class StructuredSchema(Generic[T]):
    json_schema: dict[str, Any]
    decode: Callable[[Any], T]


def structured_schema(json_schema: dict[str, Any], decode: Callable[[Any], T]) -> StructuredSchema[T]:
    return StructuredSchema(json_schema, decode)


def schema_object(schema: StructuredSchema[Any] | str | dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
    if isinstance(schema, StructuredSchema): return schema.json_schema
    if not isinstance(schema, str): return schema
    if schema.lstrip().startswith('{'):
        try: return json.loads(schema)
        except ValueError as error: raise MercuryError('invalid schema JSON') from error
    try: return json.loads(Path(cwd or '.', schema).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error: raise MercuryError('could not read schema file: ' + schema) from error


class MercurySchemaError(MercuryError):
    """Structured output did not match its schema (``outcome`` is the raw row), or the CLI refused a schema that is not a JSON Schema (``outcome`` is None; ``issues`` carry the CLI's words at path ``schema``)."""
    def __init__(self, issues: list[Issue], outcome: OutcomeRow | None, message: str | None = None, *, code: int | None = None, data: Any = None):
        self.issues = issues
        self.outcome = outcome
        super().__init__(message if message is not None else 'structured output does not match schema: ' + ', '.join(issue.path or 'structured' for issue in issues), code=code, data=data)


RPC_INVALID_PARAMS = -32602


def schema_refusal(error: Mapping[str, Any]) -> MercurySchemaError | None:
    """The CLI's -32602 answer to a schema that is not a JSON Schema, as a ``MercurySchemaError``; None for any other error."""
    if error.get('code') != RPC_INVALID_PARAMS: return None
    data = error.get('data')
    issues = data.get('issues') if isinstance(data, Mapping) else None
    if not isinstance(issues, list): return None
    found = [Issue('.'.join(str(part) for part in issue['path']), str(issue['message'])) for issue in issues if isinstance(issue, Mapping) and isinstance(issue.get('path'), list) and issue['path'][:1] == ['schema'] and isinstance(issue.get('message'), str)]
    if not found: return None
    return MercurySchemaError(found, None, found[0].message, code=error.get('code'), data=data)


@overload
def validate_outcome(outcome: OutcomeRow, schema: StructuredSchema[T], cwd: str | None = None) -> TypedOutcome[T]: ...
@overload
def validate_outcome(outcome: OutcomeRow, schema: str | dict[str, Any] | None = None, cwd: str | None = None) -> OutcomeRow: ...
def validate_outcome(outcome: OutcomeRow, schema: StructuredSchema[T] | str | dict[str, Any] | None = None, cwd: str | None = None) -> TypedOutcome[T] | OutcomeRow:
    if schema is None or outcome['status'] != 'completed': return outcome
    spec = schema_object(schema, cwd)
    issues = validate(spec, outcome.get('structured'))
    if issues: raise MercurySchemaError(issues, outcome)
    return cast(TypedOutcome[T], {**outcome, 'structured': schema.decode(outcome.get('structured')) if isinstance(schema, StructuredSchema) else outcome.get('structured')})

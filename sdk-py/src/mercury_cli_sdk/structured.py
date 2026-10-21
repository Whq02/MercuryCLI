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
class RunResult:
    """What run_sync returns: the outcome, received rows and exit receipt."""
    outcome: OutcomeRow
    rows: list[StreamRow]
    exit: RunExit


class TypedRunResult(RunResult, Generic[T]):
    outcome: TypedOutcome[T]


@dataclass(frozen=True)
class StructuredSchema(Generic[T]):
    json_schema: dict[str, Any]
    decode: Callable[[Any], T]


def structured_schema(json_schema: dict[str, Any], decode: Callable[[Any], T]) -> StructuredSchema[T]:
    return StructuredSchema(json_schema, decode)


_SCHEMA_TYPES = ('object', 'array', 'string', 'number', 'integer', 'boolean', 'null')


def _kind_of(value: Any) -> str:
    if value is None: return 'null'
    if isinstance(value, bool): return 'boolean'
    if isinstance(value, (int, float)): return 'number'
    if isinstance(value, str): return 'string'
    if isinstance(value, list): return 'array'
    if isinstance(value, Mapping): return 'object'
    return type(value).__name__


def schema_problem(schema: Any, at: str = 'schema') -> str | None:
    """The first reason ``schema`` is not a JSON Schema the package can read (an unknown ``type``, non-object ``properties`` and the other keywords the reader indexes into), or None."""
    if not isinstance(schema, Mapping): return f'not a JSON schema — {at} must be an object (found {_kind_of(schema)})'
    types = [] if 'type' not in schema else schema['type'] if isinstance(schema['type'], list) else [schema['type']]
    for type_ in types:
        if not isinstance(type_, str) or type_ not in _SCHEMA_TYPES: return f'not a JSON schema — {at}.type must be {", ".join(_SCHEMA_TYPES)} or an array of them (found {json.dumps(type_)})'
    for key in ('enum', 'required', 'oneOf', 'anyOf'):
        if key in schema and not isinstance(schema[key], list): return f'not a JSON schema — {at}.{key} must be an array (found {_kind_of(schema[key])})'
    for key in ('minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'):
        if key in schema and (isinstance(schema[key], bool) or not isinstance(schema[key], (int, float))): return f'not a JSON schema — {at}.{key} must be a number (found {_kind_of(schema[key])})'
    for index, name in enumerate(schema.get('required', [])):
        if not isinstance(name, str): return f'not a JSON schema — {at}.required[{index}] must be a string (found {_kind_of(name)})'
    if 'properties' in schema and not isinstance(schema['properties'], Mapping): return f'not a JSON schema — {at}.properties must be an object of schemas (found {_kind_of(schema["properties"])})'
    if 'additionalProperties' in schema and not isinstance(schema['additionalProperties'], (bool, Mapping)): return f'not a JSON schema — {at}.additionalProperties must be a boolean or a schema (found {_kind_of(schema["additionalProperties"])})'
    for key, inner in schema.get('properties', {}).items():
        problem = schema_problem(inner, f'{at}.properties.{key}')
        if problem: return problem
    for key in ('items', 'propertyNames'):
        if key in schema:
            problem = schema_problem(schema[key], f'{at}.{key}')
            if problem: return problem
    if isinstance(schema.get('additionalProperties'), Mapping):
        problem = schema_problem(schema['additionalProperties'], f'{at}.additionalProperties')
        if problem: return problem
    for key in ('oneOf', 'anyOf'):
        for index, option in enumerate(schema.get(key, [])):
            problem = schema_problem(option, f'{at}.{key}[{index}]')
            if problem: return problem
    return None


def schema_object(schema: StructuredSchema[Any] | str | dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
    spec = _schema_source(schema, cwd)
    problem = schema_problem(spec)
    if problem is not None: raise MercurySchemaError([Issue('schema', problem)], None, problem)
    return spec


def _schema_source(schema: StructuredSchema[Any] | str | dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
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

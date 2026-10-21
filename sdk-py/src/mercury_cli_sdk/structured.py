from __future__ import annotations
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Generic, TypeVar, cast, overload
from .errors import MercuryError
from .generated import OutcomeRow, TypedOutcome
from .parse import Issue, validate

T = TypeVar('T')


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
    def __init__(self, issues: list[Issue], outcome: OutcomeRow):
        self.issues = issues
        self.outcome = outcome
        super().__init__('structured output does not match schema: ' + ', '.join(issue.path or 'structured' for issue in issues))


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

from __future__ import annotations
import json
import math
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, NotRequired, TypedDict, TypeVar, cast
from .generated import ROWS_SCHEMA, ROW_SCHEMAS, INPUT_ROW_SCHEMAS, Row, InputRow


class UnknownRow(TypedDict):
    type: Literal['unknown_row']
    original_type: str
    raw: dict[str, Any]
    seq: NotRequired[int]
    timestamp: NotRequired[str]
    parent_call_id: NotRequired[str]
    session_id: NotRequired[str]
    turn: NotRequired[int]


StreamRow = Row | UnknownRow


@dataclass(frozen=True)
class Issue:
    path: str
    message: str


T = TypeVar('T')


@dataclass(frozen=True)
class RowRead(Generic[T]):
    ok: bool
    row: T | None = None
    reason: str | None = None
    type: str | None = None
    issues: list[Issue] = field(default_factory=list)
    schema: Any = None


def validate(schema: dict, value: Any, path: str = '') -> list[Issue]:
    union = schema.get('oneOf', schema.get('anyOf'))
    if union is not None:
        attempts = [validate(s, value, path) for s in union]
        return [] if any(not a for a in attempts) else [Issue(path, 'matches no union member')]
    tests = {
        'object': lambda v: isinstance(v, dict), 'array': lambda v: isinstance(v, list),
        'string': lambda v: isinstance(v, str), 'boolean': lambda v: isinstance(v, bool),
        'number': lambda v: type(v) in (int, float) and math.isfinite(v),
        'integer': lambda v: type(v) is int,
        'null': lambda v: v is None,
    }
    if 'type' in schema:
        types = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if not any(tests[t](value) for t in types):
            return [Issue(path, f'expected {types}')]
    if 'const' in schema and (value != schema['const'] or isinstance(value, bool) != isinstance(schema['const'], bool)):
        return [Issue(path, f"expected constant {schema['const']!r}")]
    if 'enum' in schema and value not in schema['enum']:
        return [Issue(path, f"expected one of {schema['enum']!r}")]
    issues = []
    if type(value) in (int, float):
        for key, bad in [('minimum', lambda x: value < x), ('maximum', lambda x: value > x), ('exclusiveMinimum', lambda x: value <= x), ('exclusiveMaximum', lambda x: value >= x)]:
            if key in schema and bad(schema[key]): issues.append(Issue(path, key))
    if isinstance(value, str):
        if len(value) < schema.get('minLength', 0): issues.append(Issue(path, 'string too short'))
        if 'maxLength' in schema and len(value) > schema['maxLength']: issues.append(Issue(path, 'string too long'))
    if isinstance(value, list) and 'items' in schema:
        for i, item in enumerate(value): issues.extend(validate(schema['items'], item, f'{path}[{i}]'))
    if isinstance(value, dict):
        props = schema.get('properties', {})
        for key in schema.get('required', []):
            if key not in value: issues.append(Issue(f'{path}.{key}'.lstrip('.'), 'required'))
        for key, item in value.items():
            p = f'{path}.{key}'.lstrip('.')
            if key in props: issues.extend(validate(props[key], item, p))
            elif schema.get('additionalProperties') is False: issues.append(Issue(p, 'not a declared key'))
            elif isinstance(schema.get('additionalProperties'), dict): issues.extend(validate(schema['additionalProperties'], item, p))
    return issues


def _read(value: Any, inputs: bool = False) -> RowRead[StreamRow | InputRow]:
    if not isinstance(value, dict): return RowRead(False, reason='not_an_object')
    t = value.get('type')
    if not isinstance(t, str): return RowRead(False, reason='no_type')
    schemas = INPUT_ROW_SCHEMAS if inputs else ROW_SCHEMAS
    if t not in schemas:
        if inputs: return RowRead(False, reason='unknown_type', type=t)
        unknown = {'type': 'unknown_row', 'original_type': t, 'raw': value}
        for key in ('seq', 'turn'):
            if type(value.get(key)) is int: unknown[key] = value[key]
        for key in ('timestamp', 'parent_call_id', 'session_id'):
            if isinstance(value.get(key), str): unknown[key] = value[key]
        return RowRead(True, row=cast(UnknownRow, unknown))
    if not inputs and t in ('session', 'outcome') and (type(value.get('schema')) is not int or value.get('schema') != ROWS_SCHEMA):
        return RowRead(False, reason='schema_mismatch', type=t, schema=value.get('schema'))
    issues = validate(schemas[t], value)
    if inputs and not issues:
        if t == 'prompt' and value['content'] in ('', []): issues.append(Issue('content', 'a prompt row with no content'))
        if t == 'shell' and not value['command'].strip(): issues.append(Issue('command', 'a shell row with no command'))
        if t == 'note' and (value['to'] == '' or value['content'] == ''): issues.append(Issue('', 'a note row with no agent or no content'))
    return RowRead(not issues, row=cast(StreamRow | InputRow, value) if not issues else None, reason='invalid' if issues else None, type=t, issues=issues)


def row_of(value: Any) -> RowRead[StreamRow]:
    return cast(RowRead[StreamRow], _read(value))


def input_row_of(value: Any) -> RowRead[InputRow]:
    return cast(RowRead[InputRow], _read(value, True))


def parse_row(line: str) -> RowRead[StreamRow]:
    try:
        return row_of(json.loads(line.lstrip('\ufeff')))
    except (ValueError, TypeError):
        return RowRead(False, reason='not_json')

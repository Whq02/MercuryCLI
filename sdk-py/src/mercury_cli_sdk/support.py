from __future__ import annotations
import re
from typing import Any, Literal, Mapping, TypedDict
from .errors import MercuryError

FEATURE_FLOORS: dict[str, str] = {'per_turn_schema': '1.0.0-beta.41', 'file_checkpoints': '1.0.0-beta.41'}
RunnerFeature = Literal['per_turn_schema', 'file_checkpoints']
_FEATURE_WORDS: dict[str, str] = {'per_turn_schema': 'per-turn schema', 'file_checkpoints': 'file checkpoints'}
_VERSION = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')


class RunnerSupport(TypedDict):
    """What the connected runner honours, read from its ``initialize`` answer against ``FEATURE_FLOORS``."""
    per_turn_schema: bool
    file_checkpoints: bool


def parse_version(version: str) -> tuple[tuple[int, int, int], tuple[int | str, ...] | None] | None:
    """``(release, prerelease)`` for a ``major.minor.patch[-pre]`` version; None when the text is not one."""
    match = _VERSION.match(version.strip())
    if match is None: return None
    pre = None if match.group(4) is None else tuple(int(part) if part.isdigit() else part for part in match.group(4).split('.'))
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))), pre


def compare_versions(a: str, b: str) -> int | None:
    """-1, 0 or 1 ordering two versions as semver does; None when either does not parse."""
    left, right = parse_version(a), parse_version(b)
    if left is None or right is None: return None
    if left[0] != right[0]: return -1 if left[0] < right[0] else 1
    if left[1] is None or right[1] is None: return 0 if left[1] == right[1] else (1 if left[1] is None else -1)
    for x, y in zip(left[1], right[1]):
        if x == y: continue
        if isinstance(x, int) and isinstance(y, int): return -1 if x < y else 1
        if isinstance(x, int): return -1
        if isinstance(y, int): return 1
        return -1 if x < y else 1
    if len(left[1]) == len(right[1]): return 0
    return -1 if len(left[1]) < len(right[1]) else 1


def runner_support(initialized: Mapping[str, Any] | None) -> RunnerSupport:
    """The features the runner behind an ``initialize`` answer honours: a runner at or above each floor, or one whose answer already carries ``file_checkpoints`` (the same product fold), supports it; an unparseable version is not held below any floor."""
    answered = initialized is not None and initialized.get('file_checkpoints') is not None
    version = str((initialized or {}).get('runner', {}).get('version', ''))
    def reaches(floor: str) -> bool:
        order = compare_versions(version, floor)
        return order is None or order >= 0
    return {'per_turn_schema': answered or reaches(FEATURE_FLOORS['per_turn_schema']), 'file_checkpoints': answered or reaches(FEATURE_FLOORS['file_checkpoints'])}


def unsupported_feature(feature: RunnerFeature, version: str) -> MercuryError:
    return MercuryError(f'{_FEATURE_WORDS[feature]} needs Mercury {FEATURE_FLOORS[feature]} or newer; this runner is {version} — run `mercury update`')

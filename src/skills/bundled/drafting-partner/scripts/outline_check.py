#!/usr/bin/env python3
"""Check a Markdown draft's structure: heading levels, empty or duplicate sections, balance.

Usage:
  outline_check.py <draft.md>
  outline_check.py --self-test

Reports findings and prints the outline with word counts. Exit 0 when there
are no findings, 1 when there are, 2 on usage errors.
"""
from __future__ import annotations

import re
import sys

HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
FENCE = re.compile(r"^(```|~~~)")


def parse(text: str) -> list[dict]:
    sections: list[dict] = []
    in_fence = False
    current = {"level": 0, "title": "(preamble)", "words": 0, "line": 0}
    for i, line in enumerate(text.split("\n"), 1):
        if FENCE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            current["words"] += len(line.split())
            continue
        m = HEADING.match(line)
        if m:
            sections.append(current)
            current = {"level": len(m.group(1)), "title": m.group(2).strip(), "words": 0, "line": i}
        else:
            current["words"] += len(line.split())
    sections.append(current)
    return sections


def check(text: str) -> tuple[list[str], list[dict]]:
    findings: list[str] = []
    sections = parse(text)
    headed = [s for s in sections if s["level"] > 0]
    if not headed:
        return ["no headings found — the draft has no outline yet"], sections
    prev_level = 0
    seen: dict[str, int] = {}
    for s in headed:
        if s["level"] > prev_level + 1 and prev_level > 0:
            findings.append(f"line {s['line']}: heading level jumps from {prev_level} to {s['level']} (\"{s['title']}\")")
        prev_level = s["level"]
        key = s["title"].lower()
        if key in seen:
            findings.append(f"line {s['line']}: duplicate heading \"{s['title']}\" (also line {seen[key]})")
        seen.setdefault(key, s["line"])
    for idx, s in enumerate(headed):
        nxt = headed[idx + 1] if idx + 1 < len(headed) else None
        has_children = nxt is not None and nxt["level"] > s["level"]
        if s["words"] == 0 and not has_children:
            findings.append(f"line {s['line']}: section \"{s['title']}\" is empty")
    bodies = [s["words"] for s in headed if s["words"] > 0]
    if len(bodies) >= 3:
        biggest = max(bodies)
        median = sorted(bodies)[len(bodies) // 2]
        if median > 0 and biggest > 6 * median:
            big = max((s for s in headed if s["words"] == biggest), key=lambda s: s["line"])
            findings.append(f"line {big['line']}: \"{big['title']}\" holds {biggest} words, over six times the median section — split it")
    return findings, sections


def render(sections: list[dict]) -> str:
    lines = []
    for s in sections:
        if s["level"] == 0:
            if s["words"]:
                lines.append(f"(preamble) {s['words']}w")
            continue
        lines.append(f"{'  ' * (s['level'] - 1)}{s['title']}  {s['words']}w")
    return "\n".join(lines)


def self_test() -> int:
    good = "# Plan\n\nIntro words here.\n\n## Scope\n\nSome scope.\n\n## Costs\n\nSome costs.\n\n## Risks\n\nSome risks.\n"
    bad = "# Plan\n\n### Deep\n\ntext\n\n## Scope\n\n## Scope\n\nwords\n\n## Long\n\n" + ("word " * 400) + "\n\n## Short\n\nfew\n\n## Other\n\nfew more\n\n```\n## not a heading\n```\n"
    g, _ = check(good)
    b, secs = check(bad)
    titles = [s["title"] for s in secs if s["level"] > 0]
    ok = (
        g == []
        and any("jumps from 1 to 3" in f for f in b)
        and any("duplicate heading" in f for f in b)
        and any('"Scope" is empty' in f for f in b)
        and any("six times the median" in f for f in b)
        and "not a heading" not in titles
    )
    print("self-test:", "PASS" if ok else f"FAIL good={g} bad={b}")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if len(argv) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[0], encoding="utf-8") as fh:
        findings, sections = check(fh.read())
    print(render(sections))
    if findings:
        print()
        for f in findings:
            print(f"FAIL {f}")
        return 1
    print("\nPASS structure")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

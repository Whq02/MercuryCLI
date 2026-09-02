#!/usr/bin/env python3
"""Lint a Mercury skill directory: frontmatter, description budget, paths, body size.

Usage:
  skill_lint.py <skill-dir> [--max-description 1000] [--max-body-lines 250]
  skill_lint.py --self-test

Exit 0 when every check passes, 1 when any check fails, 2 on bad usage.
"""
from __future__ import annotations

import os
import re
import sys
import tempfile

FRONT_RE = re.compile(r"^﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)
TRIGGER_RE = re.compile(r"\b(use when|when (the user|asked|you)|trigger)", re.I)
PATH_RE = re.compile(r"`((?:scripts|references|assets|templates)/[A-Za-z0-9_./-]+)`")
REQUIRED = ("name", "description")
KNOWN = {
    "name", "description", "when_to_use", "argument-hint", "allowed-tools",
    "disable-model-invocation", "user-invocable", "context", "agent", "model",
    "effort", "paths", "version", "hooks", "shell",
}


def parse_frontmatter(text: str) -> tuple[dict[str, str], str] | None:
    m = FRONT_RE.match(text)
    if not m:
        return None
    fields: dict[str, str] = {}
    for line in m.group(1).split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")):
            continue  # continuation of a block value; the parent key is enough here
        key, sep, value = line.partition(":")
        if not sep:
            return None
        fields[key.strip()] = value.strip().strip("'\"")
    return fields, text[m.end():]


def lint(skill_dir: str, max_description: int = 1000, max_body_lines: int = 250) -> list[str]:
    findings: list[str] = []
    skill_md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill_md):
        return [f"missing {skill_md}"]
    with open(skill_md, encoding="utf-8") as fh:
        text = fh.read()
    parsed = parse_frontmatter(text)
    if parsed is None:
        return ["frontmatter block missing or malformed (expects --- … --- at the top)"]
    fields, body = parsed
    for key in REQUIRED:
        if not fields.get(key):
            findings.append(f"frontmatter: `{key}` is required")
    dir_name = os.path.basename(os.path.abspath(skill_dir.rstrip("/")))
    name = fields.get("name", "")
    if name and name != dir_name:
        findings.append(f"frontmatter: name `{name}` does not match directory `{dir_name}`")
    if name and not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name):
        findings.append(f"frontmatter: name `{name}` must be lowercase letters, digits, hyphens")
    description = fields.get("description", "")
    if len(description) > max_description:
        findings.append(f"description is {len(description)} chars (budget {max_description})")
    if description and not TRIGGER_RE.search(description + " " + fields.get("when_to_use", "")):
        findings.append("description carries no trigger (say when to use it)")
    for key in fields:
        if key not in KNOWN:
            findings.append(f"frontmatter: unknown key `{key}`")
    body_lines = body.count("\n") + 1
    if body_lines > max_body_lines:
        findings.append(f"body is {body_lines} lines (limit {max_body_lines}); move depth into references/")
    for rel in sorted(set(PATH_RE.findall(body))):
        if not os.path.exists(os.path.join(skill_dir, rel)):
            findings.append(f"body names `{rel}` but the file is absent")
    return findings


def self_test() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        good = os.path.join(tmp, "good-skill")
        os.makedirs(os.path.join(good, "scripts"))
        with open(os.path.join(good, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("---\nname: good-skill\ndescription: Does a thing. Use when asked for the thing.\n---\n\n# Body\n\nRun `scripts/run.py`.\n")
        with open(os.path.join(good, "scripts", "run.py"), "w", encoding="utf-8") as fh:
            fh.write("print('ok')\n")
        bad = os.path.join(tmp, "bad-skill")
        os.makedirs(bad)
        with open(os.path.join(bad, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("---\nname: other-name\ndescription: " + "x" * 1200 + "\nbogus: 1\n---\n\nSee `scripts/missing.py`.\n")
        g = lint(good)
        b = lint(bad)
        expect_b = ("does not match directory", "chars (budget", "carries no trigger", "unknown key", "is absent")
        ok = g == [] and all(any(e in f for f in b) for e in expect_b)
        print("self-test:", "PASS" if ok else "FAIL")
        if not ok:
            print("good:", g)
            print("bad:", b)
        return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    opts = {"--max-description": 1000, "--max-body-lines": 250}
    for flag in opts:
        if flag in argv:
            opts[flag] = int(argv[argv.index(flag) + 1])
    findings = lint(args[0], opts["--max-description"], opts["--max-body-lines"])
    if findings:
        for f in findings:
            print(f"FAIL {f}")
        return 1
    print(f"PASS {args[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

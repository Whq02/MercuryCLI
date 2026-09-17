#!/usr/bin/env python3
import glob
import os
import re
import sys

SKIP = re.compile(r"\[SKIP")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
FIRST_LINE_CHARS = 240
HEADING = "## Skip census (a count, never a verdict)"


def usage(code):
    print("usage: skip-census.py <shard-out-dir> | --aggregate <results-dir>", file=sys.stderr)
    sys.exit(code)


def read_results(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 6:
                rows.append(parts)
    return rows


def clean(line):
    return ANSI.sub("", line).replace("\t", " ").strip()[:FIRST_LINE_CHARS]


def count_skips(path):
    count = 0
    first = ""
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if SKIP.search(line):
                count += 1
                if not first:
                    first = clean(line)
    return count, first


def shard(out_dir):
    results = os.path.join(out_dir, "results.tsv")
    if not os.path.isfile(results):
        print(f"skip-census: no results.tsv under {out_dir}", file=sys.stderr)
        sys.exit(2)
    rows = []
    for dom, _cls, _rc, _secs, retry_rc, _retry_secs in read_results(results):
        attempt = os.path.join(out_dir, dom + ".out")
        retried = os.path.join(out_dir, "retry", dom + ".out")
        if retry_rc != "-" and os.path.isfile(retried):
            attempt = retried
        if not os.path.isfile(attempt):
            rows.append((dom, "-", "no output file"))
            continue
        count, first = count_skips(attempt)
        rows.append((dom, str(count), first if count else "-"))
    target = os.path.join(out_dir, "skips.tsv")
    with open(target, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write("\t".join(r) + "\n")
    skipped = [r for r in rows if r[1] not in ("-", "0")]
    uncounted = [r for r in rows if r[1] == "-"]
    tail = f", {len(uncounted)} not counted" if uncounted else ""
    print(f"skip census: {len(skipped)} of {len(rows)} suites carried [SKIP] lines{tail} → {target}")
    for dom, count, first in skipped:
        print(f"  {dom:<18} {count:>3}  {first[:200]}")
    for dom, _count, why in uncounted:
        print(f"  {dom:<18}   -  {why}")


def aggregate(results_dir):
    if not os.path.isdir(results_dir):
        print(f"skip-census: no results directory at {results_dir}", file=sys.stderr)
        sys.exit(2)
    reported = []
    for tsv in sorted(glob.glob(os.path.join(results_dir, "**", "results.tsv"), recursive=True)):
        reported.extend(r[0] for r in read_results(tsv))
    census = {}
    for tsv in sorted(glob.glob(os.path.join(results_dir, "**", "skips.tsv"), recursive=True)):
        with open(tsv, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.rstrip("\n").split("\t")
                if len(parts) == 3:
                    census[parts[0]] = (parts[1], parts[2])
    skipped = sorted(((dom, int(c), first) for dom, (c, first) in census.items() if c not in ("-", "0")), key=lambda r: (-r[1], r[0]))
    none = sorted(dom for dom, (c, _first) in census.items() if c == "0")
    uncounted = sorted((dom, why) for dom, (c, why) in census.items() if c == "-")
    absent = sorted(set(dom for dom in reported if dom not in census))
    lines = [HEADING, ""]
    tail = f"; {len(uncounted)} not counted" if uncounted else ""
    lines.append(f"- suites with `[SKIP]` lines: **{len(skipped)}** of {len(census)} counted; {len(none)} carried none{tail}")
    if absent:
        lines.append(f"- no census from: {', '.join(absent)}")
    if uncounted:
        lines.append("- not counted: " + ", ".join(f"{dom} ({why})" for dom, why in uncounted))
    lines.append("")
    if skipped:
        lines.append("| suite | skips | first skip line |")
        lines.append("|---|---|---|")
        for dom, count, first in skipped:
            cell = first.replace("|", "\\|")
            lines.append(f"| {dom} | {count} | {cell} |")
    else:
        lines.append("- no counted suite carried a `[SKIP]` line")
    out = "\n".join(lines) + "\n"
    print(out)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(out)


args = sys.argv[1:]
if len(args) == 2 and args[0] == "--aggregate":
    aggregate(args[1])
elif len(args) == 1 and not args[0].startswith("--"):
    shard(args[0])
else:
    usage(2)

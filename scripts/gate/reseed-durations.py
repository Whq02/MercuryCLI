#!/usr/bin/env python3
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "duration-seed.tsv")


def usage(code):
    sys.stderr.write(
        "usage: reseed-durations.py <verdict.json | suite=seconds ...> [--write] [--top N]\n"
        "  prints every row the verdict's pooled seconds would move in scripts/gate/duration-seed.tsv\n"
        "  (suite · seeded · measured) and the longest measured walls; --write rewrites those rows in place,\n"
        "  keeping every other row, the comments and the order. A suite the file does not know is listed,\n"
        "  never added: a new suite earns its row by hand under the class it belongs to.\n")
    sys.exit(code)


def measured_from(args):
    durations = {}
    for arg in args:
        if "=" in arg and not os.path.exists(arg):
            suite, _, secs = arg.partition("=")
            if not secs.isdigit():
                usage(2)
            durations[suite] = int(secs)
            continue
        with open(arg) as source:
            verdict = json.load(source)
        rows = verdict.get("durations") if isinstance(verdict, dict) else None
        if not isinstance(rows, dict):
            sys.stderr.write("%s: no durations object in the verdict\n" % arg)
            sys.exit(2)
        for suite, secs in rows.items():
            if isinstance(secs, (int, float)) and secs >= 0:
                durations[suite] = int(round(secs))
    return durations


def main(argv):
    write = "--write" in argv
    top = 10
    args = []
    skip = False
    for i, arg in enumerate(argv):
        if skip:
            skip = False
            continue
        if arg == "--write":
            continue
        if arg == "--top":
            top = int(argv[i + 1])
            skip = True
            continue
        args.append(arg)
    if not args:
        usage(2)
    measured = measured_from(args)
    lines = open(SEED).read().split("\n")
    seen = set()
    moved = []
    out = []
    for line in lines:
        if line.startswith("#") or "\t" not in line:
            out.append(line)
            continue
        suite, _, secs = line.partition("\t")
        seen.add(suite)
        if suite in measured and measured[suite] != int(secs):
            moved.append((suite, int(secs), measured[suite]))
            out.append("%s\t%d" % (suite, measured[suite]))
        else:
            out.append(line)
    unknown = sorted(s for s in measured if s not in seen)
    print("duration seed: %d measured wall(s) · %d row(s) move · %d suite(s) without a row" % (len(measured), len(moved), len(unknown)))
    for suite, old, new in sorted(moved, key=lambda m: m[2] - m[1]):
        print("  %-28s %6d -> %6d  (%+d s)" % (suite, old, new, new - old))
    for suite in unknown:
        print("  %-28s (no row; measured %d s — add it by hand under its class)" % (suite, measured[suite]))
    longest = sorted(measured.items(), key=lambda kv: -kv[1])[:top]
    print("the %d longest measured walls:" % len(longest))
    for suite, secs in longest:
        print("  %-28s %6d s" % (suite, secs))
    if write and moved:
        with open(SEED, "w") as target:
            target.write("\n".join(out))
        print("written: %s (%d row(s))" % (SEED, len(moved)))
    elif write:
        print("nothing to write")
    else:
        print("dry run — add --write to rewrite the rows")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SEED = os.path.join(HERE, "duration-seed.tsv")
LIMIT_PINS = ("MERCURY_SUITE_TIMEOUT", "MERCURY_SUITE_TIMEOUT_FLOOR", "MERCURY_SUITE_CEILING", "MERCURY_CI_SHARD_CEILING_FILE")


def usage(code):
    sys.stderr.write(
        "usage: reseed-durations.py <verdict.json | suite=seconds ...> [--write | --out <file>] [--top N]\n"
        "  prints every row the verdict's pooled seconds would move in scripts/gate/duration-seed.tsv\n"
        "  (suite · seeded · measured) and the longest measured walls; --write rewrites those rows in place,\n"
        "  keeping every other row, the comments and the order. A row whose fall would lower its suite's\n"
        "  hosted time limit (the budget column of scripts/gate/ci-shard.sh --plan-table) keeps its seconds\n"
        "  and is listed. A suite the file does not know is listed,\n"
        "  never added: a new suite earns its row by hand under the class it belongs to.\n"
        "  --out <file> writes the same rows, and a row for each suite the file does not know, to <file>\n"
        "  and leaves scripts/gate/duration-seed.tsv alone: a check that pins its own time limits orders its\n"
        "  queues from <file> through MERCURY_CI_SHARD_SEED_FILE.\n")
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


def hosted_limits(seed_file):
    env = {name: value for name, value in os.environ.items() if name not in LIMIT_PINS}
    env["MERCURY_CI_SHARD_SEED_FILE"] = seed_file
    limits = {}
    for scope in ("release", "drives"):
        for index in ("0", "darwin"):
            plan = subprocess.run(
                ["bash", os.path.join(HERE, "ci-shard.sh"), index, "1", "--class", scope, "--plan-table"],
                cwd=ROOT, env=env, capture_output=True, text=True)
            if plan.returncode != 0:
                sys.stderr.write("scripts/gate/ci-shard.sh --plan-table failed (rc %d): %s\n" % (plan.returncode, plan.stderr.strip()[:400]))
                sys.exit(2)
            for row in plan.stdout.splitlines():
                parts = row.split("\t")
                if len(parts) == 4 and parts[3].isdigit():
                    limits[parts[0]] = int(parts[3])
    return limits


def rows_from(lines, measured, keep):
    seen = set()
    moved = []
    out = []
    for line in lines:
        if line.startswith("#") or "\t" not in line:
            out.append(line)
            continue
        suite, _, secs = line.partition("\t")
        seen.add(suite)
        if suite in measured and measured[suite] != int(secs) and suite not in keep:
            moved.append((suite, int(secs), measured[suite]))
            out.append("%s\t%d" % (suite, measured[suite]))
        else:
            out.append(line)
    return seen, moved, out


def lowered_limits(moved, out):
    if not moved:
        return []
    handle, candidate = tempfile.mkstemp(suffix=".tsv")
    try:
        with os.fdopen(handle, "w") as target:
            target.write("\n".join(out))
        before = hosted_limits(SEED)
        after = hosted_limits(candidate)
    finally:
        os.remove(candidate)
    return [(suite, old, new, before[suite], after[suite]) for suite, old, new in moved if suite in before and suite in after and after[suite] < before[suite]]


def main(argv):
    write = "--write" in argv
    top = 10
    out_path = None
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
        if arg == "--out":
            if i + 1 >= len(argv):
                usage(2)
            out_path = argv[i + 1]
            skip = True
            continue
        args.append(arg)
    if not args or (write and out_path is not None):
        usage(2)
    measured = measured_from(args)
    lines = open(SEED).read().split("\n")
    seen, moved, out = rows_from(lines, measured, set())
    kept = lowered_limits(moved, out) if out_path is None else []
    if kept:
        seen, moved, out = rows_from(lines, measured, {row[0] for row in kept})
    unknown = sorted(s for s in measured if s not in seen)
    print("duration seed: %d measured wall(s) · %d row(s) move · %d row(s) keep their seconds · %d suite(s) without a row" % (len(measured), len(moved), len(kept), len(unknown)))
    for suite, old, new in sorted(moved, key=lambda m: m[2] - m[1]):
        print("  %-28s %6d -> %6d  (%+d s)" % (suite, old, new, new - old))
    for suite, old, new, limit, lower in sorted(kept, key=lambda k: k[4] - k[3]):
        print("  %-28s %6d kept (measured %d s; its hosted limit would fall %d -> %d s)" % (suite, old, new, limit, lower))
    for suite in unknown:
        print("  %-28s (no row; measured %d s — add it by hand under its class)" % (suite, measured[suite]))
    longest = sorted(measured.items(), key=lambda kv: -kv[1])[:top]
    print("the %d longest measured walls:" % len(longest))
    for suite, secs in longest:
        print("  %-28s %6d s" % (suite, secs))
    if out_path is not None:
        body = "\n".join(out)
        if unknown:
            body = body.rstrip("\n") + "\n" + "".join("%s\t%d\n" % (suite, measured[suite]) for suite in unknown)
        with open(out_path, "w") as target:
            target.write(body)
        print("written: %s (%d row(s) moved, %d added; %s is unchanged)" % (out_path, len(moved), len(unknown), SEED))
    elif write and moved:
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

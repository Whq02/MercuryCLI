#!/usr/bin/env python3
import glob
import json
import os
import re
import subprocess
import sys
import time

scope = "all"
positional = []
argv = sys.argv[1:]
i = 0
while i < len(argv):
    if argv[i] == "--scope":
        scope = argv[i + 1] if i + 1 < len(argv) else ""
        i += 2
        continue
    if argv[i].startswith("--scope="):
        scope = argv[i].split("=", 1)[1]
        i += 1
        continue
    positional.append(argv[i])
    i += 1
if scope not in ("release", "drives", "all"):
    print(f"ci-verdict: --scope wants release|drives|all (got '{scope}')", file=sys.stderr)
    sys.exit(2)
results_dir = positional[0] if positional else "results"

SCOPES = {
    "release": {"pure", "cpu", "exclusive"},
    "drives": {"pty"},
    "all": {"pure", "cpu", "pty", "exclusive"},
}
OTHER = {"release": "drives", "drives": "release"}
VALID = {"pure", "cpu", "pty", "exclusive"}


def class_of(runner):
    for line in open(runner, encoding="utf-8", errors="replace"):
        m = re.match(r"^# gate-class:\s*(\S+)", line)
        if m:
            return m.group(1) if m.group(1) in VALID else "undeclared"
    return "undeclared"


MEMBER = re.compile(r"── (\S+)\s+\d+s rc=(\d+)\s*$")


def red_members(log):
    found = []
    try:
        with open(log, encoding="utf-8", errors="replace") as rows_of_log:
            for line in rows_of_log:
                m = MEMBER.search(line)
                if m and m.group(2) != "0" and m.group(1) not in found:
                    found.append(m.group(1))
    except OSError:
        pass
    return found


runners = {os.path.basename(os.path.dirname(p)): p for p in glob.glob("scripts/*/run-all.sh")}
estate = sorted(runners)
declared = {d: class_of(runners[d]) for d in estate}
unclassed = [d for d in estate if declared[d] == "undeclared"]
in_scope = SCOPES[scope]
expected = sorted(d for d in estate if declared[d] in in_scope)
deferred = {}
if scope in OTHER:
    deferred[OTHER[scope]] = sorted(d for d in estate if declared[d] in SCOPES[OTHER[scope]])

rows = {}
duplicated = []
for tsv in sorted(glob.glob(os.path.join(results_dir, "**", "results.tsv"), recursive=True)):
    before = 0
    for line in open(tsv):
        parts = line.rstrip("\n").split("\t")
        if len(parts) != 6:
            continue
        dom, cls, rc, secs, retry_rc, retry_secs = parts
        if dom in rows:
            duplicated.append(dom)
        rows[dom] = {
            "class": cls,
            "rc": int(rc),
            "secs": int(secs),
            "retryRc": None if retry_rc == "-" else int(retry_rc),
            "retrySecs": None if retry_secs == "-" else int(retry_secs),
            "shard": os.path.dirname(tsv),
            "before": before,
        }
        before += 1
notes = {}
for tsv in sorted(glob.glob(os.path.join(results_dir, "**", "notes.tsv"), recursive=True)):
    for line in open(tsv):
        parts = line.rstrip("\n").split("\t", 1)
        if len(parts) == 2 and parts[0] and parts[1]:
            notes[parts[0]] = parts[1]

missing = [d for d in expected if d not in rows]
unknown = sorted(d for d in rows if d not in estate)
misplanned = sorted(d for d in rows if d in estate and declared[d] not in in_scope)
passed, failed, flakes = [], [], []
for dom, r in sorted(rows.items()):
    final_rc = r["rc"] if r["retryRc"] is None else r["retryRc"]
    if r["retryRc"] is not None:
        flakes.append(
            {
                "suite": dom,
                "pooledRc": r["rc"],
                "pooledSecs": r["secs"],
                "soloRc": r["retryRc"],
                "soloSecs": r["retrySecs"],
                "pooledMembers": red_members(os.path.join(r["shard"], dom + ".out")),
                "soloMembers": red_members(os.path.join(r["shard"], "retry", dom + ".out")),
                "homeSuitesBefore": r["before"],
            }
        )
    (passed if final_rc == 0 else failed).append(dom)

head = subprocess.run(
    ["git", "rev-parse", "HEAD"], capture_output=True, text=True
).stdout.strip() or None

ok = not failed and not missing and not duplicated and not unknown and not unclassed and not misplanned
verdict = {
    "ok": ok,
    "scope": scope,
    "pass": passed,
    "fail": failed,
    "missing": missing,
    "duplicated": sorted(set(duplicated)),
    "unknown": unknown,
    "unclassed": unclassed,
    "misplanned": misplanned,
    "deferred": deferred,
    "ranAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "headSha": head,
    "source": "ci",
    "durations": {d: r["secs"] for d, r in sorted(rows.items())},
    "classes": {d: r["class"] for d, r in sorted(rows.items())},
    "flakes": flakes,
    "notes": {d: notes[d] for d in sorted(notes) if d in rows},
}
with open("ci-verdict.json", "w") as f:
    json.dump(verdict, f, indent=2)

summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
title = {"release": "Gate verdict (release scope)", "drives": "Drives verdict", "all": "Gate verdict"}[scope]
lines = []
lines.append(f"# {title} — " + ("✅ ALL GREEN" if ok else "❌ RED"))
lines.append("")
lines.append(f"- suites reported: **{len(rows)}** / expected **{len(expected)}** ({scope} scope)")
for other, suites in deferred.items():
    lines.append(f"- deferred to the {other} verdict ({len(suites)} suites, not covered here): {', '.join(suites)}")
if failed:
    lines.append(f"- **RED:** {', '.join(failed)}")
if missing:
    lines.append(f"- **MISSING (no shard reported):** {', '.join(missing)}")
if duplicated:
    lines.append(f"- **DUPLICATED:** {', '.join(sorted(set(duplicated)))}")
if unknown:
    lines.append(f"- **UNKNOWN (row for an undeclared suite):** {', '.join(unknown)}")
if unclassed:
    lines.append(f"- **UNCLASSED (no valid `# gate-class:` header — falls through the split):** {', '.join(unclassed)}")
if misplanned:
    lines.append(f"- **MISPLANNED (row for a suite outside the {scope} scope):** {', '.join(misplanned)}")
if flakes:
    lines.append(
        "- recorded runner flakes: "
        + ", ".join(f"{f['suite']} (solo rc {f['soloRc']})" for f in flakes)
    )
    for f in flakes:
        first = ", ".join(f["pooledMembers"]) or "no member row in its log"
        second = "green" if f["soloRc"] == 0 else ", ".join(f["soloMembers"]) or "no member row in its log"
        lines.append(
            f"  - {f['suite']}: first attempt after {f['homeSuitesBefore']} suite(s) in the shard's home, red: {first}"
            f" · second run in a home of its own: {second}"
        )
lines.append("")
lines.append("| suite | class | rc | secs | retry | first stuck send |")
lines.append("|---|---|---|---|---|---|")
for dom, r in sorted(rows.items(), key=lambda kv: -kv[1]["secs"]):
    retry = "-" if r["retryRc"] is None else f"rc {r['retryRc']} in {r['retrySecs']}s"
    mark = "✅" if (r["rc"] if r["retryRc"] is None else r["retryRc"]) == 0 else "❌"
    note = notes.get(dom, "").replace("|", "\\|")
    lines.append(f"| {mark} {dom} | {r['class']} | {r['rc']} | {r['secs']} | {retry} | {note} |")
out = "\n".join(lines) + "\n"
print(out)
if summary_path:
    with open(summary_path, "a") as f:
        f.write(out)

sys.exit(0 if ok else 1)

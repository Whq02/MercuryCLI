#!/usr/bin/env python3
# ============================================================================
#  scripts/gate/ci-verdict.py — aggregate the CI gate's shard results.
#
#  Usage: ci-verdict.py <results-dir> [--scope release|drives|all]
#         (the downloaded gate-results-* / drives-results-* tree)
#
#  TWO VERDICTS. The estate splits by `# gate-class:` header into the RELEASE
#  set (pure · cpu · exclusive — the verdict a tag may carry) and the DRIVES
#  set (pty — real terminals, reported on their own). A verdict is scoped to
#  one set: its expected roster is that set; the other set is listed under
#  "deferred" so `ok` is honest about what it covers; a row for a suite
#  outside the scope is MISPLANNED and refused like an unknown row; a suite
#  with no valid header is UNCLASSED and refused in every scope — no suite
#  may fall through the split. `--scope all` is the whole estate as one.
#
#  Recomputes the expected roster from the checkout and REFUSES silent gaps: a
#  suite that no shard reported (a shard died mid-run, a bucketing bug, a
#  straggler list drifting) is a MISSING row and fails the verdict — coverage
#  is part of the contract, exactly like the local FULL run.
#
#  Writes ci-verdict.json in the local verdict.json schema (ok/pass/fail/
#  ranAt/headSha/durations/classes/flakes + missing/duplicated/unknown +
#  scope/deferred/unclassed/misplanned/notes), appends a per-suite table to
#  $GITHUB_STEP_SUMMARY (suite · class · rc · secs · retry · the capture
#  driver's first stuck send), exits nonzero on any refusal.
# ============================================================================
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
        }
# The capture driver's first stuck send per suite (the shard's notes.tsv) —
# a drive red explains itself in the table without the log.
notes = {}
for tsv in sorted(glob.glob(os.path.join(results_dir, "**", "notes.tsv"), recursive=True)):
    for line in open(tsv):
        parts = line.rstrip("\n").split("\t", 1)
        if len(parts) == 2 and parts[0] and parts[1]:
            notes[parts[0]] = parts[1]

missing = [d for d in expected if d not in rows]
# A row for a suite the checkout doesn't declare (renamed/stale/injected) is
# wrong-attribution, not coverage — refuse it like missing/duplicated (F7).
unknown = sorted(d for d in rows if d not in estate)
# A row for a suite outside this verdict's scope: the plan and the verdict
# disagree about the split — refuse it the same way.
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

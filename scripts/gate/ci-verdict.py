#!/usr/bin/env python3
# ============================================================================
#  scripts/gate/ci-verdict.py — aggregate the CI gate's shard results.
#
#  Usage: ci-verdict.py <results-dir>   (the downloaded gate-results-* tree)
#
#  Recomputes the expected suite estate from the checkout and REFUSES silent
#  gaps: a suite that no shard reported (a shard died mid-run, a bucketing
#  bug, a straggler list drifting) is a MISSING row and fails the verdict —
#  coverage is part of the contract, exactly like the local FULL run.
#
#  Writes ci-verdict.json in the local verdict.json schema (ok/pass/fail/
#  ranAt/headSha/durations/classes/flakes + missing/duplicated extensions),
#  appends a per-suite table to $GITHUB_STEP_SUMMARY, exits nonzero on any
#  RED, missing, or duplicated suite.
# ============================================================================
import glob
import json
import os
import subprocess
import sys
import time

results_dir = sys.argv[1] if len(sys.argv) > 1 else "results"

expected = sorted(
    os.path.basename(os.path.dirname(p)) for p in glob.glob("scripts/*/run-all.sh")
)

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

missing = [d for d in expected if d not in rows]
# A row for a suite the checkout doesn't declare (renamed/stale/injected) is
# wrong-attribution, not coverage — refuse it like missing/duplicated (F7).
unknown = sorted(d for d in rows if d not in expected)
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

ok = not failed and not missing and not duplicated and not unknown
verdict = {
    "ok": ok,
    "pass": passed,
    "fail": failed,
    "missing": missing,
    "duplicated": sorted(set(duplicated)),
    "unknown": unknown,
    "ranAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "headSha": head,
    "source": "ci",
    "durations": {d: r["secs"] for d, r in sorted(rows.items())},
    "classes": {d: r["class"] for d, r in sorted(rows.items())},
    "flakes": flakes,
}
with open("ci-verdict.json", "w") as f:
    json.dump(verdict, f, indent=2)

summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
lines = []
lines.append("# Gate verdict — " + ("✅ ALL GREEN" if ok else "❌ RED"))
lines.append("")
lines.append(f"- suites reported: **{len(rows)}** / expected **{len(expected)}**")
if failed:
    lines.append(f"- **RED:** {', '.join(failed)}")
if missing:
    lines.append(f"- **MISSING (no shard reported):** {', '.join(missing)}")
if duplicated:
    lines.append(f"- **DUPLICATED:** {', '.join(sorted(set(duplicated)))}")
if unknown:
    lines.append(f"- **UNKNOWN (row for an undeclared suite):** {', '.join(unknown)}")
if flakes:
    lines.append(
        "- recorded runner flakes: "
        + ", ".join(f"{f['suite']} (solo rc {f['soloRc']})" for f in flakes)
    )
lines.append("")
lines.append("| suite | class | rc | secs | retry |")
lines.append("|---|---|---|---|---|")
for dom, r in sorted(rows.items(), key=lambda kv: -kv[1]["secs"]):
    retry = "-" if r["retryRc"] is None else f"rc {r['retryRc']} in {r['retrySecs']}s"
    mark = "✅" if (r["rc"] if r["retryRc"] is None else r["retryRc"]) == 0 else "❌"
    lines.append(f"| {mark} {dom} | {r['class']} | {r['rc']} | {r['secs']} | {retry} |")
out = "\n".join(lines) + "\n"
print(out)
if summary_path:
    with open(summary_path, "a") as f:
        f.write(out)

sys.exit(0 if ok else 1)

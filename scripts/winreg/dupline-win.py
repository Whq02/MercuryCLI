#!/usr/bin/env python3
import json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(REPO, "winreg-artifacts")
BUN = shutil.which("bun") or "bun"
PROOFS = [
    ("prove-dupline-agent-drain", os.path.join(REPO, "scripts", "daemon", "prove-dupline-agent-drain.ts")),
    ("prove-dupline-agent-drain-drive", os.path.join(REPO, "scripts", "daemon", "prove-dupline-agent-drain-drive.ts")),
]

os.makedirs(OUT_DIR, exist_ok=True)
summary_path = os.path.join(OUT_DIR, "summary.json")
with open(summary_path, "w") as f:
    json.dump({"burst": "dupline", "results": [], "note": "stub: the burst died before the proofs reported; read the step log"}, f)

frames_dir = os.path.join(OUT_DIR, "dupline")
env = dict(os.environ)
env.setdefault("MERCURY_VSHOT_BUDGET_SCALE", "2")
results = []
worst = 0
log = open(os.path.join(OUT_DIR, "dupline.log"), "w", encoding="utf-8")
for name, proof in PROOFS:
    t0 = time.time()
    r = subprocess.run(
        [BUN, "run", proof, "--frames", frames_dir],
        capture_output=True, encoding="utf-8", errors="replace", cwd=REPO, env=env,
    )
    wall = round(time.time() - t0, 1)
    stdout = r.stdout or ""
    stderr = r.stderr or ""
    log.write("=== %s ===\n" % name)
    log.write(stdout)
    log.write("\n--- stderr ---\n")
    log.write(stderr)
    log.write("\n")
    rows = [l for l in stdout.splitlines() if l.startswith("  [")]
    tally = next((l for l in stdout.splitlines() if l.endswith(" failures")), "")
    results.append({"name": name, "exit": r.returncode, "wallSec": wall, "tally": tally, "rows": rows})
    with open(summary_path, "w") as f:
        json.dump({"burst": "dupline", "budgetScale": env["MERCURY_VSHOT_BUDGET_SCALE"], "results": results}, f, indent=2)
    sys.stdout.write(stdout)
    sys.stderr.write(stderr)
    print("[%s] exit=%d wall=%ss %s" % (name, r.returncode, wall, tally))
    if r.returncode != 0 and worst == 0:
        worst = r.returncode
log.close()
sys.exit(worst)

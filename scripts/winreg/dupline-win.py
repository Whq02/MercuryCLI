#!/usr/bin/env python3
import json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(REPO, "winreg-artifacts")
PROOF = os.path.join(REPO, "scripts", "daemon", "prove-dupline-agent-drain.ts")
BUN = shutil.which("bun") or "bun"
NAME = "prove-dupline-agent-drain"

os.makedirs(OUT_DIR, exist_ok=True)
summary_path = os.path.join(OUT_DIR, "summary.json")
with open(summary_path, "w") as f:
    json.dump({"burst": "dupline", "results": [], "note": "stub: the burst died before the proof reported; read the step log"}, f)

frames_dir = os.path.join(OUT_DIR, "dupline")
env = dict(os.environ)
env.setdefault("MERCURY_VSHOT_BUDGET_SCALE", "2")
t0 = time.time()
r = subprocess.run(
    [BUN, "run", PROOF, "--frames", frames_dir],
    capture_output=True, encoding="utf-8", errors="replace", cwd=REPO, env=env,
)
wall = round(time.time() - t0, 1)
stdout = r.stdout or ""
stderr = r.stderr or ""
with open(os.path.join(OUT_DIR, "dupline.log"), "w", encoding="utf-8") as f:
    f.write(stdout)
    f.write("\n--- stderr ---\n")
    f.write(stderr)
rows = [l for l in stdout.splitlines() if l.startswith("  [")]
tally = next((l for l in stdout.splitlines() if l.endswith(" failures")), "")
with open(summary_path, "w") as f:
    json.dump({
        "burst": "dupline",
        "budgetScale": env["MERCURY_VSHOT_BUDGET_SCALE"],
        "results": [{"name": NAME, "exit": r.returncode, "wallSec": wall, "tally": tally, "rows": rows}],
    }, f, indent=2)
sys.stdout.write(stdout)
sys.stderr.write(stderr)
print("[%s] exit=%d wall=%ss %s" % (NAME, r.returncode, wall, tally))
sys.exit(r.returncode)

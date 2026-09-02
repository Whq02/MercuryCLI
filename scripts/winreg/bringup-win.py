#!/usr/bin/env python3
import json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
VSHOT = os.path.join(HERE, "vshot-win.py")
OUT_DIR = os.path.join(REPO, "winreg-artifacts")
NODE = shutil.which("node") or "node"
BUN = shutil.which("bun") or "bun"
BIN = os.path.join(REPO, "dist", "mercury.mjs")

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "summary.json"), "w") as f:
    json.dump({"burst": "bringup", "results": [], "note": "stub — burst died before completion; read the step log"}, f)

def _long_path(p):
    if os.name != "nt":
        return p
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(4096)
        n = ctypes.windll.kernel32.GetLongPathNameW(p, buf, 4096)
        return buf.value if 0 < n < 4096 else p
    except Exception:
        return p

_tmp_root = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()
config_home = _long_path(tempfile.mkdtemp(prefix="mercury-winreg-home-", dir=_tmp_root))
os.environ["MERCURY_CONFIG_DIR"] = config_home
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-fixture-winreg-bringup-key")
os.environ["MERCURY_BOOT_PREFLIGHT"] = "0"
os.environ["MERCURY_LIVE_GLYPHS"] = "0"
seed = subprocess.run(
    [BUN, "run", os.path.join(REPO, "scripts", "lib", "firstRunSeed.ts"), config_home, REPO],
    capture_output=True, encoding="utf-8", errors="replace",
)
if seed.returncode != 0:
    sys.exit("firstRunSeed failed:\n%s\n%s" % (seed.stdout, seed.stderr))

READY = "❯"
COMPOSER = "? for shortcuts"
PLACEHOLDER = "Tab to focus the rails"

FIRST_CLASS_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
}

SCENARIOS = [
    {
        "name": "boot-wt-120x40",
        "env": FIRST_CLASS_ENV,
        "cfg": {
            "cols": 120, "rows": 40, "total": 400,
            "argv": [NODE, BIN],
            "readyText": [PLACEHOLDER, COMPOSER], "readySettleTicks": 3,
            "hostProfile": "wt", "cwd": REPO,
        },
    },
    {
        "name": "boot-vscode-100x30",
        "env": FIRST_CLASS_ENV,
        "cfg": {
            "cols": 100, "rows": 30, "total": 400,
            "argv": [NODE, BIN],
            "readyText": [PLACEHOLDER], "readySettleTicks": 3,
            "hostProfile": "vscode", "cwd": REPO,
        },
    },
    {
        "name": "boot-conpty-80x24",
        "envDrop": ["WT_SESSION", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM", "COLORTERM"],
        "cfg": {
            "cols": 80, "rows": 24, "total": 150,
            "argv": [NODE, BIN], "stableTicks": 5, "cwd": REPO,
        },
    },
    {
        "name": "type-echo-wt-120x40",
        "env": FIRST_CLASS_ENV,
        "cfg": {
            "cols": 120, "rows": 40, "total": 400,
            "argv": [NODE, BIN],
            "sends": [
                {"atTick": 220, "awaitText": COMPOSER, "minTick": 5,
                 "awaitSettleTicks": 3, "data": "horizon bring-up echo"},
            ],
            "readyText": "horizon bring-up echo", "readySettleTicks": 3,
            "hostProfile": "wt", "cwd": REPO,
        },
    },
    {
        "name": "resize-wt-120to80",
        "env": FIRST_CLASS_ENV,
        "cfg": {
            "cols": 120, "rows": 40, "total": 450,
            "argv": [NODE, BIN],
            "resizes": [{"atTick": 300, "cols": 80, "rows": 24}],
                        "hostProfile": "wt", "cwd": REPO,
        },
    },
]

summary = []
fail = 0
for s in SCENARIOS:
    name = s["name"]
    cfg = dict(s["cfg"])
    cfg["out"] = os.path.join(OUT_DIR, name + ".grid.json")
    cfg_path = os.path.join(OUT_DIR, name + ".cfg.json")
    with open(cfg_path, "w") as f:
        json.dump(cfg, f)
    t0 = time.time()
    env = dict(os.environ)
    env.update(s.get("env", {}))
    for k in s.get("envDrop", []):
        env.pop(k, None)
    env["VSHOT_TEE"] = os.path.join(OUT_DIR, name + ".tee.bin")
    try:
        r = subprocess.run(
            [sys.executable, VSHOT, cfg_path],
            capture_output=True, encoding="utf-8", errors="replace", env=env,
            timeout=120,
        )
    except subprocess.TimeoutExpired as e:
        class _Timeout:
            returncode = -1
            stdout = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            stderr = "TimeoutExpired after 120s"
        r = _Timeout()
    wall = round(time.time() - t0, 1)
    text_path = os.path.join(OUT_DIR, name + ".txt")
    with open(text_path, "w", encoding="utf-8") as f:
        f.write(r.stdout or "")
    entry = {"name": name, "exit": r.returncode, "wallSec": wall}
    try:
        payload = json.load(open(cfg["out"]))
        entry["endReason"] = payload.get("endReason")
        entry["readyAt"] = payload.get("readyAt")
        entry["hostProfile"] = payload.get("hostProfile")
    except Exception as e:
        entry["payloadError"] = str(e)
    if r.returncode != 0:
        fail = 1
        entry["stderr"] = (r.stderr or "")[-2000:]
    summary.append(entry)
    print("[%s] exit=%d end=%s ready=%s wall=%ss" % (
        name, r.returncode, entry.get("endReason"), entry.get("readyAt"), wall))

with open(os.path.join(OUT_DIR, "summary.json"), "w") as f:
    json.dump({"burst": "bringup", "results": summary}, f, indent=2)

shutil.rmtree(config_home, ignore_errors=True)
sys.exit(fail)

#!/usr/bin/env python3
# scripts/winreg/bringup-win.py — the Windows bring-up burst.
#
# Runs the first real ConPTY captures of the packaged runtime through
# vshot-win.py: boot to composer under the two SIMULATED first-class host
# fingerprints (ConPTY + simulated WT environment via WT_SESSION; ConPTY +
# simulated VS Code environment via TERM_PROGRAM — never the WT/VS Code
# renderer processes themselves) plus the bare-ConPTY control, a typing-echo
# journey, and a mid-flight resize.
# Artifacts (cell grids + plain text + a summary with end reasons) upload from
# the windows-ui workflow for LOCAL artifact-replay iteration — the operator
# ruling's cadence: one burst, then iterate offline, then receipt runs.
#
# Windows-only (vshot-win.py imports pywinpty). Config home is a seeded
# scratch (scripts/lib/firstRunSeed.ts — the ONE first-run seed), never the
# runner's real profile; the API key is the fixture the seed approves.
import json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
VSHOT = os.path.join(HERE, "vshot-win.py")
OUT_DIR = os.path.join(REPO, "winreg-artifacts")
NODE = shutil.which("node") or "node"
BUN = shutil.which("bun") or "bun"
BIN = os.path.join(REPO, "dist", "mercury.mjs")

os.makedirs(OUT_DIR, exist_ok=True)
# A stub summary FIRST: if anything below dies before the loop, the upload
# still ships evidence instead of going red on if-no-files-found (preflight-2
# residual). Overwritten by the real summary at the end.
with open(os.path.join(OUT_DIR, "summary.json"), "w") as f:
    json.dump({"burst": "bringup", "results": [], "note": "stub — burst died before completion; read the step log"}, f)

# One scratch config home for the burst, seeded onboarded + cwd-trusted.
# LONG-PATH LAW (burst #1 root cause): the default TEMP on hosted runners
# contains an 8.3 short segment (RUNNERA~1); a Node fs watcher armed on a
# short-form root DIES on libuv's fs-event.c:72 assertion the moment an
# event delivers the long form — the child crashed ~5s after boot. Prefer
# RUNNER_TEMP (D:\a\_temp — long form on GitHub runners); expand any 8.3
# segments via GetLongPathNameW as the fallback.
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
# Capture hermeticity (winui preflight-2 defect 2) — the SAME pins every
# POSIX capture carries (renderScenarios.ts): the boot preflight spawns a git
# probe + writes into <cwd>/.claude/doctor and its chip varies with live repo
# state; the alive-glyph layer samples the wall clock and would flake any
# static needle. Hermeticity for ALL scenarios — deliberately NOT part of the
# host-fingerprint FIRST_CLASS_ENV.
os.environ["MERCURY_BOOT_PREFLIGHT"] = "0"
os.environ["MERCURY_LIVE_GLYPHS"] = "0"
seed = subprocess.run(
    [BUN, "run", os.path.join(REPO, "scripts", "lib", "firstRunSeed.ts"), config_home, REPO],
    capture_output=True, encoding="utf-8", errors="replace",
)
if seed.returncode != 0:
    sys.exit("firstRunSeed failed:\n%s\n%s" % (seed.stdout, seed.stderr))

# TWO-NEEDLE ready gate (winui preflight defect 1): the composer sigil ❯ is
# figures.pointer — the SAME glyph the trust dialog's focused Select row
# renders, so the sigil alone can photograph a pre-REPL gate and report
# "ready". "? for shortcuts" is rendered only by the composer footer (the
# repo's established boot needle — scripts/compositor/prove-hold-takeover.ts),
# so any pre-REPL surface becomes a LOUD exit 3, never a plausible frame.
READY = "❯"
COMPOSER = "? for shortcuts"
# SPLIT-SAFE readiness:
# the rotated runner images split multibyte sequences at winpty read-chunk
# boundaries — lead bytes survive, continuations vanish — so the ❯ glyph can
# never be a reliable needle there. The composer PLACEHOLDER is pure ASCII
# and, like COMPOSER, renders ONLY in the live REPL composer (the cockpit
# discoverability placeholder — paints on a fresh home while submitCount < 2)
# — two REPL-only needles discriminate a pre-REPL gate STRICTLY BETTER than
# glyph+footer. Re-anchored (two hosted runs: the
# prior needle survived only inside the Help overlay text, so boots waited
# on a line that never paints).
PLACEHOLDER = "Tab to focus the rails"
# STEADY-NARROW: the resize capture ends on frame STABILITY (no presence
# needle) — winpty re-wraps the OLD 120-col frame into 80 cols, so text that
# exists pre-resize can be photographed mid-rewrap (the recorded sub-tick
# race); the settled 80-col frame is what the workflow asserts.
# the cockpit rails collapse at narrow width, the Tab-discoverability
# placeholder rung never renders, and the STEADY 80x24 frame carries no
# PLACEHOLDER — the one post-split-safe green (run 30681874315, readyAt=200,
# the resize tick itself) had photographed ConPTY's transitional re-wrap of
# the OLD 120-col frame, a sub-tick race the runner missed for all
# 80 post-resize ticks (end=budget, ready=None). The narrow REPL's own steady
# affordance line is the honest needle: pure ASCII, single-row at 80 cols,
# and absent from the bare-conpty requirement card (grep the boot-conpty

# First-class-profile capture env (preflight defect 3): every POSIX capture
# declares an xterm-class TERM — the Windows lane
# must produce grids comparable 1:1. Applied ONLY to the wt/vscode scenarios:
# TERM=xterm-256color also flips win32 unicode support on, which would
# destroy the bare-conpty control's value as the honest base case.
FIRST_CLASS_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
}

SCENARIOS = [
    {
        "name": "boot-wt-120x40",
        "env": FIRST_CLASS_ENV,
        "cfg": {
            # 400 ticks = 80s hard deadline: run 32664516964-era runners put the
            # wt-hosted ready at ~tick 220 (type-echo, run 32664522017) — the old
            # 250-tick cap sat under the measured boot. Cold Node + bundle parse +
            # Defender on a 2-core runner. readyText exits early, so headroom
            # is free on success (preflight defect 4).
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
            # run 32669622822's artifact: the vscode winpty profile TEARS the
            # footer row (two frames overlaid), shredding the COMPOSER needle
            # while the placeholder row survives intact — one REPL-only ASCII
            # needle discriminates ready here.
            "hostProfile": "vscode", "cwd": REPO,
        },
    },
    {
        "name": "boot-conpty-80x24",
        # The bare-console control: NO first-class fingerprint, NO declared
        # TERM — and the runner's own WT_SESSION/TERM_PROGRAM/TERM (if any)
        # are POPPED so the base case never depends on ambient runner env
        # (proof-hygiene). Bring-up only RECORDS what Mercury presents here
        # (expected: the full-profile requirement card) — no readyText:
        # whatever paints within the budget is the honest observation.
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
                # Gated on the composer-only needle: this send must never be
                # able to type into a pre-REPL Select (preflight defect 1).
                {"atTick": 220, "awaitText": COMPOSER, "minTick": 5,
                 "awaitSettleTicks": 3, "data": "horizon bring-up echo"},
            ],
            "readyText": "horizon bring-up echo", "readySettleTicks": 3,
            "hostProfile": "wt", "cwd": REPO,
        },
    },
    {
        # ACCEPTANCE NOTE: the
        # resize fires at a FIXED tick and readiness only evaluates AFTER it
        # fires (vshot gates on resized >= len(resizes)) — so the needles
        # above; PLACEHOLDER never renders there), and the resize must land
        # post-cockpit: atTick 300 (60s) clears the slowest observed boot
        # (ready=53 ticks, run 30832920807) with >5x headroom.
        # payload.stages[0].grid holds the pre-resize frame — READ IT as
        # this scenario's cockpit evidence.
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
        # A wedged capture must not kill the burst before summary.json exists
        # (preflight defect 4) — record it and keep going.
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

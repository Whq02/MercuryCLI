#!/usr/bin/env python3
# scripts/winreg/campaign-win.py — the Windows RECEIPT campaign.
#
# Where bringup proved the capture plane, this proves the PRODUCT CLAIM the
# windows scorecard row makes: the PACKAGED kit (scripts/release/package.mjs,
# the same archive a collaborator downloads) boots to the composer and runs
# real interactive journeys under PowerShell 7 AND Windows PowerShell 5.1 on
# both SIMULATED first-class host fingerprints — ConPTY + simulated WT
# environment (WT_SESSION) and ConPTY + simulated VS Code environment
# (TERM_PROGRAM) — from a SPACED NON-ASCII install path, plus the bare-ConPTY
# control, which must present the ruling-3 requirement card rather than a
# degraded cockpit. HONEST LANE LABEL: the
# Windows Terminal renderer never runs on this lane; WT-rendering claims
# belong to the field box. One run, one summary, artifacts for local replay.
#
# Windows-only (vshot-win.py imports pywinpty). Conventions shared with
# bringup-win.py: stub summary first, the long-path law, the seeded scratch
# home, the two-needle ready gate, FIRST_CLASS_ENV only on first-class hosts.
import json, os, shutil, subprocess, sys, tempfile, time, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
VSHOT = os.path.join(HERE, "vshot-win.py")
OUT_DIR = os.path.join(REPO, "winreg-artifacts")
NODE = shutil.which("node") or "node"
BUN = shutil.which("bun") or "bun"

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "summary.json"), "w") as f:
    json.dump({"burst": "campaign", "results": [], "note": "stub — campaign died before completion; read the step log"}, f)


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


def _short_path(p):
    """8.3 form — the ONLY safe way to hand a spaced exe to the driver's
    concatenation spawn model (bringup NOTE)."""
    if os.name != "nt":
        return p
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(4096)
        n = ctypes.windll.kernel32.GetShortPathNameW(p, buf, 4096)
        return buf.value if 0 < n < 4096 else p
    except Exception:
        return p


_tmp_root = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()

# ── 1. package the kit exactly the way a release does ───────────────────────
# One deliberate difference: the campaign packages UPSTREAM of the gate
# ledger (this lane's green becomes the windows-ui ledger row), so the
# verify-receipt bind takes the loud escape; the release lane keeps it strict.
pkg = subprocess.run(
    [NODE, os.path.join(REPO, "scripts", "release", "package.mjs"), "--target", "windows-x64",
     "--allow-stale-verify-receipts"],
    capture_output=True, encoding="utf-8", errors="replace", cwd=REPO,
)
if pkg.returncode != 0:
    sys.exit("package.mjs failed:\n%s\n%s" % (pkg.stdout[-4000:], pkg.stderr[-4000:]))
release_out = os.path.join(REPO, "release-out")
zips = [f for f in os.listdir(release_out) if f.endswith("windows-x64.zip")]
if not zips:
    sys.exit("no windows-x64 archive in release-out/")
archive = os.path.join(release_out, zips[0])

# ── 2. unpack to a SPACED NON-ASCII path ───
install_root = _long_path(tempfile.mkdtemp(prefix="mercury campaign ", dir=_tmp_root))
install_dir = os.path.join(install_root, "Empf\u00e4nger \u03b2 kit")
os.makedirs(install_dir, exist_ok=True)
with zipfile.ZipFile(archive) as z:
    z.extractall(install_dir)
kit = os.path.join(install_dir, "mercury")
ps1 = os.path.join(kit, "mercury.ps1")
if not os.path.exists(ps1):
    sys.exit("mercury.ps1 missing from the unpacked kit: %s" % ps1)

# ── 3. the two shells, 8.3-safe for the spawn model ─────────────────────────
PS51 = os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
PS7 = shutil.which("pwsh") or "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
PS7 = _short_path(PS7)
SHELL_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]

# ── 4. seeded scratch home (the ONE first-run seed) ─────────────────────────
config_home = _long_path(tempfile.mkdtemp(prefix="mercury-winreg-home-", dir=_tmp_root))
os.environ["MERCURY_CONFIG_DIR"] = config_home
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-fixture-winreg-campaign-key")
os.environ["MERCURY_BOOT_PREFLIGHT"] = "0"
os.environ["MERCURY_LIVE_GLYPHS"] = "0"
# The packaged ps1 launcher chains the splash under ConPTY (IsInput/
# IsOutputRedirected are both false there — that is ConPTY's point). Since
# the fullscreen splash auto-runs its animation and hands off,
# but every capture here grades the RUNTIME's own surfaces — the skip keeps
# the animation beats and the Boot-face landing out of the scenario frames
# (the launcher's own documented skip; boot-drill-win owns the splash path).
os.environ["MERCURY_SPLASH"] = "off"
seed = subprocess.run(
    [BUN, "run", os.path.join(REPO, "scripts", "lib", "firstRunSeed.ts"), config_home, REPO],
    capture_output=True, encoding="utf-8", errors="replace",
)
if seed.returncode != 0:
    sys.exit("firstRunSeed failed:\n%s\n%s" % (seed.stdout, seed.stderr))

READY = "\u276f"           # the composer sigil
COMPOSER = "? for shortcuts"
FIRST_CLASS_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
}

# W5: the \u00a78.1 reference Concourse snapshot for the
# TWO Concourse scenarios below \u2014 the registered MERCURY_CONCOURSE_FIXTURE
# seam (the same seed the macOS verify rigs drive), so the hosted lane
# receipts the Concourse surface at 142x38 AND a large profile.
CONCOURSE_FIXTURE = os.path.join(OUT_DIR, "concourse-fixture.json")
fixture = subprocess.run(
    [BUN, "run", os.path.join(REPO, "scripts", "winreg", "dump-concourse-fixture.ts"), CONCOURSE_FIXTURE],
    capture_output=True, encoding="utf-8", errors="replace",
)
if fixture.returncode != 0:
    sys.exit("dump-concourse-fixture failed:\n%s\n%s" % (fixture.stdout, fixture.stderr))

SCENARIOS = [
    # The four shell × host boots the scorecard row names. Cold Node + kit
    # + Defender: 250 ticks (50s); readyText exits early on success.
    {
        "name": "pkg-boot-wt-ps7-120x40",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 250, "argv": [PS7, *SHELL_ARGS],
                 "readyText": [READY, COMPOSER], "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    {
        "name": "pkg-boot-wt-ps51-120x40",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 250, "argv": [PS51, *SHELL_ARGS],
                 "readyText": [READY, COMPOSER], "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    {
        "name": "pkg-boot-vscode-ps7-100x30",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 100, "rows": 30, "total": 250, "argv": [PS7, *SHELL_ARGS],
                 "readyText": [READY, COMPOSER], "readySettleTicks": 3,
                 "hostProfile": "vscode", "cwd": REPO},
    },
    {
        "name": "pkg-boot-vscode-ps51-100x30",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 100, "rows": 30, "total": 250, "argv": [PS51, *SHELL_ARGS],
                 "readyText": [READY, COMPOSER], "readySettleTicks": 3,
                 "hostProfile": "vscode", "cwd": REPO},
    },
    # A REAL interactive journey on each shell: the /keys atlas is a live
    # command surface resolved from the runtime's own bindings.
    {
        "name": "pkg-keys-wt-ps7",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 300, "argv": [PS7, *SHELL_ARGS],
                 "sends": [{"atTick": 250, "awaitText": COMPOSER, "minTick": 5,
                             "awaitSettleTicks": 3, "data": "/keys\r"}],
                 "readyText": "input atlas", "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    # The PARTY board: the flagship federation surface on the OTHER
    # first-class fingerprint. The campaign fixture has no daemon and no
    # engaged party, so the HONEST verdict is the empty board — the same
    # 'not engaged' header prove-party-board pins on macOS, now receipted
    # under a VS Code ConPTY host.
    {
        "name": "pkg-party-vscode-ps7",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 100, "rows": 30, "total": 300, "argv": [PS7, *SHELL_ARGS],
                 "sends": [{"atTick": 250, "awaitText": COMPOSER, "minTick": 5,
                             "awaitSettleTicks": 3, "data": "/party\r"}],
                 "readyText": "not engaged", "readySettleTicks": 3,
                 "hostProfile": "vscode", "cwd": REPO},
    },
    {
        "name": "pkg-echo-wt-ps51",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 300, "argv": [PS51, *SHELL_ARGS],
                 "sends": [{"atTick": 250, "awaitText": COMPOSER, "minTick": 5,
                             "awaitSettleTicks": 3, "data": "campaign echo \u00e9\u00df\u00f8"}],
                 "readyText": "campaign echo \u00e9\u00df\u00f8", "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    # C3: the /workbench surface on Windows — the PROMPTS PANEL (the WORK
    # board retired in place). It
    # opens and paints its three tabs on the WT fingerprint under PS7; the
    # SAVED PROMPTS tab (the one composer the panel keeps) opens on the VS
    # Code fingerprint under the PS 5.1 floor — the surface crossed over both
    # first-class hosts AND both shells.
    # The ready needle is the panel's OWN footer hint ("tab/1-9 section"),
    # never the frame title — the title paints while sections still read
    # loading, and a receipt must prove the INTERACTIVE panel (wave-C review).
    {
        "name": "pkg-workbench-wt-ps7",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 300, "argv": [PS7, *SHELL_ARGS],
                 "sends": [{"atTick": 250, "awaitText": COMPOSER, "minTick": 5,
                             "awaitSettleTicks": 3, "data": "/workbench\r"}],
                 "readyText": "tab/1-9 section", "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    {
        "name": "pkg-workbench-saved-vscode-ps51",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 100, "rows": 30, "total": 350, "argv": [PS51, *SHELL_ARGS],
                 "sends": [
                     {"atTick": 250, "awaitText": COMPOSER, "minTick": 5,
                      "awaitSettleTicks": 3, "data": "/workbench\r"},
                     {"atTick": 999, "awaitText": "tab/1-9 section",
                      "minTick": 5, "awaitSettleTicks": 3, "data": "3"},
                 ],
                 "readyText": "a new", "readySettleTicks": 3,
                 "hostProfile": "vscode", "cwd": REPO},
    },
    # M9: the CREW board on Windows — the conversation
    # inbox section selected under WT+PS7. The boot seam mints the main
    # thread in the runner's own fresh home, so the row is a REAL store read,
    # and every needle is a split-safe pure-ASCII string rendered only by the
    # settled target phase.
    {
        "name": "pkg-constellation-crew-wt-ps7",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 350, "argv": [PS7, *SHELL_ARGS],
                 "sends": [
                     {"atTick": 250, "awaitText": COMPOSER, "minTick": 5,
                      "awaitSettleTicks": 3, "data": "/workbench\r"},
                     {"atTick": 999, "awaitText": "tab/1-9 section",
                      "minTick": 5, "awaitSettleTicks": 3, "data": "2"},
                 ],
                 # The CREW TRAFFIC tab over a fresh session: the honest
                 # empty line (no agents ran) is the settled needle.
                 "readyText": "no agent traffic this session", "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    # Mid-flight resize at the packaged kit (needle-gated boot first).
    {
        "name": "pkg-resize-wt-ps7-120to80",
        "env": FIRST_CLASS_ENV,
        "cfg": {"cols": 120, "rows": 40, "total": 300, "argv": [PS7, *SHELL_ARGS],
                 "resizes": [{"atTick": 220, "cols": 80, "rows": 24}],
                 "sends": [
                     # Strict pre-resize mark: the composer must be LIVE
                     # before the geometry change or this send never delivers
                     # (exit 4) — and stages[0] then receipts the cockpit the
                     # resize actually hit (boots land ~tick 17-24; 220 is
                     # deep margin).
                     {"atTick": 999, "awaitText": COMPOSER, "minTick": 5,
                      "awaitSettleTicks": 2, "data": "", "mark": "pre-resize"},
                 ],
                 "readyText": [READY, COMPOSER], "readySettleTicks": 4,
                 "hostProfile": "wt", "cwd": REPO},
    },
    # W5: the Session Concourse on the simulated-WT
    # fingerprint — the restoration surface finally has a hosted receipt
    # path. MERCURY_CONCOURSE=always boots the ATOMIC resolve-before-first-
    # commit lane (RFI-2); the reference fixture populates the board (the
    # same §8.1 seed the macOS verify rigs drive). Needles are split-safe
    # ASCII from the settled board: the SESSIONS pane title + a seeded row
    # title. 142x38 is the rig-canonical geometry; 205x53 is the large
    # real-window-class profile (the field box's TASK-006 L14 reports the
    # true maximized WT geometry — this leg is the hosted stand-in, never
    # the WT-renderer verdict).
    {
        "name": "pkg-concourse-wt-ps7-142x38",
        "env": {**FIRST_CLASS_ENV,
                "MERCURY_CONCOURSE": "always",
                "MERCURY_CONCOURSE_FIXTURE": CONCOURSE_FIXTURE},
        "cfg": {"cols": 142, "rows": 38, "total": 300, "argv": [PS7, *SHELL_ARGS],
                 "readyText": ["SESSIONS", "Fix OAuth callback"], "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    {
        "name": "pkg-concourse-wt-ps7-205x53",
        "env": {**FIRST_CLASS_ENV,
                "MERCURY_CONCOURSE": "always",
                "MERCURY_CONCOURSE_FIXTURE": CONCOURSE_FIXTURE},
        "cfg": {"cols": 205, "rows": 53, "total": 300, "argv": [PS7, *SHELL_ARGS],
                 "readyText": ["SESSIONS", "Fix OAuth callback"], "readySettleTicks": 3,
                 "hostProfile": "wt", "cwd": REPO},
    },
    # The bare-ConPTY control: the ruling-3 requirement card, packaged form.
    # No first-class fingerprint; ambient host env popped (proof hygiene).
    {
        "name": "pkg-card-conpty-80x24",
        "envDrop": ["WT_SESSION", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM", "COLORTERM"],
        "cfg": {"cols": 80, "rows": 24, "total": 250, "argv": [PS7, *SHELL_ARGS],
                 "readyText": "terminal check", "readySettleTicks": 3, "cwd": REPO},
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
        # encoding pinned: the capture prints the UTF-8 grid, and the runner's
        # cp1252 locale (subprocess text=True) dies on bytes like 0x8f and
        # hands back stdout=None — the run-30437906173 class. Needles are
        # matched INSIDE vshot against the pyte grid; this outer decode is
        # artifact-only, so replacement can never mask a gate.
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
    with open(os.path.join(OUT_DIR, name + ".txt"), "w", encoding="utf-8") as f:
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
    json.dump({
        "burst": "campaign",
        "kit": os.path.basename(archive),
        "installPath": install_dir,
        "results": summary,
    }, f, indent=2)

shutil.rmtree(config_home, ignore_errors=True)
shutil.rmtree(install_root, ignore_errors=True)
sys.exit(fail)

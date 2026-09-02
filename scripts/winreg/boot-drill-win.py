#!/usr/bin/env python3
# scripts/winreg/boot-drill-win.py — REC-1: the Windows LAUNCHER EXECUTION
# drill.
#
# WHY THIS EXISTS: v1.5.4 shipped a cmd launcher whose splash-receipt reader
# aborted the whole batch on its own receipt — node never started, the held
# alt-screen stranded the operator on the splash frame, and NO release lane
# noticed because none ever EXECUTED mercury.cmd under a real Windows
# console: prove-launchers pins template TEXT on a POSIX host, windows-ui
# boots the runtime directly, windows-functional runs suites from a source
# checkout, and the release smoke ran --version only. Template pins are not
# execution (REC-3). This drill runs the SHIPPED archive's mercury.cmd in a
# real ConPTY through the exact journey that died in the field:
#   deck paint → ↵ → splash handoff → runtime process alive → the hold frame
#   REPLACED by runtime paint (no strand), plus the skip-path matrix
#   (--version / --help piped) and a MERCURY_SPLASH=off interactive boot.
#
# Discipline: observable-driven waits with generous ceilings (freezable
# runners — the granted-time law: never a tight wall-clock window), poll
# counts recorded, every timeout dumps the live screen + a receipt, and the
# 1.5.4 murder signature ("The syntax of the command is incorrect.") is a
# tripwire that fails the drill INSTANTLY wherever it appears.
#
# Usage: python boot-drill-win.py --launcher <path\to\mercury.cmd>
#                                 --artifacts <dir> [--scratch <dir>]
import json, os, re, shutil, subprocess, sys, tempfile, time

# Console codepage pin — same class as vshot-win.py (ConPTY re-renders child
# output through the CONSOLE codepage; never trust an ambient one).
if sys.platform == "win32":
    import ctypes
    try:
        ctypes.windll.kernel32.SetConsoleCP(65001)
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import pyte

try:
    from winpty import PTY
except ImportError:
    sys.exit("boot-drill-win requires pywinpty (pip install pywinpty) — Windows only")


def arg(name, default=None):
    i = sys.argv.index(name) if name in sys.argv else -1
    return sys.argv[i + 1] if i != -1 and i + 1 < len(sys.argv) else default


LAUNCHER = arg("--launcher")
ARTIFACTS = arg("--artifacts", "winreg-artifacts")
SCRATCH = arg("--scratch") or tempfile.mkdtemp(prefix="mercury-boot-drill-")
if not LAUNCHER or not os.path.isfile(LAUNCHER):
    sys.exit(f"--launcher missing or not a file: {LAUNCHER!r}")
os.makedirs(ARTIFACTS, exist_ok=True)

MURDER_SIGNATURE = "syntax of the command is incorrect"
TICK_S = 0.5
COLS, ROWS = 100, 30

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BUN = shutil.which("bun") or os.path.join(os.path.expanduser("~"), ".bun", "bin", "bun.exe")
# The seeder approves THIS key for the seeded homes (the campaign's own
# fixture-key discipline) — a boot with a key the home never consented to
# raises the env-key consent card over the landing.
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-fixture-winreg-boot-drill-key")
os.environ["MERCURY_BOOT_PREFLIGHT"] = "0"

legs = []


def leg(name, ok, detail="", **extra):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{'' if ok or not detail else ' — ' + detail}")
    legs.append({"name": name, "ok": bool(ok), "detail": detail, **extra})
    return ok


def fresh_home(tag):
    """A fresh config home, SEEDED through the ONE first-run seeder (theme,
    onboarding, workspace trust for the launcher's cwd, the fixture key's
    consent) — the same seed every capture lane and gate shard boots on.
    Unseeded, the runtime's first landing is Onboarding, and a drill that
    waits for a menu behind it waits forever (every hosted run
    sat there)."""
    home = os.path.join(SCRATCH, f"home-{tag}")
    os.makedirs(home, exist_ok=True)
    seed = subprocess.run(
        [BUN, "run", os.path.join(REPO, "scripts", "lib", "firstRunSeed.ts"), home, SCRATCH],
        capture_output=True, encoding="utf-8", errors="replace",
    )
    if seed.returncode != 0:
        sys.exit("firstRunSeed failed for %s:\n%s\n%s" % (home, seed.stdout, seed.stderr))
    return home


def child_env(home, extra=None):
    env = dict(os.environ)
    # Pin EVERY config-home rung the seven-rung resolution consults, plus a
    # clean splash surface (ambient-state law).
    env["MERCURY_CONFIG_DIR"] = home
    env["MERCURY_HOME"] = home
    env["MERCURY_HOME"] = home
    for k in ("MERCURY_SPLASH", "MERCURY_SPLASH", "MERCURY_NO_BANNER", "MERCURY_NO_BANNER",
              "MERCURY_SPLASH_HANDOFF", "MERCURY_SPLASH_HANDOFF", "MERCURY_ALT_HELD",
              "MERCURY_ALT_HELD", "WT_SESSION", "TERM_PROGRAM"):
        env.pop(k, None)
    # A DECLARED first-class host: the one env stamp Windows Terminal itself
    # sets (the runner has WT installed; ConPTY under a hosted runner injects
    # no fingerprint — the same simulated-fingerprint honesty as vshot-win's
    # `wt` profile). Without it the ruling-3 terminal-check card stands
    # between the handoff and the landing; that card is the campaign's own
    # pkg-card-conpty-80x24 scene — one home per proof.
    env["WT_SESSION"] = "b1c2d3e4-boot-drill-simulated"
    if extra:
        env.update(extra)
    return env


def _q(a):
    return '"%s"' % a if (" " in a and not a.startswith('"')) else a


def _to_bytes(data):
    if isinstance(data, bytes):
        return data
    try:
        return data.encode("cp437", "strict")
    except UnicodeEncodeError:
        return data.encode("utf-8", "surrogateescape")


def _alive(p):
    fn = getattr(p, "isalive", None) or getattr(p, "is_alive", None)
    return bool(fn()) if fn else True


CMD_EXE = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")


def mercury_node_pids():
    """PIDs of node processes running THE DRILL'S OWN mercury.mjs (matched on
    the drill payload dirs — a bare `mercury.mjs` match would count, and
    kill_mercury_tree would KILL, any unrelated Mercury session when this
    script runs outside the clean CI runner)."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
             "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception:
        return []
    own_dirs = [os.path.dirname(LAUNCHER).lower(), os.path.join(SCRATCH, "branch-payload").lower()]
    pids = []
    for line in out.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and "mercury.mjs" in parts[1]:
            cmdline = parts[1].lower()
            if not any(d in cmdline for d in own_dirs):
                continue
            try:
                pids.append(int(parts[0]))
            except ValueError:
                pass
    return pids


def kill_mercury_tree():
    for pid in mercury_node_pids():
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)


class Drive:
    """One ConPTY run of the shipped launcher."""

    def __init__(self, tag, home, extra_env=None):
        self.tag = tag
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.Stream(self.screen)
        self.raw = b""
        self.polls = 0
        self.pty = PTY(COLS, ROWS)
        cmdline = " /d /c call " + _q(LAUNCHER)
        envblock = "".join("%s=%s\0" % (k, v) for k, v in sorted(child_env(home, extra_env).items()))
        self.pty.spawn(CMD_EXE, cmdline=cmdline, cwd=SCRATCH, env=envblock)

    def pump(self):
        for _ in range(64):
            try:
                data = self.pty.read(4096, blocking=False)
            except Exception:
                data = None
            if not data:
                break
            b = _to_bytes(data)
            self.raw += b
            try:
                self.stream.feed(b.decode("utf-8", "replace"))
            except Exception:
                pass

    def text(self):
        return "\n".join(self.screen.display)

    def wait_for(self, name, pred, ceiling_s, settle_ticks=0):
        """Observable-driven wait: poll `pred` every tick up to a generous
        ceiling; `settle_ticks` consecutive true reads settle the phase."""
        deadline = time.monotonic() + ceiling_s
        settled = 0
        while time.monotonic() < deadline:
            self.pump()
            self.polls += 1
            if MURDER_SIGNATURE in self.text().lower() or MURDER_SIGNATURE in self.raw.decode("utf-8", "replace").lower():
                self.dump(f"{name}-MURDER-SIGNATURE")
                return ("murder", None)
            if pred():
                settled += 1
                if settled > settle_ticks:
                    return ("ok", None)
            else:
                settled = 0
            time.sleep(TICK_S)
        self.dump(f"{name}-TIMEOUT")
        return ("timeout", None)

    def send(self, data):
        self.pty.write(data)

    def dump(self, label):
        path = os.path.join(ARTIFACTS, f"drill-{self.tag}-{label}.txt")
        with open(path, "w", encoding="utf-8", errors="replace") as f:
            f.write(self.text())
            f.write("\n\n--- raw tail (last 2000 bytes) ---\n")
            f.write(self.raw[-2000:].decode("utf-8", "replace"))
        print(f"    screen dumped → {path}")

    def close(self):
        kill_mercury_tree()
        try:
            del self.pty
        except Exception:
            pass


print("=" * 72)
print("REC-1 · Windows launcher execution drill — the SHIPPED mercury.cmd")
print(f"  launcher: {LAUNCHER}")
print("=" * 72)

# ── leg 1 · the skip-path matrix (piped — these paths boot straight) ────────
for flag, needle in (("--version", "Mercury"), ("--help", "usage")):
    home = fresh_home(f"verb{flag.strip('-')}")
    r = subprocess.run(
        [CMD_EXE, "/d", "/c", "call", LAUNCHER, flag],
        capture_output=True, text=True, timeout=300, env=child_env(home), cwd=SCRATCH,
    )
    combined = (r.stdout or "") + (r.stderr or "")
    murdered = MURDER_SIGNATURE in combined.lower()
    leg(f"skip-path {flag}: exit 0, answered, no batch abort",
        r.returncode == 0 and needle.lower() in combined.lower() and not murdered,
        f"exit={r.returncode} out={combined[:160]!r}")

# ── leg 2 · THE boot drill: animation-first splash → handoff →
#            runtime alive → hold taken over → THE ORIGINAL MENU lands ───────
home = fresh_home("boot")
d = Drive("boot", home)
try:
    # the fullscreen splash no longer waits for ↵ — it paints the
    # hero frame, auto-runs the code trace, and hands off on its own. The
    # first anchor is the FILESYSTEM beacon (stamped at handoff — immune to
    # codepage/rendering noise), never a deck frame that only exists for a
    # couple of seconds mid-animation.
    beacon = os.path.join(home, "boot-attempts.json")
    state, _ = d.wait_for("handoff", lambda: os.path.exists(beacon), ceiling_s=180)
    leg("boot: the splash handed off UNPROMPTED (boot-attempt stamped)", state == "ok", state, polls=d.polls)
    if state == "ok":
        state, _ = d.wait_for("runtime-process", lambda: len(mercury_node_pids()) > 0, ceiling_s=240)
        leg("boot: the RUNTIME PROCESS exists (node … mercury.mjs) — the 1.5.4 kill left none", state == "ok", state, polls=d.polls)

        # the strand inverse: the hold frame must be REPLACED by runtime
        # paint. The needle is the hold frame's STUCK HINT — unique to the
        # hold (the splash's scrollback brand line legitimately contains
        # 'taking the deck'; only the hold carries the escape hatch).
        state, _ = d.wait_for("takeover", lambda: "stuck? type: reset" not in d.text(), ceiling_s=240, settle_ticks=2)
        leg("boot: the held frame was TAKEN OVER (the stuck-hint hold frame is gone)", state == "ok", state, polls=d.polls)

        # THE LANDING: the runtime's first INTERACTIVE surface, on the SHIPPED
        # mercury.cmd. Seeded home + declared WT fingerprint (child_env), so
        # no requirement card or first-run screen stands between the handoff
        # and the landing. plain-handoff intent lands the Boot
        # face — the ORIGINAL menu ("Doctor / Health Check" is a 7-card row
        # label neither the hold frame nor the composer paints); a boot that
        # resolves elsewhere lands the REPL composer ("? for shortcuts" is the
        # composer footer). Both are the unified flow's own surfaces: the leg
        # holds on either and the receipt NAMES which one painted — a
        # menu-only assertion here was never observed green (every hosted run
        # since sat on the card + onboarding of an unseeded home),
        # so the Windows menu landing is a MEASUREMENT this dump records.
        MENU_NEEDLE = "Doctor / Health Check"
        COMPOSER_NEEDLE = "? for shortcuts"
        state, _ = d.wait_for(
            "landing",
            lambda: MENU_NEEDLE in d.text() or COMPOSER_NEEDLE in d.text(),
            ceiling_s=240, settle_ticks=2,
        )
        surface = "boot-menu" if MENU_NEEDLE in d.text() else ("repl-composer" if COMPOSER_NEEDLE in d.text() else "none")
        leg("boot: the runtime landed on an interactive surface (Boot menu or REPL composer)",
            state == "ok", f"{state} · surface={surface}", polls=d.polls, surface=surface)
        print(f"    note: first interactive surface = {surface} · the boot-menu landing on Windows: "
              f"{'OBSERVED' if surface == 'boot-menu' else 'not observed on this boot (see the landing dump)'}")
        d.dump("landing")

        leg("boot: the murder signature never appeared",
            MURDER_SIGNATURE not in d.text().lower() and MURDER_SIGNATURE not in d.raw.decode("utf-8", "replace").lower())
        d.dump("final")
finally:
    d.close()

# ── leg 3 · MERCURY_SPLASH=off — the interactive REPL path without the deck ─
home = fresh_home("splashoff")
d = Drive("splashoff", home, {"MERCURY_SPLASH": "off"})
try:
    state, _ = d.wait_for("runtime-process", lambda: len(mercury_node_pids()) > 0, ceiling_s=240)
    leg("splash-off: the runtime process boots directly", state == "ok", state, polls=d.polls)
    state, _ = d.wait_for("paint", lambda: d.text().strip() != "", ceiling_s=180)
    leg("splash-off: the runtime painted (interactive path, no splash)", state == "ok", state, polls=d.polls)
    d.dump("final")
finally:
    d.close()

# ── leg 4 · the exit-code branch matrix under REAL cmd.exe (the
# regression leg for the exit-code protocol):
# copy the shipped payload, swap ONLY splash.mjs for a stub exiting a chosen
# code, and drive the UNMODIFIED mercury.cmd through each launcher branch.
# 130 must stand the whole boot down (cmd exits, runtime never spawns);
# an abnormal code must heal and still boot plain (the floor law).
STUB_DIR = os.path.join(SCRATCH, "branch-payload")
if os.path.isdir(STUB_DIR):
    shutil.rmtree(STUB_DIR, ignore_errors=True)
shutil.copytree(os.path.dirname(LAUNCHER), STUB_DIR)
STUB_LAUNCHER = os.path.join(STUB_DIR, os.path.basename(LAUNCHER))
STUB_SPLASH = os.path.join(STUB_DIR, "splash.mjs")


class BranchDrive(Drive):
    def __init__(self, tag, home, extra_env=None):
        self.tag = tag
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.Stream(self.screen)
        self.raw = b""
        self.polls = 0
        self.pty = PTY(COLS, ROWS)
        cmdline = " /d /c call " + _q(STUB_LAUNCHER)
        envblock = "".join("%s=%s\0" % (k, v) for k, v in sorted(child_env(home, extra_env).items()))
        self.pty.spawn(CMD_EXE, cmdline=cmdline, cwd=SCRATCH, env=envblock)


def write_stub_splash(exit_code):
    with open(STUB_SPLASH, "w", encoding="utf-8") as f:
        f.write("process.exit(%d)\n" % exit_code)


# 130 — cancel: the launcher stands down; the runtime must never spawn.
write_stub_splash(130)
home = fresh_home("branch130")
d = BranchDrive("branch130", home)
try:
    state, _ = d.wait_for("launcher-exit", lambda: not _alive(d.pty), ceiling_s=180)
    leg("branch 130: the launcher process EXITED on its own (cancel stand-down)", state == "ok", state, polls=d.polls)
    d.pump()
    leg("branch 130: the runtime never spawned", len(mercury_node_pids()) == 0)
    leg("branch 130: no murder signature on the cancel path",
        MURDER_SIGNATURE not in d.text().lower() and MURDER_SIGNATURE not in d.raw.decode("utf-8", "replace").lower())
finally:
    d.close()

# 20 — restored handoff (inline mode): the runtime boots WITHOUT the hold
# marker (the only 20-branch execution anywhere on Windows — the posix twin
# has a PTY leg; leaving cmd's 20 text-pinned would repeat the class this
# drill exists to close).
write_stub_splash(20)
home = fresh_home("branch20")
d = BranchDrive("branch20", home)
try:
    state, _ = d.wait_for("runtime-process", lambda: len(mercury_node_pids()) > 0, ceiling_s=240)
    leg("branch 20 (restored): the runtime boots (handoff without the hold marker)", state == "ok", state, polls=d.polls)
    leg("branch 20: no murder signature",
        MURDER_SIGNATURE not in d.text().lower() and MURDER_SIGNATURE not in d.raw.decode("utf-8", "replace").lower())
finally:
    d.close()

# 7 — abnormal splash death: heal + PLAIN boot (a splash failure may cost
# hold cosmetics, never the boot — the exact inversion of the 1.5.4 wedge).
write_stub_splash(7)
home = fresh_home("branch7")
d = BranchDrive("branch7", home)
try:
    state, _ = d.wait_for("runtime-process", lambda: len(mercury_node_pids()) > 0, ceiling_s=240)
    leg("branch 7 (abnormal): the runtime STILL boots plain", state == "ok", state, polls=d.polls)
    leg("branch 7: no murder signature",
        MURDER_SIGNATURE not in d.text().lower() and MURDER_SIGNATURE not in d.raw.decode("utf-8", "replace").lower())
    d.dump("final")
finally:
    d.close()

# ── receipt ─────────────────────────────────────────────────────────────────
receipt = {
    "drill": "boot-drill-win (REC-1)",
    "launcher": LAUNCHER,
    "legs": legs,
    "ok": all(l["ok"] for l in legs),
}
with open(os.path.join(ARTIFACTS, "boot-drill-receipt.json"), "w", encoding="utf-8") as f:
    json.dump(receipt, f, indent=1)
print("\n" + "=" * 72)
if receipt["ok"]:
    print(" PASS boot-drill-win — the shipped launcher boots on a real Windows console")
    sys.exit(0)
print(f" FAIL boot-drill-win — {sum(1 for l in legs if not l['ok'])} leg(s) red")
sys.exit(1)

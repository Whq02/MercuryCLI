#!/usr/bin/env python3
"""mount-smoke.py — launch the built TUI in a PTY and assert it MOUNTS without a
runtime crash. This is the gate that would have caught the `n is not defined` regression
(REPL.tsx away-summary effect referenced an undefined var): it crashed every interactive
mount, but every other gate missed it — REPL.tsx is outside the strict typecheck floor,
and `-p`/transcript-render proofs never mount the live REPL effects.

Tests the CURRENT dist/mercury.mjs (build it first; the gate runs after a build). A fresh
session mounts the full REPL + its mount-time effects (incl. the default-ON
away-summary) WITHOUT making an API turn, so this is deterministic and offline.

PASS = a positive mount signal appears AND no crash pattern. FAIL = a crash pattern, or
no mount signal within the window (silent failure). Exit 0/1.
"""
import atexit, os, shutil, subprocess, sys, pty, tempfile, time, select, signal, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST = os.path.join(ROOT, "dist", "mercury.mjs")

def _resolve_proof_home() -> str:
    home = os.environ.get("MERCURY_CONFIG_DIR")
    if not home:
        home = tempfile.mkdtemp(prefix="mercury-proof-home-")
        os.environ["MERCURY_CONFIG_DIR"] = home
        atexit.register(shutil.rmtree, home, ignore_errors=True)
    bun = os.environ.get("BUN") or os.path.join(
        os.path.expanduser("~"), ".bun", "bin", "bun"
    )
    subprocess.run(
        [bun, "run", os.path.join(ROOT, "scripts", "lib", "firstRunSeed.ts"), home, ROOT],
        check=True,
    )
    return home

_resolve_proof_home()

CRASH = re.compile(
    r"isnotdefined|referenceerror|typeerror:|isnotafunction|"
    r"cannotread|cannotaccess.*beforeinitialization|"
    r"unhandledpromiserejection|unhandledrejection|maximumcallstack"
)
MOUNT = re.compile(r"ready|describeatask|forshortcuts|mercury|❯")


def _norm(text: str) -> str:
    """Strip ANSI escapes, then ALL whitespace, lowercase — so cell-positioned overlay
    text (where chars are spread across cells) matches the same as contiguous text."""
    no_esc = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    return re.sub(r"\s+", "", no_esc).lower()

def run_once(timeout=9.0):
    if not os.path.exists(DIST):
        print(f"  [FAIL] dist not built: {DIST} (run `bun run build.ts` first)")
        return False
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        env["MERCURY_COORDINATION_MCP"] = "0"
        os.execvpe("node", ["node", DIST], env)
        os._exit(127)

    def _reap():
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except OSError:
                pass
        for _ in range(20):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except OSError:
                break
            time.sleep(0.05)

    buf = b""
    t0 = time.time()
    try:
        while time.time() - t0 < timeout:
            r, _, _ = select.select([fd], [], [], 0.4)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                if CRASH.search(_norm(buf.decode("utf-8", "replace"))):
                    break
    finally:
        _reap()
        try:
            os.close(fd)
        except OSError:
            pass
    norm = _norm(buf.decode("utf-8", "replace"))
    crash = CRASH.search(norm)
    mounted = MOUNT.search(norm)
    if crash:
        print(f"  [FAIL] runtime crash on mount: matched {crash.group(0)!r}")
        snippet = norm[max(0, crash.start() - 80) : crash.start() + 80]
        print(f"         context: …{snippet}…")
        return False
    if not mounted:
        print("  [FAIL] no mount signal within the window — the REPL did not draw (silent failure?)")
        print(f"         last 200 chars (normalized): …{norm[-200:]}")
        return False
    print(f"  [PASS] the REPL mounted cleanly, no crash (matched {mounted.group(0)!r})")
    return True

def _hard_timeout(signum, frame):
    print("  [FAIL] hard timeout — the smoke did not complete (wedged mount?)")
    print("\n" + "=" * 60 + "\n❌ MOUNT SMOKE FAILED (timeout)\n" + "=" * 60)
    os._exit(1)


def main():
    signal.signal(signal.SIGALRM, _hard_timeout)
    signal.alarm(45)
    print("============================================================")
    print(" interactive mount smoke — the REPL draws without crashing")
    print("============================================================")
    ok = run_once()
    if not ok:
        print("  … retrying once (PTY timing)")
        ok = run_once(timeout=11.0)
    print("\n" + "=" * 60)
    if ok:
        print("✅ MOUNT SMOKE PASS")
    else:
        print("❌ MOUNT SMOKE FAILED")
    print("=" * 60)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()

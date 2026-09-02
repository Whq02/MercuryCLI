#!/usr/bin/env python3
"""mount-smoke.py — launch the built fork TUI in a PTY and assert it MOUNTS without a
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

# PROOF CONFIG HOME: the pty
# child inherits os.environ, so resolve ONE explicit home BEFORE the fork —
# an inherited MERCURY_CONFIG_DIR pin as-is, else a fresh scratch this smoke
# owns and removes (python twin of scripts/lib/proofHome.ts; never another
# program's directory, never the operator's live sovereign home). Seeding
# goes through the ONE seeder's CLI (scripts/lib/firstRunSeed.ts:
# absent-only, onboarded + trust for ROOT) — the in-file json mirror that
# lived here is the drifted-mirror class ci-shard.sh documents.
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

# Ink's error overlay renders each character in its own absolutely-positioned cell, so
# after stripping escapes the spaces are ABSENT ("n is not defined" → "nisnotdefined").
# Match against a WHITESPACE-STRIPPED, lowercased copy so the pattern is space-agnostic.
CRASH = re.compile(
    r"isnotdefined|referenceerror|typeerror:|isnotafunction|"
    r"cannotread|cannotaccess.*beforeinitialization|"
    r"unhandledpromiserejection|unhandledrejection|maximumcallstack"
)
# A positive mount signal — chrome/prompt the fork REPL draws once mounted (also matched
# on the whitespace-stripped, lowercased copy for consistency).
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
        # pty.fork() already setsid()'s the child (it's a session leader), so its pid is
        # the process-group id — killpg below reaps any MCP/daemon grandchildren too.
        env = dict(os.environ)
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        # Never let the smoke touch the real network/daemon/MCP.
        env["MERCURY_COORDINATION_MCP"] = "0"
        os.execvpe("node", ["node", DIST], env)
        os._exit(127)

    def _reap():
        # Kill the whole process GROUP (a crashed Ink app + its children keep the PTY
        # open) and reap without blocking, so a crash can never hang the gate.
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
                    break  # fail fast
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
    print(f"  [PASS] fork REPL mounted cleanly, no crash (matched {mounted.group(0)!r})")
    return True

def _hard_timeout(signum, frame):
    # Absolute backstop: the smoke must NEVER hang the gate. A wedged mount is itself
    # a failure (the REPL never drew / never settled).
    print("  [FAIL] hard timeout — the smoke did not complete (wedged mount?)")
    print("\n" + "=" * 60 + "\n❌ MOUNT SMOKE FAILED (timeout)\n" + "=" * 60)
    os._exit(1)


def main():
    signal.signal(signal.SIGALRM, _hard_timeout)
    signal.alarm(45)  # whole-smoke wall-clock ceiling (two ~11s attempts + builds margin)
    print("============================================================")
    print(" interactive mount smoke — the fork REPL draws without crashing")
    print("============================================================")
    # One retry on a non-crash miss (PTY timing), but a real crash fails immediately.
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

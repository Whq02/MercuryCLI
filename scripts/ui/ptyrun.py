#!/usr/bin/env python3
# ============================================================================
#  scripts/ui/ptyrun.py — timed PTY runner for render-TRAFFIC measurement.
#
#  Spawns a command inside a real PTY at a given size, pumps (and discards or
#  tees) its output for N seconds, then terminates it. The child sees
#  isTTY=true + a real winsize, so Ink takes the PRODUCTION write path (fd
#  writeAllSync, 16ms throttle — NOT the NODE_ENV=test immediate-render or the
#  non-TTY full-frame branch). Pair with INK_WRITE_TEE on the child to count
#  per-frame writes; this runner reports the raw PTY byte/read totals on
#  stdout as one JSON line (a cross-check that tee'd writes ≈ delivered bytes).
#
#  Usage: python3 ptyrun.py --cols 120 --rows 40 --seconds 12 [--raw f] -- cmd…
# ============================================================================
import argparse, fcntl, json, os, pty, select, signal, struct, sys, termios, time


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--seconds", type=float, default=12.0)
    ap.add_argument("--raw", help="tee raw PTY bytes to this file")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        print("ptyrun: no command", file=sys.stderr)
        sys.exit(2)

    pid, fd = pty.fork()
    if pid == 0:  # child: become the command inside the PTY
        os.execvp(cmd[0], cmd)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
    deadline = time.time() + a.seconds
    raw = open(a.raw, "wb") if a.raw else None
    nbytes = nreads = 0
    try:
        while time.time() < deadline:
            wait = min(0.25, max(0.01, deadline - time.time()))
            r, _, _ = select.select([fd], [], [], wait)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:  # child exited / PTY closed
                break
            if not data:
                break
            nbytes += len(data)
            nreads += 1
            if raw:
                raw.write(data)
    finally:
        if raw:
            raw.close()
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            time.sleep(0.15)
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
    print(json.dumps({"raw_bytes": nbytes, "raw_reads": nreads}))


if __name__ == "__main__":
    main()

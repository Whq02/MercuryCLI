#!/usr/bin/env python3
# ============================================================================
#  scripts/navigation/ptydrive.py — PTY runner with a timed STDIN + RESIZE
#  timeline.
#
#  A fork of scripts/streaming/ptydrive.py with two additions the resize
#  measurements need:
#   1. Resize events are LOGGED to the out JSONL with their actual fire epoch:
#        {"resized": epoch_ms, "atMs": scheduled, "cols": C, "rows": R}
#      (flux fires TIOCSWINSZ+SIGWINCH but records nothing — per-resize
#      latency attribution needs the real fire time).
#   2. Pending resizes participate in the select() wait computation, so a
#      resize with no nearby send fires within ~1ms of schedule instead of
#      up to 50ms late.
#
#  Everything else (send specs, output tee format, kill discipline) is
#  byte-compatible with the flux driver:
#    --send  ms:text   (repeatable; \x1b \n \r \t escapes)
#    --resize ms:cols:rows
#    --out   JSONL: {"ts": epoch_ms, "b64": …} per read
#                   {"sent": epoch_ms, "atMs": …, "b64": …} per send
#                   {"resized": epoch_ms, "atMs": …, "cols": …, "rows": …}
#  Exits when the child exits or --seconds elapses (child then TERM/KILLed).
# ============================================================================
import argparse, base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time


def unescape(s: str) -> bytes:
    return s.encode("utf-8").decode("unicode_escape").encode("latin-1", "backslashreplace")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--send", action="append", default=[])
    ap.add_argument("--resize", action="append", default=[],
                    help="ms:cols:rows — TIOCSWINSZ + SIGWINCH at the offset")
    ap.add_argument("--send-file")
    ap.add_argument("--out")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        print("ptydrive: no command", file=sys.stderr)
        sys.exit(2)

    sends = []
    for spec in a.send:
        at, _, text = spec.partition(":")
        sends.append((float(at), unescape(text)))
    resizes = []
    for spec in a.resize:
        at, cols_s, rows_s = spec.split(":")
        resizes.append((float(at), int(cols_s), int(rows_s)))
    resizes.sort(key=lambda x: x[0])
    if a.send_file:
        with open(a.send_file) as f:
            for row in json.load(f):
                sends.append((float(row["atMs"]), unescape(row["text"])))
    sends.sort(key=lambda x: x[0])

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
    out = open(a.out, "w") if a.out else None
    t0 = time.time()
    deadline = t0 + a.seconds
    si = 0
    nbytes = nreads = 0
    try:
        while time.time() < deadline:
            now_ms = (time.time() - t0) * 1000.0
            # fire due resizes (TIOCSWINSZ + SIGWINCH — a real terminal resize)
            while resizes and resizes[0][0] <= now_ms:
                atms, rc, rr = resizes.pop(0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rr, rc, 0, 0))
                try:
                    os.kill(pid, signal.SIGWINCH)
                except ProcessLookupError:
                    pass
                if out:
                    out.write(json.dumps({"resized": int(time.time() * 1000), "atMs": atms,
                                          "cols": rc, "rows": rr}) + "\n")
                    out.flush()
            # fire due sends
            while si < len(sends) and sends[si][0] <= now_ms:
                atms, payload = sends[si]
                os.write(fd, payload)
                if out:
                    out.write(json.dumps({"sent": int(time.time() * 1000), "atMs": atms,
                                          "b64": base64.b64encode(payload).decode()}) + "\n")
                    out.flush()
                si += 1
            next_send = sends[si][0] / 1000.0 + t0 if si < len(sends) else deadline
            next_resize = resizes[0][0] / 1000.0 + t0 if resizes else deadline
            next_evt = min(next_send, next_resize)
            wait = min(0.05, max(0.001, min(deadline, next_evt) - time.time()))
            r, _, _ = select.select([fd], [], [], wait)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            nbytes += len(data)
            nreads += 1
            if out:
                out.write(json.dumps({"ts": int(time.time() * 1000),
                                      "b64": base64.b64encode(data).decode()}) + "\n")
                out.flush()
    finally:
        if out:
            out.close()
        def trace(msg):
            print(f"ptydrive[{time.time()-t0:.2f}s] {msg}", file=sys.stderr, flush=True)
        reaped = None
        try:
            trace("SIGTERM")
            os.kill(pid, signal.SIGTERM)
            # grace: the child's graceful shutdown may flush tees — up to 1.5s,
            # but only as long as the child is still alive (polled, not slept)
            grace_deadline = time.time() + 1.5
            while time.time() < grace_deadline:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    reaped = wstatus
                    break
                time.sleep(0.02)
            if reaped is None:
                trace("SIGKILL")
                os.kill(pid, signal.SIGKILL)
            else:
                trace(f"exited within grace (status {reaped})")
        except ProcessLookupError:
            trace("kill: ProcessLookupError (already dead)")
        except Exception as e:
            trace(f"kill: {type(e).__name__}: {e}")
        try:
            if reaped is None:
                trace("waitpid…")
                os.waitpid(pid, 0)
                trace("waitpid done")
        except ChildProcessError:
            trace("waitpid: ChildProcessError")
    print(json.dumps({"raw_bytes": nbytes, "raw_reads": nreads, "sends": si}))


if __name__ == "__main__":
    main()

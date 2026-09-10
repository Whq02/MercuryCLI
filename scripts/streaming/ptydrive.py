#!/usr/bin/env python3
import argparse, base64, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


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
    ap.add_argument("--anchor",
                    help="needle:atMs — THE STATE ANCHOR: when `needle` FIRST paints in the "
                         "ANSI-stripped tail, every not-yet-fired ms-stamped send and resize "
                         "authored at or after atMs re-bases by (actual − atMs), and a positive "
                         "delta stretches the deadline the same amount. A boot's wall-clock "
                         "seconds never scale with the movie, so a fixed schedule authored for a "
                         "nominal world fires into the wrong screen when the world is late; the "
                         "anchor keeps the authored geometry RELATIVE to the moment the world "
                         "arrives. A needle that never paints leaves the schedule as authored. "
                         "Recorded in --out as {anchor, atMs, shiftMs, needle}.")
    ap.add_argument("--send-file")
    ap.add_argument("--out")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        print("ptydrive: no command", file=sys.stderr)
        sys.exit(2)

    try:
        scale = float(os.environ.get("MERCURY_VSHOT_BUDGET_SCALE", "1"))
    except ValueError:
        scale = 1.0
    if not (scale > 0):
        scale = 1.0
    a.seconds *= scale

    sends = []
    afters = []
    for spec in a.send:
        if spec.startswith("after:"):
            _, needle, delay_s, text = spec.split(":", 3)
            afters.append({"needle": needle.encode(), "delay": float(delay_s) * scale,
                           "payload": unescape(text), "armed_ms": None, "fired": False})
            continue
        at, _, text = spec.partition(":")
        sends.append((float(at) * scale, unescape(text)))
    resizes = []
    for spec in a.resize:
        at, cols_s, rows_s = spec.split(":")
        resizes.append((float(at) * scale, int(cols_s), int(rows_s)))
    resizes.sort(key=lambda x: x[0])
    if a.send_file:
        with open(a.send_file) as f:
            for row in json.load(f):
                sends.append((float(row["atMs"]) * scale, unescape(row["text"])))
    sends.sort(key=lambda x: x[0])
    anchor = None
    if a.anchor:
        needle, _, at_s = a.anchor.rpartition(":")
        anchor = {"needle": needle.encode(), "at": float(at_s) * scale, "armed_ms": None}

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
    out = open(a.out, "w") if a.out else None
    t0 = time.time()
    deadline = t0 + a.seconds
    si = 0
    nbytes = nreads = 0
    ended = "deadline"
    tail = b""
    raw_tail = b""
    try:
        while time.time() < deadline:
            now_ms = (time.time() - t0) * 1000.0
            def held(ms):
                return anchor is not None and anchor["armed_ms"] is None and ms >= anchor["at"]
            while resizes and resizes[0][0] <= now_ms and not held(resizes[0][0]):
                _, rc, rr = resizes.pop(0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rr, rc, 0, 0))
                try:
                    os.kill(pid, signal.SIGWINCH)
                except ProcessLookupError:
                    pass
            while si < len(sends) and sends[si][0] <= now_ms and not held(sends[si][0]):
                atms, payload = sends[si]
                os.write(fd, payload)
                if out:
                    out.write(json.dumps({"sent": int(time.time() * 1000), "atMs": atms,
                                          "b64": base64.b64encode(payload).decode()}) + "\n")
                    out.flush()
                si += 1
            for af in afters:
                if af["armed_ms"] is not None and not af["fired"] and af["armed_ms"] + af["delay"] <= now_ms:
                    os.write(fd, af["payload"])
                    if out:
                        out.write(json.dumps({"sent": int(time.time() * 1000),
                                              "atMs": round(af["armed_ms"] + af["delay"], 1),
                                              "after": af["needle"].decode("utf-8", "replace"),
                                              "b64": base64.b64encode(af["payload"]).decode()}) + "\n")
                        out.flush()
                    af["fired"] = True
            next_send = sends[si][0] / 1000.0 + t0 if si < len(sends) and not held(sends[si][0]) else deadline
            wait = min(0.05, max(0.001, min(deadline, next_send) - time.time()))
            r, _, _ = select.select([fd], [], [], wait)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                ended = "read-error"
                break
            if not data:
                ended = "eof"
                break
            nbytes += len(data)
            nreads += 1
            if afters or anchor:
                raw_tail = (raw_tail + data)[-16384:]
                tail = ANSI_RE.sub(b"", raw_tail)[-8192:]
                arm_ms = (time.time() - t0) * 1000.0
                for af in afters:
                    if af["armed_ms"] is None and af["needle"] in tail:
                        af["armed_ms"] = arm_ms
                if anchor and anchor["armed_ms"] is None and anchor["needle"] in tail:
                    anchor["armed_ms"] = arm_ms
                    shift = arm_ms - anchor["at"]
                    rest = [(ms + shift if ms >= anchor["at"] else ms, p) for ms, p in sends[si:]]
                    rest.sort(key=lambda x: x[0])
                    sends = sends[:si] + rest
                    resizes = sorted(
                        [(ms + shift if ms >= anchor["at"] else ms, c, r) for ms, c, r in resizes],
                        key=lambda x: x[0])
                    if shift > 0:
                        deadline += shift / 1000.0
                    if out:
                        out.write(json.dumps({"anchor": int(time.time() * 1000),
                                              "atMs": round(anchor["at"], 1),
                                              "shiftMs": round(shift, 1),
                                              "needle": anchor["needle"].decode("utf-8", "replace")}) + "\n")
                        out.flush()
            if out:
                out.write(json.dumps({"ts": int(time.time() * 1000),
                                      "b64": base64.b64encode(data).decode()}) + "\n")
                out.flush()
    finally:
        if out:
            out.close()
        def trace(msg):
            print(f"ptydrive[{time.time()-t0:.2f}s] {msg}", file=sys.stderr, flush=True)
        if anchor is not None and anchor["armed_ms"] is None:
            held_n = sum(1 for ms, _ in sends[si:] if ms >= anchor["at"])
            trace(f"ANCHOR-NEVER-PAINTED: {anchor['needle'].decode('utf-8', 'replace')!r} never appeared; "
                  f"{held_n} post-anchor send(s) held unfired — the world never arrived as authored")
        reaped = None
        def drain(seconds):
            until = time.time() + seconds
            while time.time() < until:
                r, _, _ = select.select([fd], [], [], 0.02)
                if not r:
                    return True
                try:
                    if not os.read(fd, 65536):
                        return False
                except OSError:
                    return False
            return True
        try:
            trace("SIGTERM")
            os.kill(pid, signal.SIGTERM)
            grace_deadline = time.time() + 1.5
            while time.time() < grace_deadline:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    reaped = wstatus
                    break
                drain(0.02)
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
                reap_deadline = time.time() + 10.0
                while time.time() < reap_deadline:
                    wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                    if wpid == pid:
                        reaped = wstatus
                        break
                    drain(0.05)
                if reaped is None:
                    trace("waitpid: child still exiting after 10s; releasing the pty master")
                    os.close(fd)
                    os.waitpid(pid, 0)
                trace("waitpid done")
        except ChildProcessError:
            trace("waitpid: ChildProcessError")
    unfired = []
    for af in afters:
        if not af["fired"]:
            state = ("never painted" if af["armed_ms"] is None
                     else "armed at %dms, delay %dms unreached" % (af["armed_ms"], af["delay"]))
            unfired.append("after %r (+%dms): %s" % (af["needle"].decode("utf-8", "replace"), af["delay"], state))
    for atms, _payload in sends[si:]:
        unfired.append("at %dms: never reached" % atms)
    if unfired:
        sys.stderr.write("[ptydrive] UNFIRED-SENDS: %d of %d sends never became due — %s\n"
                         % (len(unfired), len(sends) + len(afters), " · ".join(unfired)))
    print(json.dumps({"raw_bytes": nbytes, "raw_reads": nreads,
                      "sends": si + sum(1 for af in afters if af["fired"]),
                      "unfired": unfired, "ended": ended,
                      "elapsed_ms": int((time.time() - t0) * 1000)}))


if __name__ == "__main__":
    main()

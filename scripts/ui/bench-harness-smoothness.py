#!/usr/bin/env python3
# ============================================================================
#  scripts/ui/bench-harness-smoothness.py — HEAD-TO-HEAD smoothness benchmark
#  of installed terminal coding harnesses.
#
#  Measures, per harness, in a real PTY (120×40), with NO prompt ever
#  submitted (zero billing, zero side effects — probe chars are typed and
#  backspaced, never Entered):
#    · first_paint_ms   — exec → first bytes on the PTY
#    · ready_ms         — exec → a typed probe char ECHOES (input-interactive)
#    · echo_p50/p95_ms  — keystroke → echo latency over N trials (the FEEL)
#    · idle_writes_s / idle_bytes_s — render traffic while untouched for 12s
#    · clears_post_ready — ESC[2J/[3J/ESCc full-clears after interactive
#                          (mid-session full-clear = the flicker class)
#  Output: one JSON object per run on stdout.
#
#  Usage: python3 bench-harness-smoothness.py --label mercury -- node dist/mercury.mjs
# ============================================================================
import argparse, fcntl, json, os, pty, select, signal, struct, sys, termios, time

PROBE = "z"          # rare in chrome; typed into whatever input surface exists
BS = "\x7f"          # backspace
CLEAR_PATTERNS = (b"\x1b[2J", b"\x1b[3J", b"\x1bc")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--trials", type=int, default=24)
    ap.add_argument("--idle-seconds", type=float, default=12.0)
    ap.add_argument("--ready-timeout", type=float, default=45.0)
    # honesty flags: the default instrument pumps 1.5s before the first
    # probe, FLOORING ready_ms at ~1500ms whenever the app arms input faster
    # (the BASELINE.md editable p50 of 1523ms is that floor, not
    # the app). --honest-ready measures TRUE editability: wait until the
    # child disables kernel echo on the PTY slave (raw mode armed — before
    # that the KERNEL echoes probes instantly, a false positive), then probe;
    # pre-arm probes ride the early-input capture seam and first echo when
    # the composer renders them, so the first echo IS the editable moment.
    ap.add_argument("--pre-probe-wait", type=float, default=1.5)
    ap.add_argument("--honest-ready", action="store_true")
    # Probe cadence for phase 1. The default 250ms quantizes ready_ms by up to
    # +250ms after the true editable moment; honest measurements pass a tight
    # interval (e.g. 0.075) on BOTH sides of a comparison.
    ap.add_argument("--probe-interval", type=float, default=0.25)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd

    t0 = time.monotonic()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))

    first_paint = None
    # additive real-paint markers (first_paint counts ANY bytes — on
    # Mercury the first byte is the early-input SGR reset written long before
    # any UI exists, so first_paint under-reports the real cockpit):
    #   alt_screen_ms — first ESC[?1049h (fullscreen UI takes the terminal)
    #   big_frame_ms  — first single read ≥ 2048 bytes (a real cockpit frame)
    alt_screen = None
    big_frame = None
    ready = None
    clears_total = 0
    clears_post_ready = 0
    tail = b""

    def pump(deadline: float, watch: bytes | None = None):
        """Read until deadline or watch-bytes seen; returns (t_seen, reads, nbytes)."""
        nonlocal first_paint, alt_screen, big_frame, clears_total, clears_post_ready, tail
        seen = None
        reads = 0
        nbytes = 0
        while time.monotonic() < deadline:
            r, _, _ = select.select([fd], [], [], min(0.02, max(0.001, deadline - time.monotonic())))
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            now = time.monotonic()
            reads += 1
            nbytes += len(data)
            if first_paint is None:
                first_paint = now - t0
            if alt_screen is None and b"\x1b[?1049h" in (tail + data):
                alt_screen = now - t0
            if big_frame is None and len(data) >= 2048:
                big_frame = now - t0
            buf = tail + data
            for p in CLEAR_PATTERNS:
                n = buf.count(p)
                if n:
                    clears_total += n
                    if ready is not None:
                        clears_post_ready += n
            tail = buf[-8:]
            if watch is not None and seen is None and watch in buf:
                seen = now
                return (seen, reads, nbytes)
        return (seen, reads, nbytes)

    # ── phase 1: boot → input-interactive (type PROBE every 250ms until echoed)
    ready_deadline = time.monotonic() + a.ready_timeout
    raw_arm = None
    if a.honest_ready:
        # Wait for the child to disable kernel echo (tcgetattr on the master
        # reflects the slave termios). Records raw_arm_ms as a bonus metric.
        while time.monotonic() < ready_deadline:
            try:
                if not (termios.tcgetattr(fd)[3] & termios.ECHO):
                    raw_arm = time.monotonic() - t0
                    break
            except termios.error:
                break
            pump(time.monotonic() + 0.02)
    else:
        pump(time.monotonic() + a.pre_probe_wait)  # default pre-probe pump
    typed = 0
    while ready is None and time.monotonic() < ready_deadline:
        os.write(fd, PROBE.encode())
        typed += 1
        seen, _, _ = pump(time.monotonic() + a.probe_interval, watch=PROBE.encode())
        if seen is not None:
            ready = seen - t0
    for _ in range(typed):
        os.write(fd, BS.encode())
    pump(time.monotonic() + 0.8)

    # ── phase 2: keystroke echo latency ──
    lat = []
    if ready is not None:
        for _ in range(a.trials):
            time.sleep(0.18)
            t_send = time.monotonic()
            os.write(fd, PROBE.encode())
            seen, _, _ = pump(t_send + 1.0, watch=PROBE.encode())
            if seen is not None:
                lat.append((seen - t_send) * 1000)
            os.write(fd, BS.encode())
            pump(time.monotonic() + 0.05)
        pump(time.monotonic() + 0.8)

    # ── phase 3: idle render traffic (+ RSS/CPU samples of the child) ──
    idle_reads = idle_bytes = 0
    rss_samples, cpu_samples = [], []
    if ready is not None and a.idle_seconds > 0:
        t_idle = time.monotonic()
        t_end = t_idle + a.idle_seconds
        while time.monotonic() < t_end:
            _, r, b = pump(min(time.monotonic() + 2.0, t_end))
            idle_reads += r
            idle_bytes += b
            try:
                import subprocess
                out = subprocess.run(
                    ["ps", "-o", "rss=,%cpu=", "-p", str(pid)],
                    capture_output=True, text=True, timeout=2,
                ).stdout.split()
                if len(out) >= 2:
                    rss_samples.append(int(out[0]))
                    cpu_samples.append(float(out[1]))
            except Exception:
                pass

    # ── teardown: never submit anything; interrupt + quit ──
    try:
        os.write(fd, b"\x03")
        time.sleep(0.4)
        os.write(fd, b"\x03")
        time.sleep(0.4)
        os.write(fd, b"q")
        time.sleep(0.3)
    except OSError:
        pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        time.sleep(0.2)
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass

    lat.sort()
    p = lambda q: round(lat[min(len(lat) - 1, int(q * len(lat)))], 1) if lat else None
    print(json.dumps({
        "label": a.label,
        "cmd": " ".join(cmd),
        "first_paint_ms": round(first_paint * 1000) if first_paint else None,
        "alt_screen_ms": round(alt_screen * 1000) if alt_screen else None,
        "big_frame_ms": round(big_frame * 1000) if big_frame else None,
        "raw_arm_ms": round(raw_arm * 1000) if raw_arm else None,
        "ready_ms": round(ready * 1000) if ready else None,
        "echo_trials": len(lat),
        "echo_p50_ms": p(0.5),
        "echo_p95_ms": p(0.95),
        "echo_max_ms": p(1.0),
        "echo_all_ms": [round(v, 1) for v in lat],
        "idle_writes_s": round(idle_reads / a.idle_seconds, 1) if a.idle_seconds > 0 else None,
        "idle_bytes_s": round(idle_bytes / a.idle_seconds) if a.idle_seconds > 0 else None,
        "rss_max_kb": max(rss_samples) if rss_samples else None,
        "cpu_idle_avg_pct": round(sum(cpu_samples) / len(cpu_samples), 1) if cpu_samples else None,
        "clears_post_ready": clears_post_ready,
    }))


if __name__ == "__main__":
    main()

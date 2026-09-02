#!/usr/bin/env python3
"""ptysmoke — run a command on a real pty at a fixed size with a throttled
(slow-drain) reader and dump the raw output bytes to a file. The engine
suite's junk-bytes smoke rides this; the long acceptance recordings use the
rig's full recorder with timestamps."""
import argparse, fcntl, os, pty, select, signal, struct, sys, termios, time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=80)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--drain-bps", type=int, default=0)
    ap.add_argument("--out", required=True)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not cmd:
        print("no command", file=sys.stderr)
        sys.exit(2)

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(args.cols)
    env["LINES"] = str(args.rows)

    signal.alarm(int(args.timeout) + 15)
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvpe(cmd[0], cmd, env)
        except Exception as e:
            os.write(2, f"exec failed: {e}\n".encode())
            os._exit(127)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    out = open(args.out, "wb")
    deadline = time.monotonic() + args.timeout
    budget = float(args.drain_bps)
    refill_at = time.monotonic()
    while time.monotonic() < deadline:
        if args.drain_bps > 0:
            now = time.monotonic()
            budget = min(float(args.drain_bps), budget + (now - refill_at) * args.drain_bps)
            refill_at = now
            if budget < 512.0:
                time.sleep(0.02)
                continue
        try:
            r, _, _ = select.select([master], [], [], 0.05)
        except InterruptedError:
            continue
        if not r:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            continue
        cap = 65536 if args.drain_bps <= 0 else max(512, min(65536, int(budget)))
        try:
            data = os.read(master, cap)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        if args.drain_bps > 0:
            budget -= len(data)
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    time.sleep(0.2)
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:
        pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    out.close()
    os.close(master)
    print(f"smoke-recorded {args.out}", file=sys.stderr)
    os._exit(0)


if __name__ == "__main__":
    main()

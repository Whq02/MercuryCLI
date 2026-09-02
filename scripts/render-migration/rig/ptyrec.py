#!/usr/bin/env python3
"""PTY recorder: run a command in a real pty at a fixed size, record every
output chunk with a monotonic-ns timestamp, send scripted input at offsets,
and terminate cleanly. Frame log format (binary, little-endian):
  8B t_ns | 1B dir (0=out,1=in) | 4B len | len bytes
"""
import argparse, fcntl, os, pty, re, select, signal, struct, sys, termios, time


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class Responder:
    """Answer terminal capability queries like a modern terminal (kitty-ish,
    no graphics), so the app under test enables its production paths
    (synchronized output, kitty keyboard, dark background, CPR)."""

    def __init__(self, rows, cols, dark=True):
        self.rows, self.cols, self.dark = rows, cols, dark
        self.buf = b""

    def scan(self, chunk):
        replies = []
        self.buf = (self.buf + chunk)[-4096:]
        # DECRQM: CSI ? <mode> $ p  -> claim supported/reset (2); 2026 gets 2.
        for m in re.finditer(rb"\x1b\[\?(\d+)\$p", self.buf):
            replies.append(b"\x1b[?%s;2$y" % m.group(1))
        # DA1
        if re.search(rb"\x1b\[0?c", self.buf):
            replies.append(b"\x1b[?62;22c")
        # DA2
        if re.search(rb"\x1b\[>0?c", self.buf):
            replies.append(b"\x1b[>1;10;0c")
        # XTVERSION
        if re.search(rb"\x1b\[>0?q", self.buf):
            replies.append(b"\x1bP>|fixture(1.0)\x1b\\")
        # kitty keyboard query
        if b"\x1b[?u" in self.buf:
            replies.append(b"\x1b[?0u")
        # CPR / DECXCPR
        if b"\x1b[6n" in self.buf:
            replies.append(b"\x1b[%d;1R" % self.rows)
        if b"\x1b[?6n" in self.buf:
            replies.append(b"\x1b[?%d;1R" % self.rows)
        # DSR status
        if b"\x1b[5n" in self.buf:
            replies.append(b"\x1b[0n")
        # OSC 10/11 fg/bg color queries
        if b"\x1b]10;?" in self.buf:
            fg = b"e4e4/e4e4/e4e4" if self.dark else b"1a1a/1a1a/1a1a"
            replies.append(b"\x1b]10;rgb:" + fg + b"\x1b\\")
        if b"\x1b]11;?" in self.buf:
            bg = b"1e1e/1e1e/2222" if self.dark else b"fafa/fafa/f8f8"
            replies.append(b"\x1b]11;rgb:" + bg + b"\x1b\\")
        # XTWINOPS pixel size (14 window px, 16 cell px, 18 chars)
        if b"\x1b[14t" in self.buf:
            replies.append(b"\x1b[4;%d;%dt" % (self.rows * 20, self.cols * 10))
        if b"\x1b[16t" in self.buf:
            replies.append(b"\x1b[6;20;10t")
        if b"\x1b[18t" in self.buf:
            replies.append(b"\x1b[8;%d;%dt" % (self.rows, self.cols))
        if replies:
            # consume matched queries so repeats in the carry buffer don't re-fire
            self.buf = re.sub(rb"\x1b\[\?(\d+)\$p|\x1b\[0?c|\x1b\[>0?c|\x1b\[>0?q|\x1b\[\?u|\x1b\[6n|\x1b\[\?6n|\x1b\[5n|\x1b\[14t|\x1b\[16t|\x1b\[18t", b"", self.buf)
            self.buf = self.buf.replace(b"\x1b]10;?", b"").replace(b"\x1b]11;?", b"")
        return b"".join(replies)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=36)
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--env", action="append", default=[], help="K=V extra env")
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--send", action="append", default=[],
                    help="t_ms:text — text supports \\r \\n \\t \\x1b \\\\ escapes")
    ap.add_argument("--quit-after-quiet", type=float, default=0.0,
                    help="end early after this many seconds of output silence (0=off)")
    ap.add_argument("--respond", action="store_true",
                    help="answer terminal capability queries like a modern terminal")
    ap.add_argument("--resize", action="append", default=[],
                    help="t_ms:COLSxROWS — change pty size mid-run (sends SIGWINCH)")
    ap.add_argument("--light", action="store_true",
                    help="report a light background to OSC 10/11 queries")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("no command", file=sys.stderr)
        sys.exit(2)

    sends = []
    for s in args.send:
        t_ms, _, text = s.partition(":")
        text = (text.replace("\\r", "\r").replace("\\n", "\n")
                    .replace("\\t", "\t").replace("\\x1b", "\x1b").replace("\\\\", "\\"))
        sends.append((float(t_ms) / 1000.0, text.encode()))
    sends.sort()
    resizes = []
    for s in args.resize:
        t_ms, _, size = s.partition(":")
        c, _, r = size.partition("x")
        resizes.append((float(t_ms) / 1000.0, int(c), int(r)))
    resizes.sort()

    env = dict(os.environ)
    for kv in args.env:
        k, _, v = kv.partition("=")
        env[k] = v
    env.setdefault("TERM", "xterm-256color")
    env["COLUMNS"] = str(args.cols)
    env["LINES"] = str(args.rows)

    signal.alarm(int(args.timeout) + 20)  # hard watchdog: never outlive the budget
    pid, master = pty.fork()
    if pid == 0:  # child
        try:
            if args.cwd:
                os.chdir(args.cwd)
            os.execvpe(cmd[0], cmd, env)
        except Exception as e:
            os.write(2, f"exec failed: {e}\n".encode())
            os._exit(127)

    set_winsize(master, args.rows, args.cols)
    out = open(args.out, "wb")
    t0 = time.monotonic_ns()
    print(f"ptyrec_t0_wall_ms={int(time.time()*1000)}", file=sys.stderr, flush=True)
    responder = Responder(args.rows, args.cols, dark=not args.light) if args.respond else None

    def frame(direction, data):
        out.write(struct.pack("<QBI", time.monotonic_ns() - t0, direction, len(data)))
        out.write(data)

    deadline = time.monotonic() + args.timeout
    send_i = 0
    last_out = time.monotonic()
    child_alive = True
    while time.monotonic() < deadline:
        now = time.monotonic() - (t0 / 1e9)
        # scripted sends
        elapsed = time.monotonic_ns() - t0
        while resizes and resizes[0][0] * 1e9 <= elapsed:
            _, c, r = resizes.pop(0)
            try:
                set_winsize(master, r, c)
                os.killpg(os.getpgid(pid), signal.SIGWINCH)
            except Exception:
                try:
                    os.kill(pid, signal.SIGWINCH)
                except Exception:
                    pass
        while send_i < len(sends) and sends[send_i][0] * 1e9 <= elapsed:
            data = sends[send_i][1]
            try:
                os.write(master, data)
                frame(1, data)
            except OSError:
                pass
            send_i += 1
        next_send = sends[send_i][0] * 1e9 - elapsed if send_i < len(sends) else 0.05e9
        wait = max(0.001, min(0.05, next_send / 1e9))
        try:
            r, _, _ = select.select([master], [], [], wait)
        except InterruptedError:
            continue
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                child_alive = False
                break
            frame(0, data)
            last_out = time.monotonic()
            if responder is not None:
                reply = responder.scan(data)
                if reply:
                    try:
                        os.write(master, reply)
                        frame(1, reply)
                    except OSError:
                        pass
        else:
            if args.quit_after_quiet > 0 and send_i >= len(sends) and \
               time.monotonic() - last_out > args.quit_after_quiet:
                break
            # reap early exit
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                child_alive = False
                # drain what's left
                while True:
                    r, _, _ = select.select([master], [], [], 0.05)
                    if not r:
                        break
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    frame(0, data)
                break

    # terminate the whole child group
    if child_alive:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except Exception:
            try:
                os.kill(pid, signal.SIGTERM)
            except Exception:
                pass
        time.sleep(0.3)
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    out.close()
    try:
        os.close(master)
    except OSError:
        pass
    print(f"recorded {args.out}", file=sys.stderr)
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()

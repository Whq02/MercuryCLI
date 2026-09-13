#!/usr/bin/env python3
import fcntl
import os
import pty
import select
import struct
import sys
import tempfile
import termios
import time

if len(sys.argv) < 5:
    sys.stderr.write("usage: capture-splash-bytes.py <splash.mjs> <cols> <rows> <out.raw> [NAME=VALUE | NAME= ...]\n")
    sys.exit(2)
splash, cols, rows, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
extra = {}
for pair in sys.argv[5:]:
    name, _, value = pair.partition("=")
    extra[name] = value
home = tempfile.mkdtemp(prefix="splash-bytes-")
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["MERCURY_SPLASH_ONESHOT"] = "1"
    os.environ["MERCURY_HOME"] = home
    os.environ["MERCURY_CONFIG_DIR"] = home
    for name in ("TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "MERCURY_TRUECOLOR", "MERCURY_FULLSCREEN", "MERCURY_SPLASH", "MERCURY_REDUCED_MOTION", "MERCURY_LAUNCH_RIPPLE", "TMUX", "WT_SESSION", "KITTY_WINDOW_ID"):
        os.environ.pop(name, None)
    for name, value in extra.items():
        if value == "":
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    os.execvp("node", ["node", splash])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
data = b""
t0 = time.time()
while time.time() - t0 < 20:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd not in r:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if done:
            continue
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    data += chunk
os.close(fd)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
open(out, "wb").write(data)
count24 = data.count(b"[38;2;") + data.count(b"[48;2;")
count256 = data.count(b"[38;5;") + data.count(b"[48;5;")
print("%s: %d bytes · %d 24-bit colour sequences · %d 256-colour sequences" % (out, len(data), count24, count256))

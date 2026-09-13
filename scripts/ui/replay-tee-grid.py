#!/usr/bin/env python3
import json
import os
import re
import struct
import sys


def _import_pyte():
    try:
        import pyte
        return pyte
    except ImportError:
        pass
    ver = "%d.%d" % sys.version_info[:2]
    try:
        import pwd
        home = pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        home = os.path.expanduser("~")
    for candidate in (
        os.path.join(home, "Library", "Python", ver, "lib", "python", "site-packages"),
        os.path.join(home, ".local", "lib", "python" + ver, "site-packages"),
    ):
        if os.path.isdir(os.path.join(candidate, "pyte")):
            sys.path.insert(0, candidate)
            import pyte
            return pyte
    sys.stderr.write("replay-tee: the terminal emulator (pyte) is not importable for %s\n" % sys.executable)
    sys.exit(78)


pyte = _import_pyte()

tee_path, cols, rows, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]

KITTY_SEQ = re.compile(rb"\x1b\[[<>=][0-9;]*u")
KITTY_TAIL = re.compile(rb"(?:\x1b|\x1b\[|\x1b\[[<>=][0-9;]*)$")

data = open(tee_path, "rb").read()
frames = []
off = 0
while off + 8 <= len(data):
    tick, ln = struct.unpack(">II", data[off:off + 8])
    off += 8
    frames.append(data[off:off + ln])
    off += ln

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
carry = b""
for chunk in frames:
    buf = KITTY_SEQ.sub(b"", carry + chunk)
    m = KITTY_TAIL.search(buf)
    if m:
        carry = buf[m.start():]
        buf = buf[:m.start()]
    else:
        carry = b""
    stream.feed(buf)

grid = [[{"c": screen.buffer[y][x].data,
          "fg": screen.buffer[y][x].fg,
          "bg": screen.buffer[y][x].bg,
          "bold": bool(screen.buffer[y][x].bold),
          "rev": bool(screen.buffer[y][x].reverse)}
         for x in range(cols)] for y in range(rows)]
json.dump({"cols": cols, "rows": rows, "grid": grid}, open(out, "w"))
print("\n".join("".join(screen.buffer[y][x].data for x in range(cols)).rstrip() for y in range(rows)))

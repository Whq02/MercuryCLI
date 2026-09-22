#!/usr/bin/env python3
import json, os, re, struct, sys


def _emulator():
    try:
        import pyte as p
        return p
    except ImportError:
        pass
    try:
        import pwd
        home = pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        home = None
    ver = "%d.%d" % sys.version_info[:2]
    candidates = []
    if home:
        candidates.append(os.path.join(home, "Library", "Python", ver, "lib", "python", "site-packages"))
        candidates.append(os.path.join(home, ".local", "lib", "python" + ver, "site-packages"))
    candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
    for c in candidates:
        if os.path.isdir(os.path.join(c, "pyte")):
            sys.path.insert(0, c)
            import pyte as p
            return p
    sys.stderr.write("tee-rows: the terminal emulator (pyte) is not importable by %s\n" % sys.executable)
    sys.exit(78)


pyte = _emulator()

tee_path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
resizes = []
for spec in sys.argv[4:]:
    tick, c, r = spec.split(":")
    resizes.append((int(tick), int(c), int(r)))
resizes.sort()

KITTY_SEQ = re.compile(rb"\x1b\[[<>=][0-9;]*u")
FRAME_HOME = b"\x1b[H"

raw = open(tee_path, "rb").read()
reads = []
off = 0
while off + 8 <= len(raw):
    tick, size = struct.unpack(">II", raw[off:off + 8])
    reads.append((tick, raw[off + 8:off + 8 + size]))
    off += 8 + size

stream_bytes = b"".join(d for _, d in reads)
bounds = []
pos = 0
for tick, d in reads:
    pos += len(d)
    bounds.append((pos, tick))


def tick_of(offset):
    for end, tick in bounds:
        if offset <= end:
            return tick
    return bounds[-1][1] if bounds else 0


screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)


def lines():
    return ["".join(screen.buffer[y][x].data for x in range(cols)).rstrip() for y in range(rows)]


frames = []
start = 0
while True:
    nxt = stream_bytes.find(FRAME_HOME, start + 1)
    end = len(stream_bytes) if nxt == -1 else nxt
    frames.append((start, end))
    if nxt == -1:
        break
    start = nxt

out = sys.stdout
last = None
applied = 0
for i, (a, b) in enumerate(frames):
    tick = tick_of(b)
    while applied < len(resizes) and resizes[applied][0] <= tick:
        _, cols, rows = resizes[applied]
        screen.resize(rows, cols)
        applied += 1
        last = None
    stream.feed(KITTY_SEQ.sub(b"", stream_bytes[a:b]))
    cur = lines()
    if cur == last:
        continue
    last = cur
    out.write(json.dumps({"i": i, "tick": tick, "cols": cols, "rows": rows, "lines": cur}) + "\n")

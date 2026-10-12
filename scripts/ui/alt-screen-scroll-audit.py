#!/usr/bin/env python3
import json, os, re, struct, sys


def _resolve_pyte():
    try:
        import pyte
        return pyte
    except ImportError:
        pass
    try:
        import pwd
        home = pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        return None
    ver = "%d.%d" % sys.version_info[:2]
    for site in (
        os.path.join(home, "Library", "Python", ver, "lib", "python", "site-packages"),
        os.path.join(home, ".local", "lib", "python" + ver, "site-packages"),
    ):
        if os.path.isdir(os.path.join(site, "pyte")):
            sys.path.insert(0, site)
            try:
                import pyte
                return pyte
            except ImportError:
                sys.path.remove(site)
    return None


pyte = _resolve_pyte()
if pyte is None:
    sys.stderr.write("alt-screen-scroll-audit: pyte is not importable by %s\n" % sys.executable)
    sys.exit(78)

path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
KITTY = re.compile(rb"\x1b\[[<>=][0-9;]*u")
SU_SD = re.compile(rb"\x1b\[\d*[ST]")
counts = {
    "altEntered": 0,
    "altExited": 0,
    "lineFeedAtBottomOnAlt": 0,
    "drawThroughWrapAtBottomOnAlt": 0,
    "scrollUpDownOnAlt": 0,
    "bottomRightCellWrittenOnAlt": 0,
    "lineFeedAtBottomOnMain": 0,
}
state = {"alt": False}


class Audit(pyte.Screen):
    def index(self):
        if self.cursor.y == self.lines - 1:
            counts["lineFeedAtBottomOnAlt" if state["alt"] else "lineFeedAtBottomOnMain"] += 1
        super().index()

    def draw(self, data):
        if state["alt"] and self.cursor.y == self.lines - 1 and self.cursor.x == self.columns:
            counts["drawThroughWrapAtBottomOnAlt"] += 1
        super().draw(data)
        if state["alt"] and self.cursor.y == self.lines - 1 and self.cursor.x == self.columns:
            counts["bottomRightCellWrittenOnAlt"] += 1

    def set_mode(self, *modes, **kwargs):
        if kwargs.get("private") and 1049 in modes:
            state["alt"] = True
            counts["altEntered"] += 1
        super().set_mode(*modes, **kwargs)

    def reset_mode(self, *modes, **kwargs):
        if kwargs.get("private") and 1049 in modes:
            state["alt"] = False
            counts["altExited"] += 1
        super().reset_mode(*modes, **kwargs)


screen = Audit(cols, rows)
stream = pyte.ByteStream(screen)
raw = open(path, "rb").read()
off = 0
chunks = 0
while off + 8 <= len(raw):
    tick, n = struct.unpack(">II", raw[off:off + 8])
    off += 8
    data = raw[off:off + n]
    off += n
    chunks += 1
    if state["alt"]:
        counts["scrollUpDownOnAlt"] += len(SU_SD.findall(data))
    stream.feed(KITTY.sub(b"", data))
counts["chunks"] = chunks
counts["bytes"] = off
print(json.dumps(counts))

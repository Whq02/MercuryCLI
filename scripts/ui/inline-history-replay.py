#!/usr/bin/env python3
# scripts/ui/inline-history-replay.py — the #69 oracle's pyte half.
#
# Replays a VSHOT_TEE capture (length-prefixed `>II` frames of raw PTY bytes)
# through pyte.HistoryScreen so SCROLLBACK is modeled, then reports JSON:
#   erases     — counts of ED2 (\x1b[2J erase display) and ED3 (\x1b[3J erase
#                scrollback) seen in the raw stream, split boot vs post-boot
#                (boot = the first `bootTicks` ticks)
#   history    — the scrollback rows (top history), post-replay
#   screen     — the final visible rows
#   dupes      — non-trivial lines appearing more than once across
#                history+screen (duplicated-frame detector; trivial = blanks,
#                pure box-drawing/separator rows)
# Usage: inline-history-replay.py <tee-file> <cols> <rows> <bootTicks>
import json
import re
import struct
import sys

import pyte

tee_path, cols, rows, boot_ticks = (
    sys.argv[1],
    int(sys.argv[2]),
    int(sys.argv[3]),
    int(sys.argv[4]),
)

frames = []
data = open(tee_path, "rb").read()
off = 0
while off + 8 <= len(data):
    tick, ln = struct.unpack(">II", data[off : off + 8])
    off += 8
    frames.append((tick, data[off : off + ln]))
    off += ln

ED2 = re.compile(rb"\x1b\[2J")
ED3 = re.compile(rb"\x1b\[3J")
erases = {"boot": {"ed2": 0, "ed3": 0}, "post": {"ed2": 0, "ed3": 0}}
for tick, chunk in frames:
    phase = "boot" if tick < boot_ticks else "post"
    erases[phase]["ed2"] += len(ED2.findall(chunk))
    erases[phase]["ed3"] += len(ED3.findall(chunk))

screen = pyte.HistoryScreen(cols, rows, history=2000)
stream = pyte.ByteStream(screen)
for _tick, chunk in frames:
    stream.feed(chunk)

def render_line(line, width):
    return "".join(line[x].data if x in line else " " for x in range(width)).rstrip()

history_rows = [render_line(line, cols) for line in screen.history.top]
screen_rows = [screen.display[y].rstrip() for y in range(rows)]

def trivial(s):
    t = s.strip()
    if len(t) < 6:
        return True
    # box-drawing / separators / block-art only
    return re.fullmatch(r"[\s│╭╮╰╯─═█▀▄▖▟▆▙▗◆·╱╲?]+", t) is not None

from collections import Counter

counts = Counter(r for r in history_rows + screen_rows if not trivial(r))
dupes = [{"line": line, "n": n} for line, n in counts.items() if n > 1]

print(
    json.dumps(
        {
            "erases": erases,
            "historyLen": len(history_rows),
            "history": history_rows[-60:],
            "screen": screen_rows,
            "dupes": sorted(dupes, key=lambda d: -d["n"])[:20],
        }
    )
)

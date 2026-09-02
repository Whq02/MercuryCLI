#!/usr/bin/env python3
import base64, json, sys

import pyte

drive, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
stops = sorted(int(x) for x in sys.argv[4:])

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)

recs = []
for line in open(drive):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    if "ts" in r:
        recs.append((r["ts"], base64.b64decode(r["b64"])))

out = []
t0 = recs[0][0] if recs else 0
finite = [s for s in stops if s >= 0]
si = 0
for ts, data in recs:
    off = ts - t0
    while si < len(finite) and off > finite[si]:
        out.append({"atMs": finite[si], "rows": [row.rstrip() for row in screen.display]})
        si += 1
    stream.feed(data)
while si < len(finite):
    out.append({"atMs": finite[si], "rows": [row.rstrip() for row in screen.display]})
    si += 1
if -1 in stops:
    reverse_cells = []
    for y in range(rows):
        line = screen.buffer[y]
        for x, ch in line.items():
            if ch.reverse:
                reverse_cells.append([x, y])
    out.append({"atMs": -1, "rows": [row.rstrip() for row in screen.display],
                "cursor": {"x": screen.cursor.x, "y": screen.cursor.y,
                           "hidden": bool(screen.cursor.hidden)},
                "reverseCells": reverse_cells})

print(json.dumps({"screens": out}))

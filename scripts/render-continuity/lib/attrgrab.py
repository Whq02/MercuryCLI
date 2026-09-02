#!/usr/bin/env python3
import base64
import json
import re
import sys

import pyte

drive, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
stops = sorted(int(x) for x in sys.argv[4:])

OSC52 = re.compile(rb'\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)')

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)

recs = []
for line in open(drive):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    if 'ts' in r:
        recs.append((r['ts'], base64.b64decode(r['b64'])))


def snapshot(at_ms):
    reverse = []
    bg = []
    for y in range(rows):
        line = screen.buffer[y]
        for x, ch in line.items():
            if ch.reverse:
                reverse.append([x, y])
            if ch.bg != 'default':
                bg.append([x, y, str(ch.bg)])
    return {
        'atMs': at_ms,
        'rows': [row.rstrip() for row in screen.display],
        'reverse': reverse,
        'bg': bg,
    }


out = []
t0 = recs[0][0] if recs else 0
finite = [s for s in stops if s >= 0]
si = 0
for ts, data in recs:
    off = ts - t0
    while si < len(finite) and off > finite[si]:
        out.append(snapshot(finite[si]))
        si += 1
    stream.feed(data)
while si < len(finite):
    out.append(snapshot(finite[si]))
    si += 1
if -1 in stops:
    out.append(snapshot(-1))

SEG = re.compile(r'[a-z]+-segment')
RAIL_LANES = re.compile(r'SEAT|CREW|TASKS|TABULA|TELEMETRY|lanes')
BORDER = re.compile(r'[│╭╰╮╯]')
CJK_NEEDLE = 'formation字符 network 测试ablation'
wire = b''.join(data for _, data in recs)
copies = []
copy_facts = []
for m in OSC52.finditer(wire):
    try:
        s = base64.b64decode(m.group(1)).decode('utf-8', errors='replace')
    except Exception:
        continue
    copies.append(s)
    copy_facts.append({
        'bytes': len(s.encode('utf-8')),
        'segmentHits': len(SEG.findall(s)),
        'railLaneHits': len(RAIL_LANES.findall(s)),
        'borderGlyphHits': len(BORDER.findall(s)),
        'mascotHits': s.count('▀'),
        'newlineCount': s.count('\n'),
        'cjkNeedleHits': s.count(CJK_NEEDLE),
        'replacementHits': s.count('�'),
    })

print(json.dumps({'screens': out, 'copies': copies, 'copyFacts': copy_facts}))

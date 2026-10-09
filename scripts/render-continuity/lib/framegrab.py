#!/usr/bin/env python3
import base64
import json
import os
import re
import sys

import pyte

drive, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
stops = sorted(int(x) for x in sys.argv[4:])
token_pattern = os.environ.get("FRAMEGRAB_TOKEN_PATTERN")
TOKEN_RE = re.compile(token_pattern) if token_pattern else None
PLATE = os.environ.get("FRAMEGRAB_PLATE", "[Mercury]")
CONTINUATION_MS = 50
SPIN_MS = 12
SYNC_OPEN = b'\x1b[?2026h'
SYNC_CLOSE = b'\x1b[?2026l'

class MarginScreen(pyte.Screen):
    def _scroll(self, count, upward):
        top, bottom = self.margins or (0, self.lines - 1)
        saved = self.cursor.y
        self.cursor.y = bottom if upward else top
        for _ in range(max(1, int(count or 1))):
            if upward:
                self.index()
            else:
                self.reverse_index()
        self.cursor.y = saved

    def scroll_up(self, count=1, *args, **kwargs):
        self._scroll(count, True)

    def scroll_down(self, count=1, *args, **kwargs):
        self._scroll(count, False)


pyte.ByteStream.csi = dict(pyte.ByteStream.csi, S='scroll_up', T='scroll_down')

screen = MarginScreen(cols, rows)
stream = pyte.ByteStream(screen)

recs = []
for line in open(drive):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    if 'ts' in r:
        recs.append((r['ts'], base64.b64decode(r['b64'])))

t0 = recs[0][0] if recs else 0
hog = max((len(data) for _, data in recs), default=0)
finite = [s for s in stops if s >= 0]
out = []
fed = 0
sync_open = False


def feed_one():
    global fed, sync_open
    ts, data = recs[fed]
    stream.feed(data)
    last_open = data.rfind(SYNC_OPEN)
    last_close = data.rfind(SYNC_CLOSE)
    if last_open != -1 or last_close != -1:
        sync_open = last_open > last_close
    fed += 1


def write_continues():
    if fed == 0 or fed >= len(recs):
        return False
    last_ts, last_data = recs[fed - 1]
    gap = recs[fed][0] - last_ts
    if gap < SPIN_MS:
        return True
    if gap >= CONTINUATION_MS:
        return False
    return sync_open or (hog > 0 and len(last_data) == hog)


def token_facts(display):
    pane = 0
    for row in display:
        if '╭' in row:
            pane = max(0, row.index('╭'))
            break
    token_row = -1
    for y, row in enumerate(display):
        if TOKEN_RE.search(row[pane:]):
            token_row = y
            break
    plate = token_row != -1 and any(PLATE in display[y] for y in range(token_row + 1))
    return {'pane': pane, 'tokenRow': token_row, 'plateAtOrAbove': plate}


def f_token(frame):
    return frame['tokenRow'] != -1


def snapshot(at, fed_to):
    reverse_cells = []
    for y in range(rows):
        line = screen.buffer[y]
        for x, ch in line.items():
            if ch.reverse:
                reverse_cells.append([x, y])
    display = [row.rstrip() for row in screen.display]
    frame = {'atMs': at, 'fedToMs': fed_to, 'rows': display,
             'cursor': {'x': screen.cursor.x, 'y': screen.cursor.y, 'hidden': bool(screen.cursor.hidden)},
             'reverseCells': reverse_cells}
    if TOKEN_RE is not None:
        frame.update(token_facts(display))
    return frame


for s in finite:
    while fed < len(recs) and recs[fed][0] - t0 <= s:
        feed_one()
    while write_continues():
        feed_one()
    out.append(snapshot(s, (recs[fed - 1][0] - t0) if fed > 0 else -1))
while fed < len(recs):
    feed_one()
if -1 in stops:
    out.append(snapshot(-1, (recs[-1][0] - t0) if recs else -1))

payload = {'screens': out, 'hog': hog}
if TOKEN_RE is not None:
    finite_idx = [i for i, f in enumerate(out) if f['atMs'] != -1]
    first = next((i for i in finite_idx if f_token(out[i])), None)
    payload['tokenFacts'] = {
        'firstTokenIndex': first,
        'blankAfterFirstToken': [i for i in finite_idx if first is not None and i > first and not f_token(out[i])],
        'tokenFramesWithoutPlate': [i for i, f in enumerate(out) if f_token(f) and not f['plateAtOrAbove']],
    }
print(json.dumps(payload))

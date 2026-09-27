#!/usr/bin/env python3
import os, struct, sys, re, json, bisect
import pyte

tee, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
want_cells = '--cells' in sys.argv
band_x0 = int(os.environ.get('BAND_X0', '0'))
band_x1 = int(os.environ.get('BAND_X1', str(cols)))

class DrawLog(pyte.Screen):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.touched = {}
        self.written = set()
    def _cells(self, x0, x1, y):
        self.written.update((x, y) for x in range(max(0, x0), min(cols, x1)) if band_x0 <= x < band_x1)
    def _note(self, n):
        y = self.cursor.y
        self.touched[y] = self.touched.get(y, 0) + n
    def draw(self, data):
        x0 = self.cursor.x
        self._cells(x0, x0 + len(data), self.cursor.y)
        super().draw(data)
        n = len(data)
        if want_cells:
            inside = sum(1 for i in range(n) if band_x0 <= x0 + i < band_x1)
            self._note(inside)
        else:
            self._note(n)
    def erase_characters(self, count=None):
        self._cells(self.cursor.x, self.cursor.x + (count or 1), self.cursor.y)
        self._note(count or 1)
        super().erase_characters(count)
    def erase_in_line(self, how=0, private=False):
        self._cells(self.cursor.x if how == 0 else 0, self.cursor.x + 1 if how == 1 else cols, self.cursor.y)
        self._note(cols)
        super().erase_in_line(how, private)
    def erase_in_display(self, how=0, *a, **k):
        for y in range(rows):
            self.touched[y] = self.touched.get(y, 0) + cols
            if how in (2, 3) or (how == 0 and y > self.cursor.y) or (how == 1 and y < self.cursor.y):
                self._cells(0, cols, y)
            elif y == self.cursor.y:
                self._cells(self.cursor.x if how == 0 else 0, self.cursor.x + 1 if how == 1 else cols, y)
        super().erase_in_display(how, *a, **k)

raw = open(tee, 'rb').read()
frames = []
i = 0
while i + 8 <= len(raw):
    tick, ln = struct.unpack('>II', raw[i:i + 8]); i += 8
    frames.append((tick, raw[i:i + ln])); i += ln
kitty = re.compile(rb'\x1b\[[<>=][0-9;]*u')
screen = DrawLog(cols, rows)
stream = pyte.ByteStream(screen)
json_frames = '--frames-json' in sys.argv
ticks = {}
if not json_frames:
    print(f'frames={len(frames)}')
for k, (tick, b) in enumerate(frames):
    screen.touched = {}
    stream.feed(kitty.sub(b'', b))
    touched = ticks.setdefault(tick, {})
    for y, n in screen.touched.items():
        touched[y] = touched.get(y, 0) + n
    if not json_frames:
        t = ' '.join(f'{y}:{n}' for y, n in sorted(screen.touched.items()))
        print(f'f{k} tick={tick} bytes={len(b)} rows[{t}]')

if json_frames:
    screen = DrawLog(cols, rows)
    stream = pyte.ByteStream(screen)
    wire = b''.join(b for _, b in frames)
    offsets = []
    offset = 0
    for _, b in frames:
        offsets.append(offset)
        offset += len(b)
    def tick_at(offset):
        return frames[max(0, bisect.bisect_right(offsets, offset) - 1)][0]
    def cells():
        return {(x, y): screen.buffer[y][x].data for y in range(rows) for x in range(band_x0, band_x1)}
    park = ('\x1b[%d;1H' % rows).encode()
    boundaries = re.compile(rb'\x1b\[H|' + re.escape(park))
    committed = []
    start = None
    consumed = 0
    for boundary in boundaries.finditer(wire):
        if boundary.group() == b'\x1b[H':
            if start is None:
                stream.feed(kitty.sub(b'', wire[consumed:boundary.start()]))
                start = boundary.start()
        elif start is not None:
            before = cells()
            screen.touched = {}
            screen.written = set()
            stream.feed(kitty.sub(b'', wire[start:boundary.end()]))
            after = cells()
            committed.append({
                'startTick': tick_at(start),
                'endTick': tick_at(boundary.end() - 1),
                'rows': screen.touched,
                'written': sorted(screen.written),
                'changes': [[x, y, value, after[(x, y)]] for (x, y), value in before.items() if value != after[(x, y)]],
            })
            consumed = boundary.end()
            start = None
    print(json.dumps({'ticks': ticks, 'frames': committed}))

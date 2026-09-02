#!/usr/bin/env python3
# Replay a vshot raw tee (frames of `>II` tick,len + bytes) through pyte with
# a DRAW-LOGGING screen: every write the terminal receives (printable text,
# erase-characters, erase-in-line, erase-in-display) is logged with the
# cursor row it lands on, so a frame's TOUCHED rows are known even when the
# bytes repaint a cell with the value it already had (the ghost-pixel wipe
# changes bytes, never cells — pyte's own dirty set cannot see it).
#
#   python3 touched-rows.py <tee> <cols> <rows> [--cells]
#
# Prints one line per frame: tick, byte length, the touched rows (with the
# number of cells written on each), and — with --cells — the per-row count of
# cells written inside the band columns given by BAND_X0..BAND_X1 (env).
import os, struct, sys, re
import pyte

tee, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
want_cells = '--cells' in sys.argv
band_x0 = int(os.environ.get('BAND_X0', '0'))
band_x1 = int(os.environ.get('BAND_X1', str(cols)))

class DrawLog(pyte.Screen):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.touched = {}
    def _note(self, n):
        y = self.cursor.y
        self.touched[y] = self.touched.get(y, 0) + n
    def draw(self, data):
        # pyte feeds printable runs; each char lands on a cell (wide glyphs count as one write)
        x0 = self.cursor.x
        super().draw(data)
        n = len(data)
        if want_cells:
            inside = sum(1 for i in range(n) if band_x0 <= x0 + i < band_x1)
            self._note(inside)
        else:
            self._note(n)
    def erase_characters(self, count=None):
        self._note(count or 1)
        super().erase_characters(count)
    def erase_in_line(self, how=0, private=False):
        self._note(cols)
        super().erase_in_line(how, private)
    def erase_in_display(self, how=0, *a, **k):
        for y in range(rows):
            self.touched[y] = self.touched.get(y, 0) + cols
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
print(f'frames={len(frames)}')
for k, (tick, b) in enumerate(frames):
    screen.touched = {}
    stream.feed(kitty.sub(b'', b))
    t = ' '.join(f'{y}:{n}' for y, n in sorted(screen.touched.items()))
    print(f'f{k} tick={tick} bytes={len(b)} rows[{t}]')

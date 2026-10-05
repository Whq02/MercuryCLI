#!/usr/bin/env python3
import json
import sys

import pyte

raw_path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
stream.feed(open(raw_path, 'rb').read())

ALPHABET = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"
palette = []
index = {}
text = []
styles = []
for y in range(rows):
    line = screen.buffer[y]
    chars = []
    codes = []
    for x in range(cols):
        cell = line[x]
        chars.append(cell.data)
        key = '%s|%s|%d|%d' % (cell.fg, cell.bg, 1 if cell.bold else 0, 1 if cell.reverse else 0)
        if key not in index:
            if len(palette) >= len(ALPHABET):
                sys.stderr.write('render-final-screen: more than %d distinct styles on one screen\n' % len(ALPHABET))
                sys.exit(3)
            index[key] = len(palette)
            palette.append(key)
        codes.append(ALPHABET[index[key]])
    text.append(''.join(chars))
    styles.append(''.join(codes))
json.dump({'cols': cols, 'rows': rows, 'text': text, 'styles': styles, 'palette': palette}, sys.stdout, ensure_ascii=False)

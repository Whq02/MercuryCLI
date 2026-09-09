#!/usr/bin/env python3
import json, struct, sys
import pyte

tee_path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
raw = open(tee_path, "rb").read()


def snapshot():
    out = {}
    for y, line in screen.buffer.items():
        for x, ch in line.items():
            out[(y, x)] = (ch.data, ch.fg, ch.bg, ch.bold, ch.reverse)
    return out


reads = []
off = 0
while off + 8 <= len(raw):
    tick, size = struct.unpack(">II", raw[off:off + 8])
    reads.append((tick, raw[off + 8:off + 8 + size]))
    off += 8 + size

frames = []
prev = snapshot()
i = 0
while i < len(reads):
    tick = reads[i][0]
    data = b""
    while i < len(reads) and reads[i][0] == tick:
        data += reads[i][1]
        i += 1
    stream.feed(data)
    cur = snapshot()
    changed = sum(1 for k in set(prev) | set(cur) if prev.get(k) != cur.get(k))
    frames.append({"tick": tick, "bytes": len(data), "cells": changed})
    prev = cur

json.dump(frames, sys.stdout)

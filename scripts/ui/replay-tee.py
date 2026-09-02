#!/usr/bin/env python3
# Step-replay a VSHOT_TEE byte capture through a FRESH pyte screen.
# Usage: replay-tee.py <tee.bin> <cols> <rows> <captured-grid.json>
# Prints the detail-region trajectory per frame and the final divergence
# verdict: does offline replay of the SAME bytes reproduce the live capture?
import json, struct, sys
import pyte

tee_path, cols, rows, grid_path = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)

frames = []
with open(tee_path, 'rb') as f:
    while True:
        hdr = f.read(8)
        if len(hdr) < 8:
            break
        tick, n = struct.unpack('>II', hdr)
        frames.append((tick, f.read(n)))

def row_text(y):
    return ''.join(screen.buffer[y][x].data for x in range(cols)).rstrip()

def detail_state():
    txt = '\n'.join(row_text(y) for y in range(rows))
    good = 'Asks you to trust a new MCP server' in txt
    stale = 'A kill is absolute' in txt
    return good, stale

print(f'{len(frames)} frames, {sum(len(d) for _, d in frames)} bytes')
last = (None, None)
for i, (tick, data) in enumerate(frames):
    stream.feed(data)
    st = detail_state()
    if st != last:
        print(f'  frame {i:3d} (tick {tick:3d}, +{len(data):6d}B): detail-correct={st[0]} stale-risk={st[1]}')
        last = st

good, stale = detail_state()
print(f'REPLAY FINAL: detail-correct={good} stale-risk={stale}')

cap = json.load(open(grid_path))
cap_txt = '\n'.join(''.join(c['c'] for c in row).rstrip() for row in cap['grid'])
cap_good = 'Asks you to trust a new MCP server' in cap_txt
cap_stale = 'A kill is absolute' in cap_txt
print(f'LIVE CAPTURE : detail-correct={cap_good} stale-risk={cap_stale}')
replay_txt = '\n'.join(row_text(y) for y in range(rows))
print(f'VERDICT: replay {"MATCHES" if (replay_txt == cap_txt) else "DIVERGES FROM"} the live capture')

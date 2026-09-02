#!/usr/bin/env python3
"""Render a ptyrec capture's screen at time T using pyte."""
import argparse, struct, sys
import pyte


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cap")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=36)
    ap.add_argument("--at", type=float, action="append", default=[],
                    help="seconds — render the screen as of this time (repeatable)")
    ap.add_argument("--trim", action="store_true", help="strip trailing blank lines/rt spaces")
    ap.add_argument("--find", default=None,
                    help="report the first time this text is visible on screen")
    ap.add_argument("--after", type=float, default=0.0,
                    help="with --find: only look at frames after this time")
    args = ap.parse_args()

    frames = []
    with open(args.cap, "rb") as f:
        while True:
            hdr = f.read(13)
            if len(hdr) < 13:
                break
            t, d, n = struct.unpack("<QBI", hdr)
            data = f.read(n)
            if d == 0:
                frames.append((t / 1e9, data))

    if args.find:
        screen = pyte.Screen(args.cols, args.rows)
        stream = pyte.ByteStream(screen)
        found = None
        for t, data in frames:
            try:
                stream.feed(data)
            except Exception:
                pass
            if t <= args.after:
                continue
            joined = "\n".join(screen.display)
            if args.find in joined:
                found = t
                break
        if found is None:
            print(f"find: {args.find!r} never visible")
        else:
            print(f"find: {args.find!r} first visible at t={found:.3f}s")

    for target in args.at:
        screen = pyte.Screen(args.cols, args.rows)
        stream = pyte.ByteStream(screen)
        for t, data in frames:
            if t > target:
                break
            try:
                stream.feed(data)
            except Exception:
                pass
        print(f"===== screen at t={target}s =====")
        lines = [screen.display[i].rstrip() if args.trim else screen.display[i]
                 for i in range(args.rows)]
        if args.trim:
            while lines and not lines[-1]:
                lines.pop()
        for ln in lines:
            print(ln)
        print()


if __name__ == "__main__":
    main()

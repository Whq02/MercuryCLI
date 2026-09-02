#!/usr/bin/env python3
"""WCAG contrast check for colour pairs.

Usage:
  palette_check.py <fg> <bg> [<fg> <bg> ...]     # hex colours: #rgb, #rrggbb, rrggbb
  palette_check.py --self-test

Prints the contrast ratio for each pair and the level it meets (AAA, AA,
AA-large, fail). Exit 0 when every pair reaches at least AA-large, else 1.
"""
from __future__ import annotations

import sys


def parse_hex(value: str) -> tuple[int, int, int]:
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    if len(v) != 6 or any(c not in "0123456789abcdefABCDEF" for c in v):
        raise ValueError(f"not a hex colour: {value}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    def channel(c: int) -> float:
        s = c / 255.0
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg: str, bg: str) -> float:
    l1 = relative_luminance(parse_hex(fg))
    l2 = relative_luminance(parse_hex(bg))
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def level(ratio: float) -> str:
    if ratio >= 7.0:
        return "AAA"
    if ratio >= 4.5:
        return "AA"
    if ratio >= 3.0:
        return "AA-large"
    return "fail"


def self_test() -> int:
    checks = [
        (round(contrast_ratio("#000000", "#ffffff"), 2), 21.0),
        (round(contrast_ratio("#fff", "#000"), 2), 21.0),
        (round(contrast_ratio("#777777", "#ffffff"), 2), 4.48),
        (level(4.48), "AA-large"),
        (level(4.5), "AA"),
        (level(7.0), "AAA"),
        (level(2.9), "fail"),
    ]
    bad = [(got, want) for got, want in checks if got != want]
    try:
        parse_hex("#12")
        bad.append(("parsed #12", "ValueError"))
    except ValueError:
        pass
    print("self-test:", "PASS" if not bad else f"FAIL {bad}")
    return 0 if not bad else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if len(argv) < 2 or len(argv) % 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    worst_ok = True
    for fg, bg in zip(argv[0::2], argv[1::2]):
        try:
            ratio = contrast_ratio(fg, bg)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        lv = level(ratio)
        if lv == "fail":
            worst_ok = False
        print(f"{fg} on {bg}: {ratio:.2f}:1  {lv}")
    return 0 if worst_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

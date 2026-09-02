#!/usr/bin/env python3
"""Analyze a ptyrec capture: paint cadence, byte volume, control-sequence
census, echo latency, time-to-first-glyph."""
import argparse, re, struct, sys


def load(path):
    frames = []
    with open(path, "rb") as f:
        while True:
            hdr = f.read(13)
            if len(hdr) < 13:
                break
            t, d, n = struct.unpack("<QBI", hdr)
            frames.append((t, d, f.read(n)))
    return frames


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0
    i = min(len(sorted_vals) - 1, int(p / 100 * len(sorted_vals)))
    return sorted_vals[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cap")
    ap.add_argument("--stream-marker", default=None,
                    help="text whose first appearance marks first streamed glyph")
    ap.add_argument("--stream-sent-at", default=None,
                    help="input text (e.g. \\r) whose send time is the stream request time")
    ap.add_argument("--window", default=None, help="t0:t1 seconds — restrict paint stats to this window")
    args = ap.parse_args()
    frames = load(args.cap)
    outs = [(t, b) for t, d, b in frames if d == 0]
    ins = [(t, b) for t, d, b in frames if d == 1]
    total_bytes = sum(len(b) for _, b in outs)
    dur = (frames[-1][0] - frames[0][0]) / 1e9 if frames else 0

    blob = b"".join(b for _, b in outs)
    census = {
        "sync_begin(2026h)": blob.count(b"\x1b[?2026h"),
        "altscreen_enter(1049h)": blob.count(b"\x1b[?1049h"),
        "altscreen_exit(1049l)": blob.count(b"\x1b[?1049l"),
        "clear_screen(2J)": blob.count(b"[2J"),
        "clear_scrollback(3J)": blob.count(b"[3J"),
        "erase_line(2K)": blob.count(b"[2K"),
        "cursor_home(H)": len(re.findall(rb"\x1b\[(?:1;1)?H", blob)),
        "kitty_kbd_push(>u)": blob.count(b"\x1b[>") ,
        "osc133": blob.count(b"\x1b]133;"),
        "osc66_scaled_text": blob.count(b"\x1b]66;"),
        "bracketed_paste_on": blob.count(b"\x1b[?2004h"),
        "mouse_any(1003h)": blob.count(b"\x1b[?1003h"),
        "mouse_sgr(1006h)": blob.count(b"\x1b[?1006h"),
        "cursor_pos_req(6n)": blob.count(b"\x1b[6n"),
    }

    # paint grouping: within the analysis window, group output frames separated
    # by <2ms into one paint (a flush burst), report inter-paint gaps.
    w0, w1 = 0, float("inf")
    if args.window:
        a, _, b = args.window.partition(":")
        w0, w1 = float(a) * 1e9, float(b) * 1e9
    wouts = [(t, b) for t, b in outs if w0 <= t <= w1]
    paints = []
    for t, b in wouts:
        if paints and t - paints[-1][1] < 2e6:
            paints[-1][1] = t
            paints[-1][2] += len(b)
        else:
            paints.append([t, t, len(b)])
    gaps = sorted((paints[i][0] - paints[i - 1][0]) / 1e6 for i in range(1, len(paints)))
    sizes = sorted(p[2] for p in paints)

    print(f"frames_out={len(outs)} total_out_bytes={total_bytes} duration_s={dur:.2f}")
    print(f"window_paints={len(paints)} (coalesce<2ms)")
    if gaps:
        print(f"paint_gap_ms p50={pct(gaps,50):.1f} p90={pct(gaps,90):.1f} p99={pct(gaps,99):.1f} min={gaps[0]:.1f} max={gaps[-1]:.1f}")
        print(f"paint_bytes p50={pct(sizes,50)} p90={pct(sizes,90)} max={sizes[-1]}")
        if dur > 0 and len(paints) > 1:
            span = (paints[-1][0] - paints[0][0]) / 1e9
            if span > 0:
                print(f"paint_rate_hz={((len(paints)-1)/span):.1f} over {span:.2f}s window")
    for k, v in census.items():
        if v:
            print(f"census {k} = {v}")

    if args.stream_marker and args.stream_sent_at:
        marker = args.stream_marker.encode()
        sent = args.stream_sent_at.replace("\\r", "\r").encode()
        t_sent = next((t for t, b in ins if sent in b), None)
        t_seen = None
        if t_sent is not None:
            for t, b in outs:
                if t >= t_sent and marker in b:
                    t_seen = t
                    break
        if t_sent is not None and t_seen is not None:
            print(f"ttfg_ms={((t_seen-t_sent)/1e6):.0f} (send of {args.stream_sent_at!r} -> {args.stream_marker!r} visible)")
        else:
            print(f"ttfg: not measurable (sent={t_sent is not None} seen={t_seen is not None})")

    # echo latency: for each single-char input frame, first output containing it
    lat = []
    for t, b in ins:
        if len(b) == 1 and 32 <= b[0] < 127:
            for to, bo in outs:
                if to > t and b in bo:
                    lat.append((to - t) / 1e6)
                    break
    if lat:
        lat.sort()
        print(f"echo_ms n={len(lat)} p50={pct(lat,50):.1f} p90={pct(lat,90):.1f} max={lat[-1]:.1f}")


if __name__ == "__main__":
    main()

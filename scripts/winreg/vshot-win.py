#!/usr/bin/env python3
import json, os, re, sys, struct, time

if sys.platform == "win32":
    import ctypes
    try:
        ctypes.windll.kernel32.SetConsoleCP(65001)
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import pyte

try:
    from winpty import PTY
except ImportError:
    sys.exit("vshot-win requires pywinpty (pip install pywinpty) — Windows only")

_KITTY_SEQ = re.compile(rb"\x1b\[[<>=][0-9;]*u")
_KITTY_TAIL = re.compile(rb"(?:\x1b|\x1b\[|\x1b\[[<>=][0-9;]*)$")


class _KittyFilter:
    def __init__(self):
        self.carry = b""

    def feed(self, data):
        buf = self.carry + data
        buf = _KITTY_SEQ.sub(b"", buf)
        m = _KITTY_TAIL.search(buf)
        if m:
            self.carry = buf[m.start():]
            return buf[: m.start()]
        self.carry = b""
        return buf


if os.environ.get("VSHOT_ACTIVE"):
    sys.exit(
        "vshot-win refusing to run under vshot (VSHOT_ACTIVE set): a render "
        "proof re-entered its PARENT branch inside the PTY child."
    )
os.environ["VSHOT_ACTIVE"] = "1"


def _acquire_capture_slot():
    try:
        import msvcrt
        import tempfile

        try:
            n = int(os.environ.get("VSHOT_SLOTS", "3"))
        except ValueError:
            n = 3
        if n <= 0:
            return None
        slot_dir = os.path.join(tempfile.gettempdir(), "mercury-vshot-slots")
        os.makedirs(slot_dir, exist_ok=True)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            for i in range(n):
                f = open(os.path.join(slot_dir, "slot-%d.lock" % i), "a")
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    return f
                except OSError:
                    f.close()
            time.sleep(0.25)
        return None
    except Exception:
        return None


_capture_slot = _acquire_capture_slot()

cfg = json.load(open(sys.argv[1]))
cols, rows, total = int(cfg["cols"]), int(cfg["rows"]), int(cfg.get("total", 30))
try:
    _scale = float(os.environ.get("MERCURY_VSHOT_BUDGET_SCALE", "1"))
except ValueError:
    _scale = 1.0
if _scale > 0 and _scale != 1:
    total = max(1, int(round(total * _scale)))
argv, sends, out = cfg["argv"], cfg.get("sends", []), cfg["out"]

ready_texts = cfg.get("readyText")
if isinstance(ready_texts, str):
    ready_texts = [ready_texts]
ready_settle = int(cfg.get("readySettleTicks", 2))
ready_at = None
end_reason = "budget"
ended_at_tick = 0
stable_need = int(cfg.get("stableTicks", 0))
stable_region = cfg.get("stableRegion")
stable_run = 0
last_grid_text = None
last_stable_eval_tick = -1
prev_send_tick = None
send_await_seen_tick = None
send_stable_run = 0
send_stable_text = None
send_stable_eval_tick = -1
raw_seen = bytearray()
TICK_S = 0.2
_RELATIVE_KEYS = ("atMs", "afterMark", "afterPrevMs")
_resizes_raw = list(cfg.get("resizes", []))
if all(not any(k in r for k in _RELATIVE_KEYS) for r in _resizes_raw):
    resizes = sorted(_resizes_raw, key=lambda r: r.get("atTick", 0))
else:
    resizes = _resizes_raw


def _resize_due_s(step, marks_fired_s, last_resize_s):
    """Seconds after start at which `step` is due; None while its anchor
    (a mark or a previous resize) has not fired."""
    if "afterMark" in step:
        base = marks_fired_s.get(step["afterMark"])
        if base is None:
            return None
        return base + float(step.get("afterMs", 0)) / 1000.0
    if "afterPrevMs" in step:
        if last_resize_s is None:
            return None
        return last_resize_s + float(step["afterPrevMs"]) / 1000.0
    if "atMs" in step:
        return float(step["atMs"]) / 1000.0
    return int(step.get("atTick", 0)) * TICK_S


tee_path = os.environ.get("VSHOT_TEE")
tee = open(tee_path, "ab") if tee_path else None

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
kitty_filter = _KittyFilter()

child_env = dict(os.environ)
child_env["COLUMNS"], child_env["LINES"] = str(cols), str(rows)
profile = cfg.get("hostProfile")
if profile == "wt":
    child_env["WT_SESSION"] = "b1c2d3e4-vshot-win-capture"
    child_env.setdefault("TERM_PROGRAM", "")
elif profile == "vscode":
    child_env["TERM_PROGRAM"] = "vscode"
    child_env["TERM_PROGRAM_VERSION"] = "1.102.0"

pty = PTY(cols, rows)


def _q(a):
    return '"%s"' % a if (" " in a and not a.startswith('"')) else a


def _to_bytes(data):
    if isinstance(data, bytes):
        return data
    try:
        return data.encode("cp437", "strict")
    except UnicodeEncodeError:
        return data.encode("utf-8", "surrogateescape")


def _alive(p):
    fn = getattr(p, "isalive", None) or getattr(p, "is_alive", None)
    return bool(fn()) if fn else True


appname = argv[0]
cmdline = "".join(" " + _q(a) for a in argv[1:])
envblock = "".join("%s=%s\0" % (k, v) for k, v in sorted(child_env.items()))
pty.spawn(appname, cmdline=cmdline, cwd=cfg.get("cwd") or None, env=envblock)

sent = 0
resized = 0
stages = []
send_receipts = []
marks = []


def snap_grid(c, r):
    return [
        [
            {
                "c": screen.buffer[y][x].data,
                "fg": screen.buffer[y][x].fg,
                "bg": screen.buffer[y][x].bg,
                "bold": bool(screen.buffer[y][x].bold),
                "rev": bool(screen.buffer[y][x].reverse),
            }
            for x in range(c)
        ]
        for y in range(r)
    ]


def grid_text(region=None):
    if region:
        x0, y0, x1, y1 = region
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(cols, int(x1)), min(rows, int(y1))
    else:
        x0, y0, x1, y1 = 0, 0, cols, rows
    return "\n".join(
        "".join(screen.buffer[y][x].data for x in range(x0, x1)) for y in range(y0, y1)
    )


t0 = time.monotonic()
alive = True
marks_fired_s = {}
last_resize_s = None
while True:
    tick = int((time.monotonic() - t0) / TICK_S)
    if tick >= total:
        ended_at_tick, end_reason = tick, "budget"
        break
    if resized < len(resizes):
        due_s = _resize_due_s(resizes[resized], marks_fired_s, last_resize_s)
    else:
        due_s = None
    if due_s is not None and (time.monotonic() - t0) >= due_s:
        step = resizes[resized]
        now_s = time.monotonic() - t0
        stages.append(
            {"cols": cols, "rows": rows, "untilTick": tick, "grid": snap_grid(cols, rows)}
        )
        cols, rows = int(step["cols"]), int(step["rows"])
        screen.resize(rows, cols)
        pty.set_size(cols, rows)
        resized += 1
        last_resize_s = now_s
    got = False
    try:
        data = pty.read(65536, blocking=False)
    except Exception:
        data = None
        alive = _alive(pty)
        if not alive:
            ended_at_tick, end_reason = tick, "eof"
            break
    if data:
        got = True
        raw = _to_bytes(data)
        if tee:
            tee.write(struct.pack(">II", tick, len(raw)) + raw)
        raw_seen.extend(raw)
        stream.feed(kitty_filter.feed(raw))
    elif not _alive(pty):
        ended_at_tick, end_reason = tick, "eof"
        break
    tick = int((time.monotonic() - t0) / TICK_S)
    if sent < len(sends):
        nxt = sends[sent]
        if nxt.get("requireAwait"):
            due = False
        elif "afterPrevTicks" in nxt and prev_send_tick is not None:
            due = tick >= prev_send_tick + int(nxt["afterPrevTicks"])
        else:
            due = tick >= nxt.get("atTick", 1)
        if not due and nxt.get("awaitRaw") and tick >= nxt.get("minTick", 0):
            if nxt["awaitRaw"].encode("utf-8") in raw_seen:
                due = True
        if not due and nxt.get("awaitText") and tick >= nxt.get("minTick", 0):
            text = grid_text()
            if send_await_seen_tick is None:
                if nxt["awaitText"] in text:
                    send_await_seen_tick = tick
                    send_stable_run = 1
                    send_stable_text = grid_text(nxt.get("awaitStableRegion"))
                    send_stable_eval_tick = tick
            if send_await_seen_tick is not None:
                stable_want = int(nxt.get("awaitStableTicks", 0))
                if stable_want and tick > send_stable_eval_tick:
                    send_stable_eval_tick = tick
                    sta_text = grid_text(nxt.get("awaitStableRegion"))
                    if sta_text == send_stable_text:
                        send_stable_run += 1
                    else:
                        send_stable_run = 1
                        send_stable_text = sta_text
                settled = send_stable_run >= stable_want if stable_want else True
                due = settled and tick >= send_await_seen_tick + int(
                    nxt.get("awaitSettleTicks", 0)
                )
        send_payload = None
        if due:
            if nxt.get("signal"):
                sys.stderr.write(
                    "[vshot-win] SIGNAL-UNSUPPORTED: send %d requests %s — POSIX job control has no ConPTY equivalent; run this journey on the posix driver.\n"
                    % (sent, nxt["signal"])
                )
                sys.exit(6)
            send_payload = nxt.get("data", "")
            if nxt.get("targetText"):
                tgt = None
                for ty in range(rows):
                    row_text = "".join(screen.buffer[ty][tx].data for tx in range(cols))
                    tx0 = row_text.find(nxt["targetText"])
                    if tx0 != -1:
                        tgt = (tx0 + 1 + int(nxt.get("targetDx", 0)), ty + 1)
                        break
                if tgt is None:
                    due = False
                else:
                    send_payload = send_payload.replace("{X}", str(tgt[0])).replace("{Y}", str(tgt[1]))
        if due:
            if nxt.get("mark"):
                marks.append({"label": nxt["mark"], "atTick": tick,
                              "cols": cols, "rows": rows,
                              "grid": snap_grid(cols, rows)})
                marks_fired_s[nxt["mark"]] = time.monotonic() - t0
            pty.write(send_payload)
            send_receipts.append({"atTick": tick, "ts": int(time.time() * 1000)})
            prev_send_tick = tick
            send_await_seen_tick = None
            send_stable_run = 0
            send_stable_text = None
            send_stable_eval_tick = -1
            sent += 1
    if (ready_texts or stable_need) and sent >= len(sends) and resized >= len(resizes):
        text = grid_text()
        if ready_texts and ready_at is None and all(s in text for s in ready_texts):
            ready_at = tick
        if stable_need and tick > last_stable_eval_tick:
            last_stable_eval_tick = tick
            sta_text = grid_text(stable_region)
            stable_run = stable_run + 1 if sta_text == last_grid_text else 1
            last_grid_text = sta_text
    texts_ok = (not ready_texts) or ready_at is not None
    if stable_need:
        if texts_ok and stable_run >= stable_need:
            ended_at_tick, end_reason = tick, "stable"
            break
    elif ready_at is not None and tick >= ready_at + ready_settle:
        ended_at_tick, end_reason = tick, "ready"
        break
    if not got:
        time.sleep(
            max(0.0, min(0.05, (tick + 1) * TICK_S - (time.monotonic() - t0)))
        )

drain_hard_deadline = time.monotonic() + 2.0
quiet_deadline = time.monotonic() + 0.3
while time.monotonic() < min(quiet_deadline, drain_hard_deadline):
    try:
        data = pty.read(65536, blocking=False)
    except Exception:
        break
    if data:
        raw = _to_bytes(data)
        if tee:
            tee.write(struct.pack(">II", total, len(raw)) + raw)
        stream.feed(kitty_filter.feed(raw))
        quiet_deadline = time.monotonic() + 0.3
    else:
        if not _alive(pty):
            break
        time.sleep(0.05)

grid = [
    [
        {
            "c": screen.buffer[y][x].data,
            "fg": screen.buffer[y][x].fg,
            "bg": screen.buffer[y][x].bg,
            "bold": bool(screen.buffer[y][x].bold),
            "rev": bool(screen.buffer[y][x].reverse),
        }
        for x in range(cols)
    ]
    for y in range(rows)
]
payload = {
    "cols": cols,
    "rows": rows,
    "grid": grid,
    "readyAt": ready_at,
    "endedAtTick": ended_at_tick,
    "endReason": end_reason,
    "readyTextDeclared": list(ready_texts) if ready_texts else [],
    "hostProfile": profile or "conpty",
}
if stages:
    payload["stages"] = stages
if send_receipts:
    payload["sendReceipts"] = send_receipts
if marks:
    payload["marks"] = marks
json.dump(payload, open(out, "w"))
print(grid_text())
if ready_texts and ready_at is None:
    sys.stderr.write(
        "[vshot-win] NEVER-READY: readyText %r never appeared within %d ticks "
        "(ended: %s). This capture is a wrong-frame observation, not a settle.\n"
        % (ready_texts, total, end_reason)
    )
    sys.exit(3)
if sent < len(sends):
    undelivered = sends[sent:]
    sys.stderr.write(
        "[vshot-win] UNDELIVERED-SENDS: %d of %d sends never became due "
        "(first stuck: %r%s). The journey did not happen as written.\n"
        % (len(undelivered), len(sends),
           (undelivered[0].get("awaitText") or undelivered[0].get("awaitRaw")
            or undelivered[0].get("targetText") or undelivered[0].get("data", ""))[:60],
           " mark=%r" % undelivered[0]["mark"] if undelivered[0].get("mark") else "")
    )
    sys.exit(4)
if cfg.get("requireStable") and stable_need and end_reason != "stable":
    sys.stderr.write(
        "[vshot-win] NEVER-STABLE: the grid never held byte-identical for %d "
        "consecutive ticks within %d (ended: %s). Layout-anchored "
        "coordinates from this capture would be stale.\n"
        % (stable_need, total, end_reason))
    sys.exit(5)

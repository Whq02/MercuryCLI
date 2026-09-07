#!/usr/bin/env python3
import json, os, re, sys, select, pty, fcntl, termios, struct, time
import pyte

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
        "vshot refusing to run under vshot (VSHOT_ACTIVE set): a render proof "
        "re-entered its PARENT branch inside the PTY child — its child-branch "
        "env marker never arrived. Pass the marker via the spawn env option "
        "(cfg['env'] is NOT applied)."
    )
os.environ["VSHOT_ACTIVE"] = "1"

def _acquire_capture_slot():
    try:
        try:
            n = int(os.environ.get("VSHOT_SLOTS", "3"))
        except ValueError:
            n = 3
        if n <= 0:
            return None
        import tempfile
        slot_dir = os.path.join(
            tempfile.gettempdir(), f"hermes-vshot-slots-{os.getuid()}"
        )
        os.makedirs(slot_dir, exist_ok=True)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            for i in range(n):
                f = open(os.path.join(slot_dir, f"slot-{i}.lock"), "a")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return f
                except OSError:
                    f.close()
            time.sleep(0.25)
        return None
    except OSError:
        return None

_capture_slot = _acquire_capture_slot()

cfg = json.load(open(sys.argv[1]))
cols, rows, total = int(cfg["cols"]), int(cfg["rows"]), int(cfg.get("total", 30))
try:
    _scale = float(os.environ.get("MERCURY_VSHOT_BUDGET_SCALE", "1"))
except ValueError:
    _scale = 1.0
if not (_scale > 0):
    _scale = 1.0

def _scaled(n):
    return int(round(n * _scale))

_pure_fixed_window = (
    not cfg.get("sends")
    and not cfg.get("resizes")
    and not cfg.get("readyText")
    and not int(cfg.get("stableTicks", 0))
)
if _pure_fixed_window:
    _scale = 1.0
if _scale != 1:
    total = max(1, _scaled(total))
argv, sends, out = cfg["argv"], cfg.get("sends", []), cfg["out"]
ready_texts = cfg.get("readyText")
if isinstance(ready_texts, str):
    ready_texts = [ready_texts]
ready_settle = _scaled(int(cfg.get("readySettleTicks", 2)))
ready_at = None
ready_seen_pre_sends = False
last_output_tick = -1
end_reason = "budget"
ended_at_tick = 0
stable_need = int(cfg.get("stableTicks", 0))
stable_region = cfg.get("stableRegion")
if cfg.get("liveSeat"):
    _whole_grid = [
        "send %d (%r)" % (i, str(s.get("awaitText") or s.get("awaitRaw") or s.get("data", ""))[:40])
        for i, s in enumerate(sends)
        if int(s.get("awaitStableTicks", 0)) and not s.get("awaitStableRegion")
    ]
    if cfg.get("requireStable") and stable_need and not stable_region:
        _whole_grid.append("the capture's own requireStable/stableTicks end gate")
    if _whole_grid:
        sys.stderr.write(
            "[vshot] LIVE-SEAT-STABILITY: this board carries a live seat (liveSeat), "
            "and %s gate(s) on whole-grid stability — the peek pane keeps painting, so "
            "the gate starves and the journey never happens. Gate on settle ticks "
            "(awaitSettleTicks) or name the region the assertion reads "
            "(awaitStableRegion / stableRegion).\n" % "; ".join(_whole_grid))
        sys.exit(7)

def grid_text(region=None):
    if region:
        x0, y0, x1, y1 = region
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(cols, int(x1)), min(rows, int(y1))
    else:
        x0, y0, x1, y1 = 0, 0, cols, rows
    return "\n".join("".join(screen.buffer[y][x].data for x in range(x0, x1))
                     for y in range(y0, y1))
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
_resizes_raw = list(cfg.get("resizes", []))
_RELATIVE_KEYS = ("atMs", "afterMark", "afterPrevMs")
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
        return base + float(step.get("afterMs", 0)) * _scale / 1000.0
    if "afterPrevMs" in step:
        if last_resize_s is None:
            return None
        return last_resize_s + float(step["afterPrevMs"]) * _scale / 1000.0
    if "atMs" in step:
        return float(step["atMs"]) * _scale / 1000.0
    return _scaled(int(step.get("atTick", 0))) * TICK_S
tee_path = os.environ.get("VSHOT_TEE")
tee = open(tee_path, "ab") if tee_path else None

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
kitty_filter = _KittyFilter()

pid, fd = pty.fork()
if pid == 0:
    os.environ["COLUMNS"], os.environ["LINES"] = str(cols), str(rows)
    if cfg.get("cwd"):
        os.chdir(cfg["cwd"])
    os.execvp(argv[0], argv)
else:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    sent = 0
    resized = 0
    stages = []
    send_receipts = []
    marks = []

    def snap_grid(c, r):
        return [[{"c": screen.buffer[y][x].data,
                  "fg": screen.buffer[y][x].fg,
                  "bg": screen.buffer[y][x].bg,
                  "bold": bool(screen.buffer[y][x].bold),
                  "rev": bool(screen.buffer[y][x].reverse)}
                 for x in range(c)] for y in range(r)]

    def snap_cursor():
        return {"x": screen.cursor.x, "y": screen.cursor.y,
                "hidden": bool(screen.cursor.hidden)}

    marks_fired_s = {}
    last_resize_s = None
    t0 = time.monotonic()
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
            stages.append({"cols": cols, "rows": rows, "untilTick": tick,
                           "untilMs": int(now_s * 1000), "cursor": snap_cursor(),
                           "grid": snap_grid(cols, rows)})
            cols, rows = int(step["cols"]), int(step["rows"])
            screen.resize(rows, cols)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            resized += 1
            last_resize_s = now_s
        wait = max(0.0, (tick + 1) * TICK_S - (time.monotonic() - t0))
        if due_s is not None:
            wait = max(0.0, min(wait, due_s - (time.monotonic() - t0)))
        r, _, _ = select.select([fd], [], [], wait)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                ended_at_tick, end_reason = tick, "eof"
                break
            if not data:
                ended_at_tick, end_reason = tick, "eof"
                break
            if tee:
                tee.write(struct.pack(">II", tick, len(data)) + data)
            raw_seen.extend(data)
            last_output_tick = tick
            stream.feed(kitty_filter.feed(data))
        tick = int((time.monotonic() - t0) / TICK_S)
        if sent < len(sends):
            nxt = sends[sent]
            if nxt.get("requireAwait"):
                due = False
            elif "afterPrevTicks" in nxt and prev_send_tick is not None:
                due = tick >= prev_send_tick + _scaled(int(nxt["afterPrevTicks"]))
            else:
                due = tick >= _scaled(int(nxt.get("atTick", 1)))
            if not due and nxt.get("awaitRaw") and tick >= _scaled(int(nxt.get("minTick", 0))):
                if nxt["awaitRaw"].encode("utf-8") in raw_seen:
                    due = True
            if not due and nxt.get("awaitText") and tick >= _scaled(int(nxt.get("minTick", 0))):
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
                    due = settled and tick >= send_await_seen_tick + _scaled(int(nxt.get("awaitSettleTicks", 0)))
            send_payload = None
            if due:
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
                if ready_texts and ready_at is None and not ready_seen_pre_sends:
                    pre_text = grid_text()
                    if all(s in pre_text for s in ready_texts):
                        ready_seen_pre_sends = True
                if nxt.get("mark"):
                    marks.append({"label": nxt["mark"], "atTick": tick,
                                  "atMs": int((time.monotonic() - t0) * 1000),
                                  "cols": cols, "rows": rows,
                                  "cursor": snap_cursor(),
                                  "grid": snap_grid(cols, rows)})
                    marks_fired_s[nxt["mark"]] = time.monotonic() - t0
                if nxt.get("signal"):
                    import signal as _signal
                    os.kill(pid, getattr(_signal, nxt["signal"]))
                if send_payload:
                    os.write(fd, send_payload.encode())
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
    drain_hard_deadline = time.monotonic() + 2.0 * _scale
    quiet_deadline = time.monotonic() + 0.3 * _scale
    while time.monotonic() < min(quiet_deadline, drain_hard_deadline):
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            if tee:
                tee.write(struct.pack(">II", total, len(data)) + data)
            stream.feed(kitty_filter.feed(data))
            quiet_deadline = time.monotonic() + 0.3
    grid = [[{"c": screen.buffer[y][x].data,
              "fg": screen.buffer[y][x].fg,
              "bg": screen.buffer[y][x].bg,
              "bold": bool(screen.buffer[y][x].bold),
              "rev": bool(screen.buffer[y][x].reverse)}
             for x in range(cols)] for y in range(rows)]
    payload = {"cols": cols, "rows": rows, "grid": grid,
               "cursor": snap_cursor(),
               "readyAt": ready_at,
               "endedAtTick": ended_at_tick,
               "endReason": end_reason,
               "lastOutputTick": last_output_tick,
               "readyTextDeclared": list(ready_texts) if ready_texts else []}
    if stages:
        payload["stages"] = stages
    if send_receipts:
        payload["sendReceipts"] = send_receipts
    if marks:
        payload["marks"] = marks
    json.dump(payload, open(out, "w"))
    print("\n".join("".join(screen.buffer[y][x].data for x in range(cols)) for y in range(rows)))
    if ready_texts and ready_at is None:
        trap = ""
        if ready_seen_pre_sends:
            trap = (
                " NOTE (the end-gate trap): the ready needles WERE on screen "
                "before a send fired and never after — readyText is the "
                "POST-SENDS end gate (its scan arms once every send has "
                "fired), so anchor it on the journey's FINAL world, or drop "
                "it and gate the last send on its own awaitText.")
        sys.stderr.write(
            "[vshot] NEVER-READY: readyText %r never appeared within %d ticks "
            "(ended: %s). This capture is a wrong-frame observation, not a settle.%s\n"
            % (ready_texts, total, end_reason, trap))
        sys.exit(3)
    if sent < len(sends):
        undelivered = sends[sent:]
        sys.stderr.write(
            "[vshot] UNDELIVERED-SENDS: %d of %d sends never became due "
            "(first stuck: %r%s). The journey did not happen as written.\n"
            % (len(undelivered), len(sends),
               (undelivered[0].get("awaitText") or undelivered[0].get("awaitRaw")
                or undelivered[0].get("targetText") or undelivered[0].get("data", ""))[:60],
               " mark=%r" % undelivered[0]["mark"] if undelivered[0].get("mark") else ""))
        sys.exit(4)
    if cfg.get("requireStable") and stable_need and end_reason != "stable":
        sys.stderr.write(
            "[vshot] NEVER-STABLE: the grid never held byte-identical for %d "
            "consecutive ticks within %d (ended: %s). Layout-anchored "
            "coordinates from this capture would be stale.\n"
            % (stable_need, total, end_reason))
        sys.exit(5)

#!/usr/bin/env python3
# scripts/winreg/vshot-win.py — the Windows PTY capture substrate.
#
# The Windows twin of scripts/ui/vshot.py: boots argv in a real Windows
# pseudo-console (pywinpty) at cols×rows, pumps the loop `total` wall-clock
# ticks feeding scripted sends, captures the pyte screen → the SAME cell-grid
# JSON grammar. A test harness recording Mercury's own rendered frames — the
# packaged app under test, nothing else.
#
# CONTRACT PARITY with vshot.py (prove-capture-grammar.ts pins this): the cfg
# keys (cols/rows/total/argv/sends/out/readyText/readySettleTicks/stableTicks/
# resizes/cwd), the send-gating grammar (atTick/afterPrevTicks/awaitText/
# awaitRaw/minTick/awaitSettleTicks/awaitStableTicks), wall-clock 0.2s ticks,
# the kitty-CSI-u strip, the end-reason receipt, and the NEVER-READY refusal
# (exit 3) are byte-for-byte the same semantics. Platform differences live
# ONLY in the spawn/read/resize seam and the slot lock (msvcrt, best-effort).
#
# HOST PROFILES (full Windows = Windows Terminal stable or
# VS Code integrated): `hostProfile` in the cfg injects the host's env
# fingerprint into the child so capability detection resolves the first-class
# profiles. HONEST LANE LABEL: this lane is
# ConPTY + simulated WT environment — the fingerprint drives the profile
# RESOLVER through a real ConPTY with pyte as the semantic screen; the
# Windows Terminal renderer process itself never runs here. Claims about WT
# rendering/paint belong to the field box, never to this driver.
#   "wt"     → WT_SESSION=<uuid>  (simulated WT environment — fingerprint only)
#   "vscode" → TERM_PROGRAM=vscode, TERM_PROGRAM_VERSION=1.102.0 (simulated
#              VS Code integrated — fingerprint only)
#   absent   → no fingerprint (base ConPTY — the requirement-surface case)
#
# node-pty NOTE: this driver exists so the ROOT manifest never gains
# node-pty — src/daemon/runPtyHost.ts probes for node-pty's presence to select
# a dormant daemon PTY tier, so a root dependency would silently enable that
# tier. Python + pywinpty keeps the capture plane out of the product tree
# entirely; prove-no-node-pty.ts is the standing ratchet.
import json, os, re, sys, struct, time

# CONSOLE CODEPAGE PIN: ConPTY
# re-renders child output through the CONSOLE output codepage. On runner
# images where that page is not 65001, glyphs outside its map lose bytes
# mid-sequence (the raw tee showed `\xe2\x95\xaf` ╯ intact beside `\xc2 `
# and `\xe2x` — the · and ⌃ continuation bytes eaten), so the ❯ /
# `? for shortcuts` ready needles can never match and every wt/vscode boot
# leg exhausts its budget (runs 30677930879 + 30678259709; the alternating
# pass/fail history was a mixed-image fleet). Pin both directions to UTF-8
# BEFORE any conpty spawn — the same class as the clip.exe UTF-16 lesson:
# never trust an ambient Windows codepage.
if sys.platform == "win32":
    import ctypes
    try:
        ctypes.windll.kernel32.SetConsoleCP(65001)
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass  # non-console contexts (no attached console) keep going

# The runner's Python consoles default to cp1252 — the final screen echo must
# never kill a capture whose grid already landed (burst #1: five exit-1s from
# print(), zero from captures). errors=replace keeps the echo legible.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import pyte

try:
    from winpty import PTY  # pywinpty >= 2.0 low-level, non-blocking reads
except ImportError:
    sys.exit("vshot-win requires pywinpty (pip install pywinpty) — Windows only")

# KITTY-CSI-u STRIP — identical to vshot.py (pyte literalizes the trailing
# 'u' of kitty keyboard-protocol sequences; real terminals consume them).
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


# FORK-BOMB GUARD — same class as vshot.py: refuse to nest.
if os.environ.get("VSHOT_ACTIVE"):
    sys.exit(
        "vshot-win refusing to run under vshot (VSHOT_ACTIVE set): a render "
        "proof re-entered its PARENT branch inside the PTY child."
    )
os.environ["VSHOT_ACTIVE"] = "1"


# ── CAPTURE SLOT (best-effort, msvcrt) ───────────────────────────────────────
# Same rotating-flake rationale as vshot.py's flock semaphore: at most N
# captures machine-wide. msvcrt.locking on slot files; ANY surprise falls
# through to unserialized capture — the helper must never kill the run.
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
                    return f  # held until process exit
                except OSError:
                    f.close()
            time.sleep(0.25)
        return None
    except Exception:
        return None


_capture_slot = _acquire_capture_slot()

cfg = json.load(open(sys.argv[1]))
cols, rows, total = int(cfg["cols"]), int(cfg["rows"]), int(cfg.get("total", 30))
# MERCURY_VSHOT_BUDGET_SCALE — the hosted-profile deadline stretch, the
# posix vshot's twin (see scripts/ui/vshot.py; registry:
# src/substrate/flagRegistry.ts): scales ONLY the hard deadline `total`;
# event-driven awaits and the observed-ready early exit are untouched.
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
resizes = sorted(cfg.get("resizes", []), key=lambda r: r.get("atTick", 0))
tee_path = os.environ.get("VSHOT_TEE")
tee = open(tee_path, "ab") if tee_path else None

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
kitty_filter = _KittyFilter()

# ── SPAWN through the real pseudo-console ────────────────────────────────────
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
    # Windows arg quoting for the pseudo-console command line: quote when the
    # arg carries spaces (paths-with-spaces are a required journey).
    return '"%s"' % a if (" " in a and not a.startswith('"')) else a


def _to_bytes(data):
    # winpty-rs hands back str decoded with the OEM codepage (cp437 on the
    # hosted runners), not UTF-8 — burst #1's grids read Γö/Γû/ΓÇ where the
    # child (chcp 65001) emitted UTF-8 box/block glyphs. cp437 is a total
    # byte map, so encoding the mojibake back through it recovers the exact
    # original bytes; anything cp437 cannot round-trip falls back to UTF-8.
    if isinstance(data, bytes):
        return data
    try:
        return data.encode("cp437", "strict")
    except UnicodeEncodeError:
        return data.encode("utf-8", "surrogateescape")


def _alive(p):
    # pywinpty has shipped both spellings across releases; a wrong guess here
    # would AttributeError on the first quiet tick of every scenario. Probe
    # once, prefer isalive, fall back to is_alive (winui preflight defect 2).
    fn = getattr(p, "isalive", None) or getattr(p, "is_alive", None)
    return bool(fn()) if fn else True


# Windows spawn convention (winui preflight-2 defect 1): cmdline carries the
# ARGS ONLY with a leading separator — pywinpty's own reference caller builds
# `' ' + list2cmdline(argv[1:])` because the ConPTY backend CONCATENATES
# appname + cmdline into lpCommandLine. Repeating argv[0] would produce
# "...node.exe...node.exe script" under that model and kill every capture at
# spawn; the args-only form is correct under BOTH backend models (under the
# lpApplicationName model the CRT argv[0] is empty, which Node ignores — it
# reads its own path from GetModuleFileNameW). NOTE: a spaced appname cannot
# be safely quoted under the concatenation model — keep the runner's
# hostedtoolcache node (space-free) or repoint via 8.3 paths.
appname = argv[0]
cmdline = "".join(" " + _q(a) for a in argv[1:])
envblock = "".join("%s=%s\0" % (k, v) for k, v in sorted(child_env.items()))
pty.spawn(appname, cmdline=cmdline, cwd=cfg.get("cwd") or None, env=envblock)

sent = 0
resized = 0
stages = []
send_receipts = []
# a send may carry `"mark": "<label>"` — the grid is snapshotted
# at the moment the send becomes due (the settled state its own await-gate
# just observed) and lands in payload["marks"]. Same contract as vshot.py;
# absent key ⇒ byte-identical output.
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
    # `region` ([x0, y0, x1, y1], half-open, clamped) scopes the text to a
    # sub-rectangle — the stability comparisons may ignore a persistent
    # animation outside the band the assertions anchor in (vshot.py parity).
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
TICK_S = 0.2
alive = True
while True:
    tick = int((time.monotonic() - t0) / TICK_S)
    if tick >= total:
        ended_at_tick, end_reason = tick, "budget"
        break
    if resized < len(resizes) and tick >= int(resizes[resized].get("atTick", 0)):
        step = resizes[resized]
        stages.append(
            {"cols": cols, "rows": rows, "untilTick": tick, "grid": snap_grid(cols, rows)}
        )
        cols, rows = int(step["cols"]), int(step["rows"])
        screen.resize(rows, cols)
        pty.set_size(cols, rows)
        resized += 1
    # Non-blocking read replaces select(): pywinpty's low-level read returns
    # empty when nothing is pending. Pace to the tick clock.
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
        # STRICT gating (`requireAwait`, vshot.py parity): the send's
        # await-gate is the ONLY trigger — the tick schedule never fires it
        # blind. A strict send that never becomes due lands in the
        # UNDELIVERED-SENDS refusal. Absent ⇒ byte-identical.
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
            # `signal` sends (vshot.py parity: POSIX SIGTSTP/SIGCONT for the
            # suspend/resume trace) have NO honest ConPTY equivalent —
            # Windows job control cannot park/resume the child the same way.
            # Refuse LOUDLY (the driver-refusal grammar): a journey that
            # needs process suspension must not silently skip it and pass.
            if nxt.get("signal"):
                sys.stderr.write(
                    "[vshot-win] SIGNAL-UNSUPPORTED: send %d requests %s — POSIX job control has no ConPTY equivalent; run this journey on the posix driver.\n"
                    % (sent, nxt["signal"])
                )
                sys.exit(6)
            send_payload = nxt.get("data", "")
            if nxt.get("targetText"):
                # IN-BOOT COORDINATE RESOLUTION (`targetText`, vshot.py
                # parity — the cross-boot anchor class): resolve {X}/{Y} in
                # `data` against THIS boot's grid at fire time; the needle
                # absent ⇒ the send is not yet due (never-appearing lands in
                # the UNDELIVERED-SENDS refusal). X = the needle's 1-based
                # column + `targetDx` (default 0); Y = its 1-based row.
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
        # Nothing pending — sleep out the remainder of this tick so the loop
        # never spins (select()'s wait, expressed for the polling read).
        time.sleep(
            max(0.0, min(0.05, (tick + 1) * TICK_S - (time.monotonic() - t0)))
        )

# Drain the tail — same bounded epilogue as vshot.py (never end mid-burst;
# hard-capped so an animation tick can't wedge the capture).
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
# REFUSE an incomplete journey the same way (vshot.py's exit-4 contract): a
# send (and any mark riding it) that never became due means the scenario did
# not happen as written — exit 0 with a silently shorter journey pushes the
# loudness onto every consumer's memory.
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
# REFUSE an unsettled layout when the scene declared it must settle
# (`requireStable`, vshot.py parity): coordinates anchored on (or aimed at) a
# grid that never stopped moving are the stale-row class.
if cfg.get("requireStable") and stable_need and end_reason != "stable":
    sys.stderr.write(
        "[vshot-win] NEVER-STABLE: the grid never held byte-identical for %d "
        "consecutive ticks within %d (ended: %s). Layout-anchored "
        "coordinates from this capture would be stale.\n"
        % (stable_need, total, end_reason))
    sys.exit(5)

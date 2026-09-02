#!/usr/bin/env python3
# scripts/ui/vshot.py — PTY capture substrate for render-verify.
# Boots argv in a real PTY at cols×rows, pumps the loop `total` ticks feeding
# scripted sends, captures the pyte screen → a cell-grid JSON + plain text.
# A tick is 0.2s of WALL CLOCK (not a loop iteration): with a chatty child,
# select() returns instantly and iteration-ticks raced through the budget in
# milliseconds — sends fired early and the capture ended MID-BURST of a frame
# (the STALE-PAINT probe traced the "ghost detail rows" to exactly
# this: pyte had applied the first half of a transition frame's diff when the
# loop hit `total`). Wall-clock ticks make `total` mean seconds/0.2 again.
# VSHOT_TEE=<path> (opt-in, forensics): every PTY read is appended to <path>
# as length-prefixed frames `>II` (tick, len) + raw bytes — the STALE-PAINT
# ledger's prescribed emission-boundary probe (step-replay via pyte offline).
import json, os, re, sys, select, pty, fcntl, termios, struct, time
import pyte

# KITTY-CSI-u STRIP: pyte does not consume kitty keyboard-protocol
# sequences (ESC[<u pop · ESC[>1u push · ESC[=5;1u set) — their trailing 'u'
# literalizes at the cursor cell (seen live: a Select's focused row captured as
# "uu1. Yes" from two raw-mode toggles). Real terminals consume these; strip
# them before pyte. The tee still records RAW bytes (filter sits after tee).
# pyte's ByteStream is stateful across feeds, so split NON-kitty sequences need
# no help — we only carry a tail that could still become a kitty sequence.
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

# FORK-BOMB GUARD: a
# self-spawning render proof whose CHILD branch is selected by an env marker
# will re-enter its PARENT branch when that marker never reaches the child
# (cfg["env"] is not applied — pass env via the spawn call). The parent branch
# then runs vshot again, recursively, until the machine dies. Refuse to nest.
if os.environ.get("VSHOT_ACTIVE"):
    sys.exit(
        "vshot refusing to run under vshot (VSHOT_ACTIVE set): a render proof "
        "re-entered its PARENT branch inside the PTY child — its child-branch "
        "env marker never arrived. Pass the marker via the spawn env option "
        "(cfg['env'] is NOT applied)."
    )
os.environ["VSHOT_ACTIVE"] = "1"

# ── CROSS-SUITE CAPTURE SEMAPHORE ─────
# Pooled gate suites (ui · doctor · helm-console · party …) each spawn PTY
# captures; when several run at once the child binaries starve for CPU and
# frames land blank/partial — the gate then fails a ROTATING set of capture
# proofs (whichever were in flight), which reads as phantom regressions. Ticks
# are wall-clock, so a starved capture cannot compensate. Every capture in the
# repo funnels through THIS file, so the fix lives here: at most N captures run
# machine-wide; the rest block on flock (bounded), then run at full speed.
# Serializing costs a little wall time; starved frames cost a false-RED gate.
# VSHOT_SLOTS tunes (0 disables — e.g. for a manually serialized run).
# Default 3 since the adoption (paired with the gate's
# pty-lane cap 3 — measured: zero capture flakes at 3/3 on a loaded pool);
# a recurrence of the rotating-flake class is the revert signal (=2).
def _acquire_capture_slot():
    # Serialization is BEST-EFFORT by design: any filesystem surprise (foreign
    # /tmp dir with unfriendly perms, symlink games, read-only tmp) must fall
    # through to unserialized capture — never kill every render proof on the
    # machine over the helper that exists to make them reliable.
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
        deadline = time.monotonic() + 300  # bounded: never wedge the gate
        while time.monotonic() < deadline:
            for i in range(n):
                f = open(os.path.join(slot_dir, f"slot-{i}.lock"), "a")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return f  # held until exit (kernel releases on kill)
                except OSError:
                    f.close()
            time.sleep(0.25)
        return None  # timed out — proceed unserialized, don't fail the run
    except OSError:
        return None

_capture_slot = _acquire_capture_slot()

cfg = json.load(open(sys.argv[1]))
cols, rows, total = int(cfg["cols"]), int(cfg["rows"]), int(cfg.get("total", 30))
# THE HOSTED PROFILE (gate run 1, the 2-core budget class): a slower runner
# than every authoring box red ~28 healthy PTY suites as NEVER-READY at
# their authored deadlines. MERCURY_VSHOT_BUDGET_SCALE stretches the capture
# as ONE MOVIE (gate run 2 refinement): the hard deadline `total` AND every
# schedule source — send atTick/minTick/afterPrevTicks, resize atTick, the
# grace delays (awaitSettleTicks/readySettleTicks), the drain windows. Run 2
# proved deadline-only stretching tears the movie: blind sends still fired at
# authored ticks into boots 3× behind them (keys swallowed, journeys never
# happened — the UNDELIVERED-SENDS shapes), while the stretched deadline let
# declared-ready scenes wait honestly. Relative order is preserved by
# construction (one multiplier), awaits stay event-driven, and observed-ready
# still ends a green scene early — authored budgets stay byte-identical
# locally (default 1).
# CARVE-OUTS (state criteria are not schedules):
#   · stableTicks/awaitStableTicks hold-lengths stay AUTHORED — "byte-identical
#     for N ticks" is a state criterion; a stretched hold can starve forever
#     beside a periodic ambient animation that the authored hold slips between.
#   · a PURE FIXED-WINDOW capture (no sends, no resizes, no readyText, no
#     stableTicks) stays wholly authored: its window IS the contract (a
#     choreography watched 3× longer observes a different scene, and no early
#     exit exists to hand the headroom back).
# Registry: src/substrate/flagRegistry.ts.
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
# OBSERVED-READY early exit: `readyText` — a string
# (or list, ALL required) that marks the scene fully loaded. Once every send
# is dispatched, every resize applied, and the text is on screen, the capture
# ends after `readySettleTicks` (default 2) more ticks instead of burning the
# whole fixed budget. `total` STAYS the hard deadline — text never appearing
# ⇒ the exact old fixed-duration capture. Time-as-contract captures
# (motion lattices, dwell laws, stream benches) simply never set it: absent
# ⇒ byte-identical behavior. Only STATIC end-states may opt in — a scene
# with time-varying content would snap a different frame than its recorded
# visual baseline (the baseline --check adjudicates; a RED there = revert
# the annotation, the scene is time-as-contract).
ready_texts = cfg.get("readyText")
if isinstance(ready_texts, str):
    ready_texts = [ready_texts]
ready_settle = _scaled(int(cfg.get("readySettleTicks", 2)))
ready_at = None
# Diagnostic memory for the END-GATE TRAP (a follow-up): readyText
# is the POST-SENDS end gate by contract (its scan arms once every send has
# fired — the birth semantics), so a cfg whose ready needles name a world an
# await-send then LEAVES can never latch and burns the whole budget. Sampled
# once per send-fire (bounded cost); the NEVER-READY refusal names the trap.
ready_seen_pre_sends = False
last_output_tick = -1
# END-REASON: a capture whose declared `readyText` never appeared
# would otherwise return whatever happened to be on screen, byte-indistinguishable from a
# real settle. That is the wrong-frame class — a scheduling stall in the gate
# surfaced as three cryptic assertion failures in prove-party-board instead of
# "this scene never became ready". Record WHY the capture ended, and refuse to
# report a declared-ready scene that never reached its needles.
end_reason = "budget"
ended_at_tick = 0
# OBSERVED-STABLE early exit (opt-in, composable with readyText): once every
# send/resize is done (and readyText, if any, is satisfied), the capture ends
# when the grid has been BYTE-IDENTICAL for `stableTicks` consecutive ticks —
# the settled-screen condition (the doctor modal-growth storm: needles paint
# before async sections finish, so text alone can snap mid-growth). A scene
# with any animation never stabilizes and runs its full budget — inherently
# time-as-contract-safe. Absent ⇒ byte-identical behavior.
# `stableRegion: [x0, y0, x1, y1]` (optional, half-open, clamped) scopes the
# stability comparison to a sub-rectangle: a persistent animation OUTSIDE the
# region (the cockpit's far-right session clock) must not veto the settle of
# the band the assertions actually anchor in. Sends may scope their own
# stability the same way via `awaitStableRegion`. Same char-cell comparison
# as whole-grid stability; absent ⇒ byte-identical whole-grid behavior.
stable_need = int(cfg.get("stableTicks", 0))
stable_region = cfg.get("stableRegion")

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
# Cumulative raw output (control bytes included) for awaitRaw send gating.
raw_seen = bytearray()
# mid-flight RESIZES: [{"atTick": N, "cols": C, "rows": R},...].
# At each step the PTY winsize changes (the kernel delivers SIGWINCH), the
# pyte screen resizes, and a stage snapshot of the PREVIOUS geometry's final
# frame is appended to `stages` in the output JSON. Absent ⇒ byte-identical
# single-geometry behavior (every existing config).
resizes = sorted(cfg.get("resizes", []), key=lambda r: r.get("atTick", 0))
tee_path = os.environ.get("VSHOT_TEE")
tee = open(tee_path, "ab") if tee_path else None

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
kitty_filter = _KittyFilter()

pid, fd = pty.fork()
if pid == 0:                                   # child: become the TUI
    os.environ["COLUMNS"], os.environ["LINES"] = str(cols), str(rows)
    # Optional per-capture working directory (federation rehearsal: the guest
    # seat boots in its own clone). Absent ⇒ inherit — every existing config.
    if cfg.get("cwd"):
        os.chdir(cfg["cwd"])
    os.execvp(argv[0], argv)
else:                                          # parent: drive + capture
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    sent = 0
    resized = 0
    stages = []  # [{cols, rows, atTick, grid-snapshot BEFORE the resize}]
    send_receipts = []  # wall-clock ms per send — the latency seam
    # a send may carry `"mark": "<label>"`. The grid is snapshotted
    # at the moment that send becomes DUE — i.e. the settled state its own
    # await-gate just observed — and lands in payload["marks"]. This is the
    # semantic layer's frame SEQUENCE: an anchoring or steer/queue law is a
    # claim about two moments in one run, and a final-frame-only capture can
    # only ever assert the last one. Absent key ⇒ byte-identical output.
    marks = []

    def snap_grid(c, r):
        return [[{"c": screen.buffer[y][x].data,
                  "fg": screen.buffer[y][x].fg,
                  "bg": screen.buffer[y][x].bg,
                  "bold": bool(screen.buffer[y][x].bold),
                  "rev": bool(screen.buffer[y][x].reverse)}
                 for x in range(c)] for y in range(r)]

    t0 = time.monotonic()
    TICK_S = 0.2
    while True:
        tick = int((time.monotonic() - t0) / TICK_S)
        if tick >= total:
            ended_at_tick, end_reason = tick, "budget"
            break
        if resized < len(resizes) and tick >= _scaled(int(resizes[resized].get("atTick", 0))):
            step = resizes[resized]
            # snapshot the OUTGOING geometry's final frame first
            stages.append({"cols": cols, "rows": rows, "untilTick": tick,
                           "grid": snap_grid(cols, rows)})
            cols, rows = int(step["cols"]), int(step["rows"])
            screen.resize(rows, cols)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            resized += 1
        # Cap the select wait at the remainder of the current tick so send
        # timing stays ~one tick accurate even when the child is quiet.
        wait = max(0.0, (tick + 1) * TICK_S - (time.monotonic() - t0))
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
            last_output_tick = tick  # idle-census observable (additive)
            stream.feed(kitty_filter.feed(data))
        tick = int((time.monotonic() - t0) / TICK_S)
        if sent < len(sends):
            # OBSERVED-READY send gating: a send with
            # `awaitText` fires as soon as that text is ON SCREEN (past
            # `minTick`, default 0) — its `atTick` degrades into the HARD
            # DEADLINE, so the never-ready worst case is exactly the old
            # fixed schedule. `afterPrevTicks: N` schedules RELATIVE to the
            # previous send's actual fire tick (preserves intended gaps when
            # earlier sends fire early; the first send falls back to atTick).
            # Absent keys ⇒ byte-identical atTick behavior.
            nxt = sends[sent]
            # STRICT gating (`requireAwait`, the settled-phase law): the
            # send's await-gate (awaitText/awaitRaw, with any settle/stable
            # riders) is the ONLY trigger — the tick schedule never fires it
            # blind into a boot phase that hasn't reached the gate (the
            # hover-e2e shard red: a deadline-fired pointer motion into an
            # unpainted/unarmed rail asserts on a wrong-frame observation).
            # A strict send that never becomes due lands in the
            # UNDELIVERED-SENDS refusal below. Absent ⇒ byte-identical.
            if nxt.get("requireAwait"):
                due = False
            elif "afterPrevTicks" in nxt and prev_send_tick is not None:
                due = tick >= prev_send_tick + _scaled(int(nxt["afterPrevTicks"]))
            else:
                due = tick >= _scaled(int(nxt.get("atTick", 1)))
            if not due and nxt.get("awaitRaw") and tick >= _scaled(int(nxt.get("minTick", 0))):
                # awaitRaw: a needle matched against the CUMULATIVE RAW output
                # stream (control bytes included — pyte strips these from the
                # grid). The causal ready class: an app DECLARES a capability
                # by emitting its enable sequence (e.g. bracketed paste =
                # \x1b[?2004h at raw-mode arm), and a send gated on that
                # declaration can never race the arming on any machine.
                # atTick stays the hard deadline, exactly like awaitText.
                if nxt["awaitRaw"].encode("utf-8") in raw_seen:
                    due = True
            if not due and nxt.get("awaitText") and tick >= _scaled(int(nxt.get("minTick", 0))):
                # awaitSettleTicks (default 0): fire N ticks AFTER the needle
                # first paints — paint ≠ input-wired (a key sent the same tick
                # a loading surface's needle appears can be swallowed).
                # awaitStableTicks: additionally
                # require the WHOLE GRID byte-identical for N consecutive
                # ticks after the needle paints — the settled-layout ready
                # class. A send aimed by coordinates from another boot must
                # land on a layout that has STOPPED MOVING: on a slow runner
                # the needle paints while a resume is still streaming rows,
                # so a paint-gated click lands on a row that only later
                # settles at its anchored position (CI 30231040753, the
                # click-expand leg-4 dead clicks). atTick stays the hard
                # deadline; absent key ⇒ byte-identical behavior.
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
                    # IN-BOOT COORDINATE RESOLUTION (`targetText`, the
                    # cross-boot anchor class): a pointer send names its
                    # target row by TEXT and resolves the {X}/{Y}
                    # placeholders in `data` against THIS boot's grid at
                    # fire time. Coordinates anchored in a different boot's
                    # layout are invalid here by construction — async rail
                    # sections may settle in another order per boot, so row
                    # indices do not transfer between boots (the shard-4
                    # round-2 red: a settled sweep boot whose row 9 was the
                    # notes tip, not the baseline boot's target). The needle
                    # must be on screen at fire time: absent ⇒ the send is
                    # not yet due (never-appearing lands in the
                    # UNDELIVERED-SENDS refusal). X = the needle's 1-based
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
                if ready_texts and ready_at is None and not ready_seen_pre_sends:
                    pre_text = grid_text()
                    if all(s in pre_text for s in ready_texts):
                        ready_seen_pre_sends = True
                if nxt.get("mark"):
                    marks.append({"label": nxt["mark"], "atTick": tick,
                                  "cols": cols, "rows": rows,
                                  "grid": snap_grid(cols, rows)})
                # `signal` sends deliver a POSIX signal to the child instead
                # of bytes (SR-042's suspend/resume trace: SIGTSTP parks the
                # process, SIGCONT resumes it, and the NEXT key must land
                # exactly once). `data` still writes when non-empty, after
                # the signal.
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
                # once per TICK — output bursts spin this loop far faster
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
    # Drain the tail: a frame emitted just before the deadline may still sit in
    # the kernel PTY buffer — read until ~0.3s of silence so the capture never
    # ends mid-burst (the ghost-detail-rows class). HARD-CAPPED at 2s: a live
    # TUI with an animation tick never goes fully quiet, and the cap keeps
    # `total` meaning what it says to within a bounded epilogue. Both windows
    # ride the hosted profile (a slower runner trickles its tail longer).
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
               # Ready-gate receipt: WHY this capture ended, so a caller (or a
               # human reading the artifact) can tell a real settle from a
               # budget expiry without re-deriving it from the pixels.
               "readyAt": ready_at,
               "endedAtTick": ended_at_tick,
               "endReason": end_reason,
               # Idle-census observable (R6, additive): the tick of the
               # LAST child output — endedAtTick minus this is the silent tail.
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
    # REFUSE a wrong-frame capture. A scene that DECLARED readyText and never
    # reached it is not an observation of that scene, and returning it silently
    # is what let a scheduling stall masquerade as a product regression. The
    # grid is still written and the screen still printed (the failure stays
    # inspectable); only the exit status changes, and every prove-*.ts capture
    # helper already fails on a non-zero vshot status.
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
    # REFUSE an incomplete journey the same way. A send (and any mark riding
    # it) that never became due means the scenario did not happen as written —
    # returning exit 0 with a silently shorter journey pushed the loudness
    # onto every consumer's memory (re-audit: a vanished mark only
    # failed if the prover happened to assert its presence).
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
    # REFUSE an unsettled layout when the scene declared it must settle
    # (`requireStable`): coordinates anchored on (or aimed at) a grid that
    # never stopped moving are the stale-row class — the observation is not
    # of the settled scene the assertions describe.
    if cfg.get("requireStable") and stable_need and end_reason != "stable":
        sys.stderr.write(
            "[vshot] NEVER-STABLE: the grid never held byte-identical for %d "
            "consecutive ticks within %d (ended: %s). Layout-anchored "
            "coordinates from this capture would be stale.\n"
            % (stable_need, total, end_reason))
        sys.exit(5)

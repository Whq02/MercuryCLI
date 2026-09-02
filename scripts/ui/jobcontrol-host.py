#!/usr/bin/env python3
# ============================================================================
#  jobcontrol-host.py — a JOB-CONTROL SHELL hosting the built bundle in a PTY.
#
#  vshot.py execs the bundle straight into the PTY: the process is then the
#  session leader of a process group whose parent lives in another session —
#  an ORPHANED process group, where the kernel discards default-action stop
#  signals (SIGTSTP/SIGTTIN/SIGTTOU) and answers a background terminal read
#  with EIO instead of a stop. That is not the operator's world. Here an
#  interactive bash owns the PTY and runs the bundle as a foreground job in
#  its own process group, exactly like the operator's shell: stops happen,
#  the shell reports them, and the terminal's foreground process group is a
#  real observable.
#
#  Driven by a JSON script (argv[1]); writes a JSON report (argv[2]):
#    steps      — see run_step below (wait / launch / send / typeline /
#                 signal / sleep / mark / observe / face_row /
#                 await_state / await_settle / poll)
#    report     — marks (grid text + tee offset), state samples of the
#                 bundle's process (stat · pgid · tpgid), mode events (the
#                 DEC private modes seen in the byte stream, time-stamped),
#                 the raw tee, the shell's job-control lines, the end reason.
#  The bundle's pid is found by walking the process table for the shell's
#  child running the bundle path (never the daemon sidecar).
# ============================================================================
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

import pyte

cfg = json.load(open(sys.argv[1]))
report_path = sys.argv[2]
cols, rows = int(cfg["cols"]), int(cfg["rows"])
command = cfg["command"]  # the command line typed at the shell prompt
bundle_marker = cfg.get("bundleMarker", "mercury.mjs")
bundle_title = cfg.get("bundleTitle", "mercury")
steps = cfg["steps"]
tee_path = cfg.get("tee")
budget_s = float(cfg.get("budgetSeconds", 120))

t0 = time.monotonic()


def ms():
    return int((time.monotonic() - t0) * 1000)


_KITTY_SEQ = re.compile(rb"\x1b\[[<>=][0-9;]*u")
_KITTY_TAIL = re.compile(rb"(?:\x1b|\x1b\[|\x1b\[[<>=][0-9;]*)$")
_carry = b""


def kitty_filter(data):
    global _carry
    buf = _carry + data
    buf = _KITTY_SEQ.sub(b"", buf)
    m = _KITTY_TAIL.search(buf)
    if m:
        _carry = buf[m.start():]
        return buf[: m.start()]
    _carry = b""
    return buf


MODE_SEQS = {}
for num, name in [(1000, "mouse-normal"), (1002, "mouse-button"), (1003, "mouse-any"), (1006, "mouse-sgr"),
                  (1049, "alt-screen"), (2004, "bracketed-paste"), (1004, "focus-events"), (25, "cursor"),
                  (1007, "alt-scroll")]:
    MODE_SEQS[("\x1b[?%dh" % num).encode()] = "%s:on" % name
    MODE_SEQS[("\x1b[?%dl" % num).encode()] = "%s:off" % name

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)

shell_pid, fd = pty.fork()
if shell_pid == 0:
    os.environ["COLUMNS"], os.environ["LINES"] = str(cols), str(rows)
    if cfg.get("cwd"):
        os.chdir(cfg["cwd"])
    # No rc files, interactive (job control on), a plain prompt.
    os.environ["PS1"] = "host$ "
    os.execvp("/bin/bash", ["/bin/bash", "--noprofile", "--norc", "-i"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
raw = bytearray()
tee = open(tee_path, "wb") if tee_path else None
eof = False
mode_events = []
state_samples = []
marks = []
log_lines = []
bundle_pid = None


def log(msg):
    log_lines.append("[%7dms] %s" % (ms(), msg))


def pump(timeout):
    global eof
    if eof:
        time.sleep(timeout)
        return
    r, _, _ = select.select([fd], [], [], timeout)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            eof = True
            log("EOF on the pty")
            return
        tail = bytes(raw[-12:])
        raw.extend(data)
        if tee:
            tee.write(data)
            tee.flush()
        # The overlap covers a sequence split across two reads; offsets are
        # computed against the joined buffer.
        joined = tail + data
        for seq, name in MODE_SEQS.items():
            start = 0
            while True:
                i = joined.find(seq, start)
                if i < 0:
                    break
                if i + len(seq) > len(tail):  # not one already counted in the tail
                    mode_events.append({"ms": ms(), "mode": name, "offset": len(raw) - len(joined) + i})
                start = i + len(seq)
        stream.feed(kitty_filter(data))


def text():
    return "\n".join("".join(screen.buffer[y][x].data for x in range(cols)) for y in range(rows))


def sleep_pumping(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        pump(0.02)


def wait_for(needles, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not eof:
        pump(0.05)
        t = text()
        for n in needles:
            if n in t:
                return n
    return None


def ps_table():
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid=,tpgid=,stat=,command="],
                         capture_output=True, text=True).stdout
    rows_ = []
    for line in out.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 5:
            continue
        try:
            rows_.append({"pid": int(parts[0]), "ppid": int(parts[1]), "pgid": int(parts[2]),
                          "tpgid": int(parts[3]), "stat": parts[4], "cmd": parts[5] if len(parts) > 5 else ""})
        except ValueError:
            continue
    return rows_


def find_bundle(table):
    global bundle_pid
    if bundle_pid is not None:
        for r in table:
            if r["pid"] == bundle_pid:
                return r
        return None
    for r in table:
        # The bundle renames itself (process.title) once booted; before that
        # its command line carries the bundle path. The daemon sidecar keeps
        # the node command line and is never the job.
        cmd = r["cmd"]
        is_bundle = cmd.strip() == bundle_title or bundle_marker in cmd
        if r["ppid"] == shell_pid and is_bundle and "daemon" not in cmd:
            bundle_pid = r["pid"]
            log("bundle pid %d: %s" % (bundle_pid, r["cmd"][:100]))
            return r
    return None


def descendants(table, root):
    keep = {root}
    changed = True
    while changed:
        changed = False
        for r in table:
            if r["ppid"] in keep and r["pid"] not in keep:
                keep.add(r["pid"])
                changed = True
    return [r for r in table if r["pid"] in keep]


def sample(label):
    table = ps_table()
    me = find_bundle(table)
    entry = {"ms": ms(), "label": label, "stat": None, "pgid": None, "tpgid": None, "foreground": None,
             "tree": []}
    if me is not None:
        entry.update({"stat": me["stat"], "pgid": me["pgid"], "tpgid": me["tpgid"],
                      "foreground": me["pgid"] == me["tpgid"]})
        entry["tree"] = [{"pid": r["pid"], "ppid": r["ppid"], "pgid": r["pgid"], "tpgid": r["tpgid"],
                          "stat": r["stat"], "cmd": r["cmd"][:120]} for r in descendants(table, me["pid"])]
    state_samples.append(entry)
    return entry


def mark(label):
    marks.append({"label": label, "ms": ms(), "teeOffset": len(raw), "grid": text()})


def face_row(target):
    labels = ["New Session", "Continue Last Session", "Boot Menu", "MCPs & Skills", "Agents",
              "Doctor / Health Check", "Saturn Scheduler", "Logins", "Session Concourse", "Sessions"]
    lines = text().split("\n")
    y_new = next(i for i, l in enumerate(lines) if "New Session" in l)
    y_t = next(i for i, l in enumerate(lines) if target in l)
    between = sum(1 for l in lines[y_new + 1:y_t] if any(lab in l for lab in labels))
    for _ in range(between + 1):
        os.write(fd, b"\x1b[B")
        sleep_pumping(0.15)
    os.write(fd, b"\r")


end_reason = "steps-done"


def run_step(step):
    global end_reason
    if "wait" in step:
        needles = step["wait"] if isinstance(step["wait"], list) else [step["wait"]]
        hit = wait_for(needles, float(step.get("timeout", 30)))
        log("wait %r -> %r" % (needles, hit))
        if hit is None and step.get("required", True):
            end_reason = "never-saw:%s" % needles[0]
            return False
    elif "launch" in step:
        # The bundle's command line, typed at the shell prompt: the shell
        # forks it into its own process group as the foreground job.
        log("launch %r" % command)
        os.write(fd, (command + "\r").encode())
    elif "typeline" in step:
        log("typeline %r" % step["typeline"])
        os.write(fd, (step["typeline"] + "\r").encode())
    elif "send" in step:
        log("send %r" % step["send"])
        os.write(fd, step["send"].encode())
    elif "signal" in step:
        table = ps_table()
        me = find_bundle(table)
        if me is None:
            end_reason = "no-bundle-pid"
            log("signal %s: the bundle's pid was not found" % step["signal"])
            return False
        log("signal %s -> pid %d" % (step["signal"], me["pid"]))
        os.kill(me["pid"], getattr(signal, step["signal"]))
    elif "sleep" in step:
        sleep_pumping(float(step["sleep"]))
    elif "mark" in step:
        mark(step["mark"])
    elif "observe" in step:
        sample(step["observe"])
    elif "face_row" in step:
        face_row(step["face_row"])
    elif "await_state" in step:
        # Poll the bundle's process state until stat starts with the wanted
        # letter (or the deadline); every poll is a recorded sample.
        want = step["await_state"]
        deadline = time.monotonic() + float(step.get("timeout", 10))
        seen = False
        while time.monotonic() < deadline:
            sleep_pumping(0.05)
            s = sample("await:%s" % want)
            if s["stat"] is not None and s["stat"].startswith(want):
                seen = True
                break
        log("await_state %s -> %s" % (want, seen))
        if not seen and step.get("required", True):
            end_reason = "state-never:%s" % want
            return False
    elif "poll" in step:
        # Sample the process state at an interval for a window, watching the
        # screen for an optional needle that ends the window early.
        until = step.get("until")
        deadline = time.monotonic() + float(step.get("seconds", 10))
        interval = float(step.get("interval", 0.2))
        while time.monotonic() < deadline:
            sleep_pumping(interval)
            sample("poll:%s" % step.get("label", ""))
            if until and until in text():
                break
            if eof:
                break
    elif "await_settle" in step:
        # The grid holds byte-identical for N consecutive checks.
        need = int(step.get("checks", 4))
        deadline = time.monotonic() + float(step.get("timeout", 20))
        last = None
        run = 0
        while time.monotonic() < deadline:
            sleep_pumping(float(step.get("interval", 0.25)))
            t = text()
            run = run + 1 if t == last else 0
            last = t
            if run >= need:
                break
    return True


try:
    for step in steps:
        if ms() > budget_s * 1000:
            end_reason = "budget"
            break
        if not run_step(step):
            break
finally:
    # Leave nothing behind: end the bundle if it still runs, then the shell.
    table = ps_table()
    me = find_bundle(table)
    if me is not None:
        for r in descendants(table, me["pid"]):
            try:
                os.kill(r["pid"], signal.SIGKILL)
            except ProcessLookupError:
                pass
    try:
        os.kill(shell_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(shell_pid, 0)
    except ChildProcessError:
        pass
    final_text = text()
    shell_lines = [l.strip() for l in final_text.split("\n")
                   if re.search(r"Stopped|suspended|Terminated|Killed", l)]
    report = {
        "endReason": end_reason,
        "bundlePid": bundle_pid,
        "marks": marks,
        "samples": state_samples,
        "modeEvents": mode_events,
        "shellLines": shell_lines,
        "finalGrid": final_text,
        "log": log_lines,
        "rawBytes": len(raw),
    }
    with open(report_path, "w") as f:
        json.dump(report, f)
    if tee:
        tee.close()

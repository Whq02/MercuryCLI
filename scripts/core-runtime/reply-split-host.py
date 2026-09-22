#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import pwd
import select
import signal
import struct
import sys
import termios
import time

EMULATOR_MISSING_EXIT = 78


def resolve_emulator():
    try:
        import pyte
        return pyte
    except ImportError:
        pass
    try:
        home = pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        home = None
    ver = "%d.%d" % sys.version_info[:2]
    candidates = []
    if home:
        candidates.append(os.path.join(home, "Library", "Python", ver, "lib", "python", "site-packages"))
        candidates.append(os.path.join(home, ".local", "lib", "python" + ver, "site-packages"))
    for candidate in candidates:
        if os.path.isdir(os.path.join(candidate, "pyte")):
            sys.path.insert(0, candidate)
            try:
                import pyte
                return pyte
            except ImportError:
                sys.path.remove(candidate)
    sys.stderr.write("reply-split-host: the terminal emulator (pyte) is not importable by %s\n" % sys.executable)
    sys.exit(EMULATOR_MISSING_EXIT)


def main():
    cfg = json.load(open(sys.argv[1]))
    report_path = sys.argv[2]
    pyte = resolve_emulator()
    cols, rows = cfg["cols"], cfg["rows"]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.clear()
        os.environ.update(cfg["env"])
        os.chdir(cfg["cwd"])
        os.execvp(cfg["argv"][0], cfg["argv"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    raw = bytearray()
    marks = {}
    events = []
    started = time.time()
    budget = cfg.get("budgetSeconds", 60)
    saw_query_at = None

    def pump(seconds):
        nonlocal saw_query_at
        deadline = time.time() + seconds
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return True
            ready, _, _ = select.select([fd], [], [], min(remaining, 0.05))
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                stream.feed(data)
                raw.extend(data)
                if saw_query_at is None and b"\x1b[c" in raw:
                    saw_query_at = time.time() - started
                    events.append({"at": saw_query_at, "event": "query-seen"})

    def grid():
        return [line.rstrip() for line in screen.display]

    def wait_for(text, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(text in line for line in grid()):
                return True
            if pump(0.1) is False:
                return False
        return False

    alive = True
    for step in cfg["steps"]:
        if time.time() - started > budget:
            events.append({"at": time.time() - started, "event": "budget-exhausted"})
            break
        if "wait" in step:
            ok = wait_for(step["wait"], step.get("timeout", 30))
            events.append({"at": time.time() - started, "event": "wait", "text": step["wait"], "ok": ok})
            if not ok:
                break
        elif "sleep" in step:
            if pump(step["sleep"]) is False:
                alive = False
                break
        elif "mark" in step:
            marks[step["mark"]] = grid()
            events.append({"at": time.time() - started, "event": "mark", "label": step["mark"]})
        elif "send" in step:
            os.write(fd, step["send"].encode("utf-8"))
            events.append({"at": time.time() - started, "event": "send", "bytes": len(step["send"])})
        elif "reply" in step:
            reply = step["reply"]
            os.write(fd, reply["head"].encode("utf-8"))
            events.append({"at": time.time() - started, "event": "reply-head", "bytes": len(reply["head"])})
            pump(reply["gapMs"] / 1000.0)
            os.write(fd, reply["tail"].encode("utf-8"))
            events.append({"at": time.time() - started, "event": "reply-tail", "bytes": len(reply["tail"])})
    final = grid()
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    ended = time.time() + 3
    status = None
    while time.time() < ended:
        pump(0.1)
        done, wstatus = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = wstatus
            break
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    report = {
        "marks": marks,
        "final": final,
        "events": events,
        "sawQueryAt": saw_query_at,
        "alive": alive,
        "rawBytes": len(raw),
    }
    with open(report_path, "w") as out:
        json.dump(report, out)
    with open(report_path + ".raw", "wb") as out:
        out.write(bytes(raw))


if __name__ == "__main__":
    main()

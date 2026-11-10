#!/usr/bin/env python3
import base64
import copy
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

import pyte

ALT_MODES = (47, 1047, 1049)
KITTY_SEQ = re.compile(rb"\x1b\[[<>=][0-9;]*[um]")
KITTY_TAIL = re.compile(rb"(?:\x1b|\x1b\[|\x1b\[[<>=][0-9;]*)$")
BLANKING_SEQ = re.compile(rb"\x1b\[[0-9;?]*[JKSTLMhl]")
ERASE_DISPLAY_SEQ = re.compile(rb"\x1b\[[23]J")
ERASE_BELOW_SEQ = re.compile(rb"\x1b\[0?J")
ALT_SWITCH_SEQ = re.compile(rb"\x1b\[\?(?:47|1047|1049)[hl]")


class Emulator(pyte.Screen):
    def _scroll(self, count, upward):
        top, bottom = self.margins or (0, self.lines - 1)
        saved = self.cursor.y
        self.cursor.y = bottom if upward else top
        for _ in range(max(1, int(count or 1))):
            if upward:
                self.index()
            else:
                self.reverse_index()
        self.cursor.y = saved

    def scroll_up(self, count=1, *_args, **_kwargs):
        self._scroll(count, True)

    def scroll_down(self, count=1, *_args, **_kwargs):
        self._scroll(count, False)

    def _alt_switch(self, modes, kwargs):
        if kwargs.get("private") and any(m in ALT_MODES for m in modes):
            self.erase_in_display(2)
            self.cursor_position()

    def set_mode(self, *modes, **kwargs):
        self._alt_switch(modes, kwargs)
        super().set_mode(*modes, **kwargs)

    def reset_mode(self, *modes, **kwargs):
        self._alt_switch(modes, kwargs)
        super().reset_mode(*modes, **kwargs)


pyte.ByteStream.csi = dict(pyte.ByteStream.csi, S="scroll_up", T="scroll_down")


class KittyFilter:
    def __init__(self):
        self.carry = b""

    def feed(self, data):
        buf = KITTY_SEQ.sub(b"", self.carry + data)
        tail = KITTY_TAIL.search(buf)
        if tail:
            self.carry = buf[tail.start():]
            return buf[: tail.start()]
        self.carry = b""
        return buf


def cell_signature(ch):
    flags = "".join(
        mark
        for mark, on in (
            ("b", ch.bold),
            ("i", ch.italics),
            ("u", ch.underscore),
            ("s", ch.strikethrough),
            ("r", ch.reverse),
        )
        if on
    )
    return "%s|%s|%s" % (ch.fg, ch.bg, flags)


def cells_of(screen):
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        rows.append([line[x].data for x in range(screen.columns)])
    return rows


def grid_of(screen):
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        cells = []
        runs = []
        for x in range(screen.columns):
            ch = line[x]
            cells.append(ch.data)
            sig = cell_signature(ch)
            if runs and runs[-1][1] == sig:
                runs[-1][0] += 1
            else:
                runs.append([1, sig])
        rows.append({"cells": cells, "attrs": runs})
    return rows


def lost_cells(before, final, now):
    lost = 0
    for y in range(min(len(before), len(final), len(now))):
        b, f, n = before[y], final[y], now[y]
        if n == b and n == f:
            continue
        for x in range(min(len(b), len(f), len(n))):
            if n[x] == " " and b[x] != " " and f[x] != " ":
                lost += 1
    return lost


class Rig:
    def __init__(self, cfg):
        self.cols = int(cfg["cols"])
        self.rows = int(cfg["rows"])
        self.screen = Emulator(self.cols, self.rows)
        self.stream = pyte.ByteStream(self.screen)
        self.filter = KittyFilter()
        self.window = []
        self.shadow = None
        self.shadow_before = None
        self.fd = -1
        self.pid = -1
        self.started = time.monotonic()
        self.total_bytes = 0
        self.exited = False

    def spawn(self, argv, cwd):
        pid, fd = pty.fork()
        if pid == 0:
            if cwd:
                os.chdir(cwd)
            os.execvp(argv[0], argv)
        self.pid, self.fd = pid, fd
        self.set_size(self.cols, self.rows)

    def set_size(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def mark(self):
        self.window = []
        self.shadow = copy.deepcopy(self.screen)
        self.shadow_before = cells_of(self.screen)

    def feed(self, data):
        self.total_bytes += len(data)
        self.window.append(data)
        clean = self.filter.feed(data)
        if clean:
            self.stream.feed(clean)

    def pump(self, seconds):
        deadline = time.monotonic() + seconds
        got = 0
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            try:
                ready, _, _ = select.select([self.fd], [], [], min(left, 0.05))
            except (OSError, ValueError):
                self.exited = True
                break
            if not ready:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                self.exited = True
                break
            if not data:
                self.exited = True
                break
            got += len(data)
            self.feed(data)
        return got

    def settle(self, quiet_ms, max_ms):
        deadline = time.monotonic() + max_ms / 1000.0
        quiet_since = time.monotonic()
        while time.monotonic() < deadline and not self.exited:
            if self.pump(0.05) > 0:
                quiet_since = time.monotonic()
            elif (time.monotonic() - quiet_since) * 1000.0 >= quiet_ms:
                return True
        return False

    def await_text(self, text, max_ms):
        deadline = time.monotonic() + max_ms / 1000.0
        while time.monotonic() < deadline and not self.exited:
            if any(text in row for row in self.screen.display):
                return True
            self.pump(0.1)
        return any(text in row for row in self.screen.display)

    def flash(self):
        raw = b"".join(self.window)
        report = {
            "bytes": len(raw),
            "eraseDisplay": len(ERASE_DISPLAY_SEQ.findall(raw)),
            "eraseBelow": len(ERASE_BELOW_SEQ.findall(raw)),
            "altSwitch": len(ALT_SWITCH_SEQ.findall(raw)),
            "maxLost": 0,
            "lostAt": None,
        }
        if self.shadow is None:
            return report
        final = cells_of(self.screen)
        before = self.shadow_before
        shadow_stream = pyte.ByteStream(self.shadow)
        clean = KittyFilter().feed(raw)
        at = 0
        for found in BLANKING_SEQ.finditer(clean):
            shadow_stream.feed(clean[at:found.end()])
            at = found.end()
            lost = lost_cells(before, final, cells_of(self.shadow))
            if lost > report["maxLost"]:
                report["maxLost"] = lost
                report["lostAt"] = found.group(0).decode("latin-1")
        return report

    def snapshot(self, name):
        return {
            "name": name,
            "atMs": int((time.monotonic() - self.started) * 1000),
            "grid": grid_of(self.screen),
            "cursor": {"x": self.screen.cursor.x, "y": self.screen.cursor.y},
            "flash": self.flash(),
            "raw": base64.b64encode(b"".join(self.window)).decode("ascii"),
        }

    def end(self):
        if self.pid < 0:
            return
        try:
            os.kill(self.pid, signal.SIGCONT)
        except OSError:
            pass
        try:
            os.write(self.fd, b"\x03\x03")
        except OSError:
            pass
        deadline = time.monotonic() + 3.0
        reaped = False
        while time.monotonic() < deadline:
            try:
                done, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                reaped = True
                break
            if done == self.pid:
                reaped = True
                break
            self.pump(0.05)
        if not reaped:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def run(cfg):
    rig = Rig(cfg)
    snaps = []
    notes = []
    rig.spawn(cfg["argv"], cfg.get("cwd"))
    try:
        for step in cfg["steps"]:
            op = step["op"]
            if op == "settle":
                ok = rig.settle(step.get("quietMs", 400), step.get("maxMs", 20000))
                notes.append({"op": op, "ok": ok})
            elif op == "await":
                ok = rig.await_text(step["text"], step.get("maxMs", 30000))
                notes.append({"op": op, "text": step["text"], "ok": ok})
                if not ok and step.get("required", True):
                    break
            elif op == "snap":
                snaps.append(rig.snapshot(step["name"]))
                rig.mark()
            elif op == "mark":
                rig.mark()
            elif op == "wipe":
                rig.screen.erase_in_display(2)
                rig.mark()
            elif op == "scribble":
                glyph = step.get("glyph", "#")
                for y in range(rig.rows):
                    line = rig.screen.buffer[y]
                    for x in range(rig.cols):
                        line[x] = line[x]._replace(data=glyph, fg="red", bg="brown", bold=True, reverse=True)
                rig.screen.cursor.attrs = rig.screen.cursor.attrs._replace(fg="red", bold=True, underscore=True)
                rig.mark()
            elif op == "send":
                os.write(rig.fd, step["data"].encode("utf-8"))
            elif op == "signal":
                os.kill(rig.pid, getattr(signal, step["name"]))
            elif op == "resize":
                rig.cols, rig.rows = int(step["cols"]), int(step["rows"])
                rig.screen.resize(rig.rows, rig.cols)
                if rig.shadow is not None:
                    rig.shadow.resize(rig.rows, rig.cols)
                rig.set_size(rig.cols, rig.rows)
            elif op == "sleep":
                rig.pump(step["ms"] / 1000.0)
            elif op == "hold":
                time.sleep(step["ms"] / 1000.0)
            else:
                raise SystemExit("screenrig: unknown op %r" % op)
            if rig.exited:
                notes.append({"op": "exited", "after": op})
                break
    finally:
        rig.end()
    return {"snaps": snaps, "notes": notes, "totalBytes": rig.total_bytes, "exited": rig.exited}


if __name__ == "__main__":
    config = json.load(open(sys.argv[1]))
    result = run(config)
    with open(config["out"], "w") as handle:
        json.dump(result, handle)

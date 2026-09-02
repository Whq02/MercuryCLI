"""The report ring — what Python can honestly see (Mercury Blender bridge).

Sources: Python logging (a root-logger handler attached while the add-on is
enabled), the bridge's own operation notes, and lifecycle handler events.
C-level terminal prints (render progress lines and friends) never pass
Python logging and are OUT of this ring's reach — the Mercury tool's
description says exactly that, so nobody mistakes this tail for the
terminal.

Dropped-oldest is COUNTED: the ring never pretends to be complete.
"""

import collections
import logging
import threading
import time

from . import state

_MESSAGE_CAP = 4096
_SEVERITIES = ("debug", "info", "warning", "error")

_lock = threading.Lock()
_entries = collections.deque(maxlen=state.REPORT_RING_CAP)
_dropped = 0


def _append(severity, message, source):
    global _dropped
    if severity not in _SEVERITIES:
        severity = "info"
    entry = {
        "severity": severity,
        "message": str(message)[:_MESSAGE_CAP],
        "source": source,
        "at": int(time.time() * 1000),
    }
    with _lock:
        if len(_entries) == _entries.maxlen:
            _dropped += 1  # the deque evicts oldest silently — count it
        _entries.append(entry)


def bridge_report(severity, message):
    _append(severity, message, "bridge")


def handler_report(message):
    _append("info", message, "handler")


def tail(limit=100, severity=None):
    floor = _SEVERITIES.index(severity) if severity in _SEVERITIES else 0
    try:
        capped = max(1, int(limit))
    except (TypeError, ValueError):
        capped = 100
    with _lock:
        entries = [e for e in _entries if _SEVERITIES.index(e["severity"]) >= floor]
        dropped = _dropped
    return {"entries": entries[-capped:], "dropped": dropped}


class _RingLogHandler(logging.Handler):
    def emit(self, record):
        # Logging may fire on ANY thread — _append's lock guards the ring,
        # and a logging handler must never raise.
        try:
            if record.levelno >= logging.ERROR:
                sev = "error"
            elif record.levelno >= logging.WARNING:
                sev = "warning"
            elif record.levelno >= logging.INFO:
                sev = "info"
            else:
                sev = "debug"
            _append(sev, record.getMessage(), "logging")
        except Exception:
            pass


_log_handler = None


def attach_logging():
    global _log_handler
    if _log_handler is None:
        _log_handler = _RingLogHandler()
        logging.getLogger().addHandler(_log_handler)


def detach_logging():
    global _log_handler
    if _log_handler is not None:
        logging.getLogger().removeHandler(_log_handler)
        _log_handler = None

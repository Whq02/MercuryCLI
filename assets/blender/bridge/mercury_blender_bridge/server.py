"""The loopback socket server — STDLIB ONLY, ZERO bpy (Mercury Blender bridge).

THE MAIN-THREAD LAW (info_gotchas_threading.rst: "While threads are
running, no code (including the main thread) may use bpy or any Blender
API - only standard Python or third-party modules"): this thread NEVER
touches bpy. Every verb rides command_queue to the pump timer on the main
thread — the bpy.app.timers page's own documented pattern ("Use a Timer to
react to events in another thread"; queue.Queue carries the locking
semantics). Answers and events come back through each connection's outbox,
written by THIS thread — one writer per socket, no interleaving.

Answered HERE (no Blender truth needed): the hello (from the
main-thread-refreshed snapshot in state.py), ping (busy is not dead — a
long python_run blocks the pump, never the heartbeat), UNKNOWN_OP (the verb
table is static), AUTH_FAILED and VERSION_SKEW.

THE CONNECTION LAWS (the wire contract, kept verbatim):
 · loopback only — the listener binds 127.0.0.1, never 0.0.0.0;
 · ONE authed connection — ACCEPT-NEWEST AT HELLO TIME: only an
   authenticated newer hello displaces the older client; a bare connect (a
   reachability probe) never does;
 · unauthed sockets die on the UNAUTHED_DEADLINE_S receive deadline;
 · frames capped MAX_LINE_BYTES both directions — an oversized inbound
   buffer drops the connection, an oversized answer is REPLACED by an
   INTERNAL error carrying the same id (never silent truncation);
 · the token is RE-READ from the file beside this add-on on every hello, so
   a reinstall's rotation takes effect without a Blender restart.
"""

import json
import os
import queue
import select
import socket
import threading
import time

from . import ring, state

# (op, args, request_id, conn) rows the pump drains on the main thread.
command_queue = queue.Queue()

_active = None
_active_lock = threading.Lock()


def set_active(server):
    global _active
    with _active_lock:
        _active = server


def emit(event, data):
    """Main-thread event door (ops/pump call this; never the socket thread)."""
    with _active_lock:
        server = _active
    if server is not None:
        server.emit_event(event, data)


def answer(conn, frame):
    """Main-thread answer door for the pump."""
    with _active_lock:
        server = _active
    if server is not None:
        server.send_frame(conn, frame)


class _Conn:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.outbox = []
        self.authed = False
        self.connected_at = time.monotonic()
        self.dead = False


class BridgeServer:
    def __init__(self, port, token_path):
        self.port = port
        self.token_path = token_path
        self.thread = None
        self.stop_flag = threading.Event()
        self.listener = None
        self.lock = threading.Lock()  # guards conns/outboxes/current across threads
        self.conns = []
        self.current = None  # the ONE authed connection

    # ── lifecycle (called from the main thread) ──────────────────────────────

    def start(self):
        try:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", self.port))
            listener.listen(4)
            listener.setblocking(False)
        except OSError as exc:
            ring.bridge_report(
                "error",
                "cannot bind 127.0.0.1:%d: %s — is another Blender already serving? "
                "MERCURY_BLENDER_BRIDGE_PORT moves Mercury's side; reinstalling aligns config.json"
                % (self.port, exc),
            )
            return False
        self.listener = listener
        self.thread = threading.Thread(target=self._loop, name="mercury-blender-bridge", daemon=True)
        self.thread.start()
        return True

    def stop(self):
        self.stop_flag.set()
        if self.thread is not None:
            self.thread.join(timeout=2.0)
            self.thread = None
        with self.lock:
            conns = list(self.conns)
            self.conns = []
            self.current = None
        for conn in conns:
            self._close(conn)
        if self.listener is not None:
            try:
                self.listener.close()
            except OSError:
                pass
            self.listener = None

    # ── main-thread doors (the pump/ops write through these) ─────────────────

    def send_frame(self, conn, frame):
        data = (json.dumps(frame) + "\n").encode("utf-8")
        if len(data) > state.MAX_LINE_BYTES:
            # Never silent truncation: the answer is REPLACED, id preserved.
            data = (
                json.dumps(
                    {
                        "id": frame.get("id"),
                        "ok": False,
                        "error": {
                            "code": "INTERNAL",
                            "message": "the result exceeds the %d-byte frame cap" % state.MAX_LINE_BYTES,
                        },
                    }
                )
                + "\n"
            ).encode("utf-8")
        with self.lock:
            if not conn.dead:
                conn.outbox.append(data)

    def emit_event(self, event, data):
        frame = (json.dumps({"event": event, "data": data}) + "\n").encode("utf-8")
        with self.lock:
            if self.current is not None and not self.current.dead:
                self.current.outbox.append(frame)

    # ── the socket thread ────────────────────────────────────────────────────

    def _close(self, conn):
        conn.dead = True
        try:
            conn.sock.close()
        except OSError:
            pass

    def _loop(self):
        while not self.stop_flag.is_set():
            with self.lock:
                live = [c for c in self.conns if not c.dead]
                writable_wanted = [c.sock for c in live if c.outbox]
            rlist = [self.listener] + [c.sock for c in live]
            try:
                readable, writable, _ = select.select(rlist, writable_wanted, [], 0.05)
            except (OSError, ValueError):
                # A socket died under select — the reap below clears it.
                readable, writable = [], []
                time.sleep(0.02)
            for sock in readable:
                if sock is self.listener:
                    try:
                        fresh, _addr = self.listener.accept()
                        fresh.setblocking(False)
                        with self.lock:
                            self.conns.append(_Conn(fresh))
                    except OSError:
                        pass
                    continue
                conn = self._conn_for(sock)
                if conn is None:
                    continue
                try:
                    data = sock.recv(65536)
                except OSError:
                    self._drop(conn)
                    continue
                if not data:
                    self._drop(conn)
                    continue
                conn.buf += data
                if len(conn.buf) > state.MAX_LINE_BYTES:
                    self._drop(conn)  # oversized inbound frame: the cap law
                    continue
                while b"\n" in conn.buf:
                    line, conn.buf = conn.buf.split(b"\n", 1)
                    if line.strip():
                        self._handle_line(conn, line)
                    if conn.dead:
                        break
            for sock in writable:
                conn = self._conn_for(sock)
                if conn is None:
                    continue
                with self.lock:
                    pending = b"".join(conn.outbox)
                    conn.outbox = []
                if pending:
                    try:
                        sock.sendall(pending)
                    except OSError:
                        self._drop(conn)
            self._reap()

    def _conn_for(self, sock):
        with self.lock:
            for conn in self.conns:
                if conn.sock is sock and not conn.dead:
                    return conn
        return None

    def _drop(self, conn):
        with self.lock:
            if self.current is conn:
                self.current = None
        self._close(conn)

    def _reap(self):
        now = time.monotonic()
        with self.lock:
            for conn in self.conns:
                # The unauthed receive deadline: probes and squatters die
                # here; they never displaced the authed client to begin with.
                if not conn.dead and not conn.authed and now - conn.connected_at > state.UNAUTHED_DEADLINE_S:
                    self._close(conn)
            self.conns = [c for c in self.conns if not c.dead]

    def _read_token(self):
        try:
            with open(self.token_path, "r", encoding="utf-8") as f:
                token = f.read().strip()
            return token if token else None
        except OSError:
            return None

    def _reply_now(self, conn, frame):
        """Socket-thread reply (handshake/ping/UNKNOWN_OP only)."""
        data = (json.dumps(frame) + "\n").encode("utf-8")
        with self.lock:
            if not conn.dead:
                conn.outbox.append(data)

    def _handle_line(self, conn, line):
        try:
            frame = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._drop(conn)  # garbage is not a peer; the client resyncs its side
            return
        if not isinstance(frame, dict):
            self._drop(conn)
            return
        if not conn.authed:
            expected = self._read_token()
            if frame.get("op") != "hello" or expected is None or frame.get("token") != expected:
                self._reply_now(
                    conn,
                    {
                        "ok": False,
                        "error": {
                            "code": "AUTH_FAILED",
                            "message": "bad token",
                            "hint": 'op:"blender_bridge_install" rewrites the token file beside the add-on',
                        },
                    },
                )
                self._flush_and_close(conn)
                return
            if frame.get("version") != state.PROTOCOL_VERSION:
                self._reply_now(
                    conn,
                    {
                        "ok": False,
                        "error": {
                            "code": "VERSION_SKEW",
                            "message": "the bridge add-on speaks protocol %d but the client sent %s"
                            % (state.PROTOCOL_VERSION, frame.get("version")),
                            "hint": 'op:"blender_bridge_install" refreshes the bundled add-on so both halves match',
                        },
                    },
                )
                self._flush_and_close(conn)
                return
            conn.authed = True
            # ACCEPT-NEWEST AT HELLO TIME: only an AUTHENTICATED newer
            # connection replaces the older one — a bare connect (a
            # reachability probe) can never kick the live client.
            with self.lock:
                previous = self.current
                self.current = conn
            if previous is not None and previous is not conn:
                self._close(previous)
            snapshot = state.snapshot_read()
            self._reply_now(
                conn,
                {
                    "ok": True,
                    "result": {
                        "version": state.PROTOCOL_VERSION,
                        "bridge": "mercury_blender_bridge/%s" % state.BRIDGE_VERSION,
                        "blender": snapshot["blender"],
                        "blendFile": snapshot["blendFile"],
                        "background": snapshot["background"],
                    },
                },
            )
            return
        op = frame.get("op")
        req_id = frame.get("id")
        args = frame.get("args") if isinstance(frame.get("args"), dict) else {}
        if op == "ping":
            # Answered on THIS thread: a long main-thread op (python_run, a
            # render tick) must read as busy, never as dead.
            self._reply_now(conn, {"id": req_id, "ok": True, "result": "pong"})
            return
        if op not in state.VERBS:
            self._reply_now(
                conn,
                {
                    "id": req_id,
                    "ok": False,
                    "error": {
                        "code": "UNKNOWN_OP",
                        "message": "bridge does not handle '%s'" % op,
                        "hint": "one of: %s" % ", ".join(state.VERBS),
                    },
                },
            )
            return
        command_queue.put((op, args, req_id, conn))

    def _flush_and_close(self, conn):
        with self.lock:
            pending = b"".join(conn.outbox)
            conn.outbox = []
        try:
            if pending:
                conn.sock.sendall(pending)
        except OSError:
            pass
        self._drop(conn)

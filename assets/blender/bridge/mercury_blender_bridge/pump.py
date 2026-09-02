"""The main-thread pump — ONE persistent bpy.app.timers callback (Mercury
Blender bridge).

THE MAIN-THREAD LAW made mechanical: the socket thread queues (op, args,
id, conn) rows; THIS timer drains them on the main thread, runs the bpy
handler, and hands the answer back through the server's outbox door. The
registration is persistent=True — "Don't remove timer when a new file is
loaded" (bpy_app_timers.cc) — which is the no-reload law's other half: the
pump, like the connection, survives blend_open.

A long handler (python_run by contract, a blocking op) delays the NEXT
tick, never breaks it: the timer re-arms by returning the interval. Pings
are answered on the socket thread, so a busy pump reads as busy — never as
dead.
"""

import bpy

from . import ops, server, state

_MAX_PER_TICK = 16


def _refresh_snapshot():
    state.snapshot_update(blendFile=bpy.data.filepath)


def pump_tick():
    for _ in range(_MAX_PER_TICK):
        try:
            op, args, req_id, conn = server.command_queue.get_nowait()
        except Exception:
            break
        try:
            ok, payload = ops.dispatch(op, args)
        except Exception as exc:
            # The INTERNAL law: an add-on-side surprise is carried honestly,
            # never a dropped request.
            ok, payload = False, {"code": "INTERNAL", "message": "%s: %s" % (type(exc).__name__, exc)}
        frame = {"id": req_id, "ok": ok}
        if ok:
            frame["result"] = payload
        else:
            frame["error"] = payload
        server.answer(conn, frame)
    _refresh_snapshot()
    return state.PUMP_INTERVAL_S


def register_pump():
    if not bpy.app.timers.is_registered(pump_tick):
        bpy.app.timers.register(pump_tick, first_interval=state.PUMP_INTERVAL_S, persistent=True)


def unregister_pump():
    if bpy.app.timers.is_registered(pump_tick):
        bpy.app.timers.unregister(pump_tick)

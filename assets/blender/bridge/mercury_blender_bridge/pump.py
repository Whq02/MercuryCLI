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

bl_info = {
    "name": "Mercury Blender Bridge",
    "author": "Mercury",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "Runs headless — no UI panels; serves 127.0.0.1 only",
    "description": "Token-authed loopback control bridge for the Mercury terminal harness",
    "category": "Development",
}

import json
import os

import bpy

from . import ops, pump, ring, server, state

_server = None


def _config_port():
    cfg = os.path.join(os.path.dirname(__file__), "config.json")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            port = json.load(f).get("port")
        if isinstance(port, int) and 1 <= port <= 65535:
            return port
    except (OSError, ValueError):
        pass
    return state.DEFAULT_PORT


def register():
    global _server
    state.snapshot_update(
        blender=bpy.app.version_string,
        blendFile=getattr(bpy.data, "filepath", ""),
        background=bool(bpy.app.background),
    )
    ring.attach_logging()
    ops.register_lifecycle()
    pump.register_pump()
    port = _config_port()
    token_path = os.path.join(os.path.dirname(__file__), "token")
    _server = server.BridgeServer(port, token_path)
    server.set_active(_server)
    if _server.start():
        ring.bridge_report("info", "bridge listening on 127.0.0.1:%d" % port)


def unregister():
    global _server
    pump.unregister_pump()
    ops.unregister_lifecycle()
    ring.detach_logging()
    server.set_active(None)
    if _server is not None:
        _server.stop()
        _server = None
